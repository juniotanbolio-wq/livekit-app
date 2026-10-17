package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	lkauth "github.com/livekit/protocol/auth"

	"livekit-app/backend/internal/auth"
	"livekit-app/backend/internal/livekit"
	"livekit-app/backend/internal/ratelimit"
	"livekit-app/backend/internal/service"
	"livekit-app/backend/internal/testutil"
)

const (
	jwtSecret = "0123456789abcdef0123456789abcdef"
	lkKey     = "devkey"
	lkSecret  = "fedcba9876543210fedcba9876543210"
	origin    = "app://desktop"
)

// env é o ambiente de um teste de integração: servidor HTTP real, banco SQLite real e migrações reais.
type env struct {
	t      *testing.T
	srv    *httptest.Server
	svc    *service.Service
	clock  *testutil.Clock
	tokens *auth.Tokens
}

type options struct {
	rateLimit    int
	maxBodyBytes int64
	trusted      []netip.Prefix
}

func newEnv(t *testing.T, opts ...func(*options)) *env {
	t.Helper()
	o := options{rateLimit: 1000, maxBodyBytes: 32 * 1024}
	for _, fn := range opts {
		fn(&o)
	}

	conn := testutil.OpenDB(t)
	clock := testutil.NewClock()
	svc := service.New(conn, testutil.FastHasher(t), clock.Now)
	if _, err := svc.Seed(context.Background(), "admin", "senha-do-admin"); err != nil {
		t.Fatalf("seed: %v", err)
	}
	tokens := auth.NewTokens(jwtSecret, time.Hour, clock.Now)

	handler, err := NewHandler(Deps{
		Logger:         slog.New(slog.NewTextHandler(io.Discard, nil)),
		Service:        svc,
		Tokens:         tokens,
		LiveKit:        livekit.NewIssuer(lkKey, lkSecret, "ws://localhost:7880", 6*time.Hour),
		AuthLimiter:    ratelimit.New(o.rateLimit, time.Minute, clock.Now),
		CORSOrigins:    []string{origin},
		TrustedProxies: o.trusted,
		MaxBodyBytes:   o.maxBodyBytes,
	})
	if err != nil {
		t.Fatalf("NewHandler: %v", err)
	}
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	return &env{t: t, srv: srv, svc: svc, clock: clock, tokens: tokens}
}

// resp é uma resposta já lida e fechada.
type resp struct {
	status int
	header http.Header
	body   []byte
}

func (r resp) json(t *testing.T, into any) {
	t.Helper()
	if err := json.Unmarshal(r.body, into); err != nil {
		t.Fatalf("resposta não é o JSON esperado (%d): %s", r.status, r.body)
	}
}

func (r resp) errorMessage(t *testing.T) string {
	t.Helper()
	var e struct {
		Error string `json:"error"`
	}
	r.json(t, &e)
	return e.Error
}

func (e *env) do(method, path, token string, body any, headers ...string) resp {
	e.t.Helper()
	var reader io.Reader
	switch b := body.(type) {
	case nil:
	case string:
		reader = strings.NewReader(b)
	default:
		raw, err := json.Marshal(b)
		if err != nil {
			e.t.Fatal(err)
		}
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(context.Background(), method, e.srv.URL+path, reader)
	if err != nil {
		e.t.Fatal(err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	for i := 0; i+1 < len(headers); i += 2 {
		req.Header.Set(headers[i], headers[i+1])
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		e.t.Fatalf("%s %s: %v", method, path, err)
	}
	defer func() {
		if err := res.Body.Close(); err != nil {
			e.t.Errorf("fechar corpo: %v", err)
		}
	}()
	raw, err := io.ReadAll(res.Body)
	if err != nil {
		e.t.Fatal(err)
	}
	return resp{status: res.StatusCode, header: res.Header, body: raw}
}

type authBody struct {
	Token string `json:"token"`
	User  struct {
		ID       string `json:"id"`
		Username string `json:"username"`
		IsAdmin  bool   `json:"isAdmin"`
	} `json:"user"`
}

// invite cria um convite válido direto no serviço (o equivalente ao comando `invite create`).
func (e *env) invite() string {
	e.t.Helper()
	code, _, err := e.svc.CreateInvite(context.Background(), time.Hour)
	if err != nil {
		e.t.Fatal(err)
	}
	return code
}

// register cadastra um usuário pela API e devolve o token de sessão.
func (e *env) register(username, password string) authBody {
	e.t.Helper()
	r := e.do("POST", "/api/auth/register", "", map[string]string{
		"inviteCode": e.invite(), "username": username, "password": password,
	})
	if r.status != http.StatusCreated {
		e.t.Fatalf("cadastro de %s: %d %s", username, r.status, r.body)
	}
	var out authBody
	r.json(e.t, &out)
	return out
}

func TestHealth(t *testing.T) {
	e := newEnv(t)
	r := e.do("GET", "/health", "", nil)
	if r.status != http.StatusOK || !strings.Contains(string(r.body), `"status":"ok"`) {
		t.Fatalf("resposta inesperada: %d %s", r.status, r.body)
	}
	if r := e.do("POST", "/health", "", nil); r.status != http.StatusMethodNotAllowed {
		t.Fatalf("POST /health: esperava 405, veio %d", r.status)
	}
	if r := e.do("GET", "/nao-existe", "", nil); r.status != http.StatusNotFound || r.errorMessage(t) == "" {
		t.Fatalf("rota inexistente: %d %s", r.status, r.body)
	}
}

func TestRegisterAndLogin(t *testing.T) {
	e := newEnv(t)

	reg := e.register("ana", "senha-da-ana")
	if reg.Token == "" || reg.User.Username != "ana" || reg.User.IsAdmin || reg.User.ID == "" {
		t.Fatalf("cadastro inesperado: %+v", reg)
	}

	r := e.do("POST", "/api/auth/login", "", map[string]string{"username": "ana", "password": "senha-da-ana"})
	if r.status != http.StatusOK {
		t.Fatalf("login: %d %s", r.status, r.body)
	}
	var login authBody
	r.json(t, &login)
	if login.User.ID != reg.User.ID || login.Token == "" {
		t.Fatalf("login devolveu outro usuário: %+v", login)
	}

	admin := e.do("POST", "/api/auth/login", "", map[string]string{"username": "admin", "password": "senha-do-admin"})
	var adminBody authBody
	admin.json(t, &adminBody)
	if admin.status != http.StatusOK || !adminBody.User.IsAdmin {
		t.Fatalf("login do admin do seed: %d %s", admin.status, admin.body)
	}
}

func TestLoginFailures(t *testing.T) {
	e := newEnv(t)
	e.register("ana", "senha-da-ana")

	cases := map[string]map[string]string{
		"senha errada":        {"username": "ana", "password": "senha-errada-1"},
		"usuário inexistente": {"username": "ninguem", "password": "senha-da-ana"},
	}
	for name, body := range cases {
		r := e.do("POST", "/api/auth/login", "", body)
		if r.status != http.StatusUnauthorized {
			t.Errorf("%s: esperava 401, veio %d %s", name, r.status, r.body)
		}
	}
	// As duas falhas precisam ser indistinguíveis para quem observa a resposta.
	a := e.do("POST", "/api/auth/login", "", cases["senha errada"])
	b := e.do("POST", "/api/auth/login", "", cases["usuário inexistente"])
	if string(a.body) != string(b.body) {
		t.Errorf("mensagens diferentes revelam se o usuário existe: %q vs %q", a.body, b.body)
	}
}

func TestRegisterInviteRules(t *testing.T) {
	e := newEnv(t)
	code := e.invite()
	body := func(user string) map[string]string {
		return map[string]string{"inviteCode": code, "username": user, "password": "senha-valida-1"}
	}

	if r := e.do("POST", "/api/auth/register", "", body("ana")); r.status != http.StatusCreated {
		t.Fatalf("primeiro uso: %d %s", r.status, r.body)
	}
	if r := e.do("POST", "/api/auth/register", "", body("bia")); r.status != http.StatusBadRequest {
		t.Fatalf("convite reutilizado: esperava 400, veio %d %s", r.status, r.body)
	}

	expiring := e.invite()
	e.clock.Advance(2 * time.Hour)
	r := e.do("POST", "/api/auth/register", "", map[string]string{"inviteCode": expiring, "username": "cris", "password": "senha-valida-1"})
	if r.status != http.StatusBadRequest {
		t.Fatalf("convite expirado: esperava 400, veio %d %s", r.status, r.body)
	}
}

func TestRegisterDuplicateUsername(t *testing.T) {
	e := newEnv(t)
	e.register("Ana", "senha-da-ana")
	r := e.do("POST", "/api/auth/register", "", map[string]string{"inviteCode": e.invite(), "username": "ana", "password": "senha-valida-1"})
	if r.status != http.StatusConflict {
		t.Fatalf("esperava 409, veio %d %s", r.status, r.body)
	}
}

func TestRegisterConcurrentSameInvite(t *testing.T) {
	e := newEnv(t)
	code := e.invite()

	const attempts = 6
	statuses := make([]int, attempts)
	var wg sync.WaitGroup
	for i := range attempts {
		wg.Go(func() {
			r := e.do("POST", "/api/auth/register", "", map[string]string{
				"inviteCode": code, "username": "conc" + strconv.Itoa(i), "password": "senha-valida-1",
			})
			statuses[i] = r.status
		})
	}
	wg.Wait()

	created, rejected := 0, 0
	for _, s := range statuses {
		switch s {
		case http.StatusCreated:
			created++
		case http.StatusBadRequest:
			rejected++
		default:
			t.Errorf("status inesperado %d", s)
		}
	}
	if created != 1 || rejected != attempts-1 {
		t.Fatalf("esperava 1 criado e %d recusados, veio %d e %d", attempts-1, created, rejected)
	}
}

func TestInputValidationFromContract(t *testing.T) {
	e := newEnv(t)
	valid := func() map[string]string {
		return map[string]string{"inviteCode": "convite-valido", "username": "ana", "password": "senha-valida-1"}
	}
	mutate := func(k, v string) map[string]string { m := valid(); m[k] = v; return m }

	cases := map[string]any{
		"usuário curto":      mutate("username", "ab"),
		"usuário com espaço": mutate("username", "ana maria"),
		"usuário longo":      mutate("username", strings.Repeat("a", 33)),
		"senha curta":        mutate("password", "curta"),
		"senha longa":        mutate("password", strings.Repeat("x", 129)),
		"convite curto":      mutate("inviteCode", "abc"),
		"campo ausente":      map[string]string{"username": "ana"},
		"json malformado":    `{"username": `,
		"não é objeto":       `[1,2,3]`,
	}
	for name, body := range cases {
		r := e.do("POST", "/api/auth/register", "", body)
		if r.status != http.StatusBadRequest {
			t.Errorf("%s: esperava 400, veio %d %s", name, r.status, r.body)
			continue
		}
		if r.errorMessage(t) == "" {
			t.Errorf("%s: corpo de erro sem mensagem: %s", name, r.body)
		}
	}

	// Content-Type diferente de JSON também é recusado pelo contrato.
	req, err := http.NewRequestWithContext(context.Background(), "POST", e.srv.URL+"/api/auth/login", strings.NewReader("username=a"))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	if err := res.Body.Close(); err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != http.StatusBadRequest {
		t.Errorf("content-type inválido: esperava 400, veio %d", res.StatusCode)
	}
}

func TestChannelsRequireAuth(t *testing.T) {
	e := newEnv(t)
	reg := e.register("ana", "senha-da-ana")

	if r := e.do("GET", "/api/channels", "", nil); r.status != http.StatusUnauthorized {
		t.Errorf("sem token: esperava 401, veio %d", r.status)
	} else if r.header.Get("WWW-Authenticate") != "Bearer" {
		t.Errorf("401 deveria trazer WWW-Authenticate: Bearer")
	}
	if r := e.do("GET", "/api/channels", "isto.nao.e-jwt", nil); r.status != http.StatusUnauthorized {
		t.Errorf("token lixo: esperava 401, veio %d", r.status)
	}
	if r := e.do("GET", "/api/channels", "", nil, "Authorization", "Basic abc"); r.status != http.StatusUnauthorized {
		t.Errorf("esquema Basic: esperava 401, veio %d", r.status)
	}

	// Token assinado com outro segredo.
	forged, err := auth.NewTokens("00000000000000000000000000000000", time.Hour, e.clock.Now).Issue(reg.User.ID)
	if err != nil {
		t.Fatal(err)
	}
	if r := e.do("GET", "/api/channels", forged, nil); r.status != http.StatusUnauthorized {
		t.Errorf("token forjado: esperava 401, veio %d", r.status)
	}

	// Token legítimo mas expirado.
	e.clock.Advance(2 * time.Hour)
	if r := e.do("GET", "/api/channels", reg.Token, nil); r.status != http.StatusUnauthorized {
		t.Errorf("token expirado: esperava 401, veio %d", r.status)
	}
}

func TestChannelsList(t *testing.T) {
	e := newEnv(t)
	reg := e.register("ana", "senha-da-ana")

	r := e.do("GET", "/api/channels", reg.Token, nil)
	if r.status != http.StatusOK {
		t.Fatalf("%d %s", r.status, r.body)
	}
	var out struct {
		Channels []struct {
			ID       string `json:"id"`
			Name     string `json:"name"`
			Position int    `json:"position"`
		} `json:"channels"`
	}
	r.json(t, &out)
	if len(out.Channels) != 7 {
		t.Fatalf("esperava 7 canais, veio %d", len(out.Channels))
	}
	for i, c := range out.Channels {
		if c.Position != i+1 || c.Name != "Voz "+strconv.Itoa(i+1) || c.ID != "voice-"+strconv.Itoa(i+1) {
			t.Errorf("canal %d inesperado: %+v", i, c)
		}
	}
}

func decodeLiveKit(t *testing.T, r resp, wantRoom string) (string, *lkauth.ClaimGrants) {
	t.Helper()
	if r.status != http.StatusOK {
		t.Fatalf("token LiveKit: %d %s", r.status, r.body)
	}
	var out struct {
		Token    string `json:"token"`
		URL      string `json:"url"`
		RoomName string `json:"roomName"`
	}
	r.json(t, &out)
	if out.URL != "ws://localhost:7880" || out.RoomName != wantRoom {
		t.Fatalf("url/sala inesperadas: %+v", out)
	}
	v, err := lkauth.ParseAPIToken(out.Token)
	if err != nil {
		t.Fatal(err)
	}
	_, grants, err := v.Verify(lkSecret)
	if err != nil {
		t.Fatalf("o LiveKit recusaria a assinatura: %v", err)
	}
	return v.Identity(), grants
}

func TestLiveKitToken(t *testing.T) {
	e := newEnv(t)
	reg := e.register("ana", "senha-da-ana")

	identity, grants := decodeLiveKit(t,
		e.do("POST", "/api/livekit/token", reg.Token, map[string]string{"channelId": "voice-2", "role": "voice"}),
		"channel-voice-2")
	if identity != reg.User.ID || grants.Name != "ana" {
		t.Errorf("voz: identidade %q nome %q", identity, grants.Name)
	}
	if v := grants.Video; v == nil || v.Hidden || v.CanPublish == nil || !*v.CanPublish {
		t.Errorf("voz deveria publicar e não ser oculta: %+v", v)
	}

	identity, grants = decodeLiveKit(t,
		e.do("POST", "/api/livekit/token", reg.Token, map[string]string{"channelId": "voice-2", "role": "spectator"}),
		"channel-voice-2")
	if identity != reg.User.ID+"#spectator" {
		t.Errorf("espectador: identidade %q", identity)
	}
	if v := grants.Video; v == nil || !v.Hidden || v.CanPublish == nil || *v.CanPublish || v.CanPublishData == nil || *v.CanPublishData {
		t.Errorf("espectador deveria ser oculto e não publicar: %+v", v)
	}
}

func TestLiveKitTokenErrors(t *testing.T) {
	e := newEnv(t)
	reg := e.register("ana", "senha-da-ana")

	tokenReq := func(token string, body any) resp { return e.do("POST", "/api/livekit/token", token, body) }

	if r := tokenReq("", map[string]string{"channelId": "voice-1", "role": "voice"}); r.status != http.StatusUnauthorized {
		t.Errorf("sem token: %d", r.status)
	}
	if r := tokenReq(reg.Token, map[string]string{"channelId": "nao-existe", "role": "voice"}); r.status != http.StatusNotFound {
		t.Errorf("canal inexistente: esperava 404, veio %d %s", r.status, r.body)
	}
	if r := tokenReq(reg.Token, map[string]string{"channelId": "voice-1", "role": "admin"}); r.status != http.StatusBadRequest {
		t.Errorf("papel inválido: esperava 400, veio %d %s", r.status, r.body)
	}
	if r := tokenReq(reg.Token, map[string]string{"role": "voice"}); r.status != http.StatusBadRequest {
		t.Errorf("sem canal: esperava 400, veio %d %s", r.status, r.body)
	}

	// Token de sessão válido de um usuário que não existe mais não emite acesso de mídia.
	ghost, err := e.tokens.Issue("usuario-removido")
	if err != nil {
		t.Fatal(err)
	}
	if r := tokenReq(ghost, map[string]string{"channelId": "voice-1", "role": "voice"}); r.status != http.StatusUnauthorized {
		t.Errorf("usuário removido: esperava 401, veio %d %s", r.status, r.body)
	}
}

func TestAuthRateLimit(t *testing.T) {
	e := newEnv(t, func(o *options) { o.rateLimit = 3 })
	body := map[string]string{"username": "ninguem", "password": "qualquer-coisa"}

	for i := range 3 {
		if r := e.do("POST", "/api/auth/login", "", body); r.status != http.StatusUnauthorized {
			t.Fatalf("tentativa %d: esperava 401, veio %d", i+1, r.status)
		}
	}
	r := e.do("POST", "/api/auth/login", "", body)
	if r.status != http.StatusTooManyRequests {
		t.Fatalf("esperava 429, veio %d %s", r.status, r.body)
	}
	if secs, err := strconv.Atoi(r.header.Get("Retry-After")); err != nil || secs < 1 {
		t.Errorf("Retry-After inválido: %q", r.header.Get("Retry-After"))
	}
	// O contador é compartilhado entre login e cadastro.
	if r := e.do("POST", "/api/auth/register", "", map[string]string{"inviteCode": "convite-valido", "username": "ana", "password": "senha-valida-1"}); r.status != http.StatusTooManyRequests {
		t.Errorf("cadastro deveria compartilhar o limite: %d", r.status)
	}
	// Rotas fora de /api/auth/ não são afetadas.
	if r := e.do("GET", "/health", "", nil); r.status != http.StatusOK {
		t.Errorf("/health não pode ser limitado: %d", r.status)
	}
}

func TestBodyTooLarge(t *testing.T) {
	e := newEnv(t, func(o *options) { o.maxBodyBytes = 512 })
	big := map[string]string{"username": "ana", "password": strings.Repeat("x", 4096)}
	if r := e.do("POST", "/api/auth/login", "", big); r.status != http.StatusRequestEntityTooLarge {
		t.Fatalf("esperava 413, veio %d %s", r.status, r.body)
	}
}

func TestBodyTooLargeWithoutContentLength(t *testing.T) {
	e := newEnv(t, func(o *options) { o.maxBodyBytes = 512 })
	payload := `{"username":"ana","password":"` + strings.Repeat("x", 4096) + `"}`
	req, err := http.NewRequestWithContext(context.Background(), "POST", e.srv.URL+"/api/auth/login",
		io.NopCloser(strings.NewReader(payload))) // io.NopCloser esconde o tamanho: vai em chunked
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	if err := res.Body.Close(); err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("esperava 413 mesmo sem Content-Length, veio %d", res.StatusCode)
	}
}

func TestCORS(t *testing.T) {
	e := newEnv(t)

	// Preflight de origem permitida.
	r := e.do("OPTIONS", "/api/auth/login", "", nil,
		"Origin", origin, "Access-Control-Request-Method", "POST", "Access-Control-Request-Headers", "content-type")
	if r.status != http.StatusNoContent {
		t.Fatalf("preflight: esperava 204, veio %d", r.status)
	}
	if r.header.Get("Access-Control-Allow-Origin") != origin ||
		!strings.Contains(r.header.Get("Access-Control-Allow-Headers"), "Authorization") ||
		!strings.Contains(r.header.Get("Vary"), "Origin") {
		t.Errorf("cabeçalhos CORS incorretos: %v", r.header)
	}

	// Requisição real de origem permitida recebe o cabeçalho.
	r = e.do("GET", "/health", "", nil, "Origin", origin)
	if r.status != http.StatusOK || r.header.Get("Access-Control-Allow-Origin") != origin {
		t.Errorf("origem permitida: %d %v", r.status, r.header)
	}

	// Origem desconhecida: recusada, e sem cabeçalhos CORS.
	for _, preflight := range []bool{true, false} {
		headers := []string{"Origin", "https://evil.example"}
		method := "GET"
		if preflight {
			method = "OPTIONS"
			headers = append(headers, "Access-Control-Request-Method", "POST")
		}
		r = e.do(method, "/api/channels", "", nil, headers...)
		if r.status != http.StatusForbidden || r.header.Get("Access-Control-Allow-Origin") != "" {
			t.Errorf("origem negada (preflight=%v): %d %v", preflight, r.status, r.header)
		}
	}

	// Sem Origin (curl, processo principal do Electron): segue normal.
	if r := e.do("GET", "/health", "", nil); r.status != http.StatusOK {
		t.Errorf("sem Origin: %d", r.status)
	}
}

func TestPasswordsNeverLogged(t *testing.T) {
	var logs bytes.Buffer
	var mu sync.Mutex // protege logs: o logger é chamado de goroutines do servidor
	logger := slog.New(slog.NewTextHandler(&lockedWriter{mu: &mu, w: &logs}, &slog.HandlerOptions{Level: slog.LevelDebug}))

	conn := testutil.OpenDB(t)
	clock := testutil.NewClock()
	svc := service.New(conn, testutil.FastHasher(t), clock.Now)
	handler, err := NewHandler(Deps{
		Logger: logger, Service: svc, Tokens: auth.NewTokens(jwtSecret, time.Hour, clock.Now),
		LiveKit:     livekit.NewIssuer(lkKey, lkSecret, "ws://x", time.Hour),
		AuthLimiter: ratelimit.New(100, time.Minute, clock.Now), CORSOrigins: []string{origin}, MaxBodyBytes: 4096,
	})
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(handler)
	defer srv.Close()
	e := &env{t: t, srv: srv, svc: svc, clock: clock}

	e.do("POST", "/api/auth/login", "", map[string]string{"username": "ana", "password": "SENHA-SECRETA-123"})
	e.do("GET", "/api/channels", "TOKEN-SECRETO-ABC", nil)

	mu.Lock()
	defer mu.Unlock()
	for _, secret := range []string{"SENHA-SECRETA-123", "TOKEN-SECRETO-ABC"} {
		if strings.Contains(logs.String(), secret) {
			t.Errorf("segredo %q apareceu nos logs:\n%s", secret, logs.String())
		}
	}
	if !strings.Contains(logs.String(), "/api/auth/login") {
		t.Errorf("o log de acesso deveria existir:\n%s", logs.String())
	}
}

type lockedWriter struct {
	mu *sync.Mutex
	w  io.Writer
}

func (l *lockedWriter) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.w.Write(p)
}
