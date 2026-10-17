package livekit

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	lk "github.com/livekit/protocol/livekit"

	"livekit-app/backend/internal/presence"
)

// RoomLister é o pedaço do RoomService de que a reconciliação precisa (*lksdk.RoomServiceClient o satisfaz).
type RoomLister interface {
	ListRooms(ctx context.Context, req *lk.ListRoomsRequest) (*lk.ListRoomsResponse, error)
	ListParticipants(ctx context.Context, req *lk.ListParticipantsRequest) (*lk.ListParticipantsResponse, error)
}

// reconcileTimeout limita uma rodada inteira (todas as chamadas ao LiveKit). Sem ele, um LiveKit travado
// seguraria a goroutine para sempre.
const reconcileTimeout = 15 * time.Second

// Reconciler confere o estado em memória com o que o LiveKit realmente tem. Os webhooks são entregues
// "no máximo uma vez" na prática (o backend pode estar fora do ar, a rede pode falhar), então sem esta
// conferência uma saída perdida deixaria uma pessoa fantasma na lista para sempre.
type Reconciler struct {
	lister  RoomLister
	tracker *presence.Tracker
	logger  *slog.Logger
	now     func() time.Time
}

// NewReconciler cria o reconciliador. now precisa ser o mesmo relógio do Tracker.
func NewReconciler(lister RoomLister, tracker *presence.Tracker, logger *slog.Logger, now func() time.Time) *Reconciler {
	return &Reconciler{lister: lister, tracker: tracker, logger: logger, now: now}
}

// Once faz uma rodada. Se QUALQUER consulta falhar, nada é aplicado: um resultado parcial pareceria
// "essas pessoas saíram" e esvaziaria canais que só não conseguimos consultar.
func (r *Reconciler) Once(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, reconcileTimeout)
	defer cancel()

	// Marca o início ANTES de consultar: o Tracker usa esse instante para não desfazer o que um webhook
	// mais novo que a consulta já mudou.
	startedAt := r.now()

	rooms, err := r.lister.ListRooms(ctx, &lk.ListRoomsRequest{})
	if err != nil {
		return fmt.Errorf("listar salas: %w", err)
	}

	var observed []presence.Observed
	for _, room := range rooms.GetRooms() {
		channelID, ok := ChannelID(room.GetName())
		if !ok {
			continue
		}
		res, err := r.lister.ListParticipants(ctx, &lk.ListParticipantsRequest{Room: room.GetName()})
		if err != nil {
			return fmt.Errorf("listar participantes de %s: %w", room.GetName(), err)
		}
		for _, p := range res.GetParticipants() {
			if !IsVisible(p) {
				continue
			}
			o := presence.Observed{ChannelID: channelID, UserID: p.GetIdentity(), SID: p.GetSid(), Username: displayName(p)}
			for _, track := range p.GetTracks() {
				if track.GetSource() == lk.TrackSource_SCREEN_SHARE {
					o.ScreenTracks = append(o.ScreenTracks, track.GetSid())
				}
			}
			observed = append(observed, o)
		}
	}
	if changes := r.tracker.Reconcile(observed, startedAt); changes > 0 {
		// Info (e não Debug): significa que um webhook se perdeu ou chegou fora de ordem. É o sinal de que
		// a reconciliação está fazendo o seu trabalho, e o aceite procura por esta linha.
		r.logger.Info("reconciliacao corrigiu a presenca", "mudancas", changes)
	}
	return nil
}

// Run reconcilia agora e depois a cada interval, até ctx ser cancelado. Bloqueia: chame numa goroutine e
// espere o retorno no encerramento. Falhas só são registradas: o LiveKit pode estar subindo junto com o
// backend, e a próxima rodada tenta de novo.
func (r *Reconciler) Run(ctx context.Context, interval time.Duration) {
	r.attempt(ctx)
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			r.attempt(ctx)
		}
	}
}

func (r *Reconciler) attempt(ctx context.Context) {
	if err := r.Once(ctx); err != nil && ctx.Err() == nil {
		r.logger.Warn("reconciliação com o LiveKit falhou", "erro", err)
	}
}
