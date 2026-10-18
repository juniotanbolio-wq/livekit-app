// Teste do algoritmo do noise gate (src/renderer/src/voice/noise-gate.worklet.js) fora do navegador: o arquivo
// do worklet é carregado com os globais do AudioWorkletGlobalScope simulados e o processador é alimentado com
// sinais sintéticos de nível conhecido. No aceite (e2e.mjs) a fonte falsa do Chromium é um bipe quase no volume
// máximo, que não permite conferir o gate de forma determinística; aqui o sinal é controlado.
//
//   npm test
import assert from 'node:assert/strict';
import { test } from 'node:test';

const SAMPLE_RATE = 48_000;
const BLOCK = 128;
const registered = new Map();

globalThis.sampleRate = SAMPLE_RATE;
globalThis.AudioWorkletProcessor = class {};
globalThis.registerProcessor = (name, processor) => registered.set(name, processor);
await import('../../src/renderer/src/voice/noise-gate.worklet.js');

const Gate = registered.get('livekit-app-noise-gate');

// Senoide de 440 Hz com RMS no nível pedido (dBFS): amplitude = RMS * raiz de 2.
function tone(levelDb, seconds) {
  const amplitude = 10 ** (levelDb / 20) * Math.SQRT2;
  const samples = new Float32Array(Math.round(seconds * SAMPLE_RATE));
  for (let i = 0; i < samples.length; i++) {
    samples[i] = amplitude * Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE);
  }
  return samples;
}

function concat(...parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

// Roda o sinal em blocos de 128 amostras, como o AudioWorklet, e devolve a saída inteira.
function run(gate, signal, thresholdDb) {
  const out = new Float32Array(signal.length);
  for (let start = 0; start + BLOCK <= signal.length; start += BLOCK) {
    const input = [signal.slice(start, start + BLOCK)];
    const output = [new Float32Array(BLOCK)];
    const alive = gate.process([input], [output], { threshold: new Float32Array([thresholdDb]) });
    assert.equal(alive, true);
    out.set(output[0], start);
  }
  return out;
}

function rmsDb(samples) {
  let sum = 0;
  for (const sample of samples) {
    sum += sample * sample;
  }
  const rms = Math.sqrt(sum / samples.length);
  return rms > 0 ? 20 * Math.log10(rms) : -Infinity;
}

function segment(samples, fromSeconds, toSeconds) {
  return samples.slice(Math.round(fromSeconds * SAMPLE_RATE), Math.round(toSeconds * SAMPLE_RATE));
}

test('registra o processador com o parâmetro de limite', () => {
  assert.ok(Gate, 'processador não registrado');
  const threshold = Gate.parameterDescriptors.find((item) => item.name === 'threshold');
  assert.equal(threshold?.automationRate, 'k-rate');
});

test('som abaixo do limite sai em silêncio', () => {
  const out = run(new Gate(), tone(-60, 1), -40);
  assert.ok(rmsDb(out) < -120, `saída ${rmsDb(out)} dBFS`);
});

test('voz acima do limite passa inteira depois do ataque', () => {
  const input = tone(-20, 1);
  const out = run(new Gate(), input, -40);
  // Depois de 50 ms o ganho já chegou a 1 (ataque de ~5 ms): saída = entrada.
  const delta = rmsDb(segment(out, 0.05, 1)) - rmsDb(segment(input, 0.05, 1));
  assert.ok(Math.abs(delta) < 0.1, `diferença ${delta} dB`);
});

test('segura aberto ~200 ms depois que o som cai (pausas entre sílabas) e então fecha', () => {
  const out = run(new Gate(), concat(tone(-20, 0.5), tone(-70, 1)), -40);
  // 100 ms depois da queda ainda passa (o sinal fraco aparece na saída)...
  assert.ok(rmsDb(segment(out, 0.55, 0.65)) > -75, 'fechou cedo demais');
  // ...e meio segundo depois já cortou.
  assert.ok(rmsDb(segment(out, 1.0, 1.5)) < -110, 'não fechou');
});

test('histerese: sinal entre o limite e 6 dB abaixo mantém o gate aberto', () => {
  const out = run(new Gate(), concat(tone(-30, 0.3), tone(-43, 1)), -40);
  assert.ok(rmsDb(segment(out, 0.8, 1.3)) > -45, 'fechou com o sinal dentro da histerese');
});

test('abre e fecha em rampa, sem degrau (sem estalo)', () => {
  const input = concat(tone(-70, 0.3), tone(-10, 0.3), tone(-70, 0.6));
  const out = run(new Gate(), input, -40);
  // A saída é entrada * ganho; com ganho em rampa, a saída nunca salta mais que a própria entrada permite.
  let worst = 0;
  for (let i = 1; i < input.length; i++) {
    worst = Math.max(worst, Math.abs(out[i] - out[i - 1]) - Math.abs(input[i] - input[i - 1]));
  }
  assert.ok(worst < 0.05, `salto de ${worst}`);
});

test('limite ajustado ao vivo vale no bloco seguinte', () => {
  const gate = new Gate();
  const signal = tone(-30, 0.5);
  const open = run(gate, signal, -40);
  assert.ok(rmsDb(segment(open, 0.1, 0.5)) > -31, 'deveria passar com limite -40');
  // Com o limite em -10, o mesmo sinal (-30) fica abaixo do fechamento: 200 ms de retenção e depois a rampa de
  // saída. Aos 450-500 ms a saída já está mais de 40 dB abaixo da entrada.
  const closed = run(gate, signal, -10);
  const attenuation = rmsDb(segment(signal, 0.45, 0.5)) - rmsDb(segment(closed, 0.45, 0.5));
  assert.ok(attenuation > 40, `atenuação de só ${attenuation.toFixed(1)} dB`);
});
