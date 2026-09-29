// Modello del monitor degli agenti (WP10d D1, D3): lo stato di ogni dispatch ricavato SOLO dalle registrazioni degli
// hook — invocations.jsonl (guard-budget), ledger di session.json e blackboard (subagent-trace), agents/<id>.json
// (guard-control), control.jsonl (approval-capture) — mai dal testo del manager o dall'autodichiarazione degli agenti.
// Leggero (solo built-in e librerie degli hook): lo usano session-context, precompact-save e approval-capture
// (UserPromptSubmit, < 100 ms) oltre alla console scripts/admin/agents.mjs.
import { readdirSync, readFileSync, existsSync, openSync, readSync, fstatSync, closeSync } from "node:fs";
import { join } from "node:path";
import { invocationsFile, sessionDir } from "./workspace.mjs";
import { readJsonl } from "./state-summary.mjs";
import { claimedSeqs, invocationType, OPEN_TTL_MS, vigilanceStreak, VIGILANCE_LIMIT } from "./invocations.mjs";
import { controlFile, agentsDir, readControl, controlState, ALL } from "./control.mjs";

// "ripreso" (giro 1): compito tornato needs-input per cui il manager ha già fatto un nuovo dispatch (reply_to o stesso task_id).
export const STATES = ["in-corso", "in-attesa-utente", "in-pausa", "ok", "partial", "escalate", "bloccato", "fermato", "scaduto", "ripreso"];
const CLOSED_STATE = { ok: "ok", partial: "partial", escalate: "escalate", blocked: "bloccato", "needs-input": "in-attesa-utente", "aborted-by-user": "fermato" };

function readAgentStates(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try { const s = JSON.parse(readFileSync(join(dir, f), "utf8")); if (s && typeof s === "object" && s.agent_id) out.push(s); } catch { /* illeggibile: si salta */ }
  }
  return out;
}

// Tutto ciò che serve per le righe, da file. `session`: session.json già validato dal chiamante.
export function readMonitor(ws, customer, sid, session, { now = Date.now() } = {}) {
  const dir = sessionDir(ws, customer, sid);
  const invs = readJsonl(invocationsFile(ws, customer, sid)).map((x, seq) => ({ ...x, seq }));
  const ctl = readControl(controlFile(ws, customer, sid));
  const control = controlState(ctl.ok ? ctl.records : []);
  const agents = readAgentStates(agentsDir(ws, customer, sid));
  const ledger = Array.isArray(session?.ledger?.invocations) ? session.ledger.invocations : [];
  const pendingSteps = (session?.pending?.approvals ?? []).filter((r) => r?.step_mode);
  return { ws, customer, sid, dir, session, invs, ledger, control, controlOk: ctl.ok, controlReason: ctl.ok ? null : ctl.reason, agents, pendingSteps, now };
}

// Agente (agent_id) che ha eseguito il dispatch `seq`: dalla voce del ledger (subagent-trace) o dallo stato di
// guard-control (agents/<id>.json). → { agent_id, source } | null
function agentFor(m, seq, entry) {
  if (entry?.agent_id) return { agent_id: entry.agent_id, source: "ledger" };
  const a = m.agents.find((x) => x.inv_seq === seq);
  return a ? { agent_id: a.agent_id, source: `guard-control:${a.source ?? "?"}` } : null;
}

// Una riga per dispatch, in ordine di dispatch.
export function agentRows(m) {
  const claimed = claimedSeqs(m.invs, m.ledger);
  return m.invs.map((inv) => {
    const entry = m.ledger.find((e) => e?.inv_seq === inv.seq) ?? (!claimed.has(inv.seq) ? null : m.ledger.find((e) => !("inv_seq" in (e ?? {})) && e?.task_id === inv.task_id) ?? null);
    const t0 = Date.parse(inv.ts);
    const done = !!entry?.completed_at;
    const ag = agentFor(m, inv.seq, entry);
    const ctl = m.control.forTasks([String(inv.task_id)]);
    let state;
    let why = null;
    if (done) {
      if (entry.status_effective === "aborted-by-user" || entry.closed_by === "user-stop") state = "fermato";
      else if (entry.closed_by) { state = "scaduto"; why = `chiuso a mano (${entry.closed_by})`; }
      else state = CLOSED_STATE[entry.status_effective] ?? (entry.status_effective ? String(entry.status_effective) : "partial");
      // giro 1 (minore 1): chi è tornato needs-input resta in attesa dell'utente finché non c'è un dispatch di seguito
      if (state === "in-attesa-utente" && m.invs.some((j) => j.seq > inv.seq && (String(j.task_key ?? j.task_id) === String(inv.task_id) || String(j.reply_to ?? "") === String(inv.task_id)))) { state = "ripreso"; why = "nuovo dispatch dopo needs-input"; }
    } else if (Number.isFinite(t0) && m.now - t0 > OPEN_TTL_MS) { state = "scaduto"; why = `nessun rapporto dopo ${OPEN_TTL_MS / 3600000} h`; }
    else if (ctl.stopped) { state = "fermato"; why = "FERMA AGENTE: in chiusura"; }
    else if (ctl.paused) { state = "in-pausa"; why = ctl.paused.target === ALL ? "PAUSA TUTTI" : "PAUSA AGENTE"; }
    else if (m.pendingSteps.some((p) => p.task_id === String(inv.task_id) || (ag && p.agent_id === ag.agent_id))) { state = "in-attesa-utente"; why = "passo-passo: attende il sì dell'utente"; }
    else state = "in-corso";
    const end = done ? Date.parse(entry.completed_at) : m.now;
    return {
      seq: inv.seq, task_id: inv.task_id ?? null, type: invocationType(inv), scope: inv.scope ?? null, mode: inv.mode ?? null, tier: inv.tier ?? null,
      model: inv.model ?? null, started: inv.ts ?? null, duration_ms: Number.isFinite(t0) && Number.isFinite(end) ? Math.max(0, end - t0) : null,
      budget: inv.budget_tokens ?? null, used: entry?.tokens ?? null, tokens_by_model: entry?.tokens_by_model ?? null, usage_source: entry?.usage_source ?? null,
      state, why, open: !done && state !== "scaduto", agent_id: ag?.agent_id ?? null, agent_source: ag?.source ?? null,
      status: entry?.status ?? null, status_effective: entry?.status_effective ?? null, surprises: entry?.surprises ?? null, lesson: entry?.lesson ?? null,
      reclassified: entry?.reclassified ?? [], trace_incomplete: entry?.trace_incomplete ?? null, completed_at: entry?.completed_at ?? null,
      step_mode: !!ctl.step, kind: inv.kind ?? "task", task_key: inv.task_key ?? inv.task_id ?? null,
    };
  });
}

// Scope bloccati dalla vigilanza (≥ 3 compiti consecutivi fermati per sorprese, dopo l'ultimo sblocco confermato).
export function blockedScopes(m) {
  const scopes = [...new Set([...m.invs.map((i) => i.scope), ...m.ledger.map((e) => e?.scope)].filter(Boolean))];
  return scopes.map((s) => ({ scope: s, streak: vigilanceStreak(m.ledger, m.invs, s, { since: m.control.unlockAt(s) }) })).filter((x) => x.streak >= VIGILANCE_LIMIT);
}

export function summarize(rows, session) {
  const by = Object.fromEntries(STATES.map((s) => [s, 0]));
  for (const r of rows) by[r.state] = (by[r.state] ?? 0) + 1;
  const b = session?.budget ?? {};
  return { running: by["in-corso"], waiting: by["in-attesa-utente"], paused: by["in-pausa"], by_state: by, tokens_used: b.used ?? null, tokens_total: b.tokens ?? null };
}

export const summaryLine = (sum) => `Agenti: ${sum.running} in corso · ${sum.waiting} in attesa dell'utente${sum.paused ? ` · ${sum.paused} in pausa` : ""} · token ${sum.tokens_used ?? "?"}/${sum.tokens_total ?? "?"}`;

const mins = (ms) => (ms == null ? "?" : ms < 60000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60000)}m`);
export const rowBrief = (r) => `${r.task_id} (${r.type}, ${r.scope ?? "—"}${r.tier ? `, ${r.tier}` : ""}, ${mins(r.duration_ms)}${r.why ? `, ${r.why}` : ""})`;

// Sintesi per il contesto (≤ 5 righe): agenti in corso/in attesa, scope bloccati, compensazioni pendenti, controllo
// dell'utente, avvisi sul manager (se forniti). `onlyIfActive`: nessuna riga se non c'è niente da dire.
export function briefLines(m, { onlyIfActive = false, managerWarnings = [] } = {}) {
  const rows = agentRows(m);
  const sum = summarize(rows, m.session);
  // giro 1 (minore 1): anche chi è tornato needs-input (in attesa dell'utente, non ancora ripreso)
  const active = rows.filter((r) => r.open || r.state === "in-attesa-utente");
  const blocked = blockedScopes(m);
  const comps = m.session?.pending?.compensations ?? [];
  if (onlyIfActive && !active.length && !blocked.length && !managerWarnings.length && m.controlOk) return [];
  const lines = [summaryLine(sum)];
  const run = active.filter((r) => r.state === "in-corso");
  const wait = active.filter((r) => r.state !== "in-corso");
  if (run.length) lines.push(`In corso: ${run.slice(0, 4).map(rowBrief).join(" · ")}${run.length > 4 ? " · …" : ""}`);
  if (wait.length) lines.push(`In attesa/pausa: ${wait.slice(0, 4).map((r) => `${r.state} ${rowBrief(r)}`).join(" · ")}${wait.length > 4 ? " · …" : ""}`);
  const ctl = [];
  if (!m.controlOk) ctl.push(`registro di controllo MANOMESSO (${m.controlReason}): ogni chiamata dei sub-agenti è negata`);
  if (blocked.length) ctl.push(`scope bloccati dalla vigilanza: ${blocked.map((b) => `${b.scope} (${b.streak} compiti fermati per sorprese — SBLOCCA SCOPE ${b.scope})`).join(", ")}`);
  if (comps.length) ctl.push(`compensazioni pendenti: ${comps.length}`);
  if (ctl.length) lines.push(ctl.join(" · "));
  if (managerWarnings.length) lines.push(`Monitor del manager: ${managerWarnings.join(" · ")}`);
  return lines.slice(0, 5);
}

// ---- sorveglianza del manager (D6): R5 ≤ 15 % dei token, nessun lavoro di dominio ----
// Token del manager: manager-usage.json (scritto da stop-integrity dal transcript della sessione principale); token
// degli agenti: session.budget.used (subagent-trace). Comandi di dominio: eventi di audit della sessione principale
// (actor manager, senza agent_id) con kb find/get/… non seguiti da un Agent()/Task() entro le 20 chiamate successive.
export const R5_LIMIT = 0.15;
export const R5_MIN_TOTAL = 20000;
const DOMAIN_CMD = /\bkb(?:\.mjs)?["']?\s+(find|get|resolve|precedents|epistemic|fields|graph|coverage)\b/i;
export function managerWatch(m, events, { redactFn = (s) => s } = {}) {
  let usage = null;
  try { usage = JSON.parse(readFileSync(join(m.dir, "manager-usage.json"), "utf8")); } catch { usage = null; }
  const agentsTok = m.session?.budget?.used ?? 0;
  const mgr = Number.isInteger(usage?.tokens) ? usage.tokens : null;
  const total = mgr != null ? mgr + agentsTok : null;
  const share = total ? mgr / total : null;
  const warnings = [];
  if (share != null && total >= R5_MIN_TOTAL && share > R5_LIMIT) warnings.push(`quota di token del manager ${Math.round(share * 100)}% > ${R5_LIMIT * 100}% (R5): il manager instrada, non fa lavoro di dominio`);
  const mine = events.filter((e) => e?.kind === "tool" && (e.actor === "manager" || !e.actor) && !e.payload?.agent_id);
  const domain = [];
  mine.forEach((e, i) => {
    if (!/^(Bash|PowerShell)$/.test(e.payload?.tool ?? "") || !DOMAIN_CMD.test(e.payload?.input_summary ?? "")) return;
    if (!mine.slice(i + 1, i + 21).some((x) => /^(Agent|Task)$/.test(x.payload?.tool ?? ""))) domain.push({ ts: e.ts, cmd: redactFn(String(e.payload.input_summary)).slice(0, 160) });
  });
  if (domain.length) warnings.push(`${domain.length} comandi di dominio (kb find/get/…) eseguiti dal manager senza un dispatch successivo: risponde nel merito invece di instradare`);
  return { tokens_manager: mgr, tokens_agents: agentsTok, share, r5_limit: R5_LIMIT, domain_commands: domain.slice(-5), domain_count: domain.length, warnings, usage_source: usage ? "stop-integrity" : "assente" };
}

// Coda dell'audit del mese (ultimi `bytes`), eventi della sessione: per la sintesi veloce nel contesto.
export function auditTail(ws, customer, sid, { bytes = 128 * 1024, date = new Date() } = {}) {
  const f = join(ws, "customers", customer, "audit", `${date.toISOString().slice(0, 7)}.jsonl`);
  let text = "";
  let partial = false;
  try {
    const fd = openSync(f, "r");
    try { const size = fstatSync(fd).size; const len = Math.min(size, bytes); partial = len < size; const buf = Buffer.alloc(len); readSync(fd, buf, 0, len, size - len); text = buf.toString("utf8"); } finally { closeSync(fd); }
  } catch { return []; }
  return text.split("\n").slice(partial ? 1 : 0).flatMap((l) => { try { const e = JSON.parse(l); return e?.session === sid ? [e] : []; } catch { return []; } });
}

// Sintesi per il contesto dagli hook (session-context, precompact-save, approval-capture): ≤ 5 righe.
export function contextBrief(ws, customer, sid, session, { onlyIfActive = false, now = Date.now() } = {}) {
  const m = readMonitor(ws, customer, sid, session, { now });
  let managerWarnings = [];
  try { managerWarnings = managerWatch(m, auditTail(ws, customer, sid)).warnings; } catch { managerWarnings = []; }
  return briefLines(m, { onlyIfActive, managerWarnings });
}

// Giro 1 (minore 5): sorprese registrate da step-check per agente, dalle registrazioni (non dal rapporto): l'evento
// dello script (kind run, actor step-check) precede l'evento di audit-append della Bash che l'ha eseguito, con agent_id.
export function stepCheckSurprises(events) {
  const by = new Map();
  let pending = 0;
  for (const e of events) {
    const p = e?.payload ?? {};
    if (e?.kind === "run" && e.actor === "step-check") { if (p.status === "surprise") pending++; continue; }
    if (e?.kind === "tool" && /^(Bash|PowerShell)$/.test(p.tool ?? "") && /step-check/.test(p.input_summary ?? "")) {
      if (p.agent_id && pending) by.set(String(p.agent_id), (by.get(String(p.agent_id)) ?? 0) + pending);
      pending = 0;
    }
  }
  return by;
}
