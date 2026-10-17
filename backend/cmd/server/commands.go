package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"time"

	"livekit-app/backend/internal/config"
)

const maxInviteHours = 8760 // um ano

// seed garante os canais de voz e o admin definido em SEED_ADMIN_USERNAME / SEED_ADMIN_PASSWORD.
func seed(ctx context.Context, cfg config.Config, stdout io.Writer) (err error) {
	svc, closeDB, err := openService(ctx, cfg)
	if err != nil {
		return err
	}
	defer func() { err = errors.Join(err, closeDB()) }()

	if cfg.SeedAdminUsername == "" || cfg.SeedAdminPassword == "" {
		return errors.New("defina SEED_ADMIN_USERNAME e SEED_ADMIN_PASSWORD no ambiente (.env)")
	}
	result, err := svc.Seed(ctx, cfg.SeedAdminUsername, cfg.SeedAdminPassword)
	if err != nil {
		return fmt.Errorf("seed: %w", err)
	}
	adminLine := fmt.Sprintf("Admin %q já existia; senha mantida", cfg.SeedAdminUsername)
	if result.AdminCreated {
		adminLine = fmt.Sprintf("Admin %q criado", cfg.SeedAdminUsername)
	}
	return printLines(stdout, fmt.Sprintf("Canais garantidos: %d", result.Channels), adminLine)
}

// printLines escreve cada linha em stdout e devolve o erro de escrita (por exemplo, pipe fechado).
func printLines(w io.Writer, lines ...string) error {
	for _, line := range lines {
		if _, err := io.WriteString(w, line+"\n"); err != nil {
			return fmt.Errorf("escrever saída: %w", err)
		}
	}
	return nil
}

// invite trata `invite create [--hours N]`.
func invite(ctx context.Context, cfg config.Config, args []string, stdout io.Writer) (err error) {
	if len(args) == 0 || args[0] != "create" {
		return errors.New("uso: server invite create [--hours N]")
	}
	flags := flag.NewFlagSet("invite create", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	hours := flags.Int("hours", int(cfg.InviteTTL/time.Hour), "validade do convite em horas")
	if err := flags.Parse(args[1:]); err != nil {
		return fmt.Errorf("argumentos: %w", err)
	}
	if *hours < 1 || *hours > maxInviteHours {
		return fmt.Errorf("--hours precisa estar entre 1 e %d", maxInviteHours)
	}

	svc, closeDB, err := openService(ctx, cfg)
	if err != nil {
		return err
	}
	defer func() { err = errors.Join(err, closeDB()) }()

	code, expires, err := svc.CreateInvite(ctx, time.Duration(*hours)*time.Hour)
	if err != nil {
		return fmt.Errorf("criar convite: %w", err)
	}
	// O código só aparece aqui: no banco fica apenas o hash.
	return printLines(stdout,
		"Código de convite: "+code,
		fmt.Sprintf("Válido até: %s (%dh, uso único)", expires.Local().Format("02/01/2006 15:04"), *hours))
}
