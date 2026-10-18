import { AudioTrack, isTrackReference, useTracks } from '@livekit/components-react';
import { Track, type Room } from 'livekit-client';
import { useVoice } from '../stores/voice';
import { useWatch } from '../stores/watch';

// Microfones da sala de voz. Substitui o RoomAudioRenderer do components-react, que toca TODO áudio assinado,
// inclusive o da tela: aqui o áudio da transmissão tem controle e volume próprios (StreamAudio, abaixo).
// "Ensurdecer" silencia sem desconectar.
export function MicrophoneAudio({ room }: { room: Room }) {
  const deafened = useVoice((state) => state.deafened);
  const tracks = useTracks([Track.Source.Microphone], {
    updateOnlyOn: [],
    onlySubscribed: true,
    room,
  }).filter(
    (ref) =>
      isTrackReference(ref) &&
      !ref.participant.isLocal &&
      ref.publication.kind === Track.Kind.Audio,
  );
  return (
    <div style={{ display: 'none' }}>
      {tracks.map((ref) =>
        isTrackReference(ref) ? (
          <AudioTrack
            key={`${ref.participant.identity}:${ref.publication.trackSid}`}
            trackRef={ref}
            muted={deafened}
          />
        ) : null,
      )}
    </div>
  );
}

// Áudio da transmissão assistida (loopback do transmissor), na voz ou no espectador: só da transmissão
// selecionada, só se ligado, com o volume do player e silenciado junto com o "ensurdecer".
export function StreamAudio({ room }: { room: Room }) {
  const selectedIdentity = useWatch((state) => state.selectedIdentity);
  const audioEnabled = useWatch((state) => state.audioEnabled);
  const volume = useWatch((state) => state.volume);
  const deafened = useVoice((state) => state.deafened);
  const tracks = useTracks([Track.Source.ScreenShareAudio], { room, onlySubscribed: true });

  if (!audioEnabled) {
    return null;
  }
  const trackRef = tracks.find(
    (item) => item.participant.identity === selectedIdentity && isTrackReference(item),
  );
  if (!trackRef || !isTrackReference(trackRef)) {
    return null;
  }
  return <AudioTrack trackRef={trackRef} volume={volume} muted={deafened} />;
}
