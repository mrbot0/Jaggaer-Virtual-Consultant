// guard-alm-write (PreToolUse mcp__.*(alm|jira|atlassian).*__.*, FAIL-CLOSED) — F0.2. Ingresso minimo: solo io.mjs
// (built-in) in testa; la logica è importata dentro runHook, così anche un errore di caricamento diventa un deny.
// Logica: hooks/lib/guards/alm-write.mjs.
import { runHook } from "../lib/io.mjs";

runHook(async (input) => (await import("../lib/guards/alm-write.mjs")).decide(input), { name: "guard-alm-write", failClosed: true });
