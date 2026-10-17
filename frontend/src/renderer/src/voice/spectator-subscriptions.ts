import { Track, VideoQuality, type Room } from 'livekit-client';

export interface StreamInfo {
  identity: string;
  name: string;
  hasAudio: boolean;
}

// Únicas fontes que o espectador pode receber. Microfone e câmera ficam de fora de propósito:
// o espectador não deve ouvir nem ver ninguém além da transmissão escolhida.
export const SPECTATOR_ALLOWED_SOURCES: ReadonlySet<Track.Source> = new Set([
  Track.Source.ScreenShare,
  Track.Source.ScreenShareAudio,
]);

export function listScreenShares(room: Room): StreamInfo[] {
  const streams: StreamInfo[] = [];
  for (const participant of room.remoteParticipants.values()) {
    const video = participant.getTrackPublication(Track.Source.ScreenShare);
    if (!video || video.kind !== Track.Kind.Video) {
      continue;
    }
    streams.push({
      identity: participant.identity,
      name: participant.name || participant.identity,
      hasAudio: participant.getTrackPublication(Track.Source.ScreenShareAudio) !== undefined,
    });
  }
  return streams.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
}

export interface SpectatorSubscriptionOptions {
  selectedIdentity: string | null;
  audioEnabled: boolean;
  videoEnabled: boolean;
}

// Faz a Room refletir exatamente o que o usuário quer ver: vídeo da tela selecionada e, se
// habilitado, o áudio dela. Todo o resto é desassinado. O vídeo é pedido na camada HIGH
// (a de 1080p60) e setEnabled(false) pausa o recebimento quando o vídeo não está visível.
export function applySpectatorSubscriptions(
  room: Room,
  { selectedIdentity, audioEnabled, videoEnabled }: SpectatorSubscriptionOptions,
): void {
  for (const participant of room.remoteParticipants.values()) {
    const isSelected = participant.identity === selectedIdentity;
    for (const publication of participant.trackPublications.values()) {
      const isScreenVideo =
        publication.source === Track.Source.ScreenShare && publication.kind === Track.Kind.Video;
      const isScreenAudio =
        publication.source === Track.Source.ScreenShareAudio &&
        publication.kind === Track.Kind.Audio;
      const wanted = isSelected && (isScreenVideo || (audioEnabled && isScreenAudio));
      if (publication.isDesired !== wanted) {
        publication.setSubscribed(wanted);
      }
      if (wanted && isScreenVideo) {
        publication.setVideoQuality(VideoQuality.HIGH);
        if (publication.isEnabled !== videoEnabled) {
          publication.setEnabled(videoEnabled);
        }
      }
    }
  }
}

// Usada no evento TrackSubscribed para pegar assinaturas que escaparam da regra acima.
export function isAllowedSpectatorSubscription(
  source: Track.Source,
  participantIdentity: string,
  selectedIdentity: string | null,
): boolean {
  return SPECTATOR_ALLOWED_SOURCES.has(source) && participantIdentity === selectedIdentity;
}
