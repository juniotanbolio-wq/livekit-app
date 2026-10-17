package livekit

import (
	"errors"
	"log/slog"
	"net/http"
	"strings"

	lkauth "github.com/livekit/protocol/auth"
	lk "github.com/livekit/protocol/livekit"
	"github.com/livekit/protocol/webhook"

	"livekit-app/backend/internal/presence"
)

// maxWebhookBody limita o corpo aceito. Os eventos reais têm poucos KiB; o teto existe para um chamador
// com assinatura válida (ou sem, já que a leitura vem antes da checagem do hash) não nos fazer ler sem fim.
const maxWebhookBody = 256 * 1024

// roomPrefix é o prefixo das salas dos canais (ver RoomName).
const roomPrefix = "channel-"

// ChannelID extrai o id do canal do nome da sala. Salas que não seguem o padrão não são nossas.
func ChannelID(roomName string) (string, bool) {
	id, ok := strings.CutPrefix(roomName, roomPrefix)
	if !ok || id == "" {
		return "", false
	}
	return id, true
}

// IsVisible diz se o participante entra na presença. Ficam de fora o espectador (identidade `<id>#spectator`,
// que é uma segunda conexão do mesmo usuário e não "mais uma pessoa") e qualquer participante oculto.
// As duas checagens são redundantes de propósito: a identidade é convenção nossa, `hidden` é o que o LiveKit garante.
func IsVisible(p *lk.ParticipantInfo) bool {
	if p == nil || p.GetIdentity() == "" || p.GetSid() == "" {
		return false
	}
	if strings.HasSuffix(p.GetIdentity(), SpectatorIdentitySuffix) {
		return false
	}
	return !p.GetPermission().GetHidden()
}

// WebhookReceiver recebe os webhooks do LiveKit e os traduz em operações no Tracker de presença.
type WebhookReceiver struct {
	keys    lkauth.KeyProvider
	tracker *presence.Tracker
	logger  *slog.Logger
}

// NewWebhookReceiver cria o receptor. A chave e o segredo são os mesmos usados para emitir tokens: o LiveKit
// assina cada webhook com o par configurado em `webhook.api_key` (que precisa ser a mesma chave de API).
func NewWebhookReceiver(apiKey, apiSecret string, tracker *presence.Tracker, logger *slog.Logger) *WebhookReceiver {
	return &WebhookReceiver{keys: lkauth.NewSimpleKeyProvider(apiKey, apiSecret), tracker: tracker, logger: logger}
}

// ServeHTTP verifica a assinatura e aplica o evento. Qualquer falha de autenticidade vira 401 sem detalhes:
// quem não é o LiveKit não precisa saber o que errou.
func (w *WebhookReceiver) ServeHTTP(rw http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		rw.Header().Set("Allow", http.MethodPost)
		http.Error(rw, "método não permitido", http.StatusMethodNotAllowed)
		return
	}
	r.Body = http.MaxBytesReader(rw, r.Body, maxWebhookBody)

	// ReceiveWebhookEvent confere o JWT do cabeçalho Authorization (assinatura e expiração) e compara o
	// SHA-256 do corpo com o do JWT, então um corpo adulterado em trânsito é recusado.
	event, err := webhook.ReceiveWebhookEvent(r, w.keys)
	if err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			http.Error(rw, "corpo grande demais", http.StatusRequestEntityTooLarge)
			return
		}
		w.logger.Warn("webhook do LiveKit recusado", "erro", err, "ip", r.RemoteAddr)
		http.Error(rw, "não autorizado", http.StatusUnauthorized)
		return
	}
	w.Apply(event)
	rw.WriteHeader(http.StatusOK)
}

// Apply traduz um evento já autenticado em mudanças de presença. Eventos desconhecidos ou de salas que não
// são de canais são ignorados (o LiveKit manda também egress, ingress, etc.).
func (w *WebhookReceiver) Apply(event *lk.WebhookEvent) {
	channelID, ok := ChannelID(event.GetRoom().GetName())
	if !ok {
		return
	}
	p := event.GetParticipant()

	switch event.GetEvent() {
	case webhook.EventRoomFinished:
		w.tracker.RemoveChannel(channelID)

	case webhook.EventParticipantJoined:
		if IsVisible(p) {
			w.tracker.Join(channelID, p.GetIdentity(), p.GetSid(), displayName(p))
		}

	case webhook.EventParticipantLeft:
		if IsVisible(p) {
			w.tracker.Leave(channelID, p.GetIdentity(), p.GetSid())
		}

	case webhook.EventTrackPublished:
		if IsVisible(p) && event.GetTrack().GetSource() == lk.TrackSource_SCREEN_SHARE {
			// Join antes: os webhooks podem chegar fora de ordem, e Join é idempotente.
			w.tracker.Join(channelID, p.GetIdentity(), p.GetSid(), displayName(p))
			w.tracker.TrackPublished(channelID, p.GetIdentity(), p.GetSid(), event.GetTrack().GetSid())
		}

	case webhook.EventTrackUnpublished:
		if IsVisible(p) && event.GetTrack().GetSource() == lk.TrackSource_SCREEN_SHARE {
			w.tracker.TrackUnpublished(channelID, p.GetIdentity(), p.GetSid(), event.GetTrack().GetSid())
		}
	}
}

// displayName é o nome que o cliente mostra: o username posto no token. Sem ele, a identidade (id do usuário)
// é melhor que um nome vazio.
func displayName(p *lk.ParticipantInfo) string {
	if name := p.GetName(); name != "" {
		return name
	}
	return p.GetIdentity()
}
