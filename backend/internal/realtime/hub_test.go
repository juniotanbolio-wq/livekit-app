package realtime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"livekit-app/backend/internal/auth"
	"livekit-app/backend/internal/presence"
	"livekit-app/backend/internal/service"
	"livekit-app/backend/internal/testutil"
)

const (
	jwtSecret = "0123456789abcdef0123456789abcdef"
	waitFor   = 3 * time.Second
)

type testEnv struct {
	t       *testing.T
	hub     *Hub
	tracker *presence.Tracker
	svc     *service.Service
	tokens  *auth.Tokens
	srv     *httptest.Server
}

// newEnv sobe o hub atrás de um servidor HTTP real, com banco SQLite real e canais semeados.
func newEnv(t *testing.T, mods ...func(*Config)) *testEnv {
	t.Helper()
	conn := testutil.OpenDB(t)
	svc := service.New(conn, testutil.FastHasher(t), time.Now)
	if _, err := svc.Seed(context.Background(), "admin", "senha-do-admin"); err != nil {
		t.Fatalf("seed: %v", err)
	}
	tracker := presence.New(time.Now)
	tokens := auth.NewTokens(jwtSecret, time.Hour, time.Now)

	cfg := Config{
		AuthTimeout: time.Second, PingInterval: time.Minute, MaxConnsPerUser: 3, MaxConns: 50,
		AllowedOrigins:     []string{"app://desktop"},
		MentionSenderLimit: 100, MentionRecipientLimit: 100, MentionWindow: time.Minute,
	}
	for _, mod := range mods {
		mod(&cfg)
	}
	hub := NewHub(cfg, Deps{
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)), Tracker: tracker,
		Directory: svc, Tokens: tokens, Now: time.Now,
	})
	srv := httptest.NewServer(hub)
	t.Cleanup(func() {
		srv.Close()
		hub.Close() // também prova que o encerramento não trava com conexões abertas
	})
	return &testEnv{t: t, hub: hub, tracker: tracker, svc: svc, tokens: tokens, srv: srv}
}

// user cadastra um usuário de verdade e devolve seu id e um JWT de sessão.
func (e *testEnv) user(name string) (id, token string) {
	e.t.Helper()
	ctx := context.Background()
	code, _, err := e.svc.CreateInvite(ctx, time.Hour)
	if err != nil {
		e.t.Fatalf("criar convite: %v", err)
	}
	u, err := e.svc.Register(ctx, code, name, "senha-de-teste")
	if err != nil {
		e.t.Fatalf("cadastrar %s: %v", name, err)
	}
	token, err = e.tokens.Issue(u.ID)
	if err != nil {
		e.t.Fatalf("emitir token: %v", err)
	}
	return u.ID, token
}

func (e *testEnv) wsURL() string { return "ws" + strings.TrimPrefix(e.srv.URL, "http") + "/ws" }

func (e *testEnv) dial() *websocket.Conn {
	e.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), waitFor)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, e.wsURL(), nil) //nolint:bodyclose // após o upgrade a biblioteca não expõe corpo para fechar
	if err != nil {
		e.t.Fatalf("conectar: %v", err)
	}
	return conn
}

type msg map[string]any

func (m msg) str(key string) string { s, _ := m[key].(string); return s }
func (m msg) num(key string) int    { f, _ := m[key].(float64); return int(f) }

// wsClient lê o socket numa goroutine própria. Isso importa: com a biblioteca, um Read cujo contexto expira
// fecha a conexão, então "esperar com timeout" só é seguro lendo de um canal.
type wsClient struct {
	t    *testing.T
	conn *websocket.Conn
	msgs chan msg
	done chan struct{}
	err  error // válido depois de done fechado
}

func newWSClient(t *testing.T, conn *websocket.Conn) *wsClient {
	c := &wsClient{t: t, conn: conn, msgs: make(chan msg, 64), done: make(chan struct{})}
	go func() {
		defer close(c.done)
		for {
			_, data, err := conn.Read(context.Background())
			if err != nil {
				c.err = err
				return
			}
			var m msg
			if err := json.Unmarshal(data, &m); err != nil {
				c.err = err
				return
			}
			c.msgs <- m
		}
	}()
	t.Cleanup(func() { _ = conn.CloseNow() })
	return c
}

func (c *wsClient) send(v any) {
	c.t.Helper()
	data, err := json.Marshal(v)
	if err != nil {
		c.t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), waitFor)
	defer cancel()
	if err := c.conn.Write(ctx, websocket.MessageText, data); err != nil {
		c.t.Fatalf("enviar: %v", err)
	}
}

func (c *wsClient) next() msg {
	c.t.Helper()
	select {
	case m := <-c.msgs:
		return m
	case <-c.done:
		c.t.Fatalf("conexão fechada ao esperar mensagem: %v", c.err)
	case <-time.After(waitFor):
		c.t.Fatal("tempo esgotado esperando mensagem")
	}
	return nil
}

func (c *wsClient) expectNone(d time.Duration) {
	c.t.Helper()
	select {
	case m := <-c.msgs:
		c.t.Fatalf("mensagem inesperada: %v", m)
	case <-c.done:
		c.t.Fatalf("conexão fechada inesperadamente: %v", c.err)
	case <-time.After(d):
	}
}

func (c *wsClient) waitClosed() error {
	c.t.Helper()
	select {
	case <-c.done:
		return c.err
	case <-time.After(waitFor):
		c.t.Fatal("a conexão deveria ter sido encerrada")
		return nil
	}
}

// connect autentica e consome o snapshot inicial.
func (e *testEnv) connect(token string) (*wsClient, msg) {
	e.t.Helper()
	c := newWSClient(e.t, e.dial())
	c.send(msg{"type": "auth", "token": token})
	snap := c.next()
	if snap.str("type") != "snapshot" {
		e.t.Fatalf("esperava snapshot, veio %v", snap)
	}
	return c, snap
}

func TestAuthAndInitialSnapshot(t *testing.T) {
	e := newEnv(t)
	userID, token := e.user("ana")
	e.tracker.Join("voice-2", "outro", "PA_1", "bia")

	_, snap := e.connect(token)

	channels, _ := snap["channels"].([]any)
	if len(channels) != 7 {
		t.Fatalf("snapshot deveria listar os 7 canais: %v", snap)
	}
	first, _ := channels[0].(map[string]any)
	second, _ := channels[1].(map[string]any)
	if first["channelId"] != "voice-1" || len(first["participants"].([]any)) != 0 {
		t.Fatalf("canal vazio deve vir com lista vazia (não null): %v", first)
	}
	if second["channelId"] != "voice-2" || len(second["participants"].([]any)) != 1 {
		t.Fatalf("participante ausente do snapshot: %v", second)
	}
	if snap.num("seq") != 1 {
		t.Fatalf("seq do snapshot = %d, esperado 1", snap.num("seq"))
	}
	if !e.hub.Connected(userID) {
		t.Fatal("usuário deveria constar como conectado")
	}
}

func TestIncrementalEventsFollowSnapshotWithConsecutiveSeq(t *testing.T) {
	e := newEnv(t)
	_, token := e.user("ana")
	c, snap := e.connect(token)
	base := snap.num("seq")

	e.tracker.Join("voice-1", "u9", "PA_9", "caio")
	e.tracker.TrackPublished("voice-1", "u9", "PA_9", "TR_1")
	e.tracker.TrackUnpublished("voice-1", "u9", "PA_9", "TR_1")
	e.tracker.Leave("voice-1", "u9", "PA_9")

	want := []string{"participant_joined", "stream_started", "stream_stopped", "participant_left"}
	for i, typ := range want {
		m := c.next()
		if m.str("type") != typ || m.num("seq") != base+i+1 || m.str("channelId") != "voice-1" {
			t.Fatalf("evento %d = %v, esperado %s com seq %d", i, m, typ, base+i+1)
		}
	}
}

func TestAuthRejections(t *testing.T) {
	e := newEnv(t)
	_, goodToken := e.user("ana")
	expired, err := auth.NewTokens(jwtSecret, time.Hour, func() time.Time { return time.Now().Add(-2 * time.Hour) }).Issue("qualquer")
	if err != nil {
		t.Fatal(err)
	}

	cases := map[string]any{
		"token inválido":                         msg{"type": "auth", "token": "lixo"},
		"token expirado":                         msg{"type": "auth", "token": expired},
		"token vazio":                            msg{"type": "auth", "token": ""},
		"usuário inexistente":                    msg{"type": "auth", "token": mustIssue(t, e, "id-que-nao-existe")},
		"primeira não é auth":                    msg{"type": "mention", "targetUserId": "x"},
		"auth com token válido mas tipo trocado": msg{"type": "authx", "token": goodToken},
	}
	for name, first := range cases {
		c := newWSClient(t, e.dial())
		c.send(first)
		m := c.next()
		if m.str("type") != "error" || m.str("code") != "unauthorized" {
			t.Errorf("%s: resposta = %v, esperado erro unauthorized", name, m)
		}
		if err := c.waitClosed(); websocket.CloseStatus(err) != websocket.StatusPolicyViolation {
			t.Errorf("%s: fechamento = %v, esperado 1008", name, err)
		}
	}
}

func mustIssue(t *testing.T, e *testEnv, userID string) string {
	t.Helper()
	token, err := e.tokens.Issue(userID)
	if err != nil {
		t.Fatal(err)
	}
	return token
}

func TestAuthTimeoutClosesSilentConnections(t *testing.T) {
	e := newEnv(t, func(c *Config) { c.AuthTimeout = 100 * time.Millisecond })
	c := newWSClient(t, e.dial())
	if err := c.waitClosed(); err == nil {
		t.Fatal("esperava a conexão fechada por falta de autenticação")
	}
}

func TestTokenNeverInURLIsRequired(t *testing.T) {
	// Um token na query string não autentica ninguém: só a primeira mensagem conta.
	e := newEnv(t, func(c *Config) { c.AuthTimeout = 150 * time.Millisecond })
	_, token := e.user("ana")
	ctx, cancel := context.WithTimeout(context.Background(), waitFor)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, e.wsURL()+"?token="+token, nil) //nolint:bodyclose // idem
	if err != nil {
		t.Fatalf("conectar: %v", err)
	}
	c := newWSClient(t, conn)
	if err := c.waitClosed(); err == nil {
		t.Fatal("o token na URL não deveria autenticar")
	}
}

func TestMentionDelivered(t *testing.T) {
	e := newEnv(t)
	anaID, anaToken := e.user("ana")
	biaID, biaToken := e.user("bia")
	ana, _ := e.connect(anaToken)
	bia, _ := e.connect(biaToken)

	ana.send(msg{"type": "mention", "targetUserId": biaID, "message": "  vem pra call!  ", "ref": "r1"})

	got := bia.next()
	from, _ := got["from"].(map[string]any)
	if got.str("type") != "mention" || got.str("message") != "vem pra call!" || from["id"] != anaID || from["username"] != "ana" || got.str("sentAt") == "" {
		t.Fatalf("menção recebida incorreta: %v", got)
	}
	if got["seq"] != nil {
		t.Fatalf("menção não deve carregar seq: %v", got)
	}
	ack := ana.next()
	if ack.str("type") != "mention_sent" || ack.str("ref") != "r1" {
		t.Fatalf("confirmação incorreta: %v", ack)
	}

	// Sem mensagem opcional.
	ana.send(msg{"type": "mention", "targetUserId": biaID})
	if got := bia.next(); got.str("type") != "mention" || got["message"] != nil {
		t.Fatalf("menção sem texto incorreta: %v", got)
	}
}

func TestMentionDeliveredToAllConnectionsOfRecipient(t *testing.T) {
	e := newEnv(t)
	_, anaToken := e.user("ana")
	biaID, biaToken := e.user("bia")
	ana, _ := e.connect(anaToken)
	bia1, _ := e.connect(biaToken)
	bia2, _ := e.connect(biaToken)

	ana.send(msg{"type": "mention", "targetUserId": biaID})
	if bia1.next().str("type") != "mention" || bia2.next().str("type") != "mention" {
		t.Fatal("as duas conexões do destinatário deveriam receber")
	}
}

func TestMentionErrors(t *testing.T) {
	e := newEnv(t)
	anaID, anaToken := e.user("ana")
	biaID, _ := e.user("bia") // existe, mas não conecta
	ana, _ := e.connect(anaToken)

	cases := []struct {
		name string
		send msg
		code string
	}{
		{"destinatário offline", msg{"type": "mention", "targetUserId": biaID, "ref": "x"}, "recipient_offline"},
		{"usuário desconhecido", msg{"type": "mention", "targetUserId": "ninguem", "ref": "x"}, "unknown_user"},
		{"auto-menção", msg{"type": "mention", "targetUserId": anaID, "ref": "x"}, "self_mention"},
		{"mensagem longa demais", msg{"type": "mention", "targetUserId": biaID, "ref": "x", "message": strings.Repeat("a", MaxMentionRunes+1)}, "bad_message"},
		{"sem destinatário", msg{"type": "mention"}, "bad_message"},
		{"tipo desconhecido", msg{"type": "voar"}, "bad_message"},
	}
	for _, tc := range cases {
		ana.send(tc.send)
		m := ana.next()
		if m.str("type") != "error" || m.str("code") != tc.code {
			t.Errorf("%s: resposta = %v, esperado erro %s", tc.name, m, tc.code)
		}
	}

}

func TestMentionMessageLimitCountsRunesNotBytes(t *testing.T) {
	e := newEnv(t)
	_, anaToken := e.user("ana")
	biaID, biaToken := e.user("bia")
	ana, _ := e.connect(anaToken)
	bia, _ := e.connect(biaToken)

	ana.send(msg{"type": "mention", "targetUserId": biaID, "message": strings.Repeat("ã", MaxMentionRunes)})
	if got := bia.next(); got.str("type") != "mention" || len([]rune(got.str("message"))) != MaxMentionRunes {
		t.Fatalf("140 runas multibyte deveriam passar: %v", got)
	}
}

func TestMentionSenderRateLimit(t *testing.T) {
	e := newEnv(t, func(c *Config) { c.MentionSenderLimit = 2 })
	_, anaToken := e.user("ana")
	biaID, biaToken := e.user("bia")
	ana, _ := e.connect(anaToken)
	bia, _ := e.connect(biaToken)

	for range 2 {
		ana.send(msg{"type": "mention", "targetUserId": biaID})
		bia.next()
		ana.next() // mention_sent
	}
	ana.send(msg{"type": "mention", "targetUserId": biaID, "ref": "z"})
	m := ana.next()
	if m.str("code") != "rate_limited_sender" || m.str("ref") != "z" || !strings.Contains(m.str("message"), "tente de novo em") {
		t.Fatalf("esperava rate_limited_sender: %v", m)
	}
	bia.expectNone(150 * time.Millisecond)
}

func TestMentionRecipientRateLimit(t *testing.T) {
	e := newEnv(t, func(c *Config) { c.MentionRecipientLimit = 2 })
	targetID, targetToken := e.user("alvo")
	target, _ := e.connect(targetToken)

	senders := make([]*wsClient, 3)
	for i := range senders {
		_, token := e.user(fmt.Sprintf("remetente%d", i))
		senders[i], _ = e.connect(token)
	}
	for _, s := range senders[:2] {
		s.send(msg{"type": "mention", "targetUserId": targetID})
		target.next()
		s.next()
	}
	senders[2].send(msg{"type": "mention", "targetUserId": targetID})
	if m := senders[2].next(); m.str("code") != "rate_limited_recipient" {
		t.Fatalf("esperava rate_limited_recipient: %v", m)
	}
	target.expectNone(150 * time.Millisecond)
}

func TestOfflineMentionDoesNotConsumeRecipientBudget(t *testing.T) {
	e := newEnv(t, func(c *Config) { c.MentionRecipientLimit = 1 })
	_, anaToken := e.user("ana")
	biaID, biaToken := e.user("bia")
	ana, _ := e.connect(anaToken)

	for range 3 {
		ana.send(msg{"type": "mention", "targetUserId": biaID})
		if m := ana.next(); m.str("code") != "recipient_offline" {
			t.Fatalf("esperava recipient_offline: %v", m)
		}
	}
	bia, _ := e.connect(biaToken)
	ana.send(msg{"type": "mention", "targetUserId": biaID})
	if bia.next().str("type") != "mention" {
		t.Fatal("o orçamento do destinatário não deveria ter sido gasto pelas tentativas offline")
	}
}

func TestTooManyBadMessagesClosesConnection(t *testing.T) {
	e := newEnv(t)
	_, token := e.user("ana")
	c, _ := e.connect(token)
	for range maxBadMessages {
		c.send(msg{"type": "???"})
	}
	if err := c.waitClosed(); websocket.CloseStatus(err) != websocket.StatusPolicyViolation {
		t.Fatalf("fechamento = %v, esperado 1008", err)
	}
}

func TestPerUserConnectionLimitEvictsOldest(t *testing.T) {
	e := newEnv(t, func(c *Config) { c.MaxConnsPerUser = 2 })
	_, token := e.user("ana")
	first, _ := e.connect(token)
	second, _ := e.connect(token)
	third, _ := e.connect(token)

	if err := first.waitClosed(); websocket.CloseStatus(err) != websocket.StatusPolicyViolation {
		t.Fatalf("a conexão mais antiga deveria cair com 1008: %v", err)
	}
	second.expectNone(100 * time.Millisecond)
	third.expectNone(100 * time.Millisecond)
}

func TestGlobalConnectionCap(t *testing.T) {
	e := newEnv(t, func(c *Config) { c.MaxConns = 1 })
	_, token := e.user("ana")
	e.connect(token)

	ctx, cancel := context.WithTimeout(context.Background(), waitFor)
	defer cancel()
	_, resp, err := websocket.Dial(ctx, e.wsURL(), nil) //nolint:bodyclose // após o upgrade a biblioteca não expõe corpo para fechar
	if err == nil {
		t.Fatal("a segunda conexão deveria ser recusada")
	}
	if resp == nil || resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("resposta = %v, esperado 503", resp)
	}
}

func TestOriginCheck(t *testing.T) {
	e := newEnv(t)
	dial := func(origin string) error {
		ctx, cancel := context.WithTimeout(context.Background(), waitFor)
		defer cancel()
		conn, _, err := websocket.Dial(ctx, e.wsURL(), &websocket.DialOptions{HTTPHeader: http.Header{"Origin": {origin}}}) //nolint:bodyclose // após o upgrade a biblioteca não expõe corpo para fechar
		if err == nil {
			_ = conn.CloseNow()
		}
		return err
	}
	if err := dial("app://desktop"); err != nil {
		t.Errorf("origem permitida recusada: %v", err)
	}
	if err := dial("http://evil.example"); err == nil {
		t.Error("origem desconhecida deveria ser recusada")
	}
}

func TestDeadConnectionsAreDetectedByPing(t *testing.T) {
	e := newEnv(t, func(c *Config) { c.PingInterval = 100 * time.Millisecond })
	userID, token := e.user("ana")

	// Cliente "morto": autentica, lê o snapshot e nunca mais lê o socket. A biblioteca só responde pings
	// dentro de Read, então para o servidor é igual a um cabo puxado.
	conn := e.dial()
	t.Cleanup(func() { _ = conn.CloseNow() })
	ctx, cancel := context.WithTimeout(context.Background(), waitFor)
	defer cancel()
	data, _ := json.Marshal(msg{"type": "auth", "token": token})
	if err := conn.Write(ctx, websocket.MessageText, data); err != nil {
		t.Fatal(err)
	}
	if _, _, err := conn.Read(ctx); err != nil {
		t.Fatalf("snapshot: %v", err)
	}
	if !e.hub.Connected(userID) {
		t.Fatal("deveria estar conectado")
	}

	deadline := time.Now().Add(waitFor)
	for e.hub.Connected(userID) {
		if time.Now().After(deadline) {
			t.Fatal("a conexão morta deveria ter sido removida pelo ping/pong")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestHealthyConnectionSurvivesManyPings(t *testing.T) {
	e := newEnv(t, func(c *Config) { c.PingInterval = 50 * time.Millisecond })
	userID, token := e.user("ana")
	c, _ := e.connect(token) // o leitor do wsClient responde aos pings

	c.expectNone(500 * time.Millisecond) // ~10 pings
	if !e.hub.Connected(userID) {
		t.Fatal("conexão saudável não pode ser derrubada pelo ping")
	}
}

func TestServerHTTPTimeoutsDoNotKillWebSockets(t *testing.T) {
	// O http.Server de produção tem ReadTimeout/WriteTimeout; depois do upgrade a conexão não pode herdá-los.
	conn := testutil.OpenDB(t)
	svc := service.New(conn, testutil.FastHasher(t), time.Now)
	if _, err := svc.Seed(context.Background(), "admin", "senha-do-admin"); err != nil {
		t.Fatal(err)
	}
	tokens := auth.NewTokens(jwtSecret, time.Hour, time.Now)
	hub := NewHub(Config{
		AuthTimeout: time.Second, PingInterval: time.Minute, MaxConnsPerUser: 3, MaxConns: 10,
		MentionSenderLimit: 10, MentionRecipientLimit: 10, MentionWindow: time.Minute,
	}, Deps{Logger: slog.New(slog.NewTextHandler(io.Discard, nil)), Tracker: presence.New(time.Now), Directory: svc, Tokens: tokens, Now: time.Now})
	srv := httptest.NewUnstartedServer(hub)
	srv.Config.ReadTimeout = 200 * time.Millisecond
	srv.Config.WriteTimeout = 200 * time.Millisecond
	srv.Start()
	t.Cleanup(func() { srv.Close(); hub.Close() })

	env := &testEnv{t: t, hub: hub, tracker: nil, svc: svc, tokens: tokens, srv: srv}
	_, token := env.user("ana")
	c, _ := env.connect(token)
	c.expectNone(700 * time.Millisecond) // bem além dos dois timeouts

	c.send(msg{"type": "mention", "targetUserId": "ninguem"})
	if m := c.next(); m.str("code") != "unknown_user" {
		t.Fatalf("a conexão deveria continuar funcional: %v", m)
	}
}

func TestHubCloseSendsGoingAway(t *testing.T) {
	e := newEnv(t)
	_, token := e.user("ana")
	c, _ := e.connect(token)

	closed := make(chan struct{})
	go func() {
		e.hub.Close()
		close(closed)
	}()
	if err := c.waitClosed(); websocket.CloseStatus(err) != websocket.StatusGoingAway {
		t.Fatalf("fechamento = %v, esperado 1001", err)
	}
	select {
	case <-closed:
	case <-time.After(waitFor):
		t.Fatal("Hub.Close não terminou")
	}

	// Depois de fechado, não aceita mais conexões.
	ctx, cancel := context.WithTimeout(context.Background(), waitFor)
	defer cancel()
	if _, _, err := websocket.Dial(ctx, e.wsURL(), nil); err == nil { //nolint:bodyclose // após o upgrade a biblioteca não expõe corpo para fechar
		t.Fatal("hub fechado não deveria aceitar conexões")
	}
}

func TestSlowConsumerIsDisconnected(t *testing.T) {
	var cause error
	c := &client{out: make(chan []byte, 1), cancel: func(err error) { cause = err }}
	if !c.send([]byte("a")) {
		t.Fatal("a primeira mensagem cabe na fila")
	}
	if c.send([]byte("b")) {
		t.Fatal("fila cheia deveria recusar")
	}
	if !errors.Is(cause, errSlowConsumer) {
		t.Fatalf("causa = %v, esperado errSlowConsumer", cause)
	}
}
