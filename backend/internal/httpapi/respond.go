package httpapi

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"net/http"

	"livekit-app/backend/internal/api"
)

// writeError escreve o corpo de erro padrão do contrato ({"error": "...", "details": ...}).
func writeError(logger *slog.Logger, w http.ResponseWriter, status int, message string, details any) {
	writeJSON(logger, w, status, api.ErrorResponse{Error: message, Details: details})
}

// writeJSON serializa antes de escrever, para que uma falha de codificação ainda possa virar um 500 limpo.
func writeJSON(logger *slog.Logger, w http.ResponseWriter, status int, body any) {
	var buf bytes.Buffer
	if err := json.NewEncoder(&buf).Encode(body); err != nil {
		logger.Error("falha ao serializar resposta", "erro", err)
		http.Error(w, `{"error":"Erro interno do servidor"}`, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if _, err := buf.WriteTo(w); err != nil {
		// Cliente desconectou no meio da resposta; nada a fazer além de registrar.
		logger.Debug("falha ao escrever resposta", "erro", err)
	}
}
