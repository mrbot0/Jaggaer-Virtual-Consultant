// guard-destructive (PreToolUse Bash|PowerShell|Write|Edit|MultiEdit|NotebookEdit|strumenti MCP del browser, FAIL-CLOSED)
// — F0.1. Ingresso minimo: solo io.mjs (built-in) in testa; la logica e policy/deny-rules.yaml sono caricate dentro
// runHook, così anche un errore di caricamento (modulo o policy) diventa un deny.
// Logica: hooks/lib/guards/destructive.mjs.
import { runHook } from "../lib/io.mjs";

runHook(async (input) => (await import("../lib/guards/destructive.mjs")).decide(input), { name: "guard-destructive", failClosed: true });
