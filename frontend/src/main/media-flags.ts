import { app } from 'electron';
import type { MainConfig } from './config';

// Features do Chromium que liberam a codificação de vídeo por GPU no WebRTC do Windows. Sem elas a tela sai em
// software (OpenH264), que gasta muita CPU e derruba os 60 fps em PCs mais fracos (docs/medicoes.md).
//
// - PlatformH264CbpEncoding: o LiveKit negocia H.264 Constrained Baseline (profile-level-id 42e01f). No Windows
//   o Chromium só oferece esse perfil ao codificador de hardware com esta feature, desligada por padrão
//   (third_party/blink/renderer/platform/peerconnection/webrtc_util.cc). Sem ela, todo H.264 vai para o OpenH264.
//   Medido na Fase Q: com ela, as três camadas saem pela GPU (AMD Media Foundation).
//
// Testadas e deixadas de fora: WebRtcAV1HWEncode (AV1 por GPU no WebRTC, desligada no Windows) e
// D3D12VideoEncodeAcceleratorL1T3 (camadas L1T3 no codificador D3D12). Com elas o AV1 continuou em software
// (libaom) na RX 9070 XT com o Chromium 152, em L1T1 e em L1T3; sem ganho medido, não vale ligar features em
// teste. Para experimentar em outra GPU, abra o app com --enable-features=WebRtcAV1HWEncode,... (a lista abaixo
// é somada à que vier na linha de comando, não a substitui).
//
// É uma feature em teste no Chromium (o nome pode mudar entre versões). Se o driver falhar ao iniciar o
// codificador, o próprio WebRTC volta para o software. O painel de depuração mostra o resultado real
// (encoderImplementation/powerEfficientEncoder) e `--no-hw-encode-flags` desliga tudo para comparar.
export const HW_ENCODE_FEATURES = ['PlatformH264CbpEncoding'] as const;

// Precisa rodar antes de `ready`: depois disso o Chromium já leu a linha de comando. Mantém as features que já
// vieram por --enable-features (ex.: de um teste) em vez de sobrescrevê-las, porque o Chromium só considera o
// último valor da chave.
export function applyMediaFeatureFlags(config: MainConfig): void {
  if (!config.hwEncodeFlags || process.platform !== 'win32') {
    return;
  }
  const current = app.commandLine
    .getSwitchValue('enable-features')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  const merged = [...new Set([...current, ...HW_ENCODE_FEATURES])];
  app.commandLine.appendSwitch('enable-features', merged.join(','));
}
