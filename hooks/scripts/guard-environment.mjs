// guard-environment (PreToolUse sugli strumenti MCP del browser, FAIL-CLOSED).
// Ingresso minimo: solo io.mjs (built-in) in testa; la logica è importata dentro
// runHook, così anche un errore di caricamento del modulo diventa un deny.
// Logica: hooks/lib/guards/environment.mjs.
import { runHook } from "../lib/io.mjs";

runHook(async (input) => (await import("../lib/guards/environment.mjs")).decide(input), { name: "guard-environment", failClosed: true });
