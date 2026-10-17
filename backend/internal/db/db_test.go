package db

import (
	"context"
	"path/filepath"
	"testing"
)

func TestOpenCreatesSchemaAndIsReopenable(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sub", "app.db") // o subdiretório não existe ainda
	ctx := context.Background()

	conn, err := Open(ctx, path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	for _, table := range []string{"users", "invites", "channels"} {
		var name string
		err := conn.QueryRowContext(ctx, "SELECT name FROM sqlite_master WHERE type='table' AND name=?", table).Scan(&name)
		if err != nil {
			t.Errorf("tabela %s ausente: %v", table, err)
		}
	}

	var fk int
	if err := conn.QueryRowContext(ctx, "PRAGMA foreign_keys").Scan(&fk); err != nil || fk != 1 {
		t.Errorf("foreign_keys deveria estar ligado: %d, %v", fk, err)
	}
	var mode string
	if err := conn.QueryRowContext(ctx, "PRAGMA journal_mode").Scan(&mode); err != nil || mode != "wal" {
		t.Errorf("journal_mode deveria ser wal: %q, %v", mode, err)
	}
	if err := conn.Close(); err != nil {
		t.Fatal(err)
	}

	// Reabrir não pode falhar nem refazer migrações.
	again, err := Open(ctx, path)
	if err != nil {
		t.Fatalf("reabrir: %v", err)
	}
	if err := again.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestUsernameIsCaseInsensitiveUnique(t *testing.T) {
	path := filepath.Join(t.TempDir(), "app.db")
	ctx := context.Background()
	conn, err := Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := conn.Close(); err != nil {
			t.Error(err)
		}
	})

	insert := "INSERT INTO users (id, username, password_hash, is_admin, created_at) VALUES (?, ?, 'x', 0, 0)"
	if _, err := conn.ExecContext(ctx, insert, "1", "Admin"); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.ExecContext(ctx, insert, "2", "admin"); err == nil {
		t.Fatal("'admin' deveria conflitar com 'Admin'")
	}
}
