package httpapi

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"
)

func request(remote string, xff ...string) *http.Request {
	r := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/", nil)
	r.RemoteAddr = remote
	for _, v := range xff {
		r.Header.Add("X-Forwarded-For", v)
	}
	return r
}

func TestClientIP(t *testing.T) {
	proxy := []netip.Prefix{netip.MustParsePrefix("10.0.0.0/8")}

	cases := []struct {
		name    string
		req     *http.Request
		trusted []netip.Prefix
		want    string
	}{
		{"sem proxy confiável ignora X-Forwarded-For", request("203.0.113.9:5555", "1.1.1.1"), nil, "203.0.113.9"},
		{"conexão direta não confiável ignora o cabeçalho", request("203.0.113.9:5555", "10.1.1.1"), proxy, "203.0.113.9"},
		{"proxy confiável usa o cliente do cabeçalho", request("10.0.0.2:1", "198.51.100.7"), proxy, "198.51.100.7"},
		{"cliente não consegue forjar à esquerda", request("10.0.0.2:1", "6.6.6.6, 198.51.100.7"), proxy, "198.51.100.7"},
		{"cadeia de proxies confiáveis", request("10.0.0.2:1", "198.51.100.7, 10.0.0.9"), proxy, "198.51.100.7"},
		{"vários cabeçalhos somados", request("10.0.0.2:1", "6.6.6.6", "198.51.100.7"), proxy, "198.51.100.7"},
		{"cabeçalho malformado volta ao IP da conexão", request("10.0.0.2:1", "lixo"), proxy, "10.0.0.2"},
		{"sem cabeçalho", request("10.0.0.2:1"), proxy, "10.0.0.2"},
		{"IPv4 mapeado em IPv6", request("[::ffff:203.0.113.9]:1"), nil, "203.0.113.9"},
		{"IPv6 agrupa por /64", request("[2001:db8:1:2:aaaa:bbbb:cccc:dddd]:1"), nil, "2001:db8:1:2::/64"},
	}
	for _, c := range cases {
		if got := clientIP(c.req, c.trusted); got != c.want {
			t.Errorf("%s: %q, queria %q", c.name, got, c.want)
		}
	}

	// Dois endereços do mesmo /64 compartilham a chave; outro /64 não.
	a := clientIP(request("[2001:db8:1:2::1]:1"), nil)
	b := clientIP(request("[2001:db8:1:2::ffff]:1"), nil)
	c := clientIP(request("[2001:db8:1:3::1]:1"), nil)
	if a != b || a == c {
		t.Errorf("agrupamento /64 incorreto: %s %s %s", a, b, c)
	}
}

func TestRecovererTurnsPanicInto500(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	h := recoverer(logger)(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { panic("boom") }))

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, request("192.0.2.1:1234"))
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("esperava 500, veio %d", rec.Code)
	}
	if body := rec.Body.String(); !strings.Contains(body, "Erro interno do servidor") || strings.Contains(body, "boom") {
		t.Fatalf("o corpo não pode vazar detalhes do panic: %s", body)
	}
}
