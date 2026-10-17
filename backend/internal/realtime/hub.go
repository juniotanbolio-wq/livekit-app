// Package realtime entrega presença e menções aos clientes por WebSocket.
//
// Protocolo (detalhado em docs/protocolo-tempo-real.md):
//   - o cliente abre /ws SEM credenciais na URL e, em até AuthTimeout, envia {"type":"auth","token":...};
//   - o servidor responde com um snapshot completo da presença (com seq) e depois só com as mudanças
//     (seq crescente de um em um; um salto significa evento perdido e o cliente deve reconectar);
//   - menções chegam em tempo real, só a quem está conectado, e não são guardadas em lugar nenhum.
package realtime

import (
	"context"
	"fmt"
	"log/slog"
	"net/url"
	"sync"
	"time"

	"github.com/coder/websocket"

	"livekit-app/backend/internal/presence"
	"livekit-app/backend/internal/ratelimit"
	"livekit-app/backend/internal/store"
)

// Limites do protocolo. Ficam como constantes porque fazem parte do contrato com o cliente.
const (
	// readLimit é o maior frame aceito do cliente. As mensagens legítimas têm centenas de bytes
	// (um JWT, ou uma menção de até 140 caracteres); o limite impede memória descontrolada por conexão.
	readLimit = 4 << 10
	// MaxMentionRunes é o tamanho máximo da mensagem opcional de uma menção.
	MaxMentionRunes = 140
	maxRefRunes     = 64
	// sendBuffer é a fila de saída por conexão (menções, erros, confirmações).
	sendBuffer = 64
	// presenceBuffer é a folga para eventos de presença enquanto o cliente lê; estouro = consumidor lento.
	presenceBuffer = 256
	// writeTimeout evita que um cliente que não lê prenda o escritor para sempre.
	writeTimeout = 10 * time.Second
	// maxBadMessages: depois de tantas mensagens malformadas seguidas a conexão é encerrada.
	maxBadMessages = 5
)

// Directory é o que o hub precisa da camada de serviço (*service.Service satisfaz).
type Directory interface {
	User(ctx context.Context, id string) (store.User, error)
	Channels(ctx context.Context) ([]store.Channel, error)
}

// TokenVerifier valida o JWT de sessão e devolve o id do usuário (*auth.Tokens satisfaz).
type TokenVerifier interface {
	Verify(token string) (string, error)
}

// Config reúne os limites do tempo real.
type Config struct {
	AuthTimeout     time.Duration
	PingInterval    time.Duration
	MaxConnsPerUser int
	MaxConns        int
	// AllowedOrigins são as origens de navegador aceitas (as mesmas do CORS). A checagem exata de origem
	// é feita pelo middleware de CORS; aqui elas só viram padrões de host para a verificação da biblioteca.
	AllowedOrigins []string

	MentionSenderLimit    int
	MentionRecipientLimit int
	MentionWindow         time.Duration
}

// Deps são as dependências do hub.
type Deps struct {
	Logger    *slog.Logger
	Tracker   *presence.Tracker
	Directory Directory
	Tokens    TokenVerifier
	Now       func() time.Time
}

// closeError diz como encerrar a conexão (código e motivo vistos pelo cliente).
type closeError struct {
	code   websocket.StatusCode
	reason string
}

func (e *closeError) Error() string { return fmt.Sprintf("conexão encerrada: %s", e.reason) }

var (
	errEvicted      = &closeError{websocket.StatusPolicyViolation, "substituída por uma conexão mais nova do mesmo usuário"}
	errSlowConsumer = &closeError{websocket.StatusPolicyViolation, "consumidor lento"}
	errTooManyBad   = &closeError{websocket.StatusPolicyViolation, "mensagens inválidas demais"}
	errShutdown     = &closeError{websocket.StatusGoingAway, "servidor reiniciando"}
)

// Hub guarda as conexões autenticadas e roteia menções. Seguro para uso concorrente.
type Hub struct {
	cfg    Config
	logger *slog.Logger
	deps   Deps
	now    func() time.Time

	senderLimiter    *ratelimit.Limiter
	recipientLimiter *ratelimit.Limiter
	originPatterns   []string

	baseCtx context.Context //nolint:containedctx // contexto de vida do hub; cancelado em Close para encerrar todas as conexões
	cancel  context.CancelCauseFunc
	wg      sync.WaitGroup // uma entrada por conexão ativa (inclui as ainda não autenticadas)

	mu      sync.Mutex           // protege os campos abaixo
	conns   map[string][]*client // usuário -> conexões, da mais antiga para a mais nova
	total   int                  // conexões ativas (autenticadas ou não), contra o teto global
	closing bool
}

// NewHub cria o hub. Chame Run numa goroutine (limpeza dos limitadores) e Close no encerramento.
func NewHub(cfg Config, d Deps) *Hub {
	ctx, cancel := context.WithCancelCause(context.Background())
	return &Hub{
		cfg:              cfg,
		logger:           d.Logger,
		deps:             d,
		now:              d.Now,
		senderLimiter:    ratelimit.New(cfg.MentionSenderLimit, cfg.MentionWindow, d.Now),
		recipientLimiter: ratelimit.New(cfg.MentionRecipientLimit, cfg.MentionWindow, d.Now),
		originPatterns:   originHosts(cfg.AllowedOrigins),
		baseCtx:          ctx,
		cancel:           cancel,
		conns:            make(map[string][]*client),
	}
}

// originHosts converte origens completas (app://desktop, http://localhost:5173) nos padrões de host que
// a biblioteca compara com o cabeçalho Origin.
func originHosts(origins []string) []string {
	var hosts []string
	for _, origin := range origins {
		if u, err := url.Parse(origin); err == nil && u.Host != "" {
			hosts = append(hosts, u.Host)
		}
	}
	return hosts
}

// Run mantém a limpeza periódica dos limitadores até ctx ser cancelado. Bloqueia.
func (h *Hub) Run(ctx context.Context) {
	var wg sync.WaitGroup
	for _, l := range []*ratelimit.Limiter{h.senderLimiter, h.recipientLimiter} {
		wg.Go(func() { l.Run(ctx, time.Minute) })
	}
	wg.Wait()
}

// Close recusa novas conexões, encerra as existentes com "going away" e espera todas terminarem.
// Precisa ser chamado antes de fechar o banco: os handlers ainda podem consultar o serviço.
func (h *Hub) Close() {
	h.mu.Lock()
	h.closing = true
	h.mu.Unlock()
	h.cancel(errShutdown)
	h.wg.Wait()
}

// Connected diz se o usuário tem pelo menos uma conexão autenticada.
func (h *Hub) Connected(userID string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.conns[userID]) > 0
}

// reserve conta uma conexão nova contra o teto global (já na chegada, antes de autenticar: sem isso, quem
// abre milhares de conexões sem credencial esgotaria descritores e memória).
func (h *Hub) reserve() bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closing || h.total >= h.cfg.MaxConns {
		return false
	}
	h.total++
	h.wg.Add(1)
	return true
}

func (h *Hub) release() {
	h.mu.Lock()
	h.total--
	h.mu.Unlock()
	h.wg.Done()
}

// register põe a conexão autenticada no registro. Ao passar do limite por usuário, a(s) mais antiga(s) são
// encerradas: quem reconecta logo depois de uma queda de rede não pode ficar barrado só porque o servidor
// ainda não percebeu que a conexão antiga morreu.
func (h *Hub) register(c *client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	list := h.conns[c.userID]
	for len(list) >= h.cfg.MaxConnsPerUser {
		list[0].cancel(errEvicted)
		list = list[1:]
	}
	h.conns[c.userID] = append(list, c)
}

func (h *Hub) unregister(c *client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	list := h.conns[c.userID]
	for i, other := range list {
		if other == c {
			list = append(list[:i:i], list[i+1:]...)
			break
		}
	}
	if len(list) == 0 {
		delete(h.conns, c.userID)
		return
	}
	h.conns[c.userID] = list
}

// connsOf devolve uma cópia da lista de conexões do usuário.
func (h *Hub) connsOf(userID string) []*client {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]*client(nil), h.conns[userID]...)
}
