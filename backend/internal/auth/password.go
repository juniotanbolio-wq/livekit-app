// Package auth cuida de senhas (argon2id) e dos tokens de sessão (JWT).
package auth

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"

	"golang.org/x/crypto/argon2"
)

// ErrInvalidHash indica que o hash armazenado não está no formato PHC esperado.
var ErrInvalidHash = errors.New("hash de senha em formato inválido")

// Params são os custos do argon2id. Ficam gravados dentro de cada hash (formato PHC), então mudar os
// padrões no futuro não invalida senhas já cadastradas.
type Params struct {
	MemoryKiB uint32
	Time      uint32
	Threads   uint8
}

// DefaultParams segue a recomendação da OWASP para argon2id (acima do mínimo de 19 MiB/t=2/p=1).
// Para ~15 usuários num servidor doméstico, o custo de ~100 ms por login é irrelevante e dificulta ataques offline.
var DefaultParams = Params{MemoryKiB: 64 * 1024, Time: 3, Threads: 2}

const (
	saltLen = 16
	keyLen  = 32
	// maxMemoryKiB limita o que aceitamos ler de um hash armazenado, para um registro adulterado
	// não conseguir pedir gigabytes de RAM na verificação.
	maxMemoryKiB = 512 * 1024
	// maxConcurrent limita hashes simultâneos: cada um usa MemoryKiB de RAM, então sem limite
	// um surto de logins (ou um ataque) esgotaria a memória do servidor doméstico.
	maxConcurrent = 4
)

// Hasher gera e verifica hashes argon2id.
type Hasher struct {
	params Params
	// sem é um semáforo: o envio ocupa uma vaga, a leitura libera.
	sem chan struct{}
	// dummy é um hash válido de uma senha aleatória, usado para gastar o mesmo tempo quando o usuário não existe.
	dummy string
}

// NewHasher cria um Hasher e já calcula o hash falso usado em DummyVerify.
func NewHasher(params Params) (*Hasher, error) {
	h := &Hasher{params: params, sem: make(chan struct{}, maxConcurrent)}
	random := make([]byte, 24)
	if _, err := rand.Read(random); err != nil {
		return nil, fmt.Errorf("gerar senha falsa: %w", err)
	}
	dummy, err := h.Hash(context.Background(), base64.RawStdEncoding.EncodeToString(random))
	if err != nil {
		return nil, fmt.Errorf("gerar hash falso: %w", err)
	}
	h.dummy = dummy
	return h, nil
}

// Hash devolve o hash PHC: $argon2id$v=19$m=...,t=...,p=...$salt$hash.
func (h *Hasher) Hash(ctx context.Context, password string) (string, error) {
	if err := h.acquire(ctx); err != nil {
		return "", err
	}
	defer h.release()

	salt := make([]byte, saltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("gerar salt: %w", err)
	}
	key := argon2.IDKey([]byte(password), salt, h.params.Time, h.params.MemoryKiB, h.params.Threads, keyLen)
	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argon2.Version, h.params.MemoryKiB, h.params.Time, h.params.Threads,
		base64.RawStdEncoding.EncodeToString(salt), base64.RawStdEncoding.EncodeToString(key)), nil
}

// Verify confere a senha contra o hash. Um hash malformado devolve ErrInvalidHash (e false).
func (h *Hasher) Verify(ctx context.Context, encoded, password string) (bool, error) {
	p, salt, want, err := decode(encoded)
	if err != nil {
		return false, err
	}
	if err := h.acquire(ctx); err != nil {
		return false, err
	}
	defer h.release()

	got := argon2.IDKey([]byte(password), salt, p.Time, p.MemoryKiB, p.Threads, uint32(len(want))) //nolint:gosec // len(want) vem de decode e é no máximo 64
	// Comparação em tempo constante: uma comparação comum vazaria, pelo tempo, quantos bytes batem.
	return subtle.ConstantTimeCompare(got, want) == 1, nil
}

// DummyVerify gasta o mesmo tempo de uma verificação real. O login chama quando o usuário não existe,
// para que o tempo de resposta não revele quais nomes de usuário estão cadastrados.
func (h *Hasher) DummyVerify(ctx context.Context, password string) error {
	_, err := h.Verify(ctx, h.dummy, password)
	return err
}

func (h *Hasher) acquire(ctx context.Context) error {
	select {
	case h.sem <- struct{}{}:
		return nil
	case <-ctx.Done():
		return fmt.Errorf("aguardando vaga para hash de senha: %w", ctx.Err())
	}
}

func (h *Hasher) release() { <-h.sem }

func decode(encoded string) (Params, []byte, []byte, error) {
	parts := strings.Split(encoded, "$")
	// "$argon2id$v=19$m=..,t=..,p=..$salt$hash" → ["", "argon2id", "v=19", "m=..", "salt", "hash"]
	if len(parts) != 6 || parts[1] != "argon2id" {
		return Params{}, nil, nil, ErrInvalidHash
	}
	var version int
	if _, err := fmt.Sscanf(parts[2], "v=%d", &version); err != nil || version != argon2.Version {
		return Params{}, nil, nil, ErrInvalidHash
	}
	var p Params
	var threads uint32
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &p.MemoryKiB, &p.Time, &threads); err != nil {
		return Params{}, nil, nil, ErrInvalidHash
	}
	if p.MemoryKiB == 0 || p.MemoryKiB > maxMemoryKiB || p.Time == 0 || threads == 0 || threads > 255 {
		return Params{}, nil, nil, ErrInvalidHash
	}
	p.Threads = uint8(threads) //nolint:gosec // validado acima (1..255)

	salt, err := base64.RawStdEncoding.DecodeString(parts[4])
	if err != nil || len(salt) == 0 {
		return Params{}, nil, nil, ErrInvalidHash
	}
	key, err := base64.RawStdEncoding.DecodeString(parts[5])
	if err != nil || len(key) == 0 || len(key) > 64 {
		return Params{}, nil, nil, ErrInvalidHash
	}
	return p, salt, key, nil
}
