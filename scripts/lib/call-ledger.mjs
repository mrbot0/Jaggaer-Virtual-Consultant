// Ledger delle chiamate (K6.7, §29.10): i comandi di consultazione (kb find/resolve/get/…) annotano
// { cmd, args_hash, ts, task?, agent_id? } in session.ledger.calls quando una sessione è attiva, così il
// self-check #12 riconosce la stessa query ripetuta con gli stessi argomenti ("usa il risultato precedente").
// Mai bloccante: senza sessione o su errore non fa nulla (la consultazione non dipende dal ledger).
import { createHash } from "node:crypto";
import { loadHookState } from "../../hooks/lib/workspace.mjs";
import { updateSessionFile } from "../../hooks/lib/session-state.mjs";

const IGNORED = new Set(["--json", "--help"]);
export const MAX_CALLS = 500;

// Argomenti normalizzati (senza --json/--help, spazi compattati) → sha256 (16 caratteri).
export function argsHash(args = []) {
  const norm = args.filter((a) => !IGNORED.has(a)).map((a) => String(a).replace(/\s+/g, " ").trim());
  return createHash("sha256").update(JSON.stringify(norm)).digest("hex").slice(0, 16);
}

export function recordCall(cmd, args = [], { env = process.env, now = new Date() } = {}) {
  try {
    const st = loadHookState({ session_id: env.JVC_SESSION_ID }, env);
    if (!st.jvc || !st.sessionFile || !st.session) return null;
    const entry = { cmd, args_hash: argsHash(args), ts: now.toISOString(), ...(env.JVC_TASK_ID ? { task: env.JVC_TASK_ID } : {}), ...(env.JVC_AGENT_ID ? { agent_id: env.JVC_AGENT_ID } : {}) };
    updateSessionFile(st.sessionFile, (s) => { s.ledger.calls = [...(Array.isArray(s.ledger.calls) ? s.ledger.calls : []), entry].slice(-MAX_CALLS); });
    return entry;
  } catch { return null; }
}
