package httpapi

import (
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"net/netip"
	"slices"
	"strings"
	"time"

	"livekit-app/backend/internal/auth"
	"livekit-app/backend/internal/ratelimit"
)

type middleware func(http.Handler) http.Handler

// chain aplica os middlewares com o primeiro da lista como o mais externo.
func chain(h http.Handler, mws ...middleware) http.Handler {
	for i := len(mws) - 1; i >= 0; i-- {
		h = mws[i](h)
	}
	return h
}

// statusRecorder guarda o status escrito, para o log de acesso. Unwrap preserva Flush/Hijack
// (http.ResponseController), necessários para o WebSocket da R1b.
type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (s *statusRecorder) WriteHeader(code int) {
	s.status = code
	s.ResponseWriter.WriteHeader(code)
}

func (s *statusRecorder) Unwrap() http.ResponseWriter { return s.ResponseWriter }

// recoverer impede que um panic num handler derrube o processo inteiro (e as outras conexões).
func recoverer(logger *slog.Logger) middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			defer func() {
				rec := recover()
				if rec == nil {
					return
				}
				if rec == http.ErrAbortHandler { //nolint:errorlint // sentinela de panic, não é um error encadeado
					panic(rec)
				}
				logger.Error("panic no handler", "erro", fmt.Sprint(rec), "metodo", r.Method, "caminho", r.URL.Path)
				writeError(logger, w, http.StatusInternalServerError, "Erro interno do servidor", nil)
			}()
			next.ServeHTTP(w, r)
		})
	}
}

// accessLog registra uma linha por requisição. Nunca registra cabeçalhos nem corpo:
// Authorization carrega o token de sessão e o corpo carrega senhas e códigos de convite.
func accessLog(logger *slog.Logger, trusted []netip.Prefix) middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
			next.ServeHTTP(rec, r)
			logger.Info("requisição",
				"metodo", r.Method, "caminho", r.URL.Path, "status", rec.status,
				"duracao_ms", time.Since(start).Milliseconds(), "ip", clientIP(r, trusted))
		})
	}
}

// cors aceita só as origens configuradas. Requisições sem cabeçalho Origin (curl, scripts, processo
// principal do Electron) passam: CORS é proteção de navegador, e a autorização real é o token.
// Uma origem desconhecida recebe 403 em vez de só ficar sem os cabeçalhos CORS, para o erro ficar explícito.
func cors(logger *slog.Logger, allowed []string) middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			origin := r.Header.Get("Origin")
			if origin == "" {
				next.ServeHTTP(w, r)
				return
			}
			if !slices.Contains(allowed, origin) {
				writeError(logger, w, http.StatusForbidden, "Origem não permitida", nil)
				return
			}
			h := w.Header()
			h.Set("Access-Control-Allow-Origin", origin)
			// Vary: a resposta muda conforme a origem; sem isso um cache poderia servir o cabeçalho errado.
			h.Add("Vary", "Origin")
			if r.Method == http.MethodOptions && r.Header.Get("Access-Control-Request-Method") != "" {
				h.Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
				h.Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
				h.Set("Access-Control-Max-Age", "600")
				w.WriteHeader(http.StatusNoContent)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// limitBody recusa corpos grandes antes de qualquer processamento. O Content-Length dá a resposta
// imediata (413); o MaxBytesReader cobre corpos sem tamanho declarado (chunked).
func limitBody(logger *slog.Logger, maxBytes int64) middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.ContentLength > maxBytes {
				writeError(logger, w, http.StatusRequestEntityTooLarge, "Corpo da requisição grande demais", nil)
				return
			}
			r.Body = http.MaxBytesReader(w, r.Body, maxBytes)
			next.ServeHTTP(w, r)
		})
	}
}

// authRatePrefix: tudo que tenta adivinhar senha ou convite fica sob este prefixo.
const authRatePrefix = "/api/auth/"

// rateLimitAuth limita cadastro e login por IP, com um contador compartilhado entre as duas rotas
// (como na v1): quem erra senhas não ganha mais tentativas alternando para o cadastro.
func rateLimitAuth(logger *slog.Logger, limiter *ratelimit.Limiter, trusted []netip.Prefix) middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !strings.HasPrefix(r.URL.Path, authRatePrefix) || r.Method == http.MethodOptions {
				next.ServeHTTP(w, r)
				return
			}
			ok, retry := limiter.Allow(clientIP(r, trusted))
			if !ok {
				seconds := int(math.Ceil(retry.Seconds()))
				w.Header().Set("Retry-After", fmt.Sprint(max(seconds, 1)))
				writeError(logger, w, http.StatusTooManyRequests, "Muitas tentativas, tente novamente mais tarde", nil)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// identify extrai o usuário do token Bearer, se houver e for válido, e o põe no contexto.
// Não rejeita nada: quem exige autenticação é o contrato (securitySchemes do openapi.yaml), via
// AuthenticationFunc do validador. Assim a lista de rotas protegidas vive num lugar só.
func identify(tokens *auth.Tokens) middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			header := r.Header.Get("Authorization")
			scheme, token, found := strings.Cut(header, " ")
			if found && strings.EqualFold(scheme, "Bearer") {
				if userID, err := tokens.Verify(strings.TrimSpace(token)); err == nil {
					r = r.WithContext(auth.WithUserID(r.Context(), userID))
				}
			}
			next.ServeHTTP(w, r)
		})
	}
}

// clientIP devolve a chave de cliente usada no rate limit e nos logs.
// X-Forwarded-For só é considerado quando a conexão vem de um proxy confiável (TRUSTED_PROXIES):
// o cabeçalho é livre para qualquer cliente, e confiar nele sem essa checagem permitiria
// burlar o rate limit trocando o valor a cada requisição.
func clientIP(r *http.Request, trusted []netip.Prefix) string {
	peer, err := netip.ParseAddrPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	addr := peer.Addr().Unmap()
	if isTrusted(addr, trusted) {
		// Percorre da direita para a esquerda: os últimos itens foram acrescentados pelos nossos proxies;
		// o primeiro endereço que não é de proxy confiável é o cliente real.
		parts := strings.Split(strings.Join(r.Header.Values("X-Forwarded-For"), ","), ",")
		for i := len(parts) - 1; i >= 0; i-- {
			candidate, err := netip.ParseAddr(strings.TrimSpace(parts[i]))
			if err != nil {
				break // cabeçalho malformado: volta para o IP da conexão
			}
			candidate = candidate.Unmap()
			if !isTrusted(candidate, trusted) {
				return ipKey(candidate)
			}
		}
	}
	return ipKey(addr)
}

func isTrusted(addr netip.Addr, trusted []netip.Prefix) bool {
	return slices.ContainsFunc(trusted, func(p netip.Prefix) bool { return p.Contains(addr) })
}

// ipKey agrupa IPv6 por /64: um único cliente costuma controlar o /64 inteiro e giraria endereços
// para escapar do limite.
func ipKey(addr netip.Addr) string {
	if addr.Is6() {
		if prefix, err := addr.Prefix(64); err == nil {
			return prefix.String()
		}
	}
	return addr.String()
}
