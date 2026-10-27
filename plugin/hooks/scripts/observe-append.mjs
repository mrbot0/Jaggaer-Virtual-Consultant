// observe-append (PostToolUse sugli strumenti MCP del browser) — K6.2, §20.1, §20.6, §29.6.
// Un'OBS per ogni risultato del browser, ERR grezzi, redazione alla cattura, origine osservata.
// Fail-OPEN con avviso (mai un blocco), ma un guasto azzera l'URL corrente — anche se il modulo non si carica
// (WP07 giro 1, I3: l'import sta dentro il try e il ripiego usa solo moduli leggeri).
// Logica: hooks/lib/observe-append.mjs.
import { runHook } from "../lib/io.mjs";

async function localReset(input) {
  try { const { resetOnFailure } = await import("../lib/browser-origin.mjs"); resetOnFailure(input); } catch { /* i guard negano comunque su stato illeggibile */ }
}

runHook(async (input) => {
  let m;
  try { m = await import("../lib/observe-append.mjs"); } catch (err) { await localReset(input); throw err; }
  try { return await m.record(input); } catch (err) { m.resetOnFailure(input); throw err; }
}, { name: "observe-append", failClosed: false, stdinTimeoutMs: 50000 });
