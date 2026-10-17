package httpapi

import (
	"context"
	"errors"
	"fmt"
	"time"

	"livekit-app/backend/internal/api"
	"livekit-app/backend/internal/auth"
	"livekit-app/backend/internal/livekit"
	"livekit-app/backend/internal/service"
	"livekit-app/backend/internal/store"
)

// handlers implementa api.StrictServerInterface. A validação de formato (tamanhos, regex, enums) e a
// exigência de autenticação já foram feitas pelo validador do contrato antes de chegar aqui.
type handlers struct {
	svc     *service.Service
	tokens  *auth.Tokens
	livekit *livekit.Issuer
}

var _ api.StrictServerInterface = (*handlers)(nil)

func (h *handlers) GetHealth(context.Context, api.GetHealthRequestObject) (api.GetHealthResponseObject, error) {
	// Sem tocar em banco nem LiveKit: "vivo" não pode depender de dependências externas.
	return api.GetHealth200JSONResponse{Status: api.Ok}, nil
}

func (h *handlers) Register(ctx context.Context, req api.RegisterRequestObject) (api.RegisterResponseObject, error) {
	user, err := h.svc.Register(ctx, req.Body.InviteCode, req.Body.Username, req.Body.Password)
	switch {
	case errors.Is(err, service.ErrInviteInvalid):
		return api.Register400JSONResponse{BadRequestJSONResponse: api.BadRequestJSONResponse{Error: "Código de convite inválido, expirado ou já utilizado"}}, nil
	case errors.Is(err, service.ErrUsernameTaken):
		return api.Register409JSONResponse{ConflictJSONResponse: api.ConflictJSONResponse{Error: "Nome de usuário já está em uso"}}, nil
	case err != nil:
		return nil, fmt.Errorf("cadastro: %w", err)
	}
	resp, err := h.authResponse(user)
	if err != nil {
		return nil, err
	}
	return api.Register201JSONResponse(resp), nil
}

func (h *handlers) Login(ctx context.Context, req api.LoginRequestObject) (api.LoginResponseObject, error) {
	user, err := h.svc.Authenticate(ctx, req.Body.Username, req.Body.Password)
	switch {
	case errors.Is(err, service.ErrInvalidCredentials):
		return api.Login401JSONResponse{UnauthorizedJSONResponse: api.UnauthorizedJSONResponse{Error: "Usuário ou senha inválidos"}}, nil
	case err != nil:
		return nil, fmt.Errorf("login: %w", err)
	}
	resp, err := h.authResponse(user)
	if err != nil {
		return nil, err
	}
	return api.Login200JSONResponse(resp), nil
}

func (h *handlers) ListChannels(ctx context.Context, _ api.ListChannelsRequestObject) (api.ListChannelsResponseObject, error) {
	channels, err := h.svc.Channels(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]api.Channel, 0, len(channels))
	for _, c := range channels {
		out = append(out, api.Channel{Id: c.ID, Name: c.Name, Position: int(c.Position)})
	}
	return api.ListChannels200JSONResponse{Channels: out}, nil
}

func (h *handlers) CreateLiveKitToken(ctx context.Context, req api.CreateLiveKitTokenRequestObject) (api.CreateLiveKitTokenResponseObject, error) {
	unauthorized := api.CreateLiveKitToken401JSONResponse{UnauthorizedJSONResponse: api.UnauthorizedJSONResponse{Error: "Token ausente, inválido ou expirado"}}

	userID, ok := auth.UserID(ctx)
	if !ok {
		// Não deveria acontecer (o validador já exigiu autenticação); falha fechada por garantia.
		return unauthorized, nil
	}
	// Reconsulta o usuário: um token de sessão ainda válido não deve emitir acesso de mídia
	// para uma conta que já foi removida.
	user, err := h.svc.User(ctx, userID)
	if errors.Is(err, service.ErrNotFound) {
		return unauthorized, nil
	}
	if err != nil {
		return nil, err
	}

	channel, err := h.svc.Channel(ctx, req.Body.ChannelId)
	if errors.Is(err, service.ErrNotFound) {
		return api.CreateLiveKitToken404JSONResponse{NotFoundJSONResponse: api.NotFoundJSONResponse{Error: "Canal não encontrado"}}, nil
	}
	if err != nil {
		return nil, err
	}

	token, err := h.livekit.Issue(
		livekit.User{ID: user.ID, Username: user.Username},
		channel.ID,
		livekit.Role(req.Body.Role),
	)
	if err != nil {
		return nil, fmt.Errorf("emitir token do LiveKit: %w", err)
	}
	return api.CreateLiveKitToken200JSONResponse{Token: token.JWT, Url: h.livekit.PublicURL(), RoomName: token.RoomName}, nil
}

func (h *handlers) authResponse(user store.User) (api.AuthResponse, error) {
	token, err := h.tokens.Issue(user.ID)
	if err != nil {
		return api.AuthResponse{}, err
	}
	return api.AuthResponse{
		Token: token,
		User: api.User{
			Id:        user.ID,
			Username:  user.Username,
			IsAdmin:   user.IsAdmin,
			CreatedAt: time.Unix(user.CreatedAt, 0).UTC(),
		},
	}, nil
}
