package config

import (
	"log/slog"
	"testing"
)

func env(values map[string]string) func(string) string {
	return func(key string) string { return values[key] }
}

func TestLoadDefaults(t *testing.T) {
	cfg, err := Load(env(nil))
	if err != nil {
		t.Fatalf("erro inesperado: %v", err)
	}
	if cfg.HTTPAddr != ":8080" || cfg.LogLevel != slog.LevelInfo || cfg.DatabasePath != "data/app.db" {
		t.Fatalf("padrões incorretos: %+v", cfg)
	}
}

func TestLoadOverrides(t *testing.T) {
	cfg, err := Load(env(map[string]string{"HTTP_ADDR": "127.0.0.1:9000", "LOG_LEVEL": "debug"}))
	if err != nil {
		t.Fatalf("erro inesperado: %v", err)
	}
	if cfg.HTTPAddr != "127.0.0.1:9000" || cfg.LogLevel != slog.LevelDebug {
		t.Fatalf("valores não aplicados: %+v", cfg)
	}
}

func TestLoadInvalid(t *testing.T) {
	cases := map[string]map[string]string{
		"nível": {"LOG_LEVEL": "barulhento"},
		"addr":  {"HTTP_ADDR": "8080"},
	}
	for name, values := range cases {
		if _, err := Load(env(values)); err == nil {
			t.Errorf("%s: esperava erro", name)
		}
	}
}
