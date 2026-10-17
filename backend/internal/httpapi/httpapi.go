// Package httpapi monta o roteador HTTP do backend.
package httpapi

import (
	"encoding/json"
	"log/slog"
	"net/http"
)

// NewHandler devolve o roteador raiz. Rotas de negócio entram a partir da fase R1a.
func NewHandler(logger *slog.Logger) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", healthHandler(logger))
	return mux
}

// healthHandler responde ao healthcheck do Docker/Caddy; não toca em nenhuma dependência externa
// para que "vivo" não dependa de banco ou LiveKit.
func healthHandler(logger *slog.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(map[string]string{"status": "ok"}); err != nil {
			logger.Error("falha ao escrever resposta do /health", "erro", err)
		}
	}
}
