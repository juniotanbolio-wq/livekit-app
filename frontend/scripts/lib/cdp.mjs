// Cliente mínimo do Chrome DevTools Protocol para dirigir a janela do app (Runtime.evaluate e capturas de tela).
import { waitFor } from './harness.mjs';

// Executados dentro da página. fill usa o setter nativo para o React enxergar a mudança do input.
export const PAGE_HELPERS = `
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const exists = (s) => $(s) !== null;
  const text = (s) => $(s)?.textContent?.trim() ?? null;
  const click = (s) => { const el = $(s); if (!el) return false; el.click(); return true; };
  const clickText = (s, t) => { const el = $$(s).find((e) => e.textContent.trim() === t); if (!el) return false; el.click(); return true; };
  const fill = (s, v) => {
    const el = $(s); if (!el) return false;
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  };
  const choose = (s, v) => {
    const el = $(s); if (!el) return false;
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, v);
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return el.value === v;
  };
  const submit = (s) => { const el = $(s); if (!el) return false; el.requestSubmit(); return true; };
  const key = (k, opts = {}) => window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...opts }));
  const debug = () => { const el = $('[data-debug-panel]'); return el ? JSON.parse(el.dataset.debugJson) : null; };
`;

export class Cdp {
  #socket;
  #nextId = 1;
  #pending = new Map();

  static async connect(port) {
    const page = await waitFor(
      async () => {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        return list.find((target) => target.type === 'page' && target.url.startsWith('app://'));
      },
      { timeout: 30_000, interval: 300 },
    );
    if (!page) {
      throw new Error(`a janela do app não apareceu no CDP da porta ${port}`);
    }
    const cdp = new Cdp();
    await cdp.#open(page.webSocketDebuggerUrl);
    return cdp;
  }

  #open(url) {
    return new Promise((resolve, reject) => {
      this.#socket = new WebSocket(url);
      this.#socket.onopen = () => resolve();
      this.#socket.onerror = () => reject(new Error('falha ao conectar no CDP'));
      this.#socket.onmessage = (event) => {
        const message = JSON.parse(event.data);
        const entry = this.#pending.get(message.id);
        if (entry) {
          this.#pending.delete(message.id);
          if (message.error) {
            entry.reject(new Error(message.error.message));
          } else {
            entry.resolve(message.result);
          }
        }
      };
      this.#socket.onclose = () => {
        for (const entry of this.#pending.values()) {
          entry.reject(new Error('CDP desconectado'));
        }
        this.#pending.clear();
      };
    });
  }

  // Com prazo: se a instância morrer no meio do teste, a etapa falha em vez de travar o script.
  send(method, params = {}) {
    if (this.#socket?.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('CDP desconectado'));
    }
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`CDP sem resposta para ${method}`));
      }, 30_000);
      this.#pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.#socket.send(JSON.stringify({ id, method, params }));
    });
  }

  // Avalia uma expressão na página com os auxiliares de DOM acima disponíveis.
  async eval(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression: `(async () => { ${PAGE_HELPERS}; return (${expression}); })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? 'erro na página');
    }
    return result.result.value;
  }

  close() {
    this.#socket?.close();
  }
}
