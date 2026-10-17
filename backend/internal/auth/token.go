package auth

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

const (
	issuer    = "livekit-app"
	algorithm = "HS256"
)

// ErrInvalidToken cobre qualquer token recusado (assinatura, expiração, algoritmo ou formato).
var ErrInvalidToken = errors.New("token inválido ou expirado")

// Tokens emite e verifica os JWTs de sessão do app (não confundir com os tokens do LiveKit).
type Tokens struct {
	secret []byte
	ttl    time.Duration
	now    func() time.Time
	parser *jwt.Parser
}

// NewTokens cria o emissor/verificador. now é injetável para testar expiração.
func NewTokens(secret string, ttl time.Duration, now func() time.Time) *Tokens {
	return &Tokens{
		secret: []byte(secret),
		ttl:    ttl,
		now:    now,
		// WithValidMethods é o que impede o ataque clássico de trocar o algoritmo para "none"
		// (ou para RS256 usando a chave como segredo HMAC).
		parser: jwt.NewParser(
			jwt.WithValidMethods([]string{algorithm}),
			jwt.WithIssuer(issuer),
			jwt.WithExpirationRequired(),
			jwt.WithTimeFunc(now),
		),
	}
}

// Issue assina um token cujo sujeito é o id do usuário.
func (t *Tokens) Issue(userID string) (string, error) {
	issued := t.now()
	claims := jwt.RegisteredClaims{
		Issuer:    issuer,
		Subject:   userID,
		IssuedAt:  jwt.NewNumericDate(issued),
		ExpiresAt: jwt.NewNumericDate(issued.Add(t.ttl)),
	}
	signed, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(t.secret)
	if err != nil {
		return "", fmt.Errorf("assinar token: %w", err)
	}
	return signed, nil
}

// Verify devolve o id do usuário do token, ou ErrInvalidToken.
func (t *Tokens) Verify(token string) (string, error) {
	var claims jwt.RegisteredClaims
	parsed, err := t.parser.ParseWithClaims(token, &claims, func(*jwt.Token) (any, error) {
		return t.secret, nil
	})
	if err != nil || !parsed.Valid || claims.Subject == "" {
		return "", ErrInvalidToken
	}
	return claims.Subject, nil
}

type userIDKey struct{}

// WithUserID guarda no contexto o usuário já autenticado da requisição.
func WithUserID(ctx context.Context, userID string) context.Context {
	return context.WithValue(ctx, userIDKey{}, userID)
}

// UserID devolve o usuário autenticado da requisição, se houver.
func UserID(ctx context.Context) (string, bool) {
	id, ok := ctx.Value(userIDKey{}).(string)
	return id, ok && id != ""
}
