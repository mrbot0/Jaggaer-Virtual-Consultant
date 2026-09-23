// Sotto-compiti: guard-budget registra ogni dispatch consentito in
// invocations.jsonl (ordine di dispatch = indice di riga, `seq`); subagent-trace
// lo chiude con una voce in session.ledger.invocations che porta `inv_seq`.
// L'abbinamento stop → dispatch avviene per tipo di agente e ordine di dispatch,
// MAI per il task_id dichiarato nel rapporto (fix round 1 #14): il rapporto è
// testo del sub-agente, non un'identità.
import { baseAgentType } from "./workspace.mjs";

// Tipo base di un'invocazione registrata (Task senza subagent_type = general-purpose).
export const invocationType = (inv) => baseAgentType(inv?.subagent_type ?? "general-purpose");

// Indici di invocations.jsonl già attribuiti a una voce del ledger. Le voci
// senza il campo inv_seq (scritte prima del fix #14, o a mano) reclamano la
// prima invocazione libera con lo stesso task_id.
export function claimedSeqs(invs, ledgerInvocations = []) {
  const claimed = new Set();
  for (const e of ledgerInvocations) if (Number.isInteger(e?.inv_seq)) claimed.add(e.inv_seq);
  for (const e of ledgerInvocations) {
    if (!e || typeof e !== "object" || "inv_seq" in e || !e.task_id) continue;
    const k = invs.findIndex((x, i) => !claimed.has(i) && x?.task_id === e.task_id);
    if (k >= 0) claimed.add(k);
  }
  return claimed;
}

// Prima invocazione libera dello stesso tipo, in ordine di dispatch → seq o null.
export function matchInvocation(invs, ledgerInvocations, agentType) {
  const claimed = claimedSeqs(invs, ledgerInvocations);
  const k = invs.findIndex((x, i) => !claimed.has(i) && invocationType(x) === agentType);
  return k >= 0 ? k : null;
}

// Sotto-compiti aperti: dispatch senza voce nel ledger, più quelli la cui voce
// è stata bloccata da subagent-trace e non è ancora conclusa (il sub-agente
// sta ancora lavorando). → [{ ...inv, seq }]
export function openFrom(invs, ledgerInvocations = []) {
  const claimed = claimedSeqs(invs, ledgerInvocations);
  const running = new Set(ledgerInvocations
    .filter((e) => Number.isInteger(e?.inv_seq) && (e.blocks ?? 0) > 0 && !e.completed_at)
    .map((e) => e.inv_seq));
  return invs.map((x, seq) => ({ ...x, seq })).filter((x) => !claimed.has(x.seq) || running.has(x.seq));
}
