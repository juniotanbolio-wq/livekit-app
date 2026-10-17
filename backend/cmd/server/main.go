// Comando server: ponto de entrada do backend.
//
// Uso:
//
//	server [serve]               sobe a API HTTP (padrão)
//	server seed                  garante os 7 canais de voz e o usuário admin (idempotente)
//	server invite create [--hours N]   cria um convite de uso único e imprime o código
package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	lksdk "github.com/livekit/server-sdk-go/v2"

	"livekit-app/backend/internal/auth"
	"livekit-app/backend/internal/config"
	"livekit-app/backend/internal/db"
	"livekit-app/backend/internal/httpapi"
	"livekit-app/backend/internal/livekit"
	"livekit-app/backend/internal/presence"
	"livekit-app/backend/internal/ratelimit"
	"livekit-app/backend/internal/realtime"
	"livekit-app/backend/internal/service"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	err := run(ctx, os.Args[1:], os.Getenv, os.Stdout)
	stop()
	if err != nil {
		fmt.Fprintln(os.Stderr, "erro fatal:", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, args []string, getenv func(string) string, stdout io.Writer) error {
	cfg, err := config.Load(getenv)
	if err != nil {
		return fmt.Errorf("configuração: %w", err)
	}
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: cfg.LogLevel}))

	command := "serve"
	if len(args) > 0 {
		command = args[0]
	}
	switch command {
	case "serve":
		return serve(ctx, cfg, logger)
	case "seed":
		return seed(ctx, cfg, stdout)
	case "invite":
		return invite(ctx, cfg, args[1:], stdout)
	default:
		return fmt.Errorf("comando desconhecido %q (use serve, seed ou invite create)", command)
	}
}

// openService abre o banco (aplicando migrações) e monta o serviço. O fechamento do banco fica com o chamador.
func openService(ctx context.Context, cfg config.Config) (*service.Service, func() error, error) {
	conn, err := db.Open(ctx, cfg.DatabasePath)
	if err != nil {
		return nil, nil, fmt.Errorf("banco de dados: %w", err)
	}
	hasher, err := auth.NewHasher(auth.DefaultParams)
	if err != nil {
		return nil, nil, errors.Join(fmt.Errorf("hasher de senhas: %w", err), conn.Close())
	}
	return service.New(conn, hasher, time.Now), conn.Close, nil
}

func serve(ctx context.Context, cfg config.Config, logger *slog.Logger) (err error) {
	svc, closeDB, err := openService(ctx, cfg)
	if err != nil {
		return err
	}
	defer func() { err = errors.Join(err, closeDB()) }()

	limiter := ratelimit.New(cfg.AuthRateLimit, cfg.AuthRateWindow, time.Now)
	tokens := auth.NewTokens(cfg.JWTSecret, cfg.JWTTTL, time.Now)

	// Tempo real: os webhooks do LiveKit alimentam o Tracker (presença em memória), o hub entrega ao
	// WebSocket e o reconciliador corrige o que os webhooks deixarem escapar.
	tracker := presence.New(time.Now)
	hub := realtime.NewHub(realtime.Config{
		AuthTimeout:           cfg.WSAuthTimeout,
		PingInterval:          cfg.WSPingInterval,
		MaxConnsPerUser:       cfg.WSMaxConnsPerUser,
		MaxConns:              cfg.WSMaxConns,
		AllowedOrigins:        cfg.CORSOrigins,
		MentionSenderLimit:    cfg.MentionSenderLimit,
		MentionRecipientLimit: cfg.MentionRecipientLimit,
		MentionWindow:         cfg.MentionWindow,
	}, realtime.Deps{Logger: logger, Tracker: tracker, Directory: svc, Tokens: tokens, Now: time.Now})
	// Fecha as conexões WebSocket ANTES de o banco fechar (defer roda em ordem inversa): os handlers ainda consultam o serviço.
	defer hub.Close()
	reconciler := livekit.NewReconciler(
		lksdk.NewRoomServiceClient(cfg.LiveKitURL, cfg.LiveKitAPIKey, cfg.LiveKitAPISecret), tracker, logger, time.Now)

	handler, err := httpapi.NewHandler(httpapi.Deps{
		Logger:         logger,
		Service:        svc,
		Tokens:         tokens,
		LiveKit:        livekit.NewIssuer(cfg.LiveKitAPIKey, cfg.LiveKitAPISecret, cfg.LiveKitPublicURL, cfg.LiveKitTokenTTL),
		AuthLimiter:    limiter,
		CORSOrigins:    cfg.CORSOrigins,
		TrustedProxies: cfg.TrustedProxies,
		MaxBodyBytes:   cfg.MaxBodyBytes,
		WebSocket:      hub,
		Webhook:        livekit.NewWebhookReceiver(cfg.LiveKitAPIKey, cfg.LiveKitAPISecret, tracker, logger),
	})
	if err != nil {
		return fmt.Errorf("montar roteador: %w", err)
	}

	// Os timeouts evitam que conexões lentas (slowloris) prendam goroutines indefinidamente.
	srv := &http.Server{
		Addr:              cfg.HTTPAddr,
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    1 << 20,
	}

	// As rotinas de fundo (limpeza dos limitadores e reconciliação com o LiveKit) param junto com o servidor;
	// o wg garante que todas terminaram antes de a função retornar (nenhuma goroutine vazada).
	bgCtx, cancelBackground := context.WithCancel(ctx)
	var background sync.WaitGroup
	background.Go(func() { limiter.Run(bgCtx, time.Minute) })
	background.Go(func() { hub.Run(bgCtx) })
	background.Go(func() { reconciler.Run(bgCtx, cfg.ReconcileInterval) })
	defer func() {
		cancelBackground()
		background.Wait()
	}()

	// Canal com buffer 1: a goroutine de ListenAndServe nunca fica bloqueada ao devolver o erro.
	serveErr := make(chan error, 1)
	go func() {
		logger.Info("servidor iniciado", "addr", cfg.HTTPAddr)
		serveErr <- srv.ListenAndServe()
	}()

	select {
	case err := <-serveErr:
		if !errors.Is(err, http.ErrServerClosed) {
			return fmt.Errorf("servidor HTTP: %w", err)
		}
		return nil
	case <-ctx.Done():
		logger.Info("encerrando servidor")
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		return fmt.Errorf("shutdown: %w", err)
	}
	// Espera a goroutine terminar para não vazá-la.
	if err := <-serveErr; err != nil && !errors.Is(err, http.ErrServerClosed) {
		return fmt.Errorf("servidor HTTP: %w", err)
	}
	return nil
}
