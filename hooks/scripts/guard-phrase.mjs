// guard-phrase (PreToolUse `.*`, FAIL-CLOSED) — K5 giro 2 (N5). Ingresso minimo:
// solo io.mjs (built-in) in testa; la logica è importata dentro runHook, così
// anche un errore di caricamento del modulo diventa un deny.
// Logica: hooks/lib/guards/phrase.mjs.
import { runHook } from "../lib/io.mjs";

runHook(async (input) => (await import("../lib/guards/phrase.mjs")).decide(input), { name: "guard-phrase", failClosed: true });
