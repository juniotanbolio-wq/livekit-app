package livekit

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	lkauth "github.com/livekit/protocol/auth"
	lk "github.com/livekit/protocol/livekit"
	"google.golang.org/protobuf/encoding/protojson"

	"livekit-app/backend/internal/presence"
	"livekit-app/backend/internal/testutil"
)

func discardLogger() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

type webhookEnv struct {
	t        *testing.T
	tracker  *presence.Tracker
	receiver *WebhookReceiver
}

func newWebhookEnv(t *testing.T) *webhookEnv {
	t.Helper()
	tracker := presence.New(testutil.NewClock().Now)
	return &webhookEnv{t: t, tracker: tracker, receiver: NewWebhookReceiver(testKey, testSecret, tracker, discardLogger())}
}

// signedRequest monta a requisição como o LiveKit: JWT no Authorization com o SHA-256 do corpo.
func signedRequest(t *testing.T, key, secret string, body []byte) *http.Request {
	t.Helper()
	sum := sha256.Sum256(body)
	jwt, err := lkauth.NewAccessToken(key, secret).
		SetValidFor(5 * time.Minute).
		SetSha256(base64.StdEncoding.EncodeToString(sum[:])).
		ToJWT()
	if err != nil {
		t.Fatalf("assinar webhook de teste: %v", err)
	}
	req := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/webhooks/livekit", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/webhook+json")
	req.Header.Set("Authorization", jwt)
	return req
}

func eventBody(t *testing.T, ev *lk.WebhookEvent) []byte {
	t.Helper()
	body, err := protojson.Marshal(ev)
	if err != nil {
		t.Fatalf("serializar evento: %v", err)
	}
	return body
}

// send entrega o evento assinado corretamente e devolve o status.
func (e *webhookEnv) send(ev *lk.WebhookEvent) int {
	e.t.Helper()
	rec := httptest.NewRecorder()
	e.receiver.ServeHTTP(rec, signedRequest(e.t, testKey, testSecret, eventBody(e.t, ev)))
	return rec.Code
}

func participant(identity, sid string, hidden bool) *lk.ParticipantInfo {
	return &lk.ParticipantInfo{
		Identity: identity, Sid: sid, Name: "nome-" + identity,
		Permission: &lk.ParticipantPermission{Hidden: hidden},
	}
}

func (e *webhookEnv) present(channelID string) []presence.Participant {
	_, snap := e.tracker.Snapshot()
	return snap[channelID]
}

func TestWebhookParticipantLifecycle(t *testing.T) {
	e := newWebhookEnv(t)
	room := &lk.Room{Name: "channel-voice-1"}

	if code := e.send(&lk.WebhookEvent{Event: "participant_joined", Room: room, Participant: participant("u1", "PA_1", false)}); code != http.StatusOK {
		t.Fatalf("status = %d", code)
	}
	got := e.present("voice-1")
	if len(got) != 1 || got[0].UserID != "u1" || got[0].Username != "nome-u1" || got[0].IsScreenSharing {
		t.Fatalf("presença incorreta após join: %+v", got)
	}

	e.send(&lk.WebhookEvent{Event: "participant_left", Room: room, Participant: participant("u1", "PA_1", false)})
	if got := e.present("voice-1"); len(got) != 0 {
		t.Fatalf("deveria estar vazio após left: %+v", got)
	}
}

func TestWebhookIgnoresHiddenAndSpectatorParticipants(t *testing.T) {
	e := newWebhookEnv(t)
	room := &lk.Room{Name: "channel-voice-1"}

	e.send(&lk.WebhookEvent{Event: "participant_joined", Room: room, Participant: participant("u1#spectator", "PA_s", false)})
	e.send(&lk.WebhookEvent{Event: "participant_joined", Room: room, Participant: participant("u2", "PA_h", true)})
	e.send(&lk.WebhookEvent{
		Event: "track_published", Room: room, Participant: participant("u1#spectator", "PA_s", false),
		Track: &lk.TrackInfo{Sid: "TR_1", Source: lk.TrackSource_SCREEN_SHARE},
	})

	if seq, _ := e.tracker.Snapshot(); seq != 0 {
		t.Fatalf("nenhum evento de presença deveria ter sido gerado (seq=%d)", seq)
	}
}

func TestWebhookScreenShareDetectedBySource(t *testing.T) {
	e := newWebhookEnv(t)
	room := &lk.Room{Name: "channel-voice-2"}
	p := participant("u1", "PA_1", false)
	e.send(&lk.WebhookEvent{Event: "participant_joined", Room: room, Participant: p})

	// Câmera e microfone não contam como transmissão.
	e.send(&lk.WebhookEvent{Event: "track_published", Room: room, Participant: p, Track: &lk.TrackInfo{Sid: "TR_cam", Source: lk.TrackSource_CAMERA}})
	e.send(&lk.WebhookEvent{Event: "track_published", Room: room, Participant: p, Track: &lk.TrackInfo{Sid: "TR_mic", Source: lk.TrackSource_MICROPHONE}})
	if got := e.present("voice-2"); got[0].IsScreenSharing {
		t.Fatalf("câmera/microfone não deveriam marcar transmissão: %+v", got)
	}

	e.send(&lk.WebhookEvent{Event: "track_published", Room: room, Participant: p, Track: &lk.TrackInfo{Sid: "TR_scr", Source: lk.TrackSource_SCREEN_SHARE}})
	if got := e.present("voice-2"); !got[0].IsScreenSharing {
		t.Fatalf("deveria estar transmitindo: %+v", got)
	}

	// Despublicar a câmera não derruba a transmissão; despublicar a tela, sim.
	e.send(&lk.WebhookEvent{Event: "track_unpublished", Room: room, Participant: p, Track: &lk.TrackInfo{Sid: "TR_cam", Source: lk.TrackSource_CAMERA}})
	if got := e.present("voice-2"); !got[0].IsScreenSharing {
		t.Fatalf("a câmera não pode encerrar a transmissão: %+v", got)
	}
	e.send(&lk.WebhookEvent{Event: "track_unpublished", Room: room, Participant: p, Track: &lk.TrackInfo{Sid: "TR_scr", Source: lk.TrackSource_SCREEN_SHARE}})
	if got := e.present("voice-2"); got[0].IsScreenSharing {
		t.Fatalf("a transmissão deveria ter acabado: %+v", got)
	}
}

func TestWebhookTrackBeforeJoinStillRegistersParticipant(t *testing.T) {
	e := newWebhookEnv(t)
	e.send(&lk.WebhookEvent{
		Event: "track_published", Room: &lk.Room{Name: "channel-voice-1"}, Participant: participant("u1", "PA_1", false),
		Track: &lk.TrackInfo{Sid: "TR_scr", Source: lk.TrackSource_SCREEN_SHARE},
	})
	if got := e.present("voice-1"); len(got) != 1 || !got[0].IsScreenSharing {
		t.Fatalf("presença incorreta: %+v", got)
	}
}

func TestWebhookRoomFinishedClearsChannel(t *testing.T) {
	e := newWebhookEnv(t)
	room := &lk.Room{Name: "channel-voice-1"}
	e.send(&lk.WebhookEvent{Event: "participant_joined", Room: room, Participant: participant("u1", "PA_1", false)})
	e.send(&lk.WebhookEvent{Event: "room_finished", Room: room})
	if got := e.present("voice-1"); len(got) != 0 {
		t.Fatalf("canal deveria estar vazio: %+v", got)
	}
}

func TestWebhookIgnoresForeignRoomsAndOtherEvents(t *testing.T) {
	e := newWebhookEnv(t)
	e.send(&lk.WebhookEvent{Event: "participant_joined", Room: &lk.Room{Name: "sala-qualquer"}, Participant: participant("u1", "PA_1", false)})
	e.send(&lk.WebhookEvent{Event: "egress_started", Room: &lk.Room{Name: "channel-voice-1"}})
	if seq, _ := e.tracker.Snapshot(); seq != 0 {
		t.Fatalf("nada deveria ter mudado (seq=%d)", seq)
	}
}

func TestWebhookRejectsBadSignatures(t *testing.T) {
	e := newWebhookEnv(t)
	body := eventBody(t, &lk.WebhookEvent{
		Event: "participant_joined", Room: &lk.Room{Name: "channel-voice-1"}, Participant: participant("u1", "PA_1", false),
	})

	tampered := signedRequest(t, testKey, testSecret, body)
	tampered.Body = io.NopCloser(bytes.NewReader(append(bytes.Clone(body), ' ')))

	noAuth := signedRequest(t, testKey, testSecret, body)
	noAuth.Header.Del("Authorization")

	cases := map[string]*http.Request{
		"segredo errado":        signedRequest(t, testKey, strings.Repeat("x", 32), body),
		"chave desconhecida":    signedRequest(t, "outrakey", testSecret, body),
		"sem Authorization":     noAuth,
		"corpo adulterado":      tampered,
		"Authorization de lixo": withAuth(signedRequest(t, testKey, testSecret, body), "isto-nao-e-um-jwt"),
	}
	for name, req := range cases {
		rec := httptest.NewRecorder()
		e.receiver.ServeHTTP(rec, req)
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("%s: status = %d, esperado 401", name, rec.Code)
		}
	}
	if seq, _ := e.tracker.Snapshot(); seq != 0 {
		t.Fatalf("webhook recusado não pode alterar a presença (seq=%d)", seq)
	}
}

func withAuth(req *http.Request, value string) *http.Request {
	req.Header.Set("Authorization", value)
	return req
}

func TestWebhookRejectsWrongMethodAndHugeBody(t *testing.T) {
	e := newWebhookEnv(t)

	rec := httptest.NewRecorder()
	e.receiver.ServeHTTP(rec, httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/webhooks/livekit", nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("GET: status = %d, esperado 405", rec.Code)
	}

	rec = httptest.NewRecorder()
	e.receiver.ServeHTTP(rec, signedRequest(t, testKey, testSecret, bytes.Repeat([]byte("a"), maxWebhookBody+1)))
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("corpo grande: status = %d, esperado 413", rec.Code)
	}
}

func TestChannelID(t *testing.T) {
	cases := map[string]struct {
		id string
		ok bool
	}{
		"channel-voice-1": {"voice-1", true},
		"channel-":        {"", false},
		"voice-1":         {"", false},
		"":                {"", false},
	}
	for room, want := range cases {
		if id, ok := ChannelID(room); id != want.id || ok != want.ok {
			t.Errorf("ChannelID(%q) = %q, %v; esperado %q, %v", room, id, ok, want.id, want.ok)
		}
	}
}
