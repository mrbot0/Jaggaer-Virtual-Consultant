// observe-append (PostToolUse sugli strumenti MCP del browser) — K6.2, §20.1, §20.6, §29.6.
// Un'OBS per ogni risultato del browser, ERR grezzi, redazione alla cattura, origine osservata.
// Fail-OPEN con avviso (mai un blocco), ma un guasto azzera l'URL corrente.
// Logica: hooks/lib/observe-append.mjs.
import { runHook } from "../lib/io.mjs";

runHook(async (input) => {
  const m = await import("../lib/observe-append.mjs");
  try { return await m.record(input); } catch (err) { m.resetOnFailure(input); throw err; }
}, { name: "observe-append", failClosed: false });
