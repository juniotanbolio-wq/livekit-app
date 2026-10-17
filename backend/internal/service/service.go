// Package service concentra as regras de negócio de identidade: convites, cadastro, login, canais e seed.
// O servidor HTTP e os comandos de linha (invite create, seed) usam o mesmo código, para não haver regras duplicadas.
package service

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"modernc.org/sqlite"
	sqlite3 "modernc.org/sqlite/lib"

	"livekit-app/backend/internal/auth"
	"livekit-app/backend/internal/store"
)

// Erros de domínio; a camada HTTP os traduz em códigos de status.
var (
	ErrInviteInvalid      = errors.New("código de convite inválido, expirado ou já utilizado")
	ErrUsernameTaken      = errors.New("nome de usuário já está em uso")
	ErrInvalidCredentials = errors.New("usuário ou senha inválidos")
	ErrNotFound           = errors.New("não encontrado")
	ErrInvalidInput       = errors.New("dados inválidos")
)

// VoiceChannelCount é o número de canais de voz criados pelo seed.
const VoiceChannelCount = 7

// Mesmos limites do contrato (contracts/openapi.yaml); o seed valida aqui porque não passa pela API.
var usernameRE = regexp.MustCompile(`^[a-zA-Z0-9_.-]{3,32}$`)

const (
	passwordMin = 8
	passwordMax = 128
)

// Service é seguro para uso concorrente.
type Service struct {
	db     *sql.DB
	q      *store.Queries
	hasher *auth.Hasher
	now    func() time.Time
}

// New cria o serviço. now é injetável para testar expiração de convites.
func New(db *sql.DB, hasher *auth.Hasher, now func() time.Time) *Service {
	return &Service{db: db, q: store.New(db), hasher: hasher, now: now}
}

// CreateInvite cria um convite de uso único. O código em claro só existe no retorno: no banco vai o SHA-256,
// então um vazamento do arquivo SQLite não entrega convites utilizáveis.
func (s *Service) CreateInvite(ctx context.Context, ttl time.Duration) (string, time.Time, error) {
	raw := make([]byte, 12)
	if _, err := rand.Read(raw); err != nil {
		return "", time.Time{}, fmt.Errorf("gerar código de convite: %w", err)
	}
	code := base64.RawURLEncoding.EncodeToString(raw)

	now := s.now()
	expires := now.Add(ttl)
	id, err := newID()
	if err != nil {
		return "", time.Time{}, err
	}
	err = s.q.CreateInvite(ctx, store.CreateInviteParams{
		ID:        id,
		CodeHash:  hashInvite(code),
		ExpiresAt: expires.Unix(),
		CreatedAt: now.Unix(),
	})
	if err != nil {
		return "", time.Time{}, fmt.Errorf("salvar convite: %w", err)
	}
	return code, expires, nil
}

// Register cria o usuário consumindo o convite. Tudo acontece numa única transação: se o nome de usuário
// já existir, o convite NÃO é gasto. O hash da senha é calculado antes de abrir a transação, porque o SQLite
// só tem um escritor e o argon2id é lento (não se segura o lock de escrita durante ~100 ms de CPU).
func (s *Service) Register(ctx context.Context, inviteCode, username, password string) (store.User, error) {
	hash, err := s.hasher.Hash(ctx, password)
	if err != nil {
		return store.User{}, fmt.Errorf("calcular hash da senha: %w", err)
	}
	id, err := newID()
	if err != nil {
		return store.User{}, err
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return store.User{}, fmt.Errorf("iniciar transação: %w", err)
	}
	defer rollback(tx)
	qtx := s.q.WithTx(tx)

	now := s.now()
	codeHash := hashInvite(inviteCode)

	// O UPDATE condicional (used_at IS NULL AND expires_at > agora) é o que torna o consumo atômico:
	// com dois cadastros simultâneos do mesmo convite, só um enxerga 1 linha afetada.
	consumed, err := qtx.ConsumeInvite(ctx, store.ConsumeInviteParams{
		UsedAt:   sql.NullInt64{Int64: now.Unix(), Valid: true},
		CodeHash: codeHash,
	})
	if err != nil {
		return store.User{}, fmt.Errorf("consumir convite: %w", err)
	}
	if consumed != 1 {
		return store.User{}, ErrInviteInvalid
	}

	user, err := qtx.CreateUser(ctx, store.CreateUserParams{
		ID: id, Username: username, PasswordHash: hash, IsAdmin: false, CreatedAt: now.Unix(),
	})
	if err != nil {
		if isUniqueViolation(err) {
			return store.User{}, ErrUsernameTaken
		}
		return store.User{}, fmt.Errorf("criar usuário: %w", err)
	}
	if err := qtx.SetInviteUsedBy(ctx, store.SetInviteUsedByParams{
		UsedBy:   sql.NullString{String: user.ID, Valid: true},
		CodeHash: codeHash,
	}); err != nil {
		return store.User{}, fmt.Errorf("registrar quem usou o convite: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return store.User{}, fmt.Errorf("confirmar cadastro: %w", err)
	}
	return user, nil
}

// Authenticate confere usuário e senha. Usuário inexistente e senha errada devolvem o mesmo erro, no mesmo tempo.
func (s *Service) Authenticate(ctx context.Context, username, password string) (store.User, error) {
	user, err := s.q.GetUserByUsername(ctx, username)
	if errors.Is(err, sql.ErrNoRows) {
		if err := s.hasher.DummyVerify(ctx, password); err != nil {
			return store.User{}, fmt.Errorf("verificação simulada: %w", err)
		}
		return store.User{}, ErrInvalidCredentials
	}
	if err != nil {
		return store.User{}, fmt.Errorf("buscar usuário: %w", err)
	}
	ok, err := s.hasher.Verify(ctx, user.PasswordHash, password)
	if err != nil {
		return store.User{}, fmt.Errorf("verificar senha: %w", err)
	}
	if !ok {
		return store.User{}, ErrInvalidCredentials
	}
	return user, nil
}

// User busca um usuário pelo id (ErrNotFound se foi removido depois de o token ser emitido).
func (s *Service) User(ctx context.Context, id string) (store.User, error) {
	user, err := s.q.GetUserByID(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return store.User{}, ErrNotFound
	}
	if err != nil {
		return store.User{}, fmt.Errorf("buscar usuário: %w", err)
	}
	return user, nil
}

// Channels lista os canais em ordem de posição.
func (s *Service) Channels(ctx context.Context) ([]store.Channel, error) {
	channels, err := s.q.ListChannels(ctx)
	if err != nil {
		return nil, fmt.Errorf("listar canais: %w", err)
	}
	return channels, nil
}

// Channel busca um canal pelo id.
func (s *Service) Channel(ctx context.Context, id string) (store.Channel, error) {
	channel, err := s.q.GetChannel(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return store.Channel{}, ErrNotFound
	}
	if err != nil {
		return store.Channel{}, fmt.Errorf("buscar canal: %w", err)
	}
	return channel, nil
}

// SeedResult descreve o que o seed fez, para o comando imprimir.
type SeedResult struct {
	Channels     int
	AdminCreated bool
}

// Seed garante os 7 canais de voz e o usuário admin. É idempotente: se o admin já existe, só reforça a
// flag de admin e mantém a senha atual (rodar o seed de novo nunca troca a senha de ninguém).
func (s *Service) Seed(ctx context.Context, adminUsername, adminPassword string) (SeedResult, error) {
	if !usernameRE.MatchString(adminUsername) {
		return SeedResult{}, fmt.Errorf("%w: SEED_ADMIN_USERNAME precisa ter 3 a 32 caracteres de [a-zA-Z0-9_.-]", ErrInvalidInput)
	}
	if n := len([]rune(adminPassword)); n < passwordMin || n > passwordMax {
		return SeedResult{}, fmt.Errorf("%w: SEED_ADMIN_PASSWORD precisa ter de %d a %d caracteres", ErrInvalidInput, passwordMin, passwordMax)
	}

	// O hash é calculado antes da transação (mesmo motivo do Register) e descartado se o admin já existir.
	hash, err := s.hasher.Hash(ctx, adminPassword)
	if err != nil {
		return SeedResult{}, fmt.Errorf("calcular hash da senha: %w", err)
	}
	adminID, err := newID()
	if err != nil {
		return SeedResult{}, err
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return SeedResult{}, fmt.Errorf("iniciar transação: %w", err)
	}
	defer rollback(tx)
	qtx := s.q.WithTx(tx)

	for n := 1; n <= VoiceChannelCount; n++ {
		err := qtx.UpsertChannel(ctx, store.UpsertChannelParams{
			ID: fmt.Sprintf("voice-%d", n), Name: fmt.Sprintf("Voz %d", n), Position: int64(n),
		})
		if err != nil {
			return SeedResult{}, fmt.Errorf("garantir canal %d: %w", n, err)
		}
	}

	result := SeedResult{Channels: VoiceChannelCount}
	existing, err := qtx.GetUserByUsername(ctx, adminUsername)
	switch {
	case err == nil:
		if err := qtx.SetUserAdmin(ctx, existing.ID); err != nil {
			return SeedResult{}, fmt.Errorf("promover admin: %w", err)
		}
	case errors.Is(err, sql.ErrNoRows):
		_, err := qtx.CreateUser(ctx, store.CreateUserParams{
			ID: adminID, Username: adminUsername, PasswordHash: hash, IsAdmin: true, CreatedAt: s.now().Unix(),
		})
		if err != nil {
			return SeedResult{}, fmt.Errorf("criar admin: %w", err)
		}
		result.AdminCreated = true
	default:
		return SeedResult{}, fmt.Errorf("buscar admin: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return SeedResult{}, fmt.Errorf("confirmar seed: %w", err)
	}
	return result, nil
}

func hashInvite(code string) string {
	sum := sha256.Sum256([]byte(strings.TrimSpace(code)))
	return hex.EncodeToString(sum[:])
}

func newID() (string, error) {
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("gerar id: %w", err)
	}
	return hex.EncodeToString(raw), nil
}

func isUniqueViolation(err error) bool {
	var sqliteErr *sqlite.Error
	return errors.As(err, &sqliteErr) && sqliteErr.Code() == sqlite3.SQLITE_CONSTRAINT_UNIQUE
}

// rollback desfaz a transação se ela ainda estiver aberta; depois do Commit é no-op (sql.ErrTxDone).
func rollback(tx *sql.Tx) {
	_ = tx.Rollback() //nolint:errcheck // erro esperado (ErrTxDone) após commit; falha real já aparece no erro original
}
