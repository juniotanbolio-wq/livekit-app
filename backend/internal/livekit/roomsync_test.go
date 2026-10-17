package livekit

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	lk "github.com/livekit/protocol/livekit"

	"livekit-app/backend/internal/presence"
	"livekit-app/backend/internal/testutil"
)

// fakeLister simula o RoomService.
type fakeLister struct {
	mu           sync.Mutex // protege os campos abaixo
	rooms        []*lk.Room
	participants map[string][]*lk.ParticipantInfo
	roomsErr     error
	partsErr     error
	roomCalls    int
}

func (f *fakeLister) ListRooms(context.Context, *lk.ListRoomsRequest) (*lk.ListRoomsResponse, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.roomCalls++
	if f.roomsErr != nil {
		return nil, f.roomsErr
	}
	return &lk.ListRoomsResponse{Rooms: f.rooms}, nil
}

func (f *fakeLister) ListParticipants(_ context.Context, req *lk.ListParticipantsRequest) (*lk.ListParticipantsResponse, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.partsErr != nil {
		return nil, f.partsErr
	}
	return &lk.ListParticipantsResponse{Participants: f.participants[req.GetRoom()]}, nil
}

func (f *fakeLister) calls() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.roomCalls
}

func newReconcilerEnv(t *testing.T, lister *fakeLister) (*Reconciler, *presence.Tracker, *testutil.Clock) {
	t.Helper()
	clock := testutil.NewClock()
	tracker := presence.New(clock.Now)
	return NewReconciler(lister, tracker, discardLogger(), clock.Now), tracker, clock
}

func screenTrack(sid string) *lk.TrackInfo {
	return &lk.TrackInfo{Sid: sid, Source: lk.TrackSource_SCREEN_SHARE}
}

func TestReconcilerOnceBuildsStateFromLiveKit(t *testing.T) {
	lister := &fakeLister{
		rooms: []*lk.Room{{Name: "channel-voice-1"}, {Name: "sala-de-outra-coisa"}},
		participants: map[string][]*lk.ParticipantInfo{
			"channel-voice-1": {
				participant("u1", "PA_1", false),
				{Identity: "u2", Sid: "PA_2", Name: "bia", Tracks: []*lk.TrackInfo{
					{Sid: "TR_mic", Source: lk.TrackSource_MICROPHONE}, screenTrack("TR_scr"),
				}},
				participant("u1#spectator", "PA_s", false), // espectador: fora
				participant("u3", "PA_3", true),            // oculto: fora
			},
			"sala-de-outra-coisa": {participant("x", "PA_x", false)},
		},
	}
	r, tracker, clock := newReconcilerEnv(t, lister)
	clock.Advance(time.Second)

	if err := r.Once(context.Background()); err != nil {
		t.Fatalf("Once: %v", err)
	}
	_, snap := tracker.Snapshot()
	got := snap["voice-1"]
	if len(snap) != 1 || len(got) != 2 {
		t.Fatalf("snapshot incorreto: %+v", snap)
	}
	if got[0].Username != "bia" || !got[0].IsScreenSharing || got[1].Username != "nome-u1" || got[1].IsScreenSharing {
		t.Fatalf("participantes incorretos: %+v", got)
	}
}

func TestReconcilerRemovesGhostsMissedByWebhooks(t *testing.T) {
	lister := &fakeLister{rooms: []*lk.Room{}} // o LiveKit não tem mais nenhuma sala
	r, tracker, clock := newReconcilerEnv(t, lister)
	tracker.Join("voice-1", "ghost", "PA_g", "fantasma") // o webhook de saída se perdeu
	clock.Advance(time.Second)

	_, _, sub := tracker.Subscribe(8)
	defer sub.Close()
	if err := r.Once(context.Background()); err != nil {
		t.Fatalf("Once: %v", err)
	}
	if _, snap := tracker.Snapshot(); len(snap) != 0 {
		t.Fatalf("o fantasma deveria ter sido removido: %+v", snap)
	}
	select {
	case ev := <-sub.Events():
		if ev.Type != presence.EventLeft || ev.UserID != "ghost" {
			t.Fatalf("evento incorreto: %+v", ev)
		}
	default:
		t.Fatal("os clientes conectados deveriam receber participant_left")
	}
}

func TestReconcilerFailureLeavesStateUntouched(t *testing.T) {
	cases := map[string]*fakeLister{
		"ListRooms falha":        {roomsErr: errors.New("livekit fora do ar")},
		"ListParticipants falha": {rooms: []*lk.Room{{Name: "channel-voice-1"}}, partsErr: errors.New("timeout")},
	}
	for name, lister := range cases {
		r, tracker, clock := newReconcilerEnv(t, lister)
		tracker.Join("voice-1", "u1", "PA_1", "ana")
		clock.Advance(time.Second)

		if err := r.Once(context.Background()); err == nil {
			t.Errorf("%s: esperava erro", name)
		}
		if _, snap := tracker.Snapshot(); len(snap["voice-1"]) != 1 {
			t.Errorf("%s: um erro de consulta não pode esvaziar a presença: %+v", name, snap)
		}
	}
}

func TestReconcilerRunRepeatsAndStops(t *testing.T) {
	lister := &fakeLister{roomsErr: errors.New("ainda subindo")}
	r, _, _ := newReconcilerEnv(t, lister)

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		r.Run(ctx, 5*time.Millisecond)
	}()

	deadline := time.After(5 * time.Second)
	for lister.calls() < 3 {
		select {
		case <-deadline:
			t.Fatalf("a reconciliação periódica não repetiu (chamadas: %d)", lister.calls())
		case <-time.After(5 * time.Millisecond):
		}
	}
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Run não terminou após cancelar o contexto")
	}
}
