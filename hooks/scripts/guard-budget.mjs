// guard-budget (PreToolUse Agent|Task e Bash|PowerShell, FAIL-CLOSED).
// Ingresso minimo come gli altri guard: la logica (hooks/lib/guards/budget.mjs)
// è importata dentro runHook, così un errore di caricamento diventa un deny.
import { runHook } from "../lib/io.mjs";

runHook(async (input) => (await import("../lib/guards/budget.mjs")).decide(input), { name: "guard-budget", failClosed: true });
