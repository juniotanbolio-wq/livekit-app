// Package ratelimit limita tentativas por chave (IP) numa janela fixa, em memória.
package ratelimit

import (
	"context"
	"sync"
	"time"
)

// maxKeys limita a memória: um atacante com muitos IPs distintos (ex.: IPv6) não faz o mapa crescer sem fim.
const maxKeys = 50_000

type entry struct {
	count       int
	windowStart time.Time
}

// Limiter permite até limit eventos por chave a cada window. Seguro para uso concorrente.
type Limiter struct {
	limit  int
	window time.Duration
	now    func() time.Time

	mu      sync.Mutex // protege entries
	entries map[string]*entry
}

// New cria o limitador. now é injetável para testes.
func New(limit int, window time.Duration, now func() time.Time) *Limiter {
	return &Limiter{limit: limit, window: window, now: now, entries: make(map[string]*entry)}
}

// Allow registra uma tentativa de key. Se o limite foi excedido, devolve false e quanto falta para a janela reabrir.
func (l *Limiter) Allow(key string) (bool, time.Duration) {
	now := l.now()

	l.mu.Lock()
	defer l.mu.Unlock()

	e, ok := l.entries[key]
	if ok && now.Sub(e.windowStart) >= l.window {
		ok = false // janela anterior expirou; recomeça abaixo
	}
	if !ok {
		if _, exists := l.entries[key]; !exists && len(l.entries) >= maxKeys {
			l.purgeLocked(now)
			if len(l.entries) >= maxKeys {
				// Falha fechada: com a tabela cheia, recusar é mais seguro do que deixar passar.
				return false, l.window
			}
		}
		l.entries[key] = &entry{count: 1, windowStart: now}
		return true, 0
	}
	if e.count >= l.limit {
		return false, e.windowStart.Add(l.window).Sub(now)
	}
	e.count++
	return true, 0
}

// Run remove periodicamente as chaves expiradas até ctx ser cancelado. Bloqueia: chame numa goroutine
// e espere o retorno no encerramento para não vazá-la.
func (l *Limiter) Run(ctx context.Context, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			l.mu.Lock()
			l.purgeLocked(l.now())
			l.mu.Unlock()
		}
	}
}

// purgeLocked exige l.mu travado.
func (l *Limiter) purgeLocked(now time.Time) {
	for key, e := range l.entries {
		if now.Sub(e.windowStart) >= l.window {
			delete(l.entries, key)
		}
	}
}
