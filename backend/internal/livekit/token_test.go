package livekit

import (
	"encoding/json"
	"testing"
	"time"

	lkauth "github.com/livekit/protocol/auth"
)

const (
	testKey    = "devkey"
	testSecret = "0123456789abcdef0123456789abcdef"
)

func newTestIssuer() *Issuer {
	return NewIssuer(testKey, testSecret, "ws://localhost:7880", 6*time.Hour)
}

// verify decodifica o token como o LiveKit faria (confere a assinatura) e devolve as permissões.
func verify(t *testing.T, jwt string) (identity string, grants *lkauth.ClaimGrants) {
	t.Helper()
	v, err := lkauth.ParseAPIToken(jwt)
	if err != nil {
		t.Fatalf("ParseAPIToken: %v", err)
	}
	if v.APIKey() != testKey {
		t.Fatalf("chave de API = %q, queria %q", v.APIKey(), testKey)
	}
	_, grants, err = v.Verify(testSecret)
	if err != nil {
		t.Fatalf("assinatura do token não confere: %v", err)
	}
	return v.Identity(), grants
}

func boolOf(t *testing.T, name string, p *bool) bool {
	t.Helper()
	if p == nil {
		// No LiveKit, nil significa "true". Por isso o código exige flags explícitas.
		t.Fatalf("%s não está explícito no token", name)
	}
	return *p
}

func TestVoiceTokenGrants(t *testing.T) {
	tok, err := newTestIssuer().Issue(User{ID: "u1", Username: "ana"}, "voice-3", RoleVoice)
	if err != nil {
		t.Fatal(err)
	}
	if tok.RoomName != "channel-voice-3" {
		t.Fatalf("sala = %q", tok.RoomName)
	}
	identity, grants := verify(t, tok.JWT)
	if identity != "u1" {
		t.Errorf("identidade = %q, queria u1", identity)
	}
	if grants.Name != "ana" {
		t.Errorf("nome = %q", grants.Name)
	}
	v := grants.Video
	if v == nil || !v.RoomJoin || v.Room != "channel-voice-3" {
		t.Fatalf("grant de sala incorreto: %+v", v)
	}
	if v.Hidden {
		t.Error("voz não pode ser hidden")
	}
	if !boolOf(t, "canPublish", v.CanPublish) || !boolOf(t, "canPublishData", v.CanPublishData) || !boolOf(t, "canSubscribe", v.CanSubscribe) {
		t.Errorf("voz deve publicar, enviar dados e assinar: %+v", v)
	}
}

func TestSpectatorTokenGrants(t *testing.T) {
	tok, err := newTestIssuer().Issue(User{ID: "u1", Username: "ana"}, "voice-3", RoleSpectator)
	if err != nil {
		t.Fatal(err)
	}
	identity, grants := verify(t, tok.JWT)
	if identity != "u1#spectator" {
		t.Errorf("identidade = %q, queria u1#spectator", identity)
	}
	v := grants.Video
	if v == nil || !v.RoomJoin || v.Room != "channel-voice-3" {
		t.Fatalf("grant de sala incorreto: %+v", v)
	}
	if !v.Hidden {
		t.Error("espectador precisa ser hidden")
	}
	if boolOf(t, "canPublish", v.CanPublish) || boolOf(t, "canPublishData", v.CanPublishData) {
		t.Errorf("espectador não pode publicar mídia nem dados: %+v", v)
	}
	if !boolOf(t, "canSubscribe", v.CanSubscribe) {
		t.Error("espectador precisa poder assinar")
	}
}

func TestTokenMetadataAndTTL(t *testing.T) {
	tok, err := newTestIssuer().Issue(User{ID: "u1", Username: "ana"}, "voice-1", RoleSpectator)
	if err != nil {
		t.Fatal(err)
	}
	v, err := lkauth.ParseAPIToken(tok.JWT)
	if err != nil {
		t.Fatal(err)
	}
	claims, grants, err := v.Verify(testSecret)
	if err != nil {
		t.Fatal(err)
	}
	var meta map[string]string
	if err := json.Unmarshal([]byte(grants.Metadata), &meta); err != nil {
		t.Fatalf("metadata não é JSON: %v", err)
	}
	if meta["userId"] != "u1" || meta["role"] != "spectator" {
		t.Errorf("metadata = %v", meta)
	}
	if claims.ExpiresAt == nil {
		t.Fatal("token sem expiração")
	}
	if ttl := time.Until(claims.ExpiresAt.Time); ttl < 5*time.Hour+55*time.Minute || ttl > 6*time.Hour+time.Minute {
		t.Errorf("TTL fora do esperado (~6h): %v", ttl)
	}
}

func TestIssueRejectsUnknownRole(t *testing.T) {
	if _, err := newTestIssuer().Issue(User{ID: "u1", Username: "ana"}, "voice-1", Role("admin")); err == nil {
		t.Fatal("papel desconhecido deveria falhar")
	}
}

func TestTokenSignedWithOtherSecretIsRejected(t *testing.T) {
	other := NewIssuer(testKey, "fedcba9876543210fedcba9876543210", "ws://x", time.Hour)
	tok, err := other.Issue(User{ID: "u1", Username: "ana"}, "voice-1", RoleVoice)
	if err != nil {
		t.Fatal(err)
	}
	v, err := lkauth.ParseAPIToken(tok.JWT)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := v.Verify(testSecret); err == nil {
		t.Fatal("token assinado com outro segredo não pode validar")
	}
}
