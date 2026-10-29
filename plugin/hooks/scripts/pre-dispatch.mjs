// pre-dispatch (PreToolUse su ogni strumento, FAIL-CLOSED) — 29/10/2026, punto 5 del piano: un solo processo node per
// chiamata. La logica è in hooks/lib/dispatch.mjs; qui runHook parte sempre (nessun controllo isMain: un guard che non
// parte è un guard spento).
import { runHook } from "../lib/io.mjs";

runHook(async (input) => (await import("../lib/dispatch.mjs")).dispatch(input), { name: "pre-dispatch", failClosed: true });
