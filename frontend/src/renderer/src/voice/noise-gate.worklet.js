// Noise gate da voz, executado no AudioWorklet (thread de áudio, blocos de 128 amostras). Carregado como arquivo
// solto (import "?url" em audio-processing.ts), por isso é JavaScript puro, sem imports.
//
// Por que não o gate pronto da biblioteca: ele abre e fecha de uma vez (o corte seco estala) e o limite só muda
// recriando o nó. Aqui o ganho sobe com constante de tempo de 5 ms (a primeira sílaba não é cortada) e desce com
// 50 ms (-40 dB em ~230 ms: sem estalo e sem cauda de ruído longa), há histerese de 6 dB (não fica abrindo e
// fechando no limiar) e o limite é um AudioParam, ajustável ao vivo.
const ATTACK_SECONDS = 0.005;
const RELEASE_SECONDS = 0.05;
// Depois de cair abaixo do limite, o gate ainda espera este tempo antes de fechar (pausas curtas entre sílabas).
const HOLD_SECONDS = 0.2;
const HYSTERESIS_DB = 6;

class NoiseGateProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      {
        name: 'threshold',
        defaultValue: -50,
        minValue: -100,
        maxValue: 0,
        automationRate: 'k-rate',
      },
    ];
  }

  constructor() {
    super();
    this.open = false;
    this.gain = 0;
    this.heldSamples = 0;
    // Coeficientes de um filtro de um polo: fração do caminho até o alvo percorrida a cada amostra.
    this.attack = 1 - Math.exp(-1 / (ATTACK_SECONDS * sampleRate));
    this.release = 1 - Math.exp(-1 / (RELEASE_SECONDS * sampleRate));
    this.holdLimit = Math.round(HOLD_SECONDS * sampleRate);
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    // Sem entrada (fonte ainda não conectada): segue vivo e devolve silêncio.
    if (!input || input.length === 0 || !output) {
      return true;
    }
    const frames = input[0].length;
    let sum = 0;
    for (const channel of input) {
      for (let i = 0; i < frames; i++) {
        sum += channel[i] * channel[i];
      }
    }
    const rms = Math.sqrt(sum / (frames * input.length));
    const thresholdDb = parameters.threshold[0];
    const openLevel = 10 ** (thresholdDb / 20);
    const closeLevel = 10 ** ((thresholdDb - HYSTERESIS_DB) / 20);
    if (rms >= openLevel) {
      this.open = true;
      this.heldSamples = 0;
    } else if (this.open && rms < closeLevel) {
      this.heldSamples += frames;
      if (this.heldSamples >= this.holdLimit) {
        this.open = false;
      }
    } else if (this.open) {
      this.heldSamples = 0;
    }

    const target = this.open ? 1 : 0;
    const rate = target > this.gain ? this.attack : this.release;
    for (let i = 0; i < frames; i++) {
      this.gain += (target - this.gain) * rate;
      for (let c = 0; c < output.length; c++) {
        const source = input[Math.min(c, input.length - 1)];
        output[c][i] = source[i] * this.gain;
      }
    }
    return true;
  }
}

registerProcessor('livekit-app-noise-gate', NoiseGateProcessor);
