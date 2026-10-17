// Package livekit emite os tokens de acesso às salas do LiveKit.
// O backend nunca toca na mídia: ele só decide quem pode entrar em qual sala e com quais permissões.
package livekit

import (
	"encoding/json"
	"fmt"
	"time"

	lkauth "github.com/livekit/protocol/auth"
)

// Role é o papel pedido pelo cliente ao entrar num canal.
type Role string

const (
	// RoleVoice é a conexão normal: fala, publica câmera/tela e ouve.
	RoleVoice Role = "voice"
	// RoleSpectator é a segunda conexão do Modo Espectador: oculta, sem publicar, só assiste.
	RoleSpectator Role = "spectator"
)

// SpectatorIdentitySuffix distingue a conexão de espectador da conexão de voz do mesmo usuário.
// O LiveKit derruba uma identidade repetida na mesma sala, então as duas precisam ser diferentes.
const SpectatorIdentitySuffix = "#spectator"

// Valid diz se o papel é um dos conhecidos.
func (r Role) Valid() bool { return r == RoleVoice || r == RoleSpectator }

// User é o que o token precisa saber do usuário.
type User struct {
	ID       string
	Username string
}

// Issuer assina tokens com a chave de API do LiveKit.
type Issuer struct {
	apiKey, apiSecret string
	ttl               time.Duration
	publicURL         string
}

// NewIssuer cria o emissor. publicURL é o endereço WebSocket que o cliente deve usar para conectar.
func NewIssuer(apiKey, apiSecret, publicURL string, ttl time.Duration) *Issuer {
	return &Issuer{apiKey: apiKey, apiSecret: apiSecret, publicURL: publicURL, ttl: ttl}
}

// PublicURL devolve o endereço do LiveKit para o cliente.
func (i *Issuer) PublicURL() string { return i.publicURL }

// RoomName é o nome da sala LiveKit de um canal: uma sala por canal de voz.
func RoomName(channelID string) string { return "channel-" + channelID }

// Token é o resultado da emissão.
type Token struct {
	JWT      string
	RoomName string
}

// Issue emite o token do usuário para a sala do canal, com as permissões do papel.
func (i *Issuer) Issue(user User, channelID string, role Role) (Token, error) {
	if !role.Valid() {
		return Token{}, fmt.Errorf("papel desconhecido %q", role)
	}
	room := RoomName(channelID)

	identity := user.ID
	if role == RoleSpectator {
		identity += SpectatorIdentitySuffix
	}
	metadata, err := json.Marshal(map[string]string{"userId": user.ID, "role": string(role)})
	if err != nil {
		return Token{}, fmt.Errorf("metadata do token: %w", err)
	}

	jwt, err := lkauth.NewAccessToken(i.apiKey, i.apiSecret).
		SetVideoGrant(grantFor(role, room)).
		SetIdentity(identity).
		SetName(user.Username).
		SetMetadata(string(metadata)).
		SetValidFor(i.ttl).
		ToJWT()
	if err != nil {
		return Token{}, fmt.Errorf("assinar token do LiveKit: %w", err)
	}
	return Token{JWT: jwt, RoomName: room}, nil
}

// grantFor define as permissões. São as mesmas da v1 e é aqui que a segurança do Modo Espectador se decide:
//   - Todas as flags são explícitas. No LiveKit, uma permissão ausente (nil) vale "true";
//     deixar CanPublish de fora do espectador o deixaria publicar.
//   - Espectador: hidden (os outros não o veem na sala), sem publicar mídia nem dados, só assina.
//     Quais faixas ele assina é decisão do cliente (autoSubscribe desligado); o servidor garante que
//     ele jamais consiga publicar.
//   - Voz: publica (microfone, câmera, tela), troca dados e assina.
func grantFor(role Role, room string) *lkauth.VideoGrant {
	grant := &lkauth.VideoGrant{RoomJoin: true, Room: room}
	switch role {
	case RoleSpectator:
		grant.Hidden = true
		grant.SetCanPublish(false)
		grant.SetCanPublishData(false)
		grant.SetCanSubscribe(true)
	case RoleVoice:
		grant.SetCanPublish(true)
		grant.SetCanPublishData(true)
		grant.SetCanSubscribe(true)
	}
	return grant
}
