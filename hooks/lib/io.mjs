// I/O comune degli hook Claude Code: stdin JSON con timeout, costruttori
// dell'output, runner con politica di errore esplicita (§44.4, §47.2 #4):
//  - guard di sicurezza (failClosed): qualunque eccezione ⇒ deny;
//  - altri hook: eccezione ⇒ exit 0 con avviso (systemMessage).
// Solo moduli built-in: questo file deve caricarsi sempre, anche se il resto
// del plugin è rotto, perché è lui a trasformare il guasto in un deny.

export function readStdin(timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let done = false;
    const finish = (fn, v) => { if (!done) { done = true; clearTimeout(timer); fn(v); } };
    const timer = setTimeout(() => finish(reject, new Error(`stdin non chiuso entro ${timeoutMs} ms`)), timeoutMs);
    process.stdin.on("data", (c) => chunks.push(c));
    process.stdin.on("end", () => finish(resolve, Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", (e) => finish(reject, e));
  });
}

export const preToolUse = (decision, reason, extra = {}) => ({
  hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision, permissionDecisionReason: reason, ...extra },
});
export const deny = (reason) => preToolUse("deny", reason);
export const ask = (reason) => preToolUse("ask", reason);
export const allowWithInput = (reason, updatedInput) => preToolUse("allow", reason, { updatedInput });
export const context = (event, text) => ({ hookSpecificOutput: { hookEventName: event, additionalContext: text } });
export const block = (reason) => ({ decision: "block", reason });
export const warning = (text) => ({ systemMessage: text });

function write(out, code = 0) {
  const text = out == null ? "" : JSON.stringify(out);
  if (!text) { process.exit(code); return; }
  process.stdout.write(text, () => process.exit(code));
}

// Esegue `fn(input)` e scrive il suo output. `fn` restituisce null (nessuna
// opinione) o un oggetto di output. JVC_TEST_THROW=1 simula un guasto interno
// dopo la lettura dello stdin (per i test di fail-closed / fail-open).
export async function runHook(fn, { name = "hook", failClosed = false } = {}) {
  let finished = false;
  const onError = (err) => {
    if (finished) return;
    finished = true;
    const msg = String(err?.message ?? err).slice(0, 300);
    try {
      if (failClosed) write(deny(`guard error (fail-closed): ${name}: ${msg}`));
      else {
        process.stderr.write(`[jvc:${name}] avviso: ${msg}\n`);
        write(warning(`[jvc:${name}] avviso: hook non riuscito (${msg}); si prosegue.`));
      }
    } catch {
      // Ultima difesa: exit 2 blocca la chiamata allo strumento in PreToolUse.
      process.exit(failClosed ? 2 : 0);
    }
  };
  process.on("uncaughtException", onError);
  process.on("unhandledRejection", onError);
  try {
    const raw = await readStdin();
    const input = raw.trim() ? JSON.parse(raw) : {};
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("input dell'hook non è un oggetto JSON");
    if (process.env.JVC_TEST_THROW === "1") throw new Error("JVC_TEST_THROW: guasto simulato");
    // F0.3: ogni guard FAIL-CLOSED consulta prima il gate di integrità del pacchetto (integrity-gate.mjs):
    // integrità registrata a SessionStart non ok ⇒ deny di tutto tranne letture del workspace e doctor/verify.
    if (failClosed) {
      const gate = await (await import("./integrity-gate.mjs")).integrityGate(input, process.env);
      if (gate) { if (finished) return; finished = true; write(gate); return; }
    }
    const out = await fn(input);
    if (finished) return;
    finished = true;
    write(out ?? null);
  } catch (err) { onError(err); }
}
