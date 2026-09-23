// approval-capture (UserPromptSubmit) — §52.2, §57.2. I token 3A nascono SOLO
// dal prompt dell'utente: questo hook riconosce le frasi esatte (APPROVO PIANO /
// PROVA / PASSO, un sì per una sola azione in attesa) e le appende al registro
// approvals.jsonl (catena di hash). Non è un guard: su errore consente con
// avviso (fail-open) — e un errore non crea MAI un token (il record si scrive
// solo alla fine, dopo tutti i controlli). Logica: scripts/admin/approvals.mjs.
import { runHook } from "../lib/io.mjs";

runHook(async (input) => (await import("../../scripts/admin/approvals.mjs")).capture(input), { name: "approval-capture", failClosed: false });
