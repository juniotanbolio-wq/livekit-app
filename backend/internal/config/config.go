// Package config carrega a configuração do backend exclusivamente de variáveis de ambiente.
// Segredos nunca ficam em arquivo versionado: vêm do .env (ignorado pelo git) ou do ambiente do contêiner.
package config

import (
	"errors"
	"fmt"
	"log/slog"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// minSecretLen é o tamanho mínimo aceito para segredos de assinatura (JWT e API secret do LiveKit).
const minSecretLen = 32

// Config reúne tudo que o servidor precisa para subir.
type Config struct {
	HTTPAddr     string
	LogLevel     slog.Level
	DatabasePath string

	// JWTSecret assina os tokens de sessão (HS256). Quem o conhece forja qualquer usuário.
	JWTSecret string
	JWTTTL    time.Duration

	// CORSOrigins é a lista exata de origens de navegador aceitas (o app Electron usa app://desktop).
	CORSOrigins []string

	LiveKitAPIKey    string
	LiveKitAPISecret string
	// LiveKitPublicURL é o endereço WebSocket que o cliente usa para falar com o LiveKit.
	LiveKitPublicURL string
	LiveKitTokenTTL  time.Duration

	InviteTTL time.Duration

	// Limite de tentativas nas rotas de autenticação, por IP.
	AuthRateLimit  int
	AuthRateWindow time.Duration

	MaxBodyBytes int64

	// TrustedProxies são os proxies cujo X-Forwarded-For é aceito. Vazio = usa sempre o IP da conexão,
	// porque o cabeçalho é forjável por qualquer cliente que fale direto com o servidor.
	TrustedProxies []netip.Prefix

	// Usados apenas pelo comando `seed`.
	SeedAdminUsername string
	SeedAdminPassword string
}

// Load lê as variáveis por meio de getenv (injetável para facilitar os testes) e valida os valores.
// Todos os erros de configuração são devolvidos juntos, para o operador corrigir de uma vez.
func Load(getenv func(string) string) (Config, error) {
	l := loader{getenv: getenv}

	cfg := Config{
		HTTPAddr:          l.str("HTTP_ADDR", ":8080"),
		DatabasePath:      l.str("DATABASE_PATH", "data/app.db"),
		JWTSecret:         l.secret("JWT_SECRET"),
		JWTTTL:            l.duration("JWT_TTL", 7*24*time.Hour),
		LiveKitAPIKey:     l.required("LIVEKIT_API_KEY"),
		LiveKitAPISecret:  l.secret("LIVEKIT_API_SECRET"),
		LiveKitPublicURL:  l.wsURL("LIVEKIT_PUBLIC_URL", "ws://localhost:7880"),
		LiveKitTokenTTL:   l.duration("LIVEKIT_TOKEN_TTL", 6*time.Hour),
		AuthRateLimit:     l.positiveInt("AUTH_RATE_LIMIT", 10),
		AuthRateWindow:    l.duration("AUTH_RATE_WINDOW", 15*time.Minute),
		MaxBodyBytes:      int64(l.positiveInt("MAX_BODY_BYTES", 32*1024)),
		SeedAdminUsername: strings.TrimSpace(getenv("SEED_ADMIN_USERNAME")),
		SeedAdminPassword: getenv("SEED_ADMIN_PASSWORD"),
	}

	level, err := parseLevel(l.str("LOG_LEVEL", "info"))
	if err != nil {
		l.errs = append(l.errs, err)
	}
	cfg.LogLevel = level

	if !strings.Contains(cfg.HTTPAddr, ":") {
		l.errs = append(l.errs, fmt.Errorf("HTTP_ADDR inválido %q: use o formato host:porta ou :porta", cfg.HTTPAddr))
	}

	cfg.CORSOrigins = splitList(l.str("CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173,app://desktop"))

	hours := l.positiveInt("INVITE_TTL_HOURS", 72)
	cfg.InviteTTL = time.Duration(hours) * time.Hour

	for _, item := range splitList(getenv("TRUSTED_PROXIES")) {
		prefix, err := parsePrefix(item)
		if err != nil {
			l.errs = append(l.errs, fmt.Errorf("TRUSTED_PROXIES inválido %q: %w", item, err))
			continue
		}
		cfg.TrustedProxies = append(cfg.TrustedProxies, prefix)
	}

	if err := errors.Join(l.errs...); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

// loader acumula os erros de validação em vez de parar no primeiro.
type loader struct {
	getenv func(string) string
	errs   []error
}

func (l *loader) str(key, fallback string) string {
	if v := strings.TrimSpace(l.getenv(key)); v != "" {
		return v
	}
	return fallback
}

func (l *loader) required(key string) string {
	v := strings.TrimSpace(l.getenv(key))
	if v == "" {
		l.errs = append(l.errs, fmt.Errorf("%s é obrigatória", key))
	}
	return v
}

func (l *loader) secret(key string) string {
	v := l.required(key)
	if v != "" && len(v) < minSecretLen {
		l.errs = append(l.errs, fmt.Errorf("%s precisa ter %d ou mais caracteres", key, minSecretLen))
	}
	return v
}

func (l *loader) positiveInt(key string, fallback int) int {
	raw := strings.TrimSpace(l.getenv(key))
	if raw == "" {
		return fallback
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n <= 0 {
		l.errs = append(l.errs, fmt.Errorf("%s inválida %q: use um inteiro positivo", key, raw))
		return fallback
	}
	return n
}

func (l *loader) duration(key string, fallback time.Duration) time.Duration {
	raw := strings.TrimSpace(l.getenv(key))
	if raw == "" {
		return fallback
	}
	d, err := parseDuration(raw)
	if err != nil || d <= 0 {
		l.errs = append(l.errs, fmt.Errorf("%s inválida %q: use formatos como 30m, 6h ou 7d", key, raw))
		return fallback
	}
	return d
}

func (l *loader) wsURL(key, fallback string) string {
	raw := l.str(key, fallback)
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "ws" && u.Scheme != "wss") || u.Host == "" {
		l.errs = append(l.errs, fmt.Errorf("%s inválida %q: use ws://host:porta ou wss://host", key, raw))
	}
	return raw
}

// parseDuration aceita o sufixo "d" (dias), que time.ParseDuration não conhece.
func parseDuration(raw string) (time.Duration, error) {
	if days, ok := strings.CutSuffix(raw, "d"); ok {
		n, err := strconv.Atoi(days)
		if err != nil {
			return 0, fmt.Errorf("dias inválidos: %w", err)
		}
		return time.Duration(n) * 24 * time.Hour, nil
	}
	d, err := time.ParseDuration(raw)
	if err != nil {
		return 0, fmt.Errorf("duração inválida: %w", err)
	}
	return d, nil
}

func parsePrefix(item string) (netip.Prefix, error) {
	if strings.Contains(item, "/") {
		p, err := netip.ParsePrefix(item)
		if err != nil {
			return netip.Prefix{}, fmt.Errorf("prefixo inválido: %w", err)
		}
		return p.Masked(), nil
	}
	addr, err := netip.ParseAddr(item)
	if err != nil {
		return netip.Prefix{}, fmt.Errorf("endereço inválido: %w", err)
	}
	return netip.PrefixFrom(addr, addr.BitLen()), nil
}

func splitList(value string) []string {
	var out []string
	for _, item := range strings.Split(value, ",") {
		if item = strings.TrimSpace(item); item != "" {
			out = append(out, item)
		}
	}
	return out
}

func parseLevel(value string) (slog.Level, error) {
	var level slog.Level
	if err := level.UnmarshalText([]byte(value)); err != nil {
		return 0, errors.Join(fmt.Errorf("LOG_LEVEL inválido %q (use debug, info, warn ou error)", value), err)
	}
	return level, nil
}
