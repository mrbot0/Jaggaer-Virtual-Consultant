// Modello del monitor degli agenti (WP10d D1, D3): lo stato di ogni dispatch ricavato SOLO dalle registrazioni degli
// hook — invocations.jsonl (guard-budget), ledger di session.json e blackboard (subagent-trace), agents/<id>.json
// (guard-control), control.jsonl (approval-capture) — mai dal testo del manager o dall'autodichiarazione degli agenti.
// Leggero (solo built-in e librerie degli hook): lo usano session-context, precompact-save e approval-capture
// (UserPromptSubmit, < 100 ms) oltre alla console scripts/admin/agents.mjs.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { invocationsFile, sessionDir } from "./workspace.mjs";
import { readJsonl } from "./state-summary.mjs";
import { claimedSeqs, invocationType, OPEN_TTL_MS, vigilanceStreak, VIGILANCE_LIMIT } from "./invocations.mjs";
import { controlFile, agentsDir, readControl, controlState, ALL } from "./control.mjs";

export const STATES = ["in-corso", "in-attesa-utente", "in-pausa", "ok", "partial", "escalate", "bloccato", "fermato", "scaduto"];
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
  const active = rows.filter((r) => r.open);
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
