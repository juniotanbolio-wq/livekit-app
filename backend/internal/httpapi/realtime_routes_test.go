package httpapi

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"livekit-app/backend/internal/auth"
	"livekit-app/backend/internal/livekit"
	"livekit-app/backend/internal/presence"
	"livekit-app/backend/internal/ratelimit"
	"livekit-app/backend/internal/realtime"
	"livekit-app/backend/internal/service"
	"livekit-app/backend/internal/testutil"
)

// newRoutingHandler monta o roteador com handlers de mentira em /ws e /webhooks/livekit.
func newRoutingHandler(t *testing.T, withRealtime bool) http.Handler {
	t.Helper()
	conn := testutil.OpenDB(t)
	clock := testutil.NewClock()
	deps := Deps{
		Logger:       slog.New(slog.NewTextHandler(io.Discard, nil)),
		Service:      service.New(conn, testutil.FastHasher(t), clock.Now),
		Tokens:       auth.NewTokens(jwtSecret, time.Hour, clock.Now),
		LiveKit:      livekit.NewIssuer(lkKey, lkSecret, "ws://localhost:7880", time.Hour),
		AuthLimiter:  ratelimit.New(100, time.Minute, clock.Now),
		CORSOrigins:  []string{origin},
		MaxBodyBytes: 32 * 1024,
	}
	if withRealtime {
		deps.WebSocket = http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("X-Rota", "ws")
			w.WriteHeader(http.StatusAccepted)
		})
		deps.Webhook = http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("X-Rota", "webhook")
			w.WriteHeader(http.StatusAccepted)
		})
	}
	h, err := NewHandler(deps)
	if err != nil {
		t.Fatalf("NewHandler: %v", err)
	}
	return h
}

func serve(h http.Handler, method, path string, headers map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequestWithContext(context.Background(), method, path, nil)
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestRealtimeRoutesBypassTheContractValidator(t *testing.T) {
	h := newRoutingHandler(t, true)

	if rec := serve(h, http.MethodGet, "/ws", nil); rec.Code != http.StatusAccepted || rec.Header().Get("X-Rota") != "ws" {
		t.Errorf("/ws deveria chegar ao handler do WebSocket: %d %v", rec.Code, rec.Header())
	}
	if rec := serve(h, http.MethodPost, "/webhooks/livekit", nil); rec.Code != http.StatusAccepted || rec.Header().Get("X-Rota") != "webhook" {
		t.Errorf("/webhooks/livekit deveria chegar ao receptor: %d %v", rec.Code, rec.Header())
	}
	// A API continua protegida pelo contrato.
	if rec := serve(h, http.MethodGet, "/api/channels", nil); rec.Code != http.StatusUnauthorized {
		t.Errorf("/api/channels sem token = %d, esperado 401", rec.Code)
	}
	if rec := serve(h, http.MethodGet, "/health", nil); rec.Code != http.StatusOK {
		t.Errorf("/health = %d, esperado 200", rec.Code)
	}
}

func TestWebSocketRouteEnforcesCORSButWebhookDoesNot(t *testing.T) {
	h := newRoutingHandler(t, true)

	if rec := serve(h, http.MethodGet, "/ws", map[string]string{"Origin": "http://evil.example"}); rec.Code != http.StatusForbidden {
		t.Errorf("/ws com origem desconhecida = %d, esperado 403", rec.Code)
	}
	if rec := serve(h, http.MethodGet, "/ws", map[string]string{"Origin": origin}); rec.Code != http.StatusAccepted {
		t.Errorf("/ws com origem permitida = %d, esperado 202", rec.Code)
	}
}

func TestRealtimeRoutesAbsentWhenNotConfigured(t *testing.T) {
	h := newRoutingHandler(t, false)
	for _, path := range []string{"/ws", "/webhooks/livekit"} {
		if rec := serve(h, http.MethodGet, path, nil); rec.Code != http.StatusNotFound {
			t.Errorf("%s sem tempo real configurado = %d, esperado 404", path, rec.Code)
		}
	}
}

// TestWebSocketThroughTheFullMiddlewareChain garante que o upgrade funciona atrás de recoverer, log e CORS
// (o log envolve o ResponseWriter; o Hijack precisa atravessar o wrapper).
func TestWebSocketThroughTheFullMiddlewareChain(t *testing.T) {
	conn := testutil.OpenDB(t)
	svc := service.New(conn, testutil.FastHasher(t), time.Now)
	if _, err := svc.Seed(context.Background(), "admin", "senha-do-admin"); err != nil {
		t.Fatalf("seed: %v", err)
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	tokens := auth.NewTokens(jwtSecret, time.Hour, time.Now)
	hub := realtime.NewHub(realtime.Config{
		AuthTimeout: time.Second, PingInterval: time.Minute, MaxConnsPerUser: 3, MaxConns: 10,
		AllowedOrigins:     []string{origin},
		MentionSenderLimit: 5, MentionRecipientLimit: 5, MentionWindow: time.Minute,
	}, realtime.Deps{Logger: logger, Tracker: presence.New(time.Now), Directory: svc, Tokens: tokens, Now: time.Now})
	t.Cleanup(hub.Close)

	handler, err := NewHandler(Deps{
		Logger: logger, Service: svc, Tokens: tokens,
		LiveKit:     livekit.NewIssuer(lkKey, lkSecret, "ws://localhost:7880", time.Hour),
		AuthLimiter: ratelimit.New(100, time.Minute, time.Now), CORSOrigins: []string{origin},
		MaxBodyBytes: 32 * 1024, WebSocket: hub,
	})
	if err != nil {
		t.Fatalf("NewHandler: %v", err)
	}
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)

	admin, err := svc.Authenticate(context.Background(), "admin", "senha-do-admin")
	if err != nil {
		t.Fatalf("autenticar admin: %v", err)
	}
	token, err := tokens.Issue(admin.ID)
	if err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	dialOpts := &websocket.DialOptions{HTTPHeader: http.Header{"Origin": {origin}}}
	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws"
	ws, _, err := websocket.Dial(ctx, wsURL, dialOpts) //nolint:bodyclose // após o upgrade a biblioteca não expõe corpo para fechar
	if err != nil {
		t.Fatalf("conectar: %v", err)
	}
	t.Cleanup(func() { _ = ws.CloseNow() })
	if err := ws.Write(ctx, websocket.MessageText, []byte(`{"type":"auth","token":"`+token+`"}`)); err != nil {
		t.Fatalf("enviar auth: %v", err)
	}
	_, data, err := ws.Read(ctx)
	if err != nil {
		t.Fatalf("ler snapshot: %v", err)
	}
	if !strings.Contains(string(data), `"type":"snapshot"`) {
		t.Fatalf("esperava snapshot: %s", data)
	}
}
