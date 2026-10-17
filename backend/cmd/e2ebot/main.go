// Comando e2ebot: participante de teste do LiveKit, usado só pelo aceite (scripts/e2e.ps1).
//
// Entra numa sala com um token já emitido pelo backend (ou seja, como um usuário de verdade), opcionalmente
// publica uma trilha de vídeo marcada como compartilhamento de tela e depois a despublica, e sai quando
// recebe SIGTERM/SIGINT ou passado o tempo pedido. Isso dispara webhooks REAIS no LiveKit
// (participant_joined, track_published, track_unpublished, participant_left), que é o que o aceite precisa.
//
// Uso:
//
//	e2ebot --url ws://livekit:7880 --token <jwt> [--publish-screen-after 2s] [--unpublish-screen-after 6s] [--leave-after 20s]
//
// Um valor 0 desliga a ação correspondente. O bot não é código de produção e não entra na imagem do servidor.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/livekit/protocol/livekit"
	lksdk "github.com/livekit/server-sdk-go/v2"
	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "e2ebot: erro:", err)
		stop()
		os.Exit(1)
	}
}

func run(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("e2ebot", flag.ContinueOnError)
	url := fs.String("url", "", "endereço WebSocket do LiveKit")
	token := fs.String("token", "", "token de acesso à sala")
	publishAfter := fs.Duration("publish-screen-after", 0, "publica a trilha de tela depois deste tempo (0 = nunca)")
	unpublishAfter := fs.Duration("unpublish-screen-after", 0, "despublica a trilha de tela depois deste tempo (0 = nunca)")
	leaveAfter := fs.Duration("leave-after", 0, "sai da sala depois deste tempo (0 = só com SIGTERM)")
	if err := fs.Parse(args); err != nil {
		return fmt.Errorf("argumentos: %w", err)
	}
	if *url == "" || *token == "" {
		return errors.New("--url e --token são obrigatórios")
	}

	// Sem autoSubscribe: o bot só publica, não precisa receber mídia de ninguém.
	room, err := lksdk.ConnectToRoomWithToken(*url, *token, &lksdk.RoomCallback{}, lksdk.WithAutoSubscribe(false))
	if err != nil {
		return fmt.Errorf("conectar ao LiveKit: %w", err)
	}
	// Disconnect envia o "leave" ao servidor: é o que gera participant_left de imediato, em vez de esperar o timeout.
	defer room.Disconnect()
	fmt.Println("conectado: identidade", room.LocalParticipant.Identity(), "sala", room.Name())

	var leaveC <-chan time.Time
	if *leaveAfter > 0 {
		timer := time.NewTimer(*leaveAfter)
		defer timer.Stop()
		leaveC = timer.C
	}
	var publishC, unpublishC <-chan time.Time
	if *publishAfter > 0 {
		timer := time.NewTimer(*publishAfter)
		defer timer.Stop()
		publishC = timer.C
	}
	if *unpublishAfter > 0 {
		timer := time.NewTimer(*unpublishAfter)
		defer timer.Stop()
		unpublishC = timer.C
	}

	var screen *screenTrack
	defer func() {
		if screen != nil {
			screen.stop()
		}
	}()

	for {
		select {
		case <-ctx.Done():
			fmt.Println("saindo (sinal recebido)")
			return nil
		case <-leaveC:
			fmt.Println("saindo (tempo esgotado)")
			return nil
		case <-publishC:
			publishC = nil
			published, err := publishScreen(room)
			if err != nil {
				return err
			}
			screen = published
			frameCtx, cancel := context.WithCancel(ctx)
			screen.stop = cancel
			go screen.writeFrames(frameCtx)
			fmt.Println("tela publicada: sid", screen.pub.SID())
		case <-unpublishC:
			unpublishC = nil
			if screen == nil {
				continue
			}
			screen.stop()
			if err := room.LocalParticipant.UnpublishTrack(screen.pub.SID()); err != nil {
				return fmt.Errorf("despublicar tela: %w", err)
			}
			fmt.Println("tela despublicada")
			screen = nil
		}
	}
}

// screenTrack é uma trilha VP8 publicada com source SCREEN_SHARE.
type screenTrack struct {
	track *lksdk.LocalTrack
	pub   *lksdk.LocalTrackPublication
	stop  context.CancelFunc // para a goroutine que escreve os quadros
}

func publishScreen(room *lksdk.Room) (*screenTrack, error) {
	track, err := lksdk.NewLocalSampleTrack(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8, ClockRate: 90000})
	if err != nil {
		return nil, fmt.Errorf("criar trilha: %w", err)
	}
	pub, err := room.LocalParticipant.PublishTrack(track, &lksdk.TrackPublicationOptions{
		Name:        "tela-e2e",
		Source:      livekit.TrackSource_SCREEN_SHARE, // é pela source que o backend reconhece "está transmitindo"
		VideoWidth:  1920,
		VideoHeight: 1080,
	})
	if err != nil {
		return nil, fmt.Errorf("publicar trilha de tela: %w", err)
	}
	return &screenTrack{track: track, pub: pub, stop: func() {}}, nil
}

// writeFrames envia quadros VP8 mínimos (um keyframe de 1920x1080 sem conteúdo útil) para a trilha parecer
// viva ao servidor. Ninguém decodifica isso: o SFU só repassa pacotes.
func (s *screenTrack) writeFrames(ctx context.Context) {
	frame := make([]byte, 64)
	copy(frame, []byte{0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a, 0x80, 0x07, 0x38, 0x04})
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			// Erro de escrita antes de a trilha estar ligada (bind) é esperado e inofensivo.
			_ = s.track.WriteSample(media.Sample{Data: frame, Duration: 100 * time.Millisecond}, nil)
		}
	}
}
