// browser-origin (PostToolUse sugli strumenti MCP del browser) — K5 giro 2 (N1).
// Registra session.browser.current_url solo dopo un navigate riuscito; azzera
// l'URL su cambi di scheda, errori e risposte non interpretabili. Non è un guard:
// su guasto consente con avviso (fail-open), ma prima azzera l'URL.
// Logica: hooks/lib/browser-origin.mjs.
import { runHook } from "../lib/io.mjs";

runHook(async (input) => {
  const m = await import("../lib/browser-origin.mjs");
  try { return m.record(input); } catch (err) { m.resetOnFailure(input); throw err; }
}, { name: "browser-origin", failClosed: false });
