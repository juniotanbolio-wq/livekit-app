// Package config carrega a configuração do backend exclusivamente de variáveis de ambiente.
// Segredos nunca ficam em arquivo versionado: vêm do .env (ignorado pelo git) ou do ambiente do contêiner.
package config

import (
	"errors"
	"fmt"
	"log/slog"
	"strings"
)

// Config reúne tudo que o servidor precisa para subir. Segredos (JWT) e dados do LiveKit
// só passam a ser obrigatórios quando as fases R1a/R1b os utilizarem.
type Config struct {
	HTTPAddr     string
	LogLevel     slog.Level
	DatabasePath string
}

// Load lê as variáveis por meio de getenv (injetável para facilitar os testes) e valida os valores.
func Load(getenv func(string) string) (Config, error) {
	cfg := Config{
		HTTPAddr:     valueOr(getenv("HTTP_ADDR"), ":8080"),
		DatabasePath: valueOr(getenv("DATABASE_PATH"), "data/app.db"),
	}

	level, err := parseLevel(valueOr(getenv("LOG_LEVEL"), "info"))
	if err != nil {
		return Config{}, err
	}
	cfg.LogLevel = level

	if !strings.Contains(cfg.HTTPAddr, ":") {
		return Config{}, fmt.Errorf("HTTP_ADDR inválido %q: use o formato host:porta ou :porta", cfg.HTTPAddr)
	}
	return cfg, nil
}

func valueOr(value, fallback string) string {
	if v := strings.TrimSpace(value); v != "" {
		return v
	}
	return fallback
}

func parseLevel(value string) (slog.Level, error) {
	var level slog.Level
	if err := level.UnmarshalText([]byte(value)); err != nil {
		return 0, errors.Join(fmt.Errorf("LOG_LEVEL inválido %q (use debug, info, warn ou error)", value), err)
	}
	return level, nil
}
