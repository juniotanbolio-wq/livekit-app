import { VideoPreset, type VideoCodec } from 'livekit-client';

export type ScreenQualityId = '1080p60' | '1080p30' | '720p60';

export type ScreenCodec = Extract<VideoCodec, 'h264' | 'vp8' | 'vp9' | 'av1'>;

// "auto" = o primeiro codec com codificação por GPU nesta máquina (lib/codec-selection.ts).
export type ScreenCodecChoice = ScreenCodec | 'auto';

export interface ScreenQuality {
  id: ScreenQualityId;
  label: string;
  width: number;
  height: number;
  fps: number;
  // Teto da camada principal. ~8 Mbps dá 1080p60 limpo para jogo e vídeo; acima disso o ganho visual é pequeno
  // e o upload de casa (e a soma no servidor, docs/plano-v2.md) aperta.
  maxBitrate: number;
  // Camadas menores do simulcast (H.264/VP8). Quem assiste recebe sempre a principal; o SFU só desce para estas
  // quando a banda de quem assiste não comporta a principal. Com VP9/AV1 (SVC) não há camadas de resolução:
  // cai o fps (camadas temporais), nunca a resolução.
  layers: VideoPreset[];
}

export const SCREEN_QUALITIES: Record<ScreenQualityId, ScreenQuality> = {
  '1080p60': {
    id: '1080p60',
    label: '1080p 60 fps',
    width: 1920,
    height: 1080,
    fps: 60,
    maxBitrate: 8_000_000,
    layers: [new VideoPreset(1280, 720, 2_500_000, 30), new VideoPreset(640, 360, 600_000, 15)],
  },
  '1080p30': {
    id: '1080p30',
    label: '1080p 30 fps',
    width: 1920,
    height: 1080,
    fps: 30,
    maxBitrate: 5_000_000,
    layers: [new VideoPreset(1280, 720, 1_500_000, 15), new VideoPreset(640, 360, 500_000, 15)],
  },
  '720p60': {
    id: '720p60',
    label: '720p 60 fps',
    width: 1280,
    height: 720,
    fps: 60,
    maxBitrate: 5_000_000,
    layers: [new VideoPreset(640, 360, 1_200_000, 30)],
  },
};

export const SCREEN_QUALITY_IDS: ScreenQualityId[] = ['1080p60', '1080p30', '720p60'];

export const SCREEN_CODECS: { id: ScreenCodecChoice; label: string }[] = [
  { id: 'auto', label: 'Automático (recomendado)' },
  { id: 'h264', label: 'H.264' },
  { id: 'vp8', label: 'VP8' },
  { id: 'vp9', label: 'VP9 (SVC)' },
  { id: 'av1', label: 'AV1 (SVC)' },
];

export function isSvcCodec(codec: ScreenCodec): boolean {
  return codec === 'vp9' || codec === 'av1';
}

export function isScreenQualityId(value: unknown): value is ScreenQualityId {
  return typeof value === 'string' && value in SCREEN_QUALITIES;
}

export function isScreenCodecChoice(value: unknown): value is ScreenCodecChoice {
  return SCREEN_CODECS.some((codec) => codec.id === value);
}
