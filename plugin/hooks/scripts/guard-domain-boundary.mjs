// guard-domain-boundary (PreToolUse, FAIL-CLOSED). Ingresso minimo: solo io.mjs (built-in)
// in testa; la logica è importata dentro runHook, così anche un errore di
// caricamento del modulo diventa un deny e non un exit != 0 (che Claude Code
// tratterebbe come errore non bloccante). Logica: hooks/lib/guards/domain.mjs.
import { runHook } from "../lib/io.mjs";

runHook(async (input) => (await import("../lib/guards/domain.mjs")).decide(input), { name: "guard-domain-boundary", failClosed: true });
