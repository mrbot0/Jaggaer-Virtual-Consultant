// guard-config-scope (PreToolUse sugli strumenti MCP del browser e su
// Bash|PowerShell|Write|Edit|MultiEdit|NotebookEdit, FAIL-CLOSED). Ingresso
// minimo: solo io.mjs (built-in) in testa; la logica è importata dentro runHook,
// così anche un errore di caricamento del modulo diventa un deny.
// Logica: hooks/lib/guards/config-scope.mjs.
import { runHook } from "../lib/io.mjs";

runHook(async (input) => (await import("../lib/guards/config-scope.mjs")).decide(input), { name: "guard-config-scope", failClosed: true });
