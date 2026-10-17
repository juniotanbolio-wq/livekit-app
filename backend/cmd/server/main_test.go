package main

import (
	"bytes"
	"context"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

func testEnv(t *testing.T) func(string) string {
	t.Helper()
	values := map[string]string{
		"DATABASE_PATH":       filepath.Join(t.TempDir(), "app.db"),
		"JWT_SECRET":          "0123456789abcdef0123456789abcdef",
		"LIVEKIT_API_KEY":     "devkey",
		"LIVEKIT_API_SECRET":  "fedcba9876543210fedcba9876543210",
		"SEED_ADMIN_USERNAME": "admin",
		"SEED_ADMIN_PASSWORD": "senha-do-admin",
	}
	return func(k string) string { return values[k] }
}

func runCmd(t *testing.T, getenv func(string) string, args ...string) (string, error) {
	t.Helper()
	var out bytes.Buffer
	err := run(context.Background(), args, getenv, &out)
	return out.String(), err
}

func TestSeedCommandIsIdempotent(t *testing.T) {
	getenv := testEnv(t)

	out, err := runCmd(t, getenv, "seed")
	if err != nil || !strings.Contains(out, "Canais garantidos: 7") || !strings.Contains(out, "criado") {
		t.Fatalf("primeiro seed: %q %v", out, err)
	}
	out, err = runCmd(t, getenv, "seed")
	if err != nil || !strings.Contains(out, "já existia") {
		t.Fatalf("segundo seed: %q %v", out, err)
	}
}

func TestSeedCommandNeedsAdminCredentials(t *testing.T) {
	base := testEnv(t)
	getenv := func(k string) string {
		if k == "SEED_ADMIN_PASSWORD" {
			return ""
		}
		return base(k)
	}
	if _, err := runCmd(t, getenv, "seed"); err == nil {
		t.Fatal("seed sem senha de admin deveria falhar")
	}
}

func TestInviteCreateCommand(t *testing.T) {
	getenv := testEnv(t)

	out, err := runCmd(t, getenv, "invite", "create", "--hours", "24")
	if err != nil {
		t.Fatalf("invite create: %v", err)
	}
	if !regexp.MustCompile(`Código de convite: [A-Za-z0-9_-]{16}\n`).MatchString(out) || !strings.Contains(out, "24h") {
		t.Fatalf("saída inesperada: %q", out)
	}

	// Cada execução gera um código diferente.
	again, err := runCmd(t, getenv, "invite", "create")
	if err != nil || again == out {
		t.Fatalf("convites deveriam ser distintos: %q %v", again, err)
	}
}

func TestInviteCreateRejectsBadArguments(t *testing.T) {
	getenv := testEnv(t)
	for _, args := range [][]string{
		{"invite"},
		{"invite", "list"},
		{"invite", "create", "--hours", "0"},
		{"invite", "create", "--hours", "99999"},
		{"invite", "create", "--hours", "abc"},
		{"invite", "create", "--nada"},
	} {
		if _, err := runCmd(t, getenv, args...); err == nil {
			t.Errorf("%v deveria falhar", args)
		}
	}
}

func TestUnknownCommand(t *testing.T) {
	if _, err := runCmd(t, testEnv(t), "explodir"); err == nil {
		t.Fatal("comando desconhecido deveria falhar")
	}
}

func TestRunFailsWithoutRequiredConfig(t *testing.T) {
	if _, err := runCmd(t, func(string) string { return "" }, "seed"); err == nil {
		t.Fatal("sem JWT_SECRET etc. deveria falhar")
	}
}
