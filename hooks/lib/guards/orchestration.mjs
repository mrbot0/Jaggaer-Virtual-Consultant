// Regole di orchestrazione applicate dal codice (WP10d D2, D8) — il livello deterministico fra il manager (LLM) e i
// sub-agenti: il manager le esegue ma non può scavalcarle. Le usa guard-budget sul dispatch (Agent|Task):
//  - un sub-agente non invoca altri agenti (§42 M1): ogni richiesta oltre confine passa dal manager (§24.2, §24.3);
//  - controllo dell'utente (control.jsonl): un compito fermato non si ridispaccia; con agenti in pausa (il compito o
//    PAUSA TUTTI) nessun nuovo dispatch;
//  - vigilanza cognitiva (§23.2): al terzo compito consecutivo fermato per sorprese sullo stesso scope, ogni nuovo
//    dispatch su quello scope è negato («il modello di questo scope va rifatto prima di continuare») finché l'utente
//    non scrive SBLOCCA SCOPE <S> (confermata nel transcript);
//  - handoff (§24.2): kind handoff ⇒ via: agent-manager e un contratto HND esistente che dichiara lo scope;
//  - una sola escalation di tier per compito (§23.2, §45.3, DT-002): per lo stesso compito (reply_to o task_id) al
//    più un salto di tier sopra il primo dispatch; un secondo tier superiore è negato. Si valuta sotto il lock di
//    invocations.jsonl (tierRefusal), insieme alla prenotazione del budget.
import { existsSync, readFileSync } from "node:fs";
import YAML from "yaml";
import { controlFile, readControl, confirmPending, controlState, transcriptCandidates, ALL } from "../control.mjs";
import { vigilanceStreak, VIGILANCE_LIMIT, VIGILANCE_MESSAGE } from "../invocations.mjs";
import { readJsonl } from "../state-summary.mjs";
import { invocationsFile } from "../workspace.mjs";
import { itemFile, CODE_RE } from "../../../scripts/lib/kb-items.mjs";

export const TIER_RANK = { T0: 0, T1: 1, T2: 2 };
const MODEL_TIER = (m) => (/haiku/i.test(m ?? "") ? "T0" : /sonnet/i.test(m ?? "") ? "T1" : /opus/i.test(m ?? "") ? "T2" : null);
// Tier del dispatch: header `tier`, altrimenti dal modello richiesto.
export const tierOf = (h, ti) => (typeof h?.tier === "string" && h.tier in TIER_RANK ? h.tier : MODEL_TIER(ti?.model));
// Compito a cui appartiene il dispatch: `reply_to` (un nuovo Agent per lo stesso compito, es. dopo escalate) o task_id.
export const taskKeyOf = (h) => String(h?.reply_to ?? h?.task_id ?? "");
export const ESCALATION_MESSAGE = "una sola escalation di tier per compito";

const who = (r) => (r.target === ALL ? "TUTTI" : `AGENTE ${r.target}`);

// Stato del controllo dell'utente per un dispatch: { refusal } | { state } (state: controlState confermato).
export function controlFor(ctx) {
  const file = controlFile(ctx.ws, ctx.customer, ctx.sid);
  const c = readControl(file);
  if (!c.ok) return { refusal: `registro di controllo dell'utente manomesso (${c.reason}): nessun dispatch finché non è ripristinato` };
  const records = c.exists ? confirmPending(file, c.records, transcriptCandidates(ctx.input)) : [];
  return { state: controlState(records) };
}

function handoffRefusal(ctx, h) {
  if (h.via !== "agent-manager") return `handoff senza via: agent-manager (§24.2): nessun agente parla direttamente con un altro, ogni richiesta oltre confine passa dal manager`;
  const code = typeof h.contract === "string" ? h.contract : "";
  const m = CODE_RE.exec(code);
  if (!m || m[4] !== "HND") return `handoff senza contratto HND valido (contract: <codice HND>, §24.2): ${code || "assente"}`;
  const f = itemFile(ctx.ws, code, ctx.session.customer);
  if (!f || !existsSync(f)) return `contratto di handoff ${code} inesistente nella conoscenza (kb/handoffs)`;
  let doc;
  try { doc = YAML.parse(readFileSync(f, "utf8")); } catch { return `contratto di handoff ${code} illeggibile (YAML non valido)`; }
  if (!doc || doc.id !== code || (doc.type != null && doc.type !== "HND")) return `il file del contratto ${code} non è l'handoff ${code}`;
  const declared = [doc.from_scope, doc.to_scope, ...(Array.isArray(doc.scopes) ? doc.scopes : [])].filter((x) => typeof x === "string").map((x) => x.toUpperCase());
  if (!declared.includes(String(h.scope))) return `il contratto ${code} non dichiara lo scope ${h.scope} (from_scope/to_scope: ${declared.join(", ") || "—"})`;
  return null;
}

// Regole valutate prima del budget. → motivo del deny | null
export function dispatchRefusal(ctx, h) {
  if (ctx.agentId) return "un sub-agente non invoca altri agenti (§42 M1): se serve un altro scope o un altro ruolo, restituisce il rapporto con la richiesta di handoff e il manager la media (§24.2)";
  const ctl = controlFor(ctx);
  if (ctl.refusal) return ctl.refusal;
  const t = ctl.state.forTasks([String(h.task_id), taskKeyOf(h)]);
  if (t.stopped) return `il compito ${h.task_id} è stato fermato dall'utente (FERMA ${who(t.stopped)} alle ${t.stopped.ts}): non si ridispaccia; chiudi con il rapporto aborted-by-user`;
  if (t.paused) return `agenti in pausa per volontà dell'utente (PAUSA ${who(t.paused)} alle ${t.paused.ts}): nessun nuovo dispatch per ${h.task_id} finché l'utente non scrive RIPRENDI ${t.paused.target === ALL ? "TUTTI" : `AGENTE ${t.paused.target}`}`;
  const invs = readJsonl(invocationsFile(ctx.ws, ctx.session.customer, ctx.sid));
  const streak = vigilanceStreak(ctx.session.ledger?.invocations ?? [], invs, String(h.scope), { since: ctl.state.unlockAt(String(h.scope)) });
  if (streak >= VIGILANCE_LIMIT) return `vigilanza cognitiva (§23.2): ${streak} compiti consecutivi sullo scope ${h.scope} fermati per sorprese — ${VIGILANCE_MESSAGE}. Sblocco solo dall'utente, con la frase SBLOCCA SCOPE ${h.scope}`;
  if (h.kind === "handoff") return handoffRefusal(ctx, h);
  return null;
}

// Sotto il lock di invocations.jsonl: `invs` = le invocazioni registrate. → motivo | null
export function tierRefusal(invs, h, ti) {
  const tier = tierOf(h, ti);
  if (!tier) return null;
  const key = taskKeyOf(h);
  const prior = invs.filter((x) => (x?.task_key ?? x?.task_id) === key && x?.tier in TIER_RANK);
  if (!prior.length) return null;
  const first = TIER_RANK[prior[0].tier];
  const max = Math.max(...prior.map((x) => TIER_RANK[x.tier]));
  if (TIER_RANK[tier] > max && max > first) return `${ESCALATION_MESSAGE} (§23.2, DT-002): il compito ${key} è già salito da ${prior[0].tier} a ${Object.keys(TIER_RANK)[max]}; ${tier} è negato — restituisci all'utente l'output parziale o ridisegna il compito`;
  return null;
}
