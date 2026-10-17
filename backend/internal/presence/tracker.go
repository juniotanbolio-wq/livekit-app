// Package presence mantém em memória quem está em cada canal de voz e quem está transmitindo a tela.
//
// O estado é alimentado por duas fontes que podem se atropelar: os webhooks do LiveKit (tempo real, mas
// podem chegar repetidos, fora de ordem ou nem chegar) e a reconciliação com o RoomService (completa, mas
// sempre um pouco atrasada). Por isso toda operação é idempotente e identifica a conexão pelo `sid` do
// participante: um `participant_left` atrasado de uma conexão antiga não pode apagar a conexão nova do
// mesmo usuário.
package presence

import (
	"slices"
	"strings"
	"sync"
	"time"
)

// EventType é o tipo de uma mudança de presença.
type EventType string

const (
	// EventJoined: o usuário entrou no canal (já com o estado atual de transmissão).
	EventJoined EventType = "participant_joined"
	// EventLeft: o usuário saiu do canal. Implica o fim de qualquer transmissão dele.
	EventLeft EventType = "participant_left"
	// EventStreamStarted: o usuário, já no canal, começou a compartilhar a tela.
	EventStreamStarted EventType = "stream_started"
	// EventStreamStopped: o usuário, ainda no canal, parou de compartilhar a tela.
	EventStreamStopped EventType = "stream_stopped"
)

// Event é uma mudança de presença. Seq cresce de um em um: quem vê um salto perdeu eventos e deve ressincronizar.
type Event struct {
	Seq       uint64
	Type      EventType
	ChannelID string
	UserID    string
	// Username e IsScreenSharing só são preenchidos em EventJoined.
	Username        string
	IsScreenSharing bool
}

// Participant é a visão pública de um participante presente no canal.
type Participant struct {
	UserID          string
	Username        string
	IsScreenSharing bool
}

// Observed é o que o RoomService informa sobre um participante, usado na reconciliação.
type Observed struct {
	ChannelID    string
	UserID       string
	SID          string
	Username     string
	ScreenTracks []string // sids das tracks com source SCREEN_SHARE
}

// tombstoneTTL: por quanto tempo lembramos de conexões que já saíram. Cobre o `track_published`/`participant_joined`
// que chega depois do `participant_left` da mesma conexão e, sem isso, ressuscitaria um participante fantasma.
const tombstoneTTL = 2 * time.Minute

type entry struct {
	sid      string
	username string
	screens  map[string]struct{} // sids das tracks de tela publicadas
	touched  time.Time           // último webhook que mexeu nesta entrada
}

// Tracker é seguro para uso concorrente.
type Tracker struct {
	now func() time.Time

	mu         sync.Mutex // protege tudo abaixo
	seq        uint64
	channels   map[string]map[string]*entry // canal -> usuário -> entrada
	tombstones map[string]time.Time         // sid -> quando saiu
	subs       map[*Subscription]struct{}
}

// New cria um Tracker vazio. now é injetável para testar a reconciliação e as lápides.
func New(now func() time.Time) *Tracker {
	return &Tracker{
		now:        now,
		channels:   make(map[string]map[string]*entry),
		tombstones: make(map[string]time.Time),
		subs:       make(map[*Subscription]struct{}),
	}
}

// Join registra a entrada (ou a reconexão) do usuário no canal. É idempotente por sid.
func (t *Tracker) Join(channelID, userID, sid, username string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.joinLocked(channelID, userID, sid, username, nil, true)
}

// Leave registra a saída. Só vale se o sid for o da conexão atual: assim um evento atrasado de uma conexão
// antiga não derruba a conexão nova do mesmo usuário.
func (t *Tracker) Leave(channelID, userID, sid string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.tombstoneLocked(sid)
	t.leaveLocked(channelID, userID, sid)
}

// TrackPublished registra uma track de tela publicada. Devolve sem efeito se a conexão não for a atual.
func (t *Tracker) TrackPublished(channelID, userID, sid, trackSID string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	e := t.currentLocked(channelID, userID, sid)
	if e == nil || trackSID == "" {
		return
	}
	e.touched = t.now()
	if _, dup := e.screens[trackSID]; dup {
		return
	}
	wasSharing := len(e.screens) > 0
	e.screens[trackSID] = struct{}{}
	if !wasSharing {
		t.emitLocked(Event{Type: EventStreamStarted, ChannelID: channelID, UserID: userID})
	}
}

// TrackUnpublished registra o fim de uma track de tela.
func (t *Tracker) TrackUnpublished(channelID, userID, sid, trackSID string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	e := t.currentLocked(channelID, userID, sid)
	if e == nil {
		return
	}
	e.touched = t.now()
	if _, ok := e.screens[trackSID]; !ok {
		return
	}
	delete(e.screens, trackSID)
	if len(e.screens) == 0 {
		t.emitLocked(Event{Type: EventStreamStopped, ChannelID: channelID, UserID: userID})
	}
}

// RemoveChannel esvazia o canal (sala encerrada no LiveKit).
func (t *Tracker) RemoveChannel(channelID string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	for userID, e := range t.channels[channelID] {
		t.tombstoneLocked(e.sid)
		t.leaveLocked(channelID, userID, e.sid)
	}
}

// Snapshot devolve a sequência atual e os participantes de cada canal (ordenados por nome, para a saída ser estável).
// Canais vazios não aparecem: quem monta a mensagem completa conhece a lista de canais.
func (t *Tracker) Snapshot() (uint64, map[string][]Participant) {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.seq, t.snapshotLocked()
}

// Reconcile alinha o estado ao que o RoomService observou e emite os eventos da diferença, para os clientes
// conectados convergirem. `startedAt` é o instante em que a consulta ao LiveKit começou: o que um webhook
// tocou depois disso é mais novo que a observação e não pode ser desfeito por ela.
// `observed` precisa ser o conjunto COMPLETO de todas as salas; com uma listagem parcial, não chame.
// Devolve quantos eventos a correção gerou (0 = o estado em memória já estava certo).
func (t *Tracker) Reconcile(observed []Observed, startedAt time.Time) int {
	t.mu.Lock()
	defer t.mu.Unlock()
	seqBefore := t.seq

	seen := make(map[string]map[string]struct{})
	for _, o := range observed {
		// Saiu depois de a consulta começar: a observação é antiga demais para ressuscitá-lo.
		if left, ok := t.tombstones[o.SID]; ok && !left.Before(startedAt) {
			continue
		}
		if seen[o.ChannelID] == nil {
			seen[o.ChannelID] = make(map[string]struct{})
		}
		seen[o.ChannelID][o.UserID] = struct{}{}

		if cur := t.channels[o.ChannelID][o.UserID]; cur != nil && cur.touched.After(startedAt) {
			continue // um webhook mais novo que a consulta já cuidou deste participante
		}
		t.joinLocked(o.ChannelID, o.UserID, o.SID, o.Username, o.ScreenTracks, false)
		t.syncScreensLocked(o)
	}

	for channelID, users := range t.channels {
		for userID, e := range users {
			if _, ok := seen[channelID][userID]; ok || e.touched.After(startedAt) {
				continue
			}
			t.tombstoneLocked(e.sid)
			t.leaveLocked(channelID, userID, e.sid)
		}
	}
	return int(t.seq - seqBefore) //nolint:gosec // diferença de contadores; cabe em int
}

// Subscription entrega os eventos a um consumidor. O buffer é limitado: um consumidor lento não pode
// travar o Tracker (que é chamado dentro do tratamento de webhook), então ao encher a inscrição é encerrada
// e o consumidor percebe pelo canal fechado.
type Subscription struct {
	t  *Tracker
	ch chan Event
}

// Events é o canal de eventos. É fechado se o consumidor ficar para trás ou após Close.
func (s *Subscription) Events() <-chan Event { return s.ch }

// Close cancela a inscrição. Pode ser chamado várias vezes.
func (s *Subscription) Close() {
	s.t.mu.Lock()
	defer s.t.mu.Unlock()
	s.t.dropLocked(s)
}

// Subscribe devolve, de forma atômica, o snapshot atual e uma inscrição que recebe exatamente os eventos
// com Seq maior que o do snapshot (sem buraco e sem repetição).
func (t *Tracker) Subscribe(buffer int) (uint64, map[string][]Participant, *Subscription) {
	t.mu.Lock()
	defer t.mu.Unlock()
	sub := &Subscription{t: t, ch: make(chan Event, buffer)}
	t.subs[sub] = struct{}{}
	return t.seq, t.snapshotLocked(), sub
}

// --- internos (exigem t.mu travado) ---

func (t *Tracker) snapshotLocked() map[string][]Participant {
	out := make(map[string][]Participant, len(t.channels))
	for channelID, users := range t.channels {
		if len(users) == 0 {
			continue
		}
		list := make([]Participant, 0, len(users))
		for userID, e := range users {
			list = append(list, Participant{UserID: userID, Username: e.username, IsScreenSharing: len(e.screens) > 0})
		}
		slices.SortFunc(list, func(a, b Participant) int {
			if c := strings.Compare(a.Username, b.Username); c != 0 {
				return c
			}
			return strings.Compare(a.UserID, b.UserID)
		})
		out[channelID] = list
	}
	return out
}

func (t *Tracker) currentLocked(channelID, userID, sid string) *entry {
	e := t.channels[channelID][userID]
	if e == nil || e.sid != sid {
		return nil
	}
	return e
}

// joinLocked cria ou atualiza a entrada. Com webhook=true respeita as lápides e marca a entrada como tocada
// agora (é o que protege contra uma reconciliação mais antiga).
func (t *Tracker) joinLocked(channelID, userID, sid, username string, screens []string, webhook bool) {
	// Na reconciliação a decisão sobre lápides já foi tomada em Reconcile (que compara com o início da consulta).
	if _, gone := t.tombstones[sid]; gone && webhook {
		return // conexão que já saiu; evento chegou atrasado
	}
	users := t.channels[channelID]
	if users == nil {
		users = make(map[string]*entry)
		t.channels[channelID] = users
	}
	cur := users[userID]
	if cur != nil && cur.sid == sid {
		cur.username = username
		if webhook {
			cur.touched = t.now()
		}
		return
	}

	// Reconexão: a conexão nova substitui a antiga sem passar por "saiu" + "entrou", que faria o cliente
	// piscar o usuário. A conexão antiga vai para a lista de lápides para o seu `left` atrasado não valer.
	if cur != nil {
		t.tombstoneLocked(cur.sid)
		if len(cur.screens) > 0 {
			t.emitLocked(Event{Type: EventStreamStopped, ChannelID: channelID, UserID: userID})
		}
	}
	e := &entry{sid: sid, username: username, screens: make(map[string]struct{}), touched: t.now()}
	for _, trackSID := range screens {
		e.screens[trackSID] = struct{}{}
	}
	users[userID] = e
	if cur == nil {
		t.emitLocked(Event{
			Type: EventJoined, ChannelID: channelID, UserID: userID,
			Username: username, IsScreenSharing: len(e.screens) > 0,
		})
	} else if len(e.screens) > 0 {
		t.emitLocked(Event{Type: EventStreamStarted, ChannelID: channelID, UserID: userID})
	}
}

// syncScreensLocked ajusta as tracks de tela de uma entrada que já existe com o mesmo sid.
func (t *Tracker) syncScreensLocked(o Observed) {
	e := t.currentLocked(o.ChannelID, o.UserID, o.SID)
	if e == nil {
		return
	}
	want := make(map[string]struct{}, len(o.ScreenTracks))
	for _, trackSID := range o.ScreenTracks {
		want[trackSID] = struct{}{}
	}
	wasSharing := len(e.screens) > 0
	e.screens = want
	switch isSharing := len(e.screens) > 0; {
	case isSharing && !wasSharing:
		t.emitLocked(Event{Type: EventStreamStarted, ChannelID: o.ChannelID, UserID: o.UserID})
	case !isSharing && wasSharing:
		t.emitLocked(Event{Type: EventStreamStopped, ChannelID: o.ChannelID, UserID: o.UserID})
	}
}

func (t *Tracker) leaveLocked(channelID, userID, sid string) {
	e := t.currentLocked(channelID, userID, sid)
	if e == nil {
		return
	}
	delete(t.channels[channelID], userID)
	if len(t.channels[channelID]) == 0 {
		delete(t.channels, channelID)
	}
	t.emitLocked(Event{Type: EventLeft, ChannelID: channelID, UserID: userID})
}

func (t *Tracker) tombstoneLocked(sid string) {
	if sid == "" {
		return
	}
	now := t.now()
	t.tombstones[sid] = now
	for old, at := range t.tombstones {
		if now.Sub(at) > tombstoneTTL {
			delete(t.tombstones, old)
		}
	}
}

// emitLocked numera o evento e o entrega a todas as inscrições, sem nunca bloquear.
func (t *Tracker) emitLocked(ev Event) {
	t.seq++
	ev.Seq = t.seq
	for sub := range t.subs {
		select {
		case sub.ch <- ev:
		default:
			t.dropLocked(sub) // consumidor lento: encerra a inscrição em vez de travar quem publica
		}
	}
}

func (t *Tracker) dropLocked(sub *Subscription) {
	if _, ok := t.subs[sub]; !ok {
		return
	}
	delete(t.subs, sub)
	close(sub.ch)
}
