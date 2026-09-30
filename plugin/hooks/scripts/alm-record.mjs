// alm-record (PostToolUse sugli strumenti MCP dell'ALM, fail-OPEN) — F0.2: registra in session.alm.created[] ciò che il
// plugin crea nell'ALM in questa sessione (guard-alm-write consente update e import solo su questi bersagli).
// Logica: hooks/lib/alm-record.mjs.
import { runHook } from "../lib/io.mjs";

runHook(async (input) => (await import("../lib/alm-record.mjs")).record(input), { name: "alm-record", failClosed: false });
