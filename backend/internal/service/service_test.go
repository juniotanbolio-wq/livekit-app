package service

import (
	"context"
	"database/sql"
	"errors"
	"strconv"
	"sync"
	"testing"
	"time"

	"livekit-app/backend/internal/testutil"
)

func newTestService(t *testing.T) (*Service, *testutil.Clock, *sql.DB) {
	t.Helper()
	conn := testutil.OpenDB(t)
	clock := testutil.NewClock()
	return New(conn, testutil.FastHasher(t), clock.Now), clock, conn
}

func TestInviteStoredOnlyAsHash(t *testing.T) {
	svc, _, conn := newTestService(t)
	code, _, err := svc.CreateInvite(context.Background(), time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if len(code) < 8 {
		t.Fatalf("código curto demais: %q", code)
	}
	var stored string
	if err := conn.QueryRowContext(context.Background(), "SELECT code_hash FROM invites").Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if stored == code || stored != hashInvite(code) {
		t.Fatalf("o banco deve guardar só o SHA-256 do código (guardou %q)", stored)
	}
}

func TestRegisterConsumesInvite(t *testing.T) {
	svc, _, _ := newTestService(t)
	ctx := context.Background()
	code, _, err := svc.CreateInvite(ctx, time.Hour)
	if err != nil {
		t.Fatal(err)
	}

	user, err := svc.Register(ctx, code, "ana", "senha-da-ana")
	if err != nil {
		t.Fatalf("Register: %v", err)
	}
	if user.Username != "ana" || user.IsAdmin || user.ID == "" || user.PasswordHash == "senha-da-ana" {
		t.Fatalf("usuário inesperado: %+v", user)
	}

	if _, err := svc.Register(ctx, code, "bia", "senha-da-bia"); !errors.Is(err, ErrInviteInvalid) {
		t.Fatalf("convite reutilizado deveria ser recusado, veio %v", err)
	}
}

func TestRegisterRejectsUnknownAndExpiredInvite(t *testing.T) {
	svc, clock, _ := newTestService(t)
	ctx := context.Background()

	if _, err := svc.Register(ctx, "convite-que-nao-existe", "ana", "senha-da-ana"); !errors.Is(err, ErrInviteInvalid) {
		t.Fatalf("convite inexistente: %v", err)
	}

	code, _, err := svc.CreateInvite(ctx, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	clock.Advance(time.Hour) // expira exatamente agora: expires_at > now é falso
	if _, err := svc.Register(ctx, code, "ana", "senha-da-ana"); !errors.Is(err, ErrInviteInvalid) {
		t.Fatalf("convite expirado: %v", err)
	}
}

// Se o nome já existe, o cadastro falha mas o convite não pode ser gasto (a transação é desfeita).
func TestRegisterUsernameTakenKeepsInviteUsable(t *testing.T) {
	svc, _, _ := newTestService(t)
	ctx := context.Background()

	first, _, _ := svc.CreateInvite(ctx, time.Hour)
	if _, err := svc.Register(ctx, first, "Ana", "senha-da-ana"); err != nil {
		t.Fatal(err)
	}
	second, _, err := svc.CreateInvite(ctx, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Register(ctx, second, "ana", "outra-senha"); !errors.Is(err, ErrUsernameTaken) {
		t.Fatalf("nome repetido (outra caixa) deveria dar ErrUsernameTaken, veio %v", err)
	}
	if _, err := svc.Register(ctx, second, "bia", "senha-da-bia"); err != nil {
		t.Fatalf("o convite deveria continuar utilizável: %v", err)
	}
}

// Dois cadastros simultâneos com o mesmo convite: exatamente um vence.
func TestRegisterConcurrentSameInvite(t *testing.T) {
	svc, _, _ := newTestService(t)
	ctx := context.Background()
	code, _, err := svc.CreateInvite(ctx, time.Hour)
	if err != nil {
		t.Fatal(err)
	}

	const attempts = 8
	errs := make([]error, attempts)
	var wg sync.WaitGroup
	for i := range attempts {
		wg.Go(func() {
			_, errs[i] = svc.Register(ctx, code, "user"+strconv.Itoa(i), "senha-comum-123")
		})
	}
	wg.Wait()

	ok, invalid := 0, 0
	for _, err := range errs {
		switch {
		case err == nil:
			ok++
		case errors.Is(err, ErrInviteInvalid):
			invalid++
		default:
			t.Errorf("erro inesperado: %v", err)
		}
	}
	if ok != 1 || invalid != attempts-1 {
		t.Fatalf("esperava 1 sucesso e %d recusas, veio %d e %d", attempts-1, ok, invalid)
	}
}

func TestAuthenticate(t *testing.T) {
	svc, _, _ := newTestService(t)
	ctx := context.Background()
	code, _, _ := svc.CreateInvite(ctx, time.Hour)
	registered, err := svc.Register(ctx, code, "ana", "senha-da-ana")
	if err != nil {
		t.Fatal(err)
	}

	user, err := svc.Authenticate(ctx, "ana", "senha-da-ana")
	if err != nil || user.ID != registered.ID {
		t.Fatalf("login válido falhou: %+v %v", user, err)
	}
	if _, err := svc.Authenticate(ctx, "ANA", "senha-da-ana"); err != nil {
		t.Fatalf("login deve ignorar maiúsculas no nome: %v", err)
	}
	if _, err := svc.Authenticate(ctx, "ana", "senha-errada"); !errors.Is(err, ErrInvalidCredentials) {
		t.Fatalf("senha errada: %v", err)
	}
	if _, err := svc.Authenticate(ctx, "ninguem", "senha-da-ana"); !errors.Is(err, ErrInvalidCredentials) {
		t.Fatalf("usuário inexistente: %v", err)
	}
}

func TestSeedIsIdempotent(t *testing.T) {
	svc, _, _ := newTestService(t)
	ctx := context.Background()

	first, err := svc.Seed(ctx, "admin", "senha-do-admin")
	if err != nil || !first.AdminCreated || first.Channels != VoiceChannelCount {
		t.Fatalf("primeiro seed: %+v %v", first, err)
	}
	// Segunda execução com outra senha: não pode trocar a senha existente.
	second, err := svc.Seed(ctx, "admin", "outra-senha-qualquer")
	if err != nil || second.AdminCreated {
		t.Fatalf("segundo seed: %+v %v", second, err)
	}

	admin, err := svc.Authenticate(ctx, "admin", "senha-do-admin")
	if err != nil || !admin.IsAdmin {
		t.Fatalf("admin deveria manter a senha original e ser admin: %+v %v", admin, err)
	}
	if _, err := svc.Authenticate(ctx, "admin", "outra-senha-qualquer"); !errors.Is(err, ErrInvalidCredentials) {
		t.Fatalf("a senha do segundo seed não pode valer: %v", err)
	}

	channels, err := svc.Channels(ctx)
	if err != nil || len(channels) != VoiceChannelCount {
		t.Fatalf("canais: %d %v", len(channels), err)
	}
	for i, c := range channels {
		if c.Position != int64(i+1) {
			t.Errorf("canal %d fora de ordem: %+v", i, c)
		}
	}
	if channels[0].ID != "voice-1" || channels[0].Name != "Voz 1" || channels[6].ID != "voice-7" {
		t.Errorf("ids/nomes inesperados: %+v ... %+v", channels[0], channels[6])
	}
}

func TestSeedPromotesExistingUserToAdmin(t *testing.T) {
	svc, _, _ := newTestService(t)
	ctx := context.Background()
	code, _, _ := svc.CreateInvite(ctx, time.Hour)
	if _, err := svc.Register(ctx, code, "ana", "senha-da-ana"); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Seed(ctx, "ana", "senha-do-seed"); err != nil {
		t.Fatal(err)
	}
	user, err := svc.Authenticate(ctx, "ana", "senha-da-ana")
	if err != nil || !user.IsAdmin {
		t.Fatalf("ana deveria virar admin mantendo a senha: %+v %v", user, err)
	}
}

func TestSeedValidatesInput(t *testing.T) {
	svc, _, _ := newTestService(t)
	cases := map[string][2]string{
		"nome curto":    {"ab", "senha-valida-123"},
		"nome inválido": {"nome com espaço", "senha-valida-123"},
		"senha curta":   {"admin", "curta"},
	}
	for name, c := range cases {
		if _, err := svc.Seed(context.Background(), c[0], c[1]); !errors.Is(err, ErrInvalidInput) {
			t.Errorf("%s: esperava ErrInvalidInput, veio %v", name, err)
		}
	}
}

func TestLookupsReturnNotFound(t *testing.T) {
	svc, _, _ := newTestService(t)
	if _, err := svc.User(context.Background(), "nao-existe"); !errors.Is(err, ErrNotFound) {
		t.Errorf("User: %v", err)
	}
	if _, err := svc.Channel(context.Background(), "nao-existe"); !errors.Is(err, ErrNotFound) {
		t.Errorf("Channel: %v", err)
	}
}
