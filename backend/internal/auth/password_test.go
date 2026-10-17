package auth

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

var testParams = Params{MemoryKiB: 8, Time: 1, Threads: 1}

func newTestHasher(t *testing.T) *Hasher {
	t.Helper()
	h, err := NewHasher(testParams)
	if err != nil {
		t.Fatalf("NewHasher: %v", err)
	}
	return h
}

func TestHashAndVerify(t *testing.T) {
	h := newTestHasher(t)
	ctx := context.Background()

	hash, err := h.Hash(ctx, "senha-correta")
	if err != nil {
		t.Fatalf("Hash: %v", err)
	}
	if !strings.HasPrefix(hash, "$argon2id$v=19$m=8,t=1,p=1$") {
		t.Fatalf("formato PHC inesperado: %s", hash)
	}

	ok, err := h.Verify(ctx, hash, "senha-correta")
	if err != nil || !ok {
		t.Fatalf("senha correta deveria passar: ok=%v err=%v", ok, err)
	}
	ok, err = h.Verify(ctx, hash, "senha-errada")
	if err != nil || ok {
		t.Fatalf("senha errada deveria falhar sem erro: ok=%v err=%v", ok, err)
	}
}

func TestHashUsesRandomSalt(t *testing.T) {
	h := newTestHasher(t)
	a, err := h.Hash(context.Background(), "mesma-senha")
	if err != nil {
		t.Fatal(err)
	}
	b, err := h.Hash(context.Background(), "mesma-senha")
	if err != nil {
		t.Fatal(err)
	}
	if a == b {
		t.Fatal("dois hashes da mesma senha não podem ser iguais (salt aleatório)")
	}
}

// Hashes antigos continuam válidos depois de mudar DefaultParams: os parâmetros vêm do próprio hash.
func TestVerifyUsesParamsFromHash(t *testing.T) {
	old := newTestHasher(t)
	hash, err := old.Hash(context.Background(), "segredo")
	if err != nil {
		t.Fatal(err)
	}
	newer, err := NewHasher(Params{MemoryKiB: 16, Time: 2, Threads: 1})
	if err != nil {
		t.Fatal(err)
	}
	ok, err := newer.Verify(context.Background(), hash, "segredo")
	if err != nil || !ok {
		t.Fatalf("hash gerado com outros parâmetros deveria verificar: ok=%v err=%v", ok, err)
	}
}

func TestVerifyRejectsMalformedHash(t *testing.T) {
	h := newTestHasher(t)
	valid, err := h.Hash(context.Background(), "x")
	if err != nil {
		t.Fatal(err)
	}
	parts := strings.Split(valid, "$")

	cases := map[string]string{
		"vazio":          "",
		"lixo":           "isto-nao-e-um-hash",
		"algoritmo":      strings.Replace(valid, "argon2id", "argon2i", 1),
		"versão":         strings.Replace(valid, "v=19", "v=16", 1),
		"memória enorme": "$argon2id$v=19$m=99999999,t=1,p=1$" + parts[4] + "$" + parts[5],
		"memória zero":   "$argon2id$v=19$m=0,t=1,p=1$" + parts[4] + "$" + parts[5],
		"threads zero":   "$argon2id$v=19$m=8,t=1,p=0$" + parts[4] + "$" + parts[5],
		"salt inválido":  "$argon2id$v=19$m=8,t=1,p=1$@@@$" + parts[5],
		"chave vazia":    "$argon2id$v=19$m=8,t=1,p=1$" + parts[4] + "$",
	}
	for name, hash := range cases {
		ok, err := h.Verify(context.Background(), hash, "x")
		if ok || !errors.Is(err, ErrInvalidHash) {
			t.Errorf("%s: esperava ErrInvalidHash, veio ok=%v err=%v", name, ok, err)
		}
	}
}

func TestDummyVerify(t *testing.T) {
	h := newTestHasher(t)
	if err := h.DummyVerify(context.Background(), "qualquer"); err != nil {
		t.Fatalf("DummyVerify: %v", err)
	}
}

// Com todas as vagas ocupadas, um contexto cancelado precisa liberar quem espera (sem goroutine presa).
func TestHashRespectsContextWhenBusy(t *testing.T) {
	h := newTestHasher(t)
	for range cap(h.sem) {
		h.sem <- struct{}{}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()

	if _, err := h.Hash(ctx, "x"); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("esperava DeadlineExceeded, veio %v", err)
	}
	if _, err := h.Verify(ctx, h.dummy, "x"); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Verify: esperava DeadlineExceeded, veio %v", err)
	}
}
