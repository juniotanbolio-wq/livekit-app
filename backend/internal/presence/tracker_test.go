package presence

import (
	"fmt"
	"slices"
	"sync"
	"testing"
	"time"

	"livekit-app/backend/internal/testutil"
)

// drain lê o que já está no buffer da inscrição (o Tracker entrega de forma síncrona), sem depender de temporização.
func drain(sub *Subscription) []Event {
	var out []Event
	for {
		select {
		case ev, ok := <-sub.Events():
			if !ok {
				return out
			}
			out = append(out, ev)
		default:
			return out
		}
	}
}

func types(events []Event) []EventType {
	out := make([]EventType, 0, len(events))
	for _, ev := range events {
		out = append(out, ev.Type)
	}
	return out
}

func newTracker(t *testing.T) (*Tracker, *testutil.Clock, *Subscription) {
	t.Helper()
	clock := testutil.NewClock()
	tr := New(clock.Now)
	_, _, sub := tr.Subscribe(64)
	t.Cleanup(sub.Close)
	return tr, clock, sub
}

func equalTypes(got, want []EventType) bool { return slices.Equal(got, want) }

func TestJoinLeaveEmitsSequentialEvents(t *testing.T) {
	tr, _, sub := newTracker(t)

	tr.Join("voice-1", "u1", "PA_1", "ana")
	tr.Join("voice-1", "u1", "PA_1", "ana") // webhook repetido: sem novo evento
	tr.Join("voice-1", "u2", "PA_2", "bia")
	tr.Leave("voice-1", "u1", "PA_1")
	tr.Leave("voice-1", "u1", "PA_1") // repetido

	events := drain(sub)
	if !equalTypes(types(events), []EventType{EventJoined, EventJoined, EventLeft}) {
		t.Fatalf("eventos inesperados: %+v", events)
	}
	for i, ev := range events {
		if ev.Seq != uint64(i+1) {
			t.Fatalf("seq do evento %d = %d, esperado %d", i, ev.Seq, i+1)
		}
	}
	if events[0].Username != "ana" || events[0].ChannelID != "voice-1" || events[2].UserID != "u1" {
		t.Fatalf("conteúdo incorreto: %+v", events)
	}
}

func TestStreamStartStopOnlyOnTransitions(t *testing.T) {
	tr, _, sub := newTracker(t)
	tr.Join("voice-1", "u1", "PA_1", "ana")
	tr.TrackPublished("voice-1", "u1", "PA_1", "TR_a")
	tr.TrackPublished("voice-1", "u1", "PA_1", "TR_a") // repetido
	tr.TrackPublished("voice-1", "u1", "PA_1", "TR_b") // segunda track de tela: ainda transmitindo
	tr.TrackUnpublished("voice-1", "u1", "PA_1", "TR_a")
	tr.TrackUnpublished("voice-1", "u1", "PA_1", "TR_b")
	tr.TrackUnpublished("voice-1", "u1", "PA_1", "TR_b") // repetido

	want := []EventType{EventJoined, EventStreamStarted, EventStreamStopped}
	if got := types(drain(sub)); !equalTypes(got, want) {
		t.Fatalf("eventos = %v, esperado %v", got, want)
	}
}

func TestTrackEventsFromStaleConnectionAreIgnored(t *testing.T) {
	tr, _, sub := newTracker(t)
	tr.Join("voice-1", "u1", "PA_new", "ana")
	tr.TrackPublished("voice-1", "u1", "PA_old", "TR_x")
	tr.Leave("voice-1", "u1", "PA_old") // `left` atrasado da conexão antiga

	if got, want := types(drain(sub)), []EventType{EventJoined}; !equalTypes(got, want) {
		t.Fatalf("eventos = %v, esperado %v", got, want)
	}
	_, snap := tr.Snapshot()
	if len(snap["voice-1"]) != 1 {
		t.Fatalf("a conexão nova deveria continuar presente: %+v", snap)
	}
}

func TestReconnectReplacesConnectionWithoutFlicker(t *testing.T) {
	tr, _, sub := newTracker(t)
	tr.Join("voice-1", "u1", "PA_1", "ana")
	tr.TrackPublished("voice-1", "u1", "PA_1", "TR_1")
	tr.Join("voice-1", "u1", "PA_2", "ana") // reconexão com sid novo
	tr.Leave("voice-1", "u1", "PA_1")       // e o left da antiga chega depois

	// Sem EventLeft: o usuário nunca deixou o canal. A transmissão da conexão antiga acabou.
	want := []EventType{EventJoined, EventStreamStarted, EventStreamStopped}
	if got := types(drain(sub)); !equalTypes(got, want) {
		t.Fatalf("eventos = %v, esperado %v", got, want)
	}
}

func TestLateJoinAfterLeaveDoesNotResurrect(t *testing.T) {
	tr, _, sub := newTracker(t)
	tr.Leave("voice-1", "u1", "PA_1") // left chegou antes do joined
	tr.Join("voice-1", "u1", "PA_1", "ana")

	if events := drain(sub); len(events) != 0 {
		t.Fatalf("não deveria haver eventos: %+v", events)
	}
	if _, snap := tr.Snapshot(); len(snap) != 0 {
		t.Fatalf("snapshot deveria estar vazio: %+v", snap)
	}
}

func TestTombstoneExpires(t *testing.T) {
	tr, clock, sub := newTracker(t)
	tr.Leave("voice-1", "u1", "PA_1")
	clock.Advance(tombstoneTTL + time.Second)
	tr.Leave("voice-1", "u9", "PA_9") // qualquer saída limpa as lápides vencidas
	tr.Join("voice-1", "u1", "PA_1", "ana")

	if got, want := types(drain(sub)), []EventType{EventJoined}; !equalTypes(got, want) {
		t.Fatalf("eventos = %v, esperado %v", got, want)
	}
}

func TestRemoveChannelEmitsLeftForEveryone(t *testing.T) {
	tr, _, sub := newTracker(t)
	tr.Join("voice-1", "u1", "PA_1", "ana")
	tr.Join("voice-1", "u2", "PA_2", "bia")
	tr.Join("voice-2", "u3", "PA_3", "caio")
	drain(sub)

	tr.RemoveChannel("voice-1")

	events := drain(sub)
	if len(events) != 2 || events[0].Type != EventLeft || events[1].Type != EventLeft {
		t.Fatalf("eventos inesperados: %+v", events)
	}
	_, snap := tr.Snapshot()
	if len(snap["voice-1"]) != 0 || len(snap["voice-2"]) != 1 {
		t.Fatalf("snapshot incorreto: %+v", snap)
	}
}

func TestSnapshotIsSortedAndReportsScreenSharing(t *testing.T) {
	tr, _, _ := newTracker(t)
	tr.Join("voice-1", "u2", "PA_2", "bia")
	tr.Join("voice-1", "u1", "PA_1", "ana")
	tr.TrackPublished("voice-1", "u2", "PA_2", "TR_1")

	seq, snap := tr.Snapshot()
	if seq != 3 {
		t.Fatalf("seq = %d, esperado 3", seq)
	}
	got := snap["voice-1"]
	if len(got) != 2 || got[0].Username != "ana" || got[1].Username != "bia" || got[0].IsScreenSharing || !got[1].IsScreenSharing {
		t.Fatalf("snapshot incorreto: %+v", got)
	}
}

func TestSubscribeIsAtomicWithSnapshot(t *testing.T) {
	tr := New(testutil.NewClock().Now)
	tr.Join("voice-1", "u1", "PA_1", "ana")

	seq, snap, sub := tr.Subscribe(8)
	defer sub.Close()
	if seq != 1 || len(snap["voice-1"]) != 1 {
		t.Fatalf("snapshot incorreto: seq=%d %+v", seq, snap)
	}
	tr.Join("voice-1", "u2", "PA_2", "bia")
	events := drain(sub)
	if len(events) != 1 || events[0].Seq != seq+1 {
		t.Fatalf("o primeiro evento deveria ser seq %d: %+v", seq+1, events)
	}
}

func TestSlowSubscriberIsDroppedWithoutBlocking(t *testing.T) {
	tr := New(testutil.NewClock().Now)
	_, _, slow := tr.Subscribe(1)
	_, _, fast := tr.Subscribe(16)
	defer fast.Close()

	tr.Join("voice-1", "u1", "PA_1", "ana")
	tr.Join("voice-1", "u2", "PA_2", "bia") // estoura o buffer da inscrição lenta

	if events := drain(slow); len(events) != 1 {
		t.Fatalf("a inscrição lenta deveria ter recebido só o que coube: %+v", events)
	}
	if _, open := <-slow.Events(); open {
		t.Fatal("a inscrição lenta deveria estar fechada")
	}
	if events := drain(fast); len(events) != 2 {
		t.Fatalf("a inscrição rápida não pode ser afetada: %+v", events)
	}
	slow.Close() // fechar de novo não pode entrar em pânico
}

func TestReconcileAddsRemovesAndSyncsStreams(t *testing.T) {
	tr, clock, sub := newTracker(t)
	tr.Join("voice-1", "gone", "PA_g", "sumiu")
	tr.Join("voice-1", "stays", "PA_s", "fica")
	tr.Join("voice-1", "sharer", "PA_x", "tela")
	tr.TrackPublished("voice-1", "sharer", "PA_x", "TR_old")
	drain(sub)

	clock.Advance(time.Minute)
	started := clock.Now()
	clock.Advance(time.Second)
	tr.Reconcile([]Observed{
		{ChannelID: "voice-1", UserID: "stays", SID: "PA_s", Username: "fica"},
		{ChannelID: "voice-1", UserID: "sharer", SID: "PA_x", Username: "tela"}, // parou de transmitir
		{ChannelID: "voice-2", UserID: "new", SID: "PA_n", Username: "novo", ScreenTracks: []string{"TR_n"}},
	}, started)

	got := map[EventType][]string{}
	for _, ev := range drain(sub) {
		got[ev.Type] = append(got[ev.Type], ev.UserID)
	}
	if len(got[EventLeft]) != 1 || got[EventLeft][0] != "gone" ||
		len(got[EventStreamStopped]) != 1 || got[EventStreamStopped][0] != "sharer" ||
		len(got[EventJoined]) != 1 || got[EventJoined][0] != "new" || len(got[EventStreamStarted]) != 0 {
		t.Fatalf("diff incorreto: %+v", got)
	}
	_, snap := tr.Snapshot()
	if len(snap["voice-1"]) != 2 || len(snap["voice-2"]) != 1 || !snap["voice-2"][0].IsScreenSharing {
		t.Fatalf("snapshot incorreto: %+v", snap)
	}
}

func TestReconcileIsIdempotent(t *testing.T) {
	tr, clock, sub := newTracker(t)
	observed := []Observed{{ChannelID: "voice-1", UserID: "u1", SID: "PA_1", Username: "ana", ScreenTracks: []string{"TR_1"}}}

	started := clock.Now()
	clock.Advance(time.Second)
	first := tr.Reconcile(observed, started)
	n := len(drain(sub))

	started = clock.Now()
	clock.Advance(time.Second)
	second := tr.Reconcile(observed, started)
	if events := drain(sub); len(events) != 0 || n != 1 || first != 1 || second != 0 {
		t.Fatalf("a segunda reconciliação não deveria gerar eventos (primeira=%d/%d, segunda=%d): %+v", n, first, second, events)
	}
}

func TestReconcileKeepsWhatWebhooksChangedAfterTheQuery(t *testing.T) {
	tr, clock, sub := newTracker(t)
	started := clock.Now() // a consulta ao LiveKit começa aqui...
	clock.Advance(time.Second)
	tr.Join("voice-1", "late", "PA_l", "tarde") // ...e um webhook chega durante ela
	drain(sub)

	tr.Reconcile(nil, started) // a observação (vazia) é mais velha que o webhook

	if events := drain(sub); len(events) != 0 {
		t.Fatalf("não deveria remover quem entrou depois da consulta: %+v", events)
	}
	if _, snap := tr.Snapshot(); len(snap["voice-1"]) != 1 {
		t.Fatalf("participante deveria continuar: %+v", snap)
	}
}

func TestReconcileDoesNotResurrectWhoLeftDuringTheQuery(t *testing.T) {
	tr, clock, sub := newTracker(t)
	tr.Join("voice-1", "u1", "PA_1", "ana")
	drain(sub)

	started := clock.Now()
	clock.Advance(time.Second)
	tr.Leave("voice-1", "u1", "PA_1") // saiu enquanto a consulta rodava
	drain(sub)

	tr.Reconcile([]Observed{{ChannelID: "voice-1", UserID: "u1", SID: "PA_1", Username: "ana"}}, started)

	if events := drain(sub); len(events) != 0 {
		t.Fatalf("não deveria ressuscitar quem saiu: %+v", events)
	}
}

func TestConcurrentUseIsRaceFree(t *testing.T) {
	tr := New(time.Now)
	var wg sync.WaitGroup
	for i := range 8 {
		wg.Go(func() {
			user := fmt.Sprintf("u%d", i)
			sid := "PA_" + user
			_, _, sub := tr.Subscribe(4)
			defer sub.Close()
			for range 50 {
				tr.Join("voice-1", user, sid, user)
				tr.TrackPublished("voice-1", user, sid, "TR_"+user)
				tr.Snapshot()
				tr.TrackUnpublished("voice-1", user, sid, "TR_"+user)
				tr.Reconcile(nil, time.Now().Add(-time.Hour))
			}
		})
	}
	wg.Wait()
}
