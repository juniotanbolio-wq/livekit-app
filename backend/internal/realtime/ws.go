package realtime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/coder/websocket"

	"livekit-app/backend/internal/api"
	"livekit-app/backend/internal/presence"
	"livekit-app/backend/internal/service"
	"livekit-app/backend/internal/store"
)

// client é uma conexão WebSocket autenticada.
type client struct {
	hub      *Hub
	conn     *websocket.Conn
	userID   string
	username string
	// out é a fila de mensagens para o escritor. Só o laço de escrita grava no socket (depois do snapshot),
	// então quem produz (leitor, outras conexões) nunca bloqueia: fila cheia = consumidor lento = desconectar.
	out    chan []byte
	cancel context.CancelCauseFunc
}

// send enfileira uma mensagem já serializada. Nunca bloqueia.
func (c *client) send(msg []byte) bool {
	if msg == nil {
		return false
	}
	select {
	case c.out <- msg:
		return true
	default:
		c.cancel(errSlowConsumer)
		return false
	}
}

func (c *client) sendError(code api.WsErrorCode, message string, ref *string) {
	c.send(encode(c.hub, api.WsError{Type: api.Error, Code: code, Message: message, Ref: ref}))
}

// encode serializa uma mensagem. Os tipos são structs simples, então a falha é bug de programação:
// registra e devolve nil (send ignora nil) em vez de derrubar o servidor.
func encode(h *Hub, v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		h.logger.Error("falha ao serializar mensagem do WebSocket", "erro", err)
		return nil
	}
	return b
}

// ServeHTTP aceita a conexão em /ws. Qualquer verificação de origem exata já foi feita pelo middleware de CORS;
// a biblioteca confere de novo os hosts (defesa em profundidade).
func (h *Hub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !h.reserve() {
		http.Error(w, "servidor ocupado", http.StatusServiceUnavailable)
		return
	}
	defer h.release()

	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: h.originPatterns})
	if err != nil {
		h.logger.Debug("handshake WebSocket recusado", "erro", err)
		return // Accept já respondeu ao cliente
	}
	conn.SetReadLimit(readLimit)
	h.serve(conn)
}

func (h *Hub) serve(conn *websocket.Conn) {
	ctx, cancel := context.WithCancelCause(h.baseCtx)
	defer cancel(nil)

	userID, username, ok := h.authenticate(ctx, conn)
	if !ok {
		return
	}
	c := &client{hub: h, conn: conn, userID: userID, username: username, out: make(chan []byte, sendBuffer), cancel: cancel}

	channels, err := h.deps.Directory.Channels(ctx)
	if err != nil {
		h.logger.Error("listar canais para o snapshot", "erro", err)
		_ = conn.Close(websocket.StatusInternalError, "erro interno")
		return
	}

	// Snapshot e inscrição são obtidos juntos: os eventos que chegarem depois têm seq maior que o do snapshot,
	// sem buraco e sem repetição. A inscrição guarda os eventos enquanto o snapshot é escrito.
	seq, snap, sub := h.deps.Tracker.Subscribe(presenceBuffer)
	defer sub.Close()
	h.register(c)
	defer h.unregister(c)

	if err := c.write(ctx, encode(h, snapshotMessage(seq, channels, snap))); err != nil {
		_ = conn.CloseNow()
		return
	}
	h.logger.Info("websocket conectado", "usuario", userID)
	defer h.logger.Info("websocket desconectado", "usuario", userID)

	// O leitor usa um contexto próprio: cancelar o da conexão fecharia o socket de forma abrupta, e o
	// fechamento educado (Close) precisa do leitor ativo para receber o frame de fechamento do cliente.
	readCtx, cancelRead := context.WithCancel(context.WithoutCancel(ctx))
	readerDone := make(chan struct{})
	go func() {
		defer close(readerDone)
		c.readLoop(readCtx)
	}()

	c.writeLoop(ctx, sub)

	var ce *closeError
	if errors.As(context.Cause(ctx), &ce) {
		_ = conn.Close(ce.code, ce.reason)
	} else {
		_ = conn.CloseNow()
	}
	cancelRead()
	<-readerDone
}

// authenticate espera a mensagem {"type":"auth","token":...}. O token viaja no corpo da mensagem, nunca na
// URL: URLs ficam em logs de acesso, de proxy e no histórico, e o token de sessão vale por dias.
func (h *Hub) authenticate(ctx context.Context, conn *websocket.Conn) (userID, username string, ok bool) {
	authCtx, cancel := context.WithTimeout(ctx, h.cfg.AuthTimeout)
	defer cancel()

	// Se o prazo estourar, a biblioteca fecha a conexão sozinha; não há o que responder a quem ficou mudo.
	typ, data, err := conn.Read(authCtx)
	if err != nil {
		_ = conn.CloseNow()
		return "", "", false
	}
	reject := func() (string, string, bool) {
		msg := encode(h, api.WsError{Type: api.Error, Code: api.WsErrorCodeUnauthorized, Message: "Autenticação necessária ou inválida"})
		if msg != nil {
			wctx, cancelWrite := context.WithTimeout(ctx, writeTimeout)
			_ = conn.Write(wctx, websocket.MessageText, msg)
			cancelWrite()
		}
		_ = conn.Close(websocket.StatusPolicyViolation, "não autorizado")
		return "", "", false
	}

	var msg api.WsClientAuth
	if typ != websocket.MessageText || json.Unmarshal(data, &msg) != nil || msg.Type != api.Auth || msg.Token == "" {
		return reject()
	}
	id, err := h.deps.Tokens.Verify(msg.Token)
	if err != nil {
		return reject()
	}
	// Reconsulta o usuário: sessão ainda válida não dá acesso a uma conta que já foi removida.
	user, err := h.deps.Directory.User(authCtx, id)
	if errors.Is(err, service.ErrNotFound) {
		return reject()
	}
	if err != nil {
		h.logger.Error("buscar usuário no WebSocket", "erro", err)
		_ = conn.Close(websocket.StatusInternalError, "erro interno")
		return "", "", false
	}
	return user.ID, user.Username, true
}

func (c *client) write(ctx context.Context, msg []byte) error {
	if msg == nil {
		return errors.New("mensagem não serializável")
	}
	// WithoutCancel: com esta biblioteca, cancelar o contexto no meio de uma escrita derruba o socket sem
	// o fechamento educado. Quem cancela ctx (leitor, expulsão) quer justamente que o Close envie o motivo.
	wctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), writeTimeout)
	defer cancel()
	if err := c.conn.Write(wctx, websocket.MessageText, msg); err != nil {
		return fmt.Errorf("escrever no websocket: %w", err)
	}
	return nil
}

// writeLoop é o único escritor da conexão: serializa eventos de presença, mensagens da fila e pings.
// Termina quando ctx é cancelado (a causa diz por quê).
func (c *client) writeLoop(ctx context.Context, sub *presence.Subscription) {
	ping := time.NewTicker(c.hub.cfg.PingInterval)
	defer ping.Stop()
	// O pong precisa voltar bem antes do próximo ping, e nunca demorar mais que 10 s.
	pongTimeout := min(c.hub.cfg.PingInterval/2, 10*time.Second)

	for {
		select {
		case <-ctx.Done():
			return

		case ev, open := <-sub.Events():
			if !open {
				// O Tracker encerra a inscrição quando o buffer enche (cliente não está lendo).
				c.cancel(errSlowConsumer)
				return
			}
			msg := presenceMessage(ev)
			if msg == nil {
				continue // tipo de evento desconhecido: não deveria ocorrer; ignorar é mais seguro que mandar "null"
			}
			if err := c.write(ctx, encode(c.hub, msg)); err != nil {
				c.cancel(err)
				return
			}

		case msg := <-c.out:
			if err := c.write(ctx, msg); err != nil {
				c.cancel(err)
				return
			}

		case <-ping.C:
			// Ping/pong detecta conexão morta (cabo puxado, NAT que esqueceu a sessão): sem ele o
			// servidor guardaria a conexão e o usuário apareceria como "conectado" para sempre.
			pctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), pongTimeout)
			err := c.conn.Ping(pctx)
			cancel()
			if err != nil {
				c.cancel(fmt.Errorf("ping sem resposta: %w", err))
				return
			}
		}
	}
}

// readLoop lê as mensagens do cliente até a conexão cair. Precisa rodar durante toda a vida da conexão:
// é ele que processa os pongs e o frame de fechamento.
func (c *client) readLoop(ctx context.Context) {
	bad := 0
	for {
		typ, data, err := c.conn.Read(ctx)
		if err != nil {
			c.cancel(err)
			return
		}
		if c.handle(ctx, typ, data) {
			bad = 0
			continue
		}
		bad++
		if bad >= maxBadMessages {
			c.cancel(errTooManyBad)
			return
		}
	}
}

// handle trata uma mensagem do cliente e diz se ela era válida.
func (c *client) handle(ctx context.Context, typ websocket.MessageType, data []byte) bool {
	var envelope struct {
		Type string `json:"type"`
	}
	if typ != websocket.MessageText || json.Unmarshal(data, &envelope) != nil {
		c.sendError(api.WsErrorCodeBadMessage, "Mensagem inválida: envie JSON em texto", nil)
		return false
	}
	switch envelope.Type {
	case string(api.WsClientMentionTypeMention):
		return c.handleMention(ctx, data)
	default:
		c.sendError(api.WsErrorCodeBadMessage, "Tipo de mensagem desconhecido", nil)
		return false
	}
}

// handleMention valida, aplica os limites e entrega a menção. Ordem das checagens (cada uma barata antes da
// seguinte, e o limite do remetente antes de qualquer consulta ao banco para limitar também a sondagem de ids):
// formato → auto-menção → limite do remetente → destinatário conectado (senão: existe? offline) → limite do
// destinatário → entrega.
func (c *client) handleMention(ctx context.Context, data []byte) bool {
	h := c.hub
	var m api.WsClientMention
	if err := json.Unmarshal(data, &m); err != nil || m.TargetUserId == "" || utf8.RuneCountInString(m.TargetUserId) > 64 {
		c.sendError(api.WsErrorCodeBadMessage, "Menção inválida: informe targetUserId", nil)
		return false
	}
	var ref *string
	if m.Ref != nil {
		if utf8.RuneCountInString(*m.Ref) > maxRefRunes {
			c.sendError(api.WsErrorCodeBadMessage, "ref grande demais", nil)
			return false
		}
		ref = m.Ref
	}
	var message *string
	if m.Message != nil {
		text := strings.TrimSpace(*m.Message)
		if utf8.RuneCountInString(text) > MaxMentionRunes {
			c.sendError(api.WsErrorCodeBadMessage, fmt.Sprintf("Mensagem grande demais (máximo %d caracteres)", MaxMentionRunes), ref)
			return false
		}
		if text != "" {
			message = &text
		}
	}

	if m.TargetUserId == c.userID {
		c.sendError(api.WsErrorCodeSelfMention, "Você não pode chamar a si mesmo", ref)
		return true
	}
	if ok, retry := h.senderLimiter.Allow(c.userID); !ok {
		c.sendError(api.WsErrorCodeRateLimitedSender, "Você chamou atenção vezes demais; "+retryHint(retry), ref)
		return true
	}

	targets := h.connsOf(m.TargetUserId)
	if len(targets) == 0 {
		// Só aqui vale uma consulta ao banco: distingue "esse usuário não existe" de "existe, mas está offline".
		_, err := h.deps.Directory.User(ctx, m.TargetUserId)
		switch {
		case errors.Is(err, service.ErrNotFound):
			c.sendError(api.WsErrorCodeUnknownUser, "Usuário não encontrado", ref)
		case err != nil:
			h.logger.Error("buscar destinatário da menção", "erro", err)
			c.sendError(api.WsErrorCodeRecipientOffline, "Não foi possível entregar agora", ref)
		default:
			c.sendError(api.WsErrorCodeRecipientOffline, "O usuário está offline", ref)
		}
		return true
	}

	// O limite do destinatário protege quem é chamado por várias pessoas ao mesmo tempo. Só é consumido
	// quando a menção seria de fato entregue.
	if ok, retry := h.recipientLimiter.Allow(m.TargetUserId); !ok {
		c.sendError(api.WsErrorCodeRateLimitedRecipient, "Esse usuário já foi chamado vezes demais; "+retryHint(retry), ref)
		return true
	}

	payload := encode(h, api.WsMention{
		Type:    api.WsMentionTypeMention,
		From:    api.PublicUser{Id: c.userID, Username: api.Username(c.username)},
		Message: message,
		SentAt:  h.now().UTC(),
	})
	delivered := 0
	for _, target := range targets {
		if target.send(payload) {
			delivered++
		}
	}
	if delivered == 0 {
		c.sendError(api.WsErrorCodeRecipientOffline, "O usuário está offline", ref)
		return true
	}
	c.send(encode(h, api.WsMentionSent{Type: api.MentionSent, Ref: ref}))
	return true
}

func retryHint(d time.Duration) string {
	return fmt.Sprintf("tente de novo em %d s", max(int(math.Ceil(d.Seconds())), 1))
}

// snapshotMessage monta o estado completo: todos os canais, na ordem de exibição, vazios inclusive
// (o cliente não precisa adivinhar quais canais existem).
func snapshotMessage(seq uint64, channels []store.Channel, snap map[string][]presence.Participant) api.WsSnapshot {
	out := make([]api.ChannelPresence, 0, len(channels))
	for _, ch := range channels {
		participants := make([]api.PresenceParticipant, 0, len(snap[ch.ID]))
		for _, p := range snap[ch.ID] {
			participants = append(participants, api.PresenceParticipant{UserId: p.UserID, Username: p.Username, IsScreenSharing: p.IsScreenSharing})
		}
		out = append(out, api.ChannelPresence{ChannelId: ch.ID, Participants: participants})
	}
	return api.WsSnapshot{Type: api.Snapshot, Seq: int64(seq), Channels: out} //nolint:gosec // seq cresce de um em um; não chega perto de estourar int64
}

// presenceMessage converte um evento do Tracker na mensagem do protocolo.
func presenceMessage(ev presence.Event) any {
	seq := int64(ev.Seq) //nolint:gosec // idem snapshotMessage
	switch ev.Type {
	case presence.EventJoined:
		return api.WsParticipantJoined{
			Type: api.ParticipantJoined, Seq: seq, ChannelId: ev.ChannelID,
			Participant: api.PresenceParticipant{UserId: ev.UserID, Username: ev.Username, IsScreenSharing: ev.IsScreenSharing},
		}
	case presence.EventLeft:
		return api.WsParticipantLeft{Type: api.ParticipantLeft, Seq: seq, ChannelId: ev.ChannelID, UserId: ev.UserID}
	case presence.EventStreamStarted:
		return api.WsStreamStarted{Type: api.StreamStarted, Seq: seq, ChannelId: ev.ChannelID, UserId: ev.UserID}
	case presence.EventStreamStopped:
		return api.WsStreamStopped{Type: api.StreamStopped, Seq: seq, ChannelId: ev.ChannelID, UserId: ev.UserID}
	default:
		return nil
	}
}
