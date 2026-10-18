import { Track, VideoQuality, type RemoteTrackPublication, type Room } from 'livekit-client';

// Regras de assinatura das duas conexões (Fase Q). As duas salas conectam com autoSubscribe desligado: nada chega
// sem uma decisão explícita daqui, e o que não está na regra é desassinado.
//
// - Voz: microfone e câmera de todos, automaticamente; tela e áudio da tela só da transmissão que a pessoa
//   escolheu assistir ("Assistir", estilo Discord). Sem prévia: quem não clica não recebe nenhum vídeo de tela,
//   e o dynacast faz o emissor parar de codificar camadas sem espectador.
// - Espectador (identidade `<id>#spectator`, oculta): só a tela escolhida e, se ligado, o áudio dela. Nunca
//   microfone nem câmera do canal assistido.

export interface StreamInfo {
  identity: string;
  name: string;
  hasAudio: boolean;
}

export interface WatchTarget {
  // Transmissão assistida nesta sala; null = nenhuma.
  selectedIdentity: string | null;
  audioEnabled: boolean;
  // Player na tela: com ele escondido o vídeo é pausado no SFU (setEnabled), sem cancelar a assinatura.
  videoEnabled: boolean;
}

// Únicas fontes que o espectador pode receber.
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

function isScreenVideo(publication: RemoteTrackPublication): boolean {
  return publication.source === Track.Source.ScreenShare && publication.kind === Track.Kind.Video;
}

function isScreenAudio(publication: RemoteTrackPublication): boolean {
  return (
    publication.source === Track.Source.ScreenShareAudio && publication.kind === Track.Kind.Audio
  );
}

function setWanted(publication: RemoteTrackPublication, wanted: boolean): void {
  if (publication.isDesired !== wanted) {
    publication.setSubscribed(wanted);
  }
}

// A tela assistida vem sempre na camada mais alta (1080p60). Sem adaptiveStream nas salas, nada reduz a camada
// pelo tamanho do player; só o SFU desce de camada quando a banda de quem assiste não comporta.
function applyScreenVideo(publication: RemoteTrackPublication, videoEnabled: boolean): void {
  publication.setVideoQuality(VideoQuality.HIGH);
  if (publication.isEnabled !== videoEnabled) {
    publication.setEnabled(videoEnabled);
  }
}

export function applyVoiceSubscriptions(
  room: Room,
  { selectedIdentity, audioEnabled, videoEnabled }: WatchTarget,
): void {
  for (const participant of room.remoteParticipants.values()) {
    const isSelected = participant.identity === selectedIdentity;
    for (const publication of participant.trackPublications.values()) {
      if (publication.source === Track.Source.Microphone) {
        setWanted(publication, true);
      } else if (publication.source === Track.Source.Camera) {
        setWanted(publication, true);
        // Câmera é secundária: a camada média (360p) basta para a grade e poupa banda para a tela.
        publication.setVideoQuality(VideoQuality.MEDIUM);
      } else if (isScreenVideo(publication)) {
        setWanted(publication, isSelected);
        if (isSelected) {
          applyScreenVideo(publication, videoEnabled);
        }
      } else if (isScreenAudio(publication)) {
        setWanted(publication, isSelected && audioEnabled);
      } else {
        setWanted(publication, false);
      }
    }
  }
}

export function applySpectatorSubscriptions(
  room: Room,
  { selectedIdentity, audioEnabled, videoEnabled }: WatchTarget,
): void {
  for (const participant of room.remoteParticipants.values()) {
    const isSelected = participant.identity === selectedIdentity;
    for (const publication of participant.trackPublications.values()) {
      const video = isScreenVideo(publication);
      const wanted = isSelected && (video || (audioEnabled && isScreenAudio(publication)));
      setWanted(publication, wanted);
      if (wanted && video) {
        applyScreenVideo(publication, videoEnabled);
      }
    }
  }
}

// Usada no evento TrackSubscribed do espectador para pegar assinaturas que escaparam da regra acima.
export function isAllowedSpectatorSubscription(
  source: Track.Source,
  participantIdentity: string,
  selectedIdentity: string | null,
): boolean {
  return SPECTATOR_ALLOWED_SOURCES.has(source) && participantIdentity === selectedIdentity;
}
