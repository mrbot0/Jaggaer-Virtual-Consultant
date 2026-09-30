// guard-control (PreToolUse `.*`, FAIL-CLOSED) — WP10d D8: pausa, stop, passo-passo e limiti per dispatch dei
// sub-agenti, decisi dall'utente e applicati dal codice. Ingresso minimo: solo io.mjs (built-in) in testa; la logica
// è importata dentro runHook, così anche un errore di caricamento diventa un deny. Logica: hooks/lib/guards/control.mjs.
import { runHook } from "../lib/io.mjs";

runHook(async (input) => (await import("../lib/guards/control.mjs")).decide(input), { name: "guard-control", failClosed: true });
