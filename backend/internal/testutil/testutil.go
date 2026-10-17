// Package testutil reúne apoios compartilhados pelos testes (banco temporário, relógio falso, hasher barato).
package testutil

import (
	"context"
	"database/sql"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"livekit-app/backend/internal/auth"
	"livekit-app/backend/internal/db"
)

// OpenDB abre um SQLite novo em diretório temporário, com as migrações reais aplicadas.
func OpenDB(t *testing.T) *sql.DB {
	t.Helper()
	conn, err := db.Open(context.Background(), filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("abrir banco de teste: %v", err)
	}
	t.Cleanup(func() {
		if err := conn.Close(); err != nil {
			t.Errorf("fechar banco de teste: %v", err)
		}
	})
	return conn
}

// FastHasher usa custos mínimos de argon2id: os testes não precisam de 64 MiB por hash.
func FastHasher(t *testing.T) *auth.Hasher {
	t.Helper()
	h, err := auth.NewHasher(auth.Params{MemoryKiB: 8, Time: 1, Threads: 1})
	if err != nil {
		t.Fatalf("criar hasher de teste: %v", err)
	}
	return h
}

// Clock é um relógio controlável pelo teste.
type Clock struct {
	mu  sync.Mutex // protege now
	now time.Time
}

// NewClock começa num instante fixo e arredondado a segundos (o banco guarda segundos Unix).
func NewClock() *Clock {
	return &Clock{now: time.Date(2026, 10, 17, 12, 0, 0, 0, time.UTC)}
}

// Now devolve o instante atual do relógio falso.
func (c *Clock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

// Advance avança o relógio.
func (c *Clock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
}
