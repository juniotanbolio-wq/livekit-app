package auth

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

const (
	testSecret  = "0123456789abcdef0123456789abcdef"
	otherSecret = "fedcba9876543210fedcba9876543210"
)

func fixedNow() time.Time { return time.Date(2026, 10, 17, 12, 0, 0, 0, time.UTC) }

func TestIssueAndVerify(t *testing.T) {
	tokens := NewTokens(testSecret, time.Hour, fixedNow)
	token, err := tokens.Issue("user-1")
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	id, err := tokens.Verify(token)
	if err != nil || id != "user-1" {
		t.Fatalf("Verify: id=%q err=%v", id, err)
	}
}

func TestVerifyExpired(t *testing.T) {
	now := fixedNow()
	issuer := NewTokens(testSecret, time.Hour, func() time.Time { return now })
	token, err := issuer.Issue("user-1")
	if err != nil {
		t.Fatal(err)
	}
	later := NewTokens(testSecret, time.Hour, func() time.Time { return now.Add(time.Hour + time.Second) })
	if _, err := later.Verify(token); !errors.Is(err, ErrInvalidToken) {
		t.Fatalf("token expirado deveria ser recusado, veio %v", err)
	}
	justBefore := NewTokens(testSecret, time.Hour, func() time.Time { return now.Add(time.Hour - time.Second) })
	if _, err := justBefore.Verify(token); err != nil {
		t.Fatalf("token ainda válido foi recusado: %v", err)
	}
}

func TestVerifyRejectsForgedTokens(t *testing.T) {
	tokens := NewTokens(testSecret, time.Hour, fixedNow)
	good := jwt.RegisteredClaims{
		Issuer:    issuer,
		Subject:   "user-1",
		ExpiresAt: jwt.NewNumericDate(fixedNow().Add(time.Hour)),
	}

	sign := func(method jwt.SigningMethod, claims jwt.RegisteredClaims, key any) string {
		s, err := jwt.NewWithClaims(method, claims).SignedString(key)
		if err != nil {
			t.Fatalf("assinar token de teste: %v", err)
		}
		return s
	}

	wrongIssuer := good
	wrongIssuer.Issuer = "outro"
	noSubject := good
	noSubject.Subject = ""
	noExpiry := good
	noExpiry.ExpiresAt = nil

	cases := map[string]string{
		"segredo errado": sign(jwt.SigningMethodHS256, good, []byte(otherSecret)),
		"alg none":       sign(jwt.SigningMethodNone, good, jwt.UnsafeAllowNoneSignatureType),
		"HS512":          sign(jwt.SigningMethodHS512, good, []byte(testSecret)),
		"emissor errado": sign(jwt.SigningMethodHS256, wrongIssuer, []byte(testSecret)),
		"sem sujeito":    sign(jwt.SigningMethodHS256, noSubject, []byte(testSecret)),
		"sem expiração":  sign(jwt.SigningMethodHS256, noExpiry, []byte(testSecret)),
		"lixo":           "isto.nao.e-jwt",
		"vazio":          "",
	}
	for name, token := range cases {
		if _, err := tokens.Verify(token); !errors.Is(err, ErrInvalidToken) {
			t.Errorf("%s: esperava ErrInvalidToken, veio %v", name, err)
		}
	}

	// Sanidade: o token "bom" montado à mão é aceito, então as recusas acima são pelo defeito certo.
	if _, err := tokens.Verify(sign(jwt.SigningMethodHS256, good, []byte(testSecret))); err != nil {
		t.Fatalf("token válido montado à mão foi recusado: %v", err)
	}
}

func TestUserIDContext(t *testing.T) {
	if _, ok := UserID(context.Background()); ok {
		t.Fatal("contexto vazio não deveria ter usuário")
	}
	ctx := WithUserID(context.Background(), "abc")
	if id, ok := UserID(ctx); !ok || id != "abc" {
		t.Fatalf("UserID = %q, %v", id, ok)
	}
	if _, ok := UserID(WithUserID(context.Background(), "")); ok {
		t.Fatal("id vazio não conta como autenticado")
	}
}
