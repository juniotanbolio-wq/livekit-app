package config

import (
	"log/slog"
	"net/netip"
	"strings"
	"testing"
	"time"
)

const (
	secretA = "0123456789abcdef0123456789abcdef"
	secretB = "fedcba9876543210fedcba9876543210"
)

// validEnv devolve o mínimo obrigatório; os testes sobrescrevem o que querem exercitar.
func validEnv(overrides map[string]string) func(string) string {
	values := map[string]string{
		"JWT_SECRET":         secretA,
		"LIVEKIT_API_KEY":    "devkey",
		"LIVEKIT_API_SECRET": secretB,
	}
	for k, v := range overrides {
		values[k] = v
	}
	return func(key string) string { return values[key] }
}

func TestLoadDefaults(t *testing.T) {
	cfg, err := Load(validEnv(nil))
	if err != nil {
		t.Fatalf("erro inesperado: %v", err)
	}
	if cfg.HTTPAddr != ":8080" || cfg.LogLevel != slog.LevelInfo || cfg.DatabasePath != "data/app.db" {
		t.Fatalf("padrões básicos incorretos: %+v", cfg)
	}
	if cfg.JWTTTL != 7*24*time.Hour || cfg.LiveKitTokenTTL != 6*time.Hour || cfg.InviteTTL != 72*time.Hour {
		t.Fatalf("durações padrão incorretas: %+v", cfg)
	}
	if cfg.AuthRateLimit != 10 || cfg.AuthRateWindow != 15*time.Minute || cfg.MaxBodyBytes != 32*1024 {
		t.Fatalf("limites padrão incorretos: %+v", cfg)
	}
	if cfg.LiveKitPublicURL != "ws://localhost:7880" {
		t.Fatalf("URL pública do LiveKit incorreta: %q", cfg.LiveKitPublicURL)
	}
	if len(cfg.CORSOrigins) != 3 || len(cfg.TrustedProxies) != 0 {
		t.Fatalf("CORS/proxies padrão incorretos: %+v", cfg)
	}
}

func TestLoadOverrides(t *testing.T) {
	cfg, err := Load(validEnv(map[string]string{
		"HTTP_ADDR":        "127.0.0.1:9000",
		"LOG_LEVEL":        "debug",
		"JWT_TTL":          "30m",
		"INVITE_TTL_HOURS": "24",
		"TRUSTED_PROXIES":  "10.0.0.0/8, 192.168.1.5",
		"CORS_ORIGINS":     "app://desktop",
	}))
	if err != nil {
		t.Fatalf("erro inesperado: %v", err)
	}
	if cfg.HTTPAddr != "127.0.0.1:9000" || cfg.LogLevel != slog.LevelDebug {
		t.Fatalf("valores não aplicados: %+v", cfg)
	}
	if cfg.JWTTTL != 30*time.Minute || cfg.InviteTTL != 24*time.Hour {
		t.Fatalf("durações não aplicadas: %+v", cfg)
	}
	want := []netip.Prefix{netip.MustParsePrefix("10.0.0.0/8"), netip.MustParsePrefix("192.168.1.5/32")}
	if len(cfg.TrustedProxies) != 2 || cfg.TrustedProxies[0] != want[0] || cfg.TrustedProxies[1] != want[1] {
		t.Fatalf("proxies confiáveis incorretos: %v", cfg.TrustedProxies)
	}
	if len(cfg.CORSOrigins) != 1 || cfg.CORSOrigins[0] != "app://desktop" {
		t.Fatalf("CORS incorreto: %v", cfg.CORSOrigins)
	}
}

func TestLoadDurationInDays(t *testing.T) {
	cfg, err := Load(validEnv(map[string]string{"JWT_TTL": "2d"}))
	if err != nil {
		t.Fatalf("erro inesperado: %v", err)
	}
	if cfg.JWTTTL != 48*time.Hour {
		t.Fatalf("2d deveria ser 48h, veio %v", cfg.JWTTTL)
	}
}

func TestLoadInvalid(t *testing.T) {
	cases := map[string]map[string]string{
		"nível":          {"LOG_LEVEL": "barulhento"},
		"addr":           {"HTTP_ADDR": "8080"},
		"jwt curto":      {"JWT_SECRET": "curto"},
		"jwt ausente":    {"JWT_SECRET": ""},
		"lk secret":      {"LIVEKIT_API_SECRET": "curto"},
		"lk key ausente": {"LIVEKIT_API_KEY": ""},
		"lk url":         {"LIVEKIT_PUBLIC_URL": "http://localhost:7880"},
		"duração":        {"JWT_TTL": "bastante"},
		"duração zero":   {"LIVEKIT_TOKEN_TTL": "0s"},
		"limite":         {"AUTH_RATE_LIMIT": "0"},
		"corpo":          {"MAX_BODY_BYTES": "-1"},
		"convite":        {"INVITE_TTL_HOURS": "abc"},
		"proxy":          {"TRUSTED_PROXIES": "não-é-ip"},
		"lk url interna": {"LIVEKIT_URL": "ws://livekit:7880"},
		"reconciliação":  {"RECONCILE_INTERVAL": "0s"},
		"ws por usuário": {"WS_MAX_CONNS_PER_USER": "0"},
		"menção":         {"MENTION_SENDER_LIMIT": "-3"},
	}
	for name, overrides := range cases {
		if _, err := Load(validEnv(overrides)); err == nil {
			t.Errorf("%s: esperava erro", name)
		}
	}
}

func TestLoadReportsAllErrorsAtOnce(t *testing.T) {
	_, err := Load(func(string) string { return "" })
	if err == nil {
		t.Fatal("esperava erro com ambiente vazio")
	}
	for _, key := range []string{"JWT_SECRET", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET"} {
		if !strings.Contains(err.Error(), key) {
			t.Errorf("erro deveria mencionar %s: %v", key, err)
		}
	}
}

func TestLoadRealtimeDefaults(t *testing.T) {
	cfg, err := Load(validEnv(nil))
	if err != nil {
		t.Fatalf("erro inesperado: %v", err)
	}
	if cfg.LiveKitURL != "http://localhost:7880" {
		t.Fatalf("LIVEKIT_URL deveria derivar da pública: %q", cfg.LiveKitURL)
	}
	if cfg.ReconcileInterval != time.Minute || cfg.WSAuthTimeout != 5*time.Second || cfg.WSPingInterval != 20*time.Second {
		t.Fatalf("durações de tempo real incorretas: %+v", cfg)
	}
	if cfg.WSMaxConnsPerUser != 3 || cfg.WSMaxConns != 200 {
		t.Fatalf("limites de conexão incorretos: %+v", cfg)
	}
	if cfg.MentionSenderLimit != 5 || cfg.MentionRecipientLimit != 5 || cfg.MentionWindow != 30*time.Second {
		t.Fatalf("limites de menção incorretos: %+v", cfg)
	}
}

func TestLoadLiveKitURLDerivation(t *testing.T) {
	cfg, err := Load(validEnv(map[string]string{"LIVEKIT_PUBLIC_URL": "wss://live.exemplo.com"}))
	if err != nil {
		t.Fatalf("erro inesperado: %v", err)
	}
	if cfg.LiveKitURL != "https://live.exemplo.com" {
		t.Fatalf("wss deveria virar https: %q", cfg.LiveKitURL)
	}

	cfg, err = Load(validEnv(map[string]string{"LIVEKIT_URL": "http://livekit:7880"}))
	if err != nil {
		t.Fatalf("erro inesperado: %v", err)
	}
	if cfg.LiveKitURL != "http://livekit:7880" {
		t.Fatalf("LIVEKIT_URL explícita deveria prevalecer: %q", cfg.LiveKitURL)
	}
}
