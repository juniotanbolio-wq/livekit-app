// Utilitários comuns do aceite (e2e.mjs) e da medição (medir.mjs): relatório de checks e espera por condição.

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Repete fn até devolver algo verdadeiro ou o prazo acabar. Exceções contam como "ainda não": a página pode estar
// recarregando ou o elemento ainda não existir.
export async function waitFor(fn, { timeout = 15_000, interval = 200 } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last) {
        return last;
      }
    } catch {
      last = undefined;
    }
    await sleep(interval);
  }
  return last ?? false;
}

export function createReporter() {
  const results = [];
  const reporter = {
    results,
    check(name, ok, detail = '') {
      results.push({ name, ok: Boolean(ok) });
      const mark = ok ? '\x1b[32m  PASSOU\x1b[0m' : '\x1b[31m  FALHOU\x1b[0m';
      console.log(`${mark}  ${name}${detail ? `  (${detail})` : ''}`);
      return Boolean(ok);
    },
    note(name, detail) {
      results.push({ name, ok: true, skipped: true });
      console.log(`\x1b[33m  NÃO TESTÁVEL\x1b[0m  ${name}  (${detail})`);
    },
    // Etapa da qual as seguintes dependem: se falhar, o teste para em vez de acumular falhas em cascata.
    mustPass(name, ok, detail) {
      if (!reporter.check(name, ok, detail)) {
        throw new Error(`etapa obrigatória falhou: ${name}`);
      }
    },
    section(title) {
      console.log(`\n\x1b[36m=== ${title} ===\x1b[0m`);
    },
    failed() {
      return results.filter((item) => !item.ok);
    },
    summary() {
      const failed = reporter.failed();
      const skipped = results.filter((item) => item.skipped);
      console.log(`\n\x1b[36m=== Resumo ===\x1b[0m`);
      console.log(
        `${results.length - failed.length - skipped.length} passaram, ${failed.length} falharam, ${skipped.length} não testáveis`,
      );
      for (const item of failed) {
        console.log(`  FALHOU  ${item.name}`);
      }
      return failed.length;
    },
  };
  return reporter;
}
