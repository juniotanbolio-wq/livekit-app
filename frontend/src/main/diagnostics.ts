import { app, ipcMain } from 'electron';
import { IpcChannel, type DiagnosticsInfo, type GpuDevice } from '../shared/desktop-api';
import type { MainConfig } from './config';
import { assertTrustedSender } from './ipc';

// Só as features que dizem respeito a vídeo e GPU; o resto do getGPUFeatureStatus() não ajuda a escolher codec.
const GPU_FEATURE_KEYS = ['video_encode', 'video_decode', 'gpu_compositing', 'webgl'];

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

// O formato de getGPUInfo('complete') não é tipado pelo Electron (vem do chrome://gpu) e muda entre
// versões do Chromium: lemos só os campos conhecidos, sem confiar na forma.
function parseGpus(info: unknown): GpuDevice[] {
  const devices = asRecord(info)?.['gpuDevice'];
  if (!Array.isArray(devices)) {
    return [];
  }
  return devices.flatMap((entry) => {
    const device = asRecord(entry);
    if (!device) {
      return [];
    }
    return [
      {
        vendorId: typeof device['vendorId'] === 'number' ? device['vendorId'] : 0,
        deviceId: typeof device['deviceId'] === 'number' ? device['deviceId'] : 0,
        active: device['active'] === true,
        name: asString(device['deviceString']) ?? asString(device['driverVendor']),
        driverVersion: asString(device['driverVersion']),
      },
    ];
  });
}

// A coleta completa de informações da GPU é lenta (pode levar centenas de ms) e não muda com o app aberto:
// fazemos uma vez só. Se falhar, tentamos de novo na próxima abertura do painel.
let gpuInfo: Promise<GpuDevice[]> | null = null;

function loadGpus(): Promise<GpuDevice[]> {
  if (!gpuInfo) {
    gpuInfo = app.getGPUInfo('complete').then(parseGpus, (err: unknown) => {
      gpuInfo = null;
      throw err;
    });
  }
  return gpuInfo;
}

function enabledFeatures(): string[] {
  return app.commandLine
    .getSwitchValue('enable-features')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export async function collectDiagnostics(): Promise<DiagnosticsInfo> {
  const status = app.getGPUFeatureStatus() as unknown as Record<string, unknown>;
  const gpuFeatures: Record<string, string> = {};
  for (const key of GPU_FEATURE_KEYS) {
    const value = asString(status[key]);
    if (value) {
      gpuFeatures[key] = value;
    }
  }
  const gpus = await loadGpus().catch(() => []);
  return {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    gpuFeatures,
    gpus,
    enabledFeatures: enabledFeatures(),
    // percentCPUUsage é medido desde a chamada anterior (o painel chama a cada segundo, então é o uso no último
    // segundo) e já vem dividido pelo número de processadores lógicos. A primeira leitura de cada processo vem 0.
    processes: app.getAppMetrics().map((metric) => ({
      type: metric.type,
      cpuPercent: Math.round(metric.cpu.percentCPUUsage * 10) / 10,
    })),
  };
}

export function registerDiagnostics(config: MainConfig): void {
  ipcMain.handle(IpcChannel.diagnosticsGet, async (event) => {
    assertTrustedSender(event, config);
    return collectDiagnostics();
  });
}
