// guard-production (PreToolUse sugli strumenti MCP del browser, FAIL-CLOSED).
// Ingresso minimo: solo io.mjs (built-in) in testa; la logica è importata dentro
// runHook, così anche un errore di caricamento del modulo diventa un deny.
// Logica: hooks/lib/guards/production.mjs.
import { runHook } from "../lib/io.mjs";

runHook(async (input) => (await import("../lib/guards/production.mjs")).decide(input), { name: "guard-production", failClosed: true });
