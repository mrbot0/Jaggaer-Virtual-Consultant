// Sotto-compiti: guard-budget registra ogni dispatch consentito in
// invocations.jsonl (ordine di dispatch = indice di riga, `seq`); subagent-trace
// lo chiude con una voce in session.ledger.invocations che porta `inv_seq`.
// L'abbinamento stop → dispatch avviene per tipo di agente e ordine di dispatch,
// MAI per il task_id dichiarato nel rapporto (fix round 1 #14): il rapporto è
// testo del sub-agente, non un'identità.
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

// Un dispatch che non arriva mai a SubagentStop (permesso negato, interruzione,
// errore dello strumento, agente ucciso) non deve tenere aperto il compito per
// sempre (fix round 2 F4): oltre OPEN_TTL_MS dal dispatch non conta più come
// aperto. La spec non fissa un TTL per le invocazioni (§46.1 dà solo il budget
// di tempo del compito, `budget.minutes`, es. 15): 2 ore per decisione del
// controller. Prima del TTL, `session.mjs use close-stale` li chiude a mano.
export const OPEN_TTL_MS = 2 * 60 * 60 * 1000;

// Revisione finale (minore B#8): con un limite di dispatch confermato dall'utente (LIMITI DISPATCH, WP10d) oltre 120
// minuti il TTL è quel limite: un sotto-compito ancora nel suo tempo non "scade" e non riapre il cambio di scope o di
// cliente (#8). TTL = max(2 h, limite). Lettura semplice di control.jsonl (l'ultimo record limits confermato): un errore
// di lettura lascia le 2 h; un TTL più lungo è la direzione prudente (più sotto-compiti restano aperti).
export const ttlFor = (minutes) => Math.max(OPEN_TTL_MS, Number.isFinite(Number(minutes)) && Number(minutes) > 0 ? Number(minutes) * 60000 : 0);
export function sessionTtlMs(sessionDirPath) {
  let text;
  try { text = readFileSync(join(sessionDirPath, "control.jsonl"), "utf8"); } catch { return OPEN_TTL_MS; }
  const recs = text.split("\n").filter((l) => l.trim()).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  const conf = new Set(recs.filter((r) => r?.kind === "confirm").map((r) => r.ref));
  const lim = recs.filter((r) => r?.kind === "limits" && conf.has(r.hash)).at(-1);
  return ttlFor(lim?.minutes);
}

const expired = (inv, now, ttlMs) => {
  const t = Date.parse(inv?.ts ?? "");
  return Number.isFinite(t) && now - t > ttlMs;
};

// Sotto-compiti aperti: dispatch senza voce nel ledger, più quelli la cui voce
// è stata bloccata da subagent-trace e non è ancora conclusa (il sub-agente
// sta ancora lavorando), esclusi quelli oltre il TTL. → [{ ...inv, seq }]
export function openFrom(invs, ledgerInvocations = [], { now = Date.now(), ttlMs = OPEN_TTL_MS } = {}) {
  const claimed = claimedSeqs(invs, ledgerInvocations);
  const running = new Set(ledgerInvocations
    .filter((e) => Number.isInteger(e?.inv_seq) && (e.blocks ?? 0) > 0 && !e.completed_at)
    .map((e) => e.inv_seq));
  return invs.map((x, seq) => ({ ...x, seq }))
    .filter((x) => !claimed.has(x.seq) || running.has(x.seq))
    .filter((x) => !expired(x, now, ttlMs));
}

// ---- vigilanza cognitiva (§23.2, WP10d D2) ----
// Un compito chiuso è "fermato per sorprese" se il rapporto dichiara almeno una sorpresa e lo status effettivo non è
// ok (partial, blocked, needs-input, escalate: §13.2 ferma il passo con needs-input o escalate; §13.3 alla terza
// escalate). Un compito ok sullo scope azzera il contatore; gli altri esiti (senza sorprese, fermati dall'utente,
// chiusi a mano o scaduti) non contano e non azzerano. Si contano solo le chiusure successive allo sblocco
// dell'utente (`since`, SBLOCCA SCOPE <S> confermato). → numero di compiti consecutivi fermati per sorprese.
export const VIGILANCE_LIMIT = 3;
export const VIGILANCE_MESSAGE = "il modello di questo scope va rifatto prima di continuare";
export const stoppedForSurprises = (e) => (e?.surprises ?? 0) >= 1 && !!e.status_effective && e.status_effective !== "ok" && e.status_effective !== "aborted-by-user" && !e.closed_by;
export function vigilanceStreak(ledgerInvocations = [], invs = [], scope, { since = null } = {}) {
  const t0 = since ? Date.parse(since) : -Infinity;
  const closed = ledgerInvocations
    .filter((e) => e && e.completed_at && Date.parse(e.completed_at) > t0)
    .filter((e) => (e.scope ?? (Number.isInteger(e.inv_seq) ? invs[e.inv_seq]?.scope : null)) === scope)
    .sort((a, b) => Date.parse(a.completed_at) - Date.parse(b.completed_at));
  let n = 0;
  for (const e of closed) {
    if (e.status_effective === "ok" && !e.closed_by) n = 0;
    else if (stoppedForSurprises(e)) n++;
  }
  return n;
}

// Chiusura manuale (use close-stale): voci di ledger per gli aperti non
// reclamati; le voci bloccate e in corso vengono concluse. Muta il ledger.
// → task_id chiusi.
export function closeOpen(invs, ledgerInvocations, { now = new Date(), by = "close-stale" } = {}) {
  const open = openFrom(invs, ledgerInvocations, { now: now.getTime(), ttlMs: Infinity });
  const at = now.toISOString();
  for (const x of open) {
    const running = ledgerInvocations.find((e) => e?.inv_seq === x.seq && !e.completed_at);
    if (running) Object.assign(running, { completed_at: at, closed_by: by });
    else ledgerInvocations.push({ agent_id: null, agent_type: invocationType(x), inv_seq: x.seq, task_id: x.task_id ?? null, enforced: false, closed_by: by, status_effective: null, completed_at: at });
  }
  return open.map((x) => x.task_id ?? `#${x.seq}`);
}
