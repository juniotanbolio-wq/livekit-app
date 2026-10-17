import { VideoPreset, type VideoCodec } from 'livekit-client';

export type ScreenQualityId = '1080p60' | '1080p30' | '720p60';

export type ScreenCodec = Extract<VideoCodec, 'h264' | 'vp8' | 'vp9' | 'av1'>;

export interface ScreenQuality {
  id: ScreenQualityId;
  label: string;
  width: number;
  height: number;
  fps: number;
  maxBitrate: number;
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

export const SCREEN_CODECS: { id: ScreenCodec; label: string }[] = [
  { id: 'h264', label: 'H.264 (padrão)' },
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

export function isScreenCodec(value: unknown): value is ScreenCodec {
  return SCREEN_CODECS.some((codec) => codec.id === value);
}
