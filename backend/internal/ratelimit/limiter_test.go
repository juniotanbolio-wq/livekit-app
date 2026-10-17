package ratelimit

import (
	"context"
	"strconv"
	"sync"
	"testing"
	"time"

	"livekit-app/backend/internal/testutil"
)

func TestAllowUpToLimitThenBlock(t *testing.T) {
	clock := testutil.NewClock()
	l := New(3, time.Minute, clock.Now)

	for i := range 3 {
		if ok, _ := l.Allow("1.2.3.4"); !ok {
			t.Fatalf("tentativa %d deveria passar", i+1)
		}
	}
	ok, retry := l.Allow("1.2.3.4")
	if ok {
		t.Fatal("quarta tentativa deveria ser bloqueada")
	}
	if retry <= 0 || retry > time.Minute {
		t.Fatalf("retry-after fora do esperado: %v", retry)
	}
}

func TestKeysAreIndependent(t *testing.T) {
	l := New(1, time.Minute, testutil.NewClock().Now)
	if ok, _ := l.Allow("a"); !ok {
		t.Fatal("a deveria passar")
	}
	if ok, _ := l.Allow("b"); !ok {
		t.Fatal("b deveria passar mesmo com a esgotada")
	}
	if ok, _ := l.Allow("a"); ok {
		t.Fatal("a deveria estar bloqueada")
	}
}

func TestWindowReopens(t *testing.T) {
	clock := testutil.NewClock()
	l := New(1, time.Minute, clock.Now)
	l.Allow("a")
	if ok, _ := l.Allow("a"); ok {
		t.Fatal("deveria bloquear dentro da janela")
	}
	clock.Advance(time.Minute)
	if ok, _ := l.Allow("a"); !ok {
		t.Fatal("deveria liberar depois da janela")
	}
}

func TestRunPurgesExpiredEntriesAndStops(t *testing.T) {
	clock := testutil.NewClock()
	l := New(1, time.Minute, clock.Now)
	l.Allow("a")
	clock.Advance(2 * time.Minute)

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		l.Run(ctx, 5*time.Millisecond)
	}()

	deadline := time.Now().Add(2 * time.Second)
	for {
		l.mu.Lock()
		n := len(l.entries)
		l.mu.Unlock()
		if n == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("entrada expirada não foi removida (restam %d)", n)
		}
		time.Sleep(5 * time.Millisecond)
	}

	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Run não terminou após cancelar o contexto (goroutine vazada)")
	}
}

func TestFullTableFailsClosed(t *testing.T) {
	l := New(1, time.Hour, testutil.NewClock().Now)
	for i := range maxKeys {
		if ok, _ := l.Allow("k" + strconv.Itoa(i)); !ok {
			t.Fatalf("chave %d deveria passar", i)
		}
	}
	if ok, _ := l.Allow("nova"); ok {
		t.Fatal("com a tabela cheia e sem entradas expiradas, chave nova deve ser recusada")
	}
}

func TestConcurrentAllowIsExact(t *testing.T) {
	const limit = 50
	l := New(limit, time.Hour, testutil.NewClock().Now)

	var wg sync.WaitGroup
	var mu sync.Mutex // protege allowed
	allowed := 0
	for range 200 {
		wg.Go(func() {
			if ok, _ := l.Allow("ip"); ok {
				mu.Lock()
				allowed++
				mu.Unlock()
			}
		})
	}
	wg.Wait()
	if allowed != limit {
		t.Fatalf("permitidas = %d, queria exatamente %d", allowed, limit)
	}
}
