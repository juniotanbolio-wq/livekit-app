package httpapi

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func newTestServer() *httptest.Server {
	return httptest.NewServer(NewHandler(slog.New(slog.NewTextHandler(io.Discard, nil))))
}

func TestHealth(t *testing.T) {
	srv := newTestServer()
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/health")
	if err != nil {
		t.Fatalf("requisição falhou: %v", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("leitura do corpo: %v", err)
	}
	if resp.StatusCode != http.StatusOK || !strings.Contains(string(body), `"status":"ok"`) {
		t.Fatalf("resposta inesperada: %d %s", resp.StatusCode, body)
	}
}

func TestHealthRejectsPost(t *testing.T) {
	srv := newTestServer()
	defer srv.Close()

	resp, err := http.Post(srv.URL+"/health", "text/plain", nil)
	if err != nil {
		t.Fatalf("requisição falhou: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("esperava 405, veio %d", resp.StatusCode)
	}
}
