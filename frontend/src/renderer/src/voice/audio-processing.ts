import { RnnoiseWorkletNode, loadRnnoise } from '@sapphi-red/web-noise-suppressor';
import rnnoiseWorkletUrl from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url';
import rnnoiseWasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url';
import rnnoiseSimdWasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url';
import type { AudioProcessorOptions, LocalAudioTrack, Track, TrackProcessor } from 'livekit-client';
import { needsProcessor, type AudioSettings } from '../stores/audio-settings';
// no-inline: arquivos pequenos o Vite embutiria como data: URL, e a CSP (script-src 'self') bloqueia worklet
// carregado de data:. Assim ele vira um arquivo servido pelo próprio app://.
import noiseGateWorkletUrl from './noise-gate.worklet.js?url&no-inline';

// Processamento local da voz, encaixado no microfone como processador de trilha do livekit-client: o que vai
// para o WebRTC é a saída deste grafo de Web Audio, não o microfone cru.
//
//   microfone (já com eco e ganho do navegador) -> [RNNoise] -> medidor -> [noise gate] -> trilha processada
//
// Tudo roda neste PC (AudioWorklet + WebAssembly); nenhum áudio sai para serviço externo. O RNNoise
// (Xiph/Mozilla, BSD-3) vem empacotado pelo @sapphi-red/web-noise-suppressor (MIT). Carregar o WASM exige
// 'wasm-unsafe-eval' na CSP (main/security.ts).

// O RNNoise foi treinado e processa quadros de 10 ms a 48 kHz: o contexto é criado nessa taxa em vez de usar o
// do livekit-client (que segue a taxa do dispositivo de saída, às vezes 44,1 kHz).
const SAMPLE_RATE = 48_000;
const GATE_PROCESSOR = 'livekit-app-noise-gate';

// O binário do RNNoise (com SIMD quando a CPU suporta) é baixado do próprio app uma vez e reaproveitado.
let rnnoiseBinary: Promise<ArrayBuffer> | null = null;

function loadRnnoiseBinary(): Promise<ArrayBuffer> {
  if (!rnnoiseBinary) {
    rnnoiseBinary = loadRnnoise({ url: rnnoiseWasmUrl, simdUrl: rnnoiseSimdWasmUrl }).catch(
      (err: unknown) => {
        rnnoiseBinary = null;
        throw err;
      },
    );
  }
  return rnnoiseBinary;
}

function describe(settings: AudioSettings): string {
  const parts: string[] = [];
  if (settings.suppression === 'advanced') {
    parts.push('rnnoise');
  }
  if (settings.gateEnabled) {
    parts.push(`gate ${settings.gateThresholdDb} dB`);
  }
  return parts.length > 0 ? parts.join(' + ') : 'sem efeito';
}

export class VoiceProcessor implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
  // Lido pelo painel de depuração (getProcessor().name).
  name: string;
  processedTrack?: MediaStreamTrack;

  private settings: AudioSettings;
  private context: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private destination: MediaStreamAudioDestinationNode | null = null;
  private analyser: AnalyserNode | null = null;
  // Medidor depois do gate: mostra o que de fato vai para o WebRTC (com o gate fechado, silêncio).
  private outputAnalyser: AnalyserNode | null = null;
  // Só o canal 0 da saída final. Igual ao medidor acima quando a saída é mono (ou L = R); 6 dB acima dele quando
  // um canal está vazio, o defeito que já derrubou a voz no modo Avançado. O painel e o aceite comparam os dois.
  private splitter: ChannelSplitterNode | null = null;
  private firstChannelAnalyser: AnalyserNode | null = null;
  private rnnoise: RnnoiseWorkletNode | null = null;
  private gate: AudioWorkletNode | null = null;
  private readonly samples = new Float32Array(1024);
  // Operações do grafo em fila: o controle do limite gera várias atualizações por segundo, e montar o grafo
  // espera o WASM; sem a fila, duas montagens simultâneas deixariam nós órfãos conectados.
  private queue: Promise<void> = Promise.resolve();

  constructor(settings: AudioSettings) {
    this.settings = settings;
    // Só vira a descrição da cadeia depois que o grafo é montado: se o WASM ou o worklet não carregarem, o
    // painel continua mostrando "iniciando" (e o erro aparece na tela da voz).
    this.name = 'iniciando';
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => undefined);
    return next;
  }

  // Só a trilha importa: o AudioContext que o livekit-client oferece é ignorado (ver SAMPLE_RATE). Aceitar o
  // objeto mínimo também permite usar o processador fora de uma sala, no "Testar microfone".
  init({ track }: Pick<AudioProcessorOptions, 'track'>): Promise<void> {
    return this.enqueue(() => this.build(track));
  }

  // Chamado quando o livekit-client troca a trilha do microfone (outro dispositivo, novas restrições). O contexto
  // e a saída continuam os mesmos; só a fonte muda.
  restart({ track }: Pick<AudioProcessorOptions, 'track'>): Promise<void> {
    return this.enqueue(async () => {
      if (!this.context) {
        await this.build(track);
        return;
      }
      this.source?.disconnect();
      this.source = this.context.createMediaStreamSource(new MediaStream([track]));
      await this.wire();
    });
  }

  destroy(): Promise<void> {
    return this.enqueue(() => this.teardown());
  }

  // Aplica configurações novas sem recriar a trilha processada (o WebRTC continua enviando a mesma).
  update(settings: AudioSettings): Promise<void> {
    return this.enqueue(async () => {
      const previous = this.settings;
      this.settings = settings;
      if (!this.context) {
        return;
      }
      const rnnoiseChanged =
        (previous.suppression === 'advanced') !== (settings.suppression === 'advanced');
      if (rnnoiseChanged || previous.gateEnabled !== settings.gateEnabled) {
        await this.wire();
        return;
      }
      this.gate?.parameters
        .get('threshold')
        ?.setValueAtTime(settings.gateThresholdDb, this.context.currentTime);
      this.name = describe(settings);
    });
  }

  // Nível do sinal que chega ao gate, em dBFS (null antes de montar). Usado pelo medidor das configurações.
  levelDb(): number | null {
    return this.measure(this.analyser);
  }

  // Nível do que sai do processador (depois do gate), em dBFS. Usado pelo painel de depuração.
  outputLevelDb(): number | null {
    return this.measure(this.outputAnalyser);
  }

  // Nível só do canal 0 da saída, em dBFS (diagnóstico de canais; ver firstChannelAnalyser).
  firstChannelLevelDb(): number | null {
    return this.measure(this.firstChannelAnalyser);
  }

  private measure(analyser: AnalyserNode | null): number | null {
    if (!analyser) {
      return null;
    }
    analyser.getFloatTimeDomainData(this.samples);
    let sum = 0;
    for (const sample of this.samples) {
      sum += sample * sample;
    }
    const rms = Math.sqrt(sum / this.samples.length);
    return rms > 0 ? Math.max(-100, 20 * Math.log10(rms)) : -100;
  }

  private async build(track: MediaStreamTrack): Promise<void> {
    await this.teardown();
    const context = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' });
    this.context = context;
    await Promise.all([
      context.audioWorklet.addModule(rnnoiseWorkletUrl),
      context.audioWorklet.addModule(noiseGateWorkletUrl),
    ]);
    this.source = context.createMediaStreamSource(new MediaStream([track]));
    this.analyser = context.createAnalyser();
    this.analyser.fftSize = this.samples.length;
    this.outputAnalyser = context.createAnalyser();
    this.outputAnalyser.fftSize = this.samples.length;
    this.splitter = context.createChannelSplitter(2);
    this.firstChannelAnalyser = context.createAnalyser();
    this.firstChannelAnalyser.fftSize = this.samples.length;
    this.splitter.connect(this.firstChannelAnalyser, 0);
    // Voz é mono; sem fixar o canal, o destino faria upmix para estéreo e o Opus gastaria bits à toa.
    this.destination = context.createMediaStreamDestination();
    this.destination.channelCount = 1;
    this.destination.channelCountMode = 'explicit';
    await this.wire();
    this.processedTrack = this.destination.stream.getAudioTracks()[0];
    // O Electron libera áudio sem gesto do usuário, mas um contexto criado com a janela escondida pode nascer
    // suspenso.
    await context.resume();
  }

  private async wire(): Promise<void> {
    const context = this.context;
    if (
      !context ||
      !this.source ||
      !this.analyser ||
      !this.outputAnalyser ||
      !this.splitter ||
      !this.destination
    ) {
      return;
    }
    this.source.disconnect();
    this.rnnoise?.disconnect();
    this.rnnoise?.destroy();
    this.rnnoise = null;
    this.gate?.disconnect();
    this.gate = null;
    this.analyser.disconnect();

    let node: AudioNode = this.source;
    if (this.settings.suppression === 'advanced') {
      this.rnnoise = new RnnoiseWorkletNode(context, {
        maxChannels: 1,
        wasmBinary: await loadRnnoiseBinary(),
      });
      // O microfone chega ao Web Audio em estéreo (L = R) e o RNNoise só processa o canal 0: sem forçar a
      // entrada mono, a saída vinha com o canal 1 em silêncio e o downmix para mono do destino deixava a voz
      // 6 dB mais baixa (medido). Com entrada mono explícita, a saída do nó também tem um canal só.
      this.rnnoise.channelCount = 1;
      this.rnnoise.channelCountMode = 'explicit';
      node.connect(this.rnnoise);
      node = this.rnnoise;
    }
    // O medidor fica antes do gate: mostra o nível que o gate compara com o limite.
    node.connect(this.analyser);
    if (this.settings.gateEnabled) {
      this.gate = new AudioWorkletNode(context, GATE_PROCESSOR, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        // Mesma razão do RNNoise: mistura a entrada para mono antes do gate, que compara e copia um canal só.
        channelCount: 1,
        channelCountMode: 'explicit',
        outputChannelCount: [1],
        parameterData: { threshold: this.settings.gateThresholdDb },
      });
      node.connect(this.gate);
      node = this.gate;
    }
    node.connect(this.destination);
    node.connect(this.outputAnalyser);
    node.connect(this.splitter);
    this.name = describe(this.settings);
  }

  private async teardown(): Promise<void> {
    this.source?.disconnect();
    this.rnnoise?.disconnect();
    this.rnnoise?.destroy();
    this.gate?.disconnect();
    this.analyser?.disconnect();
    this.outputAnalyser?.disconnect();
    this.splitter?.disconnect();
    this.firstChannelAnalyser?.disconnect();
    this.processedTrack?.stop();
    const context = this.context;
    this.context = null;
    this.source = null;
    this.rnnoise = null;
    this.gate = null;
    this.analyser = null;
    this.outputAnalyser = null;
    this.splitter = null;
    this.firstChannelAnalyser = null;
    this.destination = null;
    this.processedTrack = undefined;
    if (context && context.state !== 'closed') {
      await context.close().catch(() => undefined);
    }
  }
}

// Deixa o processador do microfone publicado de acordo com as configurações: cria, atualiza ou remove.
export async function syncVoiceProcessor(
  track: LocalAudioTrack,
  settings: AudioSettings,
): Promise<void> {
  const current = track.getProcessor();
  if (!needsProcessor(settings)) {
    if (current) {
      await track.stopProcessor();
    }
    return;
  }
  if (current instanceof VoiceProcessor) {
    await current.update(settings);
    return;
  }
  if (current) {
    await track.stopProcessor();
  }
  await track.setProcessor(new VoiceProcessor(settings));
}
