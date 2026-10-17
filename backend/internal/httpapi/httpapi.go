// Package httpapi monta o servidor HTTP do backend: roteamento gerado a partir do contrato OpenAPI,
// validação de requisições, autenticação e os middlewares de segurança.
package httpapi

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/netip"

	"github.com/getkin/kin-openapi/openapi3filter"
	"github.com/getkin/kin-openapi/routers"
	nethttpmiddleware "github.com/oapi-codegen/nethttp-middleware"

	"livekit-app/backend/internal/api"
	"livekit-app/backend/internal/auth"
	"livekit-app/backend/internal/livekit"
	"livekit-app/backend/internal/ratelimit"
	"livekit-app/backend/internal/service"
)

// Deps reúne tudo de que o roteador precisa.
type Deps struct {
	Logger         *slog.Logger
	Service        *service.Service
	Tokens         *auth.Tokens
	LiveKit        *livekit.Issuer
	AuthLimiter    *ratelimit.Limiter
	CORSOrigins    []string
	TrustedProxies []netip.Prefix
	MaxBodyBytes   int64
}

// NewHandler devolve o handler raiz. Ordem dos middlewares (de fora para dentro):
// recover → log → CORS → limite de corpo → rate limit de auth → identificação do usuário →
// validação do contrato (formato do corpo + exigência de Bearer) → rotas geradas.
func NewHandler(d Deps) (http.Handler, error) {
	spec, err := api.GetSwagger()
	if err != nil {
		return nil, fmt.Errorf("carregar contrato OpenAPI embutido: %w", err)
	}

	h := &handlers{svc: d.Service, tokens: d.Tokens, livekit: d.LiveKit}
	strict := api.NewStrictHandlerWithOptions(h, nil, api.StrictHTTPServerOptions{
		RequestErrorHandlerFunc: func(w http.ResponseWriter, _ *http.Request, err error) {
			// Em geral o validador já barrou antes; isto cobre o que ele não pega (JSON malformado que passou).
			d.Logger.Debug("corpo recusado pelo decodificador", "erro", err)
			writeError(d.Logger, w, http.StatusBadRequest, "JSON inválido", nil)
		},
		ResponseErrorHandlerFunc: func(w http.ResponseWriter, r *http.Request, err error) {
			d.Logger.Error("erro ao tratar requisição", "erro", err, "metodo", r.Method, "caminho", r.URL.Path)
			writeError(d.Logger, w, http.StatusInternalServerError, "Erro interno do servidor", nil)
		},
	})
	routes := api.HandlerWithOptions(strict, api.StdHTTPServerOptions{
		ErrorHandlerFunc: func(w http.ResponseWriter, _ *http.Request, err error) {
			writeError(d.Logger, w, http.StatusBadRequest, "Requisição inválida", err.Error())
		},
	})

	validator := nethttpmiddleware.OapiRequestValidatorWithOptions(spec, &nethttpmiddleware.Options{
		Options: openapi3filter.Options{
			// A autenticação em si é feita por identify(); aqui só se confere se ela existe.
			AuthenticationFunc: requireIdentity,
		},
		ErrorHandlerWithOpts:  validationErrorHandler(d.Logger),
		SilenceServersWarning: true,
	})

	return chain(routes,
		recoverer(d.Logger),
		accessLog(d.Logger, d.TrustedProxies),
		cors(d.Logger, d.CORSOrigins),
		limitBody(d.Logger, d.MaxBodyBytes),
		rateLimitAuth(d.Logger, d.AuthLimiter, d.TrustedProxies),
		identify(d.Tokens),
		middleware(validator),
	), nil
}

// requireIdentity é chamada pelo validador para as operações que declaram `security: bearerAuth` no contrato.
func requireIdentity(_ context.Context, in *openapi3filter.AuthenticationInput) error {
	if _, ok := auth.UserID(in.RequestValidationInput.Request.Context()); !ok {
		return errors.New("não autenticado")
	}
	return nil
}

// validationErrorHandler traduz as falhas do validador para o formato de erro do contrato.
func validationErrorHandler(logger *slog.Logger) nethttpmiddleware.ErrorHandlerWithOpts {
	return func(_ context.Context, err error, w http.ResponseWriter, _ *http.Request, opts nethttpmiddleware.ErrorHandlerOpts) {
		switch {
		case opts.MatchedRoute == nil && errors.Is(err, routers.ErrMethodNotAllowed):
			writeError(logger, w, http.StatusMethodNotAllowed, "Método não permitido", nil)
		case opts.MatchedRoute == nil:
			writeError(logger, w, http.StatusNotFound, "Rota não encontrada", nil)
		case opts.StatusCode == http.StatusUnauthorized:
			w.Header().Set("WWW-Authenticate", "Bearer")
			writeError(logger, w, http.StatusUnauthorized, "Token ausente, inválido ou expirado", nil)
		case opts.StatusCode == http.StatusBadRequest:
			var tooBig *http.MaxBytesError
			if errors.As(err, &tooBig) {
				writeError(logger, w, http.StatusRequestEntityTooLarge, "Corpo da requisição grande demais", nil)
				return
			}
			writeError(logger, w, http.StatusBadRequest, "Requisição inválida", err.Error())
		default:
			logger.Error("falha na validação da requisição", "erro", err)
			writeError(logger, w, http.StatusInternalServerError, "Erro interno do servidor", nil)
		}
	}
}
