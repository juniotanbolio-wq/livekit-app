import type { components } from '../../../generated/api';
import { isInteger, isOptionalString, isRecord, isString } from './guards';

// Cliente do WebSocket de tempo real (GET /ws): presença dos canais de voz e "chamar atenção".
// Protocolo completo em docs/protocolo-tempo-real.md; formatos nos schemas Ws* do contrato.

type Schemas = components['schemas'];
export type WsSnapshot = Schemas['WsSnapshot'];
export type WsMention = Schemas['WsMention'];
export type WsErrorCode = Schemas['WsErrorCode'];
export type PresenceEvent =
  | Schemas['WsParticipantJoined']
  | Schemas['WsParticipantLeft']
  | Schemas['WsStreamStarted']
  | Schemas['WsStreamStopped'];
type ServerMessage =
  WsSnapshot | PresenceEvent | WsMention | Schemas['WsMentionSent'] | Schemas['WsError'];

export type RealtimeStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting';

export type MentionErrorCode = WsErrorCode | 'not_connected' | 'timeout' | 'connection_lost';

export class MentionError extends Error {
  constructor(
    readonly code: MentionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'MentionError';
  }
}

export interface RealtimeHandlers {
  onStatus(status: RealtimeStatus): void;
  onSnapshot(message: WsSnapshot): void;
  onPresenceEvent(event: PresenceEvent): void;
  onMention(message: WsMention): void;
  // Token recusado pelo servidor: a sessão acabou e reconectar não adianta.
  onUnauthorized(): void;
}

// Prazo para o snapshot chegar depois de abrir a conexão (o servidor dá 5 s para o auth; aqui sobra folga).
const SNAPSHOT_TIMEOUT_MS = 10_000;
const MENTION_TIMEOUT_MS = 10_000;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
// Códigos de fechamento iniciados pelo cliente (3000-4999 são livres para a aplicação).
const CLOSE_NORMAL = 1000;
const CLOSE_NO_SNAPSHOT = 4000;
const CLOSE_SEQ_GAP = 4001;

function isParticipant(value: unknown): value is Schemas['PresenceParticipant'] {
  return (
    isRecord(value) &&
    isString(value['userId']) &&
    isString(value['username']) &&
    typeof value['isScreenSharing'] === 'boolean'
  );
}

function isChannelPresence(value: unknown): value is Schemas['ChannelPresence'] {
  return (
    isRecord(value) &&
    isString(value['channelId']) &&
    Array.isArray(value['participants']) &&
    value['participants'].every(isParticipant)
  );
}

// Confere o formato antes de usar: uma mensagem inesperada é descartada em vez de corromper a presença.
function parseServerMessage(data: unknown): ServerMessage | null {
  if (!isString(data)) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  if (!isRecord(value)) {
    return null;
  }
  const v = value;
  let valid: boolean;
  switch (v['type']) {
    case 'snapshot':
      valid =
        isInteger(v['seq']) &&
        Array.isArray(v['channels']) &&
        v['channels'].every(isChannelPresence);
      break;
    case 'participant_joined':
      valid = isInteger(v['seq']) && isString(v['channelId']) && isParticipant(v['participant']);
      break;
    case 'participant_left':
    case 'stream_started':
    case 'stream_stopped':
      valid = isInteger(v['seq']) && isString(v['channelId']) && isString(v['userId']);
      break;
    case 'mention':
      valid =
        isRecord(v['from']) &&
        isString(v['from']['id']) &&
        isString(v['from']['username']) &&
        isOptionalString(v['message']) &&
        isString(v['sentAt']);
      break;
    case 'mention_sent':
      valid = isOptionalString(v['ref']);
      break;
    case 'error':
      valid = isString(v['code']) && isString(v['message']) && isOptionalString(v['ref']);
      break;
    default:
      valid = false;
  }
  return valid ? (v as unknown as ServerMessage) : null;
}

interface PendingMention {
  resolve(): void;
  reject(error: MentionError): void;
  timer: number;
}

export function realtimeUrl(serverUrl: string): string {
  const url = new URL('/ws', serverUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.href;
}

export class RealtimeClient {
  private socket: WebSocket | null = null;
  private stopped = true;
  // Último seq aplicado nesta conexão; null até o snapshot chegar.
  private lastSeq: number | null = null;
  // Já houve snapshot nesta sessão: a partir daí uma queda é "reconectando", não "conectando".
  private everConnected = false;
  private attempt = 0;
  private unauthorized = false;
  private retryTimer: number | null = null;
  private snapshotTimer: number | null = null;
  private readonly pending = new Map<string, PendingMention>();

  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly handlers: RealtimeHandlers,
  ) {}

  start(): void {
    if (!this.stopped) {
      return;
    }
    this.stopped = false;
    window.addEventListener('online', this.onOnline);
    this.connect();
  }

  // Logout ou sessão expirada: fecha com 1000 e não reconecta.
  stop(): void {
    this.stopped = true;
    window.removeEventListener('online', this.onOnline);
    this.clearTimers();
    this.failPending('connection_lost', 'Desconectado do servidor');
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      this.detach(socket);
      socket.close(CLOSE_NORMAL, 'logout');
    }
    this.setStatus('idle');
  }

  // Resolve quando o servidor confirma a entrega (mention_sent) e rejeita com o código do erro dele.
  sendMention(targetUserId: string, message: string | null): Promise<void> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN || this.lastSeq === null) {
      return Promise.reject(
        new MentionError(
          'not_connected',
          'Sem conexão com o servidor. Aguarde a reconexão e tente de novo.',
        ),
      );
    }
    const ref = crypto.randomUUID();
    const payload: Schemas['WsClientMention'] = {
      type: 'mention',
      targetUserId,
      ref,
      ...(message ? { message } : {}),
    };
    return new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(ref);
        reject(new MentionError('timeout', 'O servidor não respondeu. Tente de novo.'));
      }, MENTION_TIMEOUT_MS);
      this.pending.set(ref, { resolve, reject, timer });
      socket.send(JSON.stringify(payload));
    });
  }

  private connect(): void {
    this.clearTimers();
    this.lastSeq = null;
    this.unauthorized = false;
    this.setStatus(this.everConnected ? 'reconnecting' : 'connecting');
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.url);
    } catch (err) {
      console.error('Falha ao abrir o WebSocket:', err);
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    // Conexão que abre mas não entrega o snapshot (proxy travado, servidor sobrecarregado) é tratada como queda.
    this.snapshotTimer = window.setTimeout(() => {
      if (this.socket === socket) {
        socket.close(CLOSE_NO_SNAPSHOT, 'sem snapshot');
      }
    }, SNAPSHOT_TIMEOUT_MS);
    socket.onopen = () => {
      // O token vai na primeira mensagem, nunca na URL: URLs ficam em logs de acesso e de proxy.
      const auth: Schemas['WsClientAuth'] = { type: 'auth', token: this.token };
      socket.send(JSON.stringify(auth));
    };
    socket.onmessage = (event: MessageEvent) => this.handleMessage(socket, event.data);
    socket.onclose = (event: CloseEvent) => this.handleClose(socket, event);
    // O evento close vem logo depois de um erro e é ele que decide a reconexão.
    socket.onerror = () => undefined;
  }

  private handleMessage(socket: WebSocket, data: unknown): void {
    if (socket !== this.socket) {
      return;
    }
    const message = parseServerMessage(data);
    if (!message) {
      console.warn('Mensagem do WebSocket em formato inesperado, ignorada');
      return;
    }
    switch (message.type) {
      case 'snapshot':
        this.clearSnapshotTimer();
        this.lastSeq = message.seq;
        this.attempt = 0;
        this.everConnected = true;
        this.handlers.onSnapshot(message);
        this.setStatus('connected');
        return;
      case 'participant_joined':
      case 'participant_left':
      case 'stream_started':
      case 'stream_stopped':
        this.handlePresenceEvent(socket, message);
        return;
      case 'mention':
        this.handlers.onMention(message);
        return;
      case 'mention_sent':
        this.settle(message.ref, null);
        return;
      case 'error':
        if (message.code === 'unauthorized') {
          // O servidor fecha a conexão em seguida (1008); quem decide é o handleClose.
          this.unauthorized = true;
          return;
        }
        if (message.ref && this.pending.has(message.ref)) {
          this.settle(message.ref, new MentionError(message.code, message.message));
          return;
        }
        console.warn(`Erro do servidor no WebSocket (${message.code}): ${message.message}`);
        return;
    }
  }

  // As mudanças de presença têm seq contíguo a partir do snapshot. Um salto significa evento perdido:
  // aplicar o resto deixaria a lista errada para sempre, então reconecta para receber um snapshot novo.
  private handlePresenceEvent(socket: WebSocket, event: PresenceEvent): void {
    if (this.lastSeq === null || event.seq <= this.lastSeq) {
      return;
    }
    if (event.seq !== this.lastSeq + 1) {
      console.warn(`Salto de seq no WebSocket (${this.lastSeq} -> ${event.seq}); reconectando`);
      this.socket = null;
      this.detach(socket);
      socket.close(CLOSE_SEQ_GAP, 'salto de seq');
      this.clearSnapshotTimer();
      this.failPending(
        'connection_lost',
        'A conexão com o servidor foi reiniciada. Tente de novo.',
      );
      this.scheduleReconnect();
      return;
    }
    this.lastSeq = event.seq;
    this.handlers.onPresenceEvent(event);
  }

  private handleClose(socket: WebSocket, event: CloseEvent): void {
    if (socket !== this.socket) {
      return;
    }
    this.socket = null;
    this.clearSnapshotTimer();
    this.failPending(
      'connection_lost',
      'A conexão com o servidor caiu antes da confirmação. Tente de novo.',
    );
    if (this.stopped) {
      return;
    }
    if (this.unauthorized) {
      this.stopped = true;
      window.removeEventListener('online', this.onOnline);
      this.setStatus('idle');
      this.handlers.onUnauthorized();
      return;
    }
    console.info(`WebSocket fechado (${event.code} ${event.reason}); reconectando`);
    this.scheduleReconnect();
  }

  // Espera exponencial com "full jitter": aleatória entre 0 e o teto (1 s, 2 s, 4 s... até 30 s). O sorteio
  // espalha os clientes que caíram juntos (reinício do servidor) para não voltarem todos no mesmo instante.
  private scheduleReconnect(): void {
    if (this.stopped) {
      return;
    }
    const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** this.attempt);
    this.attempt = Math.min(this.attempt + 1, 10);
    this.setStatus(this.everConnected ? 'reconnecting' : 'connecting');
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, Math.random() * ceiling);
  }

  // A rede voltou: não faz sentido esperar o resto do backoff.
  private readonly onOnline = (): void => {
    if (!this.stopped && this.retryTimer !== null) {
      window.clearTimeout(this.retryTimer);
      this.retryTimer = null;
      this.connect();
    }
  };

  private settle(ref: string | undefined, error: MentionError | null): void {
    const entry = ref ? this.pending.get(ref) : undefined;
    if (!entry || !ref) {
      return;
    }
    this.pending.delete(ref);
    window.clearTimeout(entry.timer);
    if (error) {
      entry.reject(error);
    } else {
      entry.resolve();
    }
  }

  private failPending(code: MentionErrorCode, message: string): void {
    for (const [ref, entry] of this.pending) {
      window.clearTimeout(entry.timer);
      entry.reject(new MentionError(code, message));
      this.pending.delete(ref);
    }
  }

  private detach(socket: WebSocket): void {
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
  }

  private clearSnapshotTimer(): void {
    if (this.snapshotTimer !== null) {
      window.clearTimeout(this.snapshotTimer);
      this.snapshotTimer = null;
    }
  }

  private clearTimers(): void {
    this.clearSnapshotTimer();
    if (this.retryTimer !== null) {
      window.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private setStatus(status: RealtimeStatus): void {
    this.handlers.onStatus(status);
  }
}
