// Console degli agenti (WP10d D1, D6, D7) — il monitor indipendente: cosa fa ogni sub-agente adesso, cosa ha fatto e
// come, ricavato SOLO dalle registrazioni degli hook (invocations.jsonl di guard-budget, ledger e blackboard di
// subagent-trace, audit per agent_id di audit-append e dei guard, step-check e observations.jsonl, workflow.jsonl,
// control.jsonl di approval-capture, agents/<id>.json di guard-control, manager-usage.json di stop-integrity). Mai
// dal testo del manager, mai contenuti di file: codici e riassunti redatti. Sola lettura: non scrive nulla.
//
// CLI:
//   agents status [--json]                           una riga per dispatch + sintesi, vigilanza, manager, catena
//   agents show <task_id> [--json]                   cronologia completa di un compito (D7): dispatch, strumenti,
//                                                    passi Chrome, traccia cognitiva, token e durata, coerenza
//   agents history [--scope <S>] [--last <N>] [--json]
//   agents watch [--interval <s>] [--count <n>]      aggiorna la console ogni N secondi (terminale separato)
// Opzioni comuni: --session <id|SES.C.AAAAMMGG.NNN> · --workspace <dir>
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import YAML from "yaml";
import { parseArgs, fail } from "../lib/args.mjs";
import { isMain } from "../lib/is-main.mjs";
import { readPointer, readCurrentSession, isSafeSessionId, sessionFile } from "../../hooks/lib/workspace.mjs";
import { checkSessionText } from "../../hooks/lib/session-state.mjs";
import { verifyChain } from "../../hooks/lib/audit.mjs";
import { redact, truncate } from "../../hooks/lib/redact.mjs";
import { readJsonl } from "../../hooks/lib/state-summary.mjs";
import { readMonitor, agentRows, summarize, summaryLine, blockedScopes, STATES, managerWatch as watchManager, R5_LIMIT, R5_MIN_TOTAL } from "../../hooks/lib/agents-model.mjs";
import { reduce as reduceWorkflow, readEvents, workflowFile } from "./workflow.mjs";

export { R5_LIMIT, R5_MIN_TOTAL };
// Sorveglianza del manager (D6): logica condivisa con gli hook (hooks/lib/agents-model.mjs), su tutto l'audit della sessione.
export const managerWatch = (m, events) => watchManager(m, events, { redactFn: (s) => truncate(redact(s), 160) });
const CODE = /\b[SCLN][A-Z]*\.[A-Z0-9]{3,4}\.[A-Z0-9]{3}\.[A-Z]{3}\.\d{4}(?:\.v\d+)?\b/g;

// ---- sessione ----
const SES_CODE = /^SES\.[A-Z0-9]{4}\.\d{8}\.\d{3}$/;
function findByCode(ws, code) {
  let custs = [];
  try { custs = readdirSync(join(ws, "customers")).filter((c) => /^[A-Z0-9]{4}$/.test(c)); } catch { return null; }
  for (const c of custs) {
    let dirs = [];
    try { dirs = readdirSync(join(ws, "customers", c, ".sessions"), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { continue; }
    for (const d of dirs) {
      try { const s = JSON.parse(readFileSync(join(ws, "customers", c, ".sessions", d, "session.json"), "utf8")); if (s.session_code === code || s.session_id === code) return { customer: c, sid: s.session_id }; } catch { /* salta */ }
    }
  }
  return null;
}

// → { customer, sid, session, warning } | { error }
export function resolveMonitorSession(ws, arg, env = process.env) {
  let customer = null;
  let sid = null;
  if (typeof arg === "string" && SES_CODE.test(arg)) {
    const f = findByCode(ws, arg);
    if (!f) return { error: `sessione ${arg} non trovata` };
    ({ customer, sid } = f);
  } else {
    sid = arg ?? env.JVC_SESSION_ID ?? readCurrentSession(ws);
    if (!isSafeSessionId(sid)) return { error: "nessuna sessione risolvibile: --session <id|SES…>" };
    let p;
    try { p = readPointer(ws, sid); } catch (err) { return { error: `puntatore di sessione illeggibile: ${err.message}` }; }
    customer = p?.customer ?? null;
    if (!customer) { const f = findByCode(ws, sid); if (f) customer = f.customer; }
    if (!customer) return { error: `nessun cliente attivo nella sessione ${sid}` };
  }
  let text;
  try { text = readFileSync(sessionFile(ws, customer, sid), "utf8"); } catch { return { error: `session.json assente per ${customer}/${sid}` }; }
  const r = checkSessionText(text, { customer, sid });
  if (r.ok) return { customer, sid, session: r.session, warning: null };
  // stato non valido: il monitor mostra comunque ciò che può, con l'avviso
  return { customer, sid, session: r.parsed && typeof r.parsed === "object" ? r.parsed : null, warning: `session.json non valido (${r.reason})` };
}

// ---- audit ----
function auditFiles(ws, customer) {
  const d = join(ws, "customers", customer, "audit");
  if (!existsSync(d)) return [];
  return readdirSync(d).filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f)).sort().map((f) => join(d, f));
}

// Eventi di audit della sessione + verifica della catena di ogni file mensile (verifyChain).
export function readAudit(ws, customer, sid) {
  const chain = [];
  const events = [];
  for (const f of auditFiles(ws, customer)) {
    const v = verifyChain(f);
    chain.push({ file: f.replace(/\\/g, "/").split("/").slice(-4).join("/"), ok: v.ok, lines: v.lines, ...(v.ok ? {} : { broken_at: v.broken_at, reason: v.reason }) });
    for (const e of readJsonl(f)) if (e?.session === sid) events.push(e);
  }
  return { events, chain, chain_ok: chain.every((c) => c.ok) };
}

const shortAct = (e) => {
  const p = e.payload ?? {};
  if (e.kind === "tool") return `${p.tool}${p.input_summary ? ` ${truncate(redact(p.input_summary), 140)}` : ""}${p.ok === false ? " ✗" : ""}`;
  if (e.kind === "guard") return `DENY ${e.actor?.replace(/^hook:/, "") ?? "guard"} ${p.tool ?? ""}: ${truncate(redact(String(p.reason ?? "")), 140)}`;
  return `${e.kind} ${e.actor ?? ""}`;
};

// Attribuzione per agent_id: eventi con payload.agent_id (strumenti, deny dei guard); step-check (actor step-check)
// al successivo evento Bash/PowerShell che ha eseguito step-check (audit-append scrive DOPO lo script); OBS di
// observe-append (observations.jsonl) alla chiamata del browser dello stesso agente più vicina nel tempo (≤ 10 s).
export function attribute(events, obs = []) {
  const by = new Map();
  const get = (id) => { if (!by.has(id)) by.set(id, { tools: {}, calls: 0, denies: [], actions: [], steps: [], obs: [], browserTs: [], first: null, last: null }); return by.get(id); };
  const pendingSteps = [];
  for (const e of events) {
    const p = e.payload ?? {};
    if (e.kind === "run" && e.actor === "step-check") { pendingSteps.push(e); continue; }
    const id = p.agent_id;
    if (e.kind === "tool" && /^(Bash|PowerShell)$/.test(p.tool ?? "") && /step-check/.test(p.input_summary ?? "") && pendingSteps.length) {
      if (id) get(id).steps.push(...pendingSteps.map((s) => ({ ts: s.ts, plan: s.payload?.plan ?? null, step: s.payload?.step ?? null, status: s.payload?.status ?? null, kind: s.payload?.kind ?? null, compat: s.payload?.compat ?? null })));
      pendingSteps.length = 0;
    }
    if (!id) continue;
    const a = get(String(id));
    if (e.kind === "tool") {
      a.calls++;
      a.tools[p.tool] = (a.tools[p.tool] ?? 0) + 1;
      if (/^mcp__/.test(p.tool ?? "")) a.browserTs.push(Date.parse(e.ts));
    }
    if (e.kind === "guard" && p.decision === "deny") a.denies.push({ ts: e.ts, guard: e.actor?.replace(/^hook:/, "") ?? null, tool: p.tool ?? null, reason: truncate(redact(String(p.reason ?? "")), 240) });
    if (e.kind === "tool" || e.kind === "guard") {
      a.actions.push({ ts: e.ts, kind: e.kind, text: shortAct(e) });
      a.first ??= e.ts;
      a.last = e.ts;
    }
  }
  for (const o of obs) {
    const t = Date.parse(o.ts);
    let best = null;
    for (const [id, a] of by) for (const bt of a.browserTs) { const d = Math.abs(bt - t); if (d <= 10000 && (!best || d < best.d)) best = { id, d }; }
    if (best) by.get(best.id).obs.push({ ts: o.ts, obs: o.obs ?? null, kind: o.kind ?? null, page_sig: o.page_sig ?? null });
  }
  return by;
}

// ---- blackboard ----
function readBlackboard(dir) {
  const d = join(dir, "blackboard");
  if (!existsSync(d)) return [];
  const out = [];
  for (const f of readdirSync(d)) {
    if (!/\.ya?ml$/.test(f)) continue;
    try { const r = YAML.parse(readFileSync(join(d, f), "utf8")); if (r && typeof r === "object") out.push(r); } catch { /* illeggibile */ }
  }
  return out;
}
const codesIn = (v) => [...new Set((JSON.stringify(v ?? null).match(CODE) ?? []))].slice(0, 12);

// ---- coerenza: rapporto dell'agente contro le registrazioni (D6) ----
export function coherence(row, rep, act) {
  const flags = [];
  const hookSurprises = (act?.steps ?? []).filter((s) => s.status === "surprise").length;
  if (rep && Number.isInteger(rep.declared_tools) && act && rep.declared_tools !== act.calls) flags.push(`il rapporto dichiara ${rep.declared_tools} strumenti usati, l'audit ne registra ${act.calls}`);
  if (rep?.status === "ok" && hookSurprises > 0) flags.push(`il rapporto dichiara ok con ${hookSurprises} sorprese registrate da step-check`);
  const declared = rep?.cognitive_trace?.surprises;
  if (Number.isInteger(declared) && hookSurprises > declared) flags.push(`il rapporto dichiara ${declared} sorprese, step-check ne registra ${hookSurprises}`);
  if ((row.reclassified ?? []).some((x) => /task_id dichiarato/.test(String(x)))) flags.push("il task_id del rapporto è diverso da quello del dispatch");
  if ((row.reclassified ?? []).some((x) => /profondità dichiarata/.test(String(x)))) flags.push("la profondità della traccia è diversa da quella del dispatch");
  if (row.state !== "in-corso" && row.completed_at && act && act.calls === 0 && rep?.status === "ok" && (rep?.cognitive_trace?.recalled || codesIn(rep?.output).length)) flags.push("il rapporto dichiara lavoro svolto ma l'audit non registra nessuna chiamata di strumento");
  const notes = [];
  if (row.usage_source === "self-declared") notes.push("token autodichiarati dal rapporto (transcript assente): non verificabili");
  if (row.trace_incomplete) notes.push("traccia incompleta (subagent-trace)");
  return { incoerente: flags.length > 0, flags, notes };
}

// ---- vista completa ----
export function buildConsole(ws, customer, sid, session, { now = Date.now() } = {}) {
  const m = readMonitor(ws, customer, sid, session, { now });
  const rows = agentRows(m);
  const audit = readAudit(ws, customer, sid);
  const obs = readJsonl(join(m.dir, "observations.jsonl"));
  const act = attribute(audit.events, obs);
  const bb = readBlackboard(m.dir);
  const wf = reduceWorkflow(readEvents(workflowFile(ws, customer, sid)));
  const cur = [...wf.steps.values()].filter((s) => s.state === "▶" || s.state === "⏸").sort((a, b) => a.n - b.n)[0] ?? null;
  for (const r of rows) {
    const a = r.agent_id ? act.get(r.agent_id) : null;
    const rep = bb.find((x) => (r.agent_id && x.agent_id === r.agent_id) || (!r.agent_id && x.task_id === r.task_id)) ?? null;
    r.calls = a?.calls ?? 0;
    r.tools = a?.tools ?? {};
    r.last_action = a?.actions.at(-1)?.text ?? null;
    r.last_ts = a?.last ?? null;
    r.last_actions = (a?.actions ?? []).slice(-5).map((x) => `${x.ts.slice(11, 19)} ${x.text}`);
    r.denies = a?.denies.length ?? 0;
    r.output_codes = codesIn(rep?.output);
    r.open_questions = Array.isArray(rep?.open_questions) ? rep.open_questions.length : 0;
    r.report_surprises = rep?.cognitive_trace?.surprises ?? null;
    r.coherence = coherence(r, rep, a);
    if (r.coherence.incoerente) r.flag = "incoerente";
  }
  const sum = summarize(rows, session);
  return {
    session: { session_id: sid, session_code: session?.session_code ?? null, customer, scope: session?.scope ?? null, mode: session?.mode ?? null },
    summary: sum, rows, vigilance: blockedScopes(m), control: { ok: m.controlOk, reason: m.controlReason, limits: m.control.limits, all_paused: !!m.control.allPaused },
    workflow: cur ? { step: cur.n, state: cur.state, agent: cur.agent, class: cur.cls, desc: cur.desc } : null,
    audit_chain: { ok: audit.chain_ok, files: audit.chain }, manager: managerWatch(m, audit.events), _m: m, _act: act, _bb: bb,
  };
}

const pad = (s, n) => { const t = String(s ?? "—"); return t.length > n ? `${t.slice(0, n - 1)}…` : t.padEnd(n); };
const dur = (ms) => (ms == null ? "—" : ms < 60000 ? `${Math.round(ms / 1000)}s` : ms < 3600000 ? `${Math.round(ms / 60000)}m` : `${(ms / 3600000).toFixed(1)}h`);
const hhmm = (ts) => (typeof ts === "string" && ts.length >= 16 ? ts.slice(11, 16) : "--:--");

export function renderStatus(c) {
  const s = c.session;
  const out = [`AGENTI  ${s.session_code ?? s.session_id} · cliente ${s.customer} · scope ${s.scope ?? "—"} · ${summaryLine(c.summary).replace(/^Agenti: /, "")}`];
  out.push(`audit: ${c.audit_chain.ok ? "catena integra" : `CATENA INTERROTTA (${c.audit_chain.files.filter((f) => !f.ok).map((f) => `${f.file} riga ${f.broken_at}: ${f.reason}`).join("; ")})`}${c.control.ok ? "" : ` · registro di controllo MANOMESSO (${c.control.reason})`}${c.control.all_paused ? " · PAUSA TUTTI attiva" : ""} · limiti per dispatch ${c.control.limits.calls} chiamate / ${c.control.limits.minutes} min`);
  if (c.workflow) out.push(`workflow: passo ${c.workflow.step} ${c.workflow.state} ${c.workflow.agent} ${c.workflow.class} ${c.workflow.desc}`.trimEnd());
  out.push("");
  out.push(`${pad("task_id", 22)} ${pad("tipo", 16)} ${pad("scope", 5)} ${pad("modo", 6)} ${pad("tier", 4)} ${pad("avviato", 7)} ${pad("durata", 6)} ${pad("budget/usato", 15)} ${pad("stato", 16)} ${pad("sorpr.", 6)} ${pad("dom.", 4)} ultima azione`);
  for (const r of c.rows) {
    out.push(`${pad(r.task_id, 22)} ${pad(r.type, 16)} ${pad(r.scope, 5)} ${pad(r.mode, 6)} ${pad(r.tier, 4)} ${pad(hhmm(r.started), 7)} ${pad(dur(r.duration_ms), 6)} ${pad(`${r.budget ?? "?"}/${r.used ?? "—"}`, 15)} ${pad(r.state + (r.flag ? " !" : ""), 16)} ${pad(r.report_surprises ?? r.surprises ?? "—", 6)} ${pad(r.open_questions, 4)} ${truncate(r.last_action ?? "—", 90)}`);
    if (r.why) out.push(`${" ".repeat(23)}↳ ${r.why}`);
    if (r.flag) out.push(`${" ".repeat(23)}↳ INCOERENTE: ${r.coherence.flags.join(" · ")}`);
  }
  if (!c.rows.length) out.push("(nessun sub-agente in questa sessione)");
  if (c.vigilance.length) out.push("", `VIGILANZA: ${c.vigilance.map((v) => `${v.scope} bloccato (${v.streak} compiti consecutivi fermati per sorprese): «il modello di questo scope va rifatto prima di continuare» — sblocco solo dall'utente: SBLOCCA SCOPE ${v.scope}`).join(" · ")}`);
  const mg = c.manager;
  out.push("", `MANAGER: quota token ${mg.share == null ? "n/d" : `${Math.round(mg.share * 100)}%`} (R5 ≤ ${mg.r5_limit * 100}%) · comandi di dominio senza dispatch: ${mg.domain_count}${mg.warnings.length ? ` · AVVISO: ${mg.warnings.join(" · ")}` : ""}`);
  return `${out.join("\n")}\n`;
}

// ---- show (D7) ----
// Redazione e troncatura di ogni stringa di una struttura (profondità e ampiezza limitate).
export function deepRedact(v, depth = 0) {
  if (typeof v === "string") return truncate(redact(v), 300);
  if (depth > 6 || v == null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => deepRedact(x, depth + 1));
  return Object.fromEntries(Object.entries(v).slice(0, 50).map(([k, x]) => [truncate(redact(k), 80), deepRedact(x, depth + 1)]));
}
export function showTask(c, taskId) {
  const rows = c.rows.filter((r) => r.task_id === taskId || r.task_key === taskId);
  if (!rows.length) return null;
  const m = c._m;
  return rows.map((r) => {
    const inv = m.invs[r.seq];
    const a = r.agent_id ? c._act.get(r.agent_id) : null;
    const rep = c._bb.find((x) => (r.agent_id && x.agent_id === r.agent_id) || (!r.agent_id && x.task_id === r.task_id)) ?? null;
    const ct = rep?.cognitive_trace ?? null;
    return {
      task_id: r.task_id, seq: r.seq, agent_id: r.agent_id, agent_source: r.agent_source, state: r.state, why: r.why,
      dispatch: { at: inv.ts, type: r.type, scope: r.scope, mode: r.mode, tier: r.tier, depth: inv.depth ?? null, model: inv.model ?? null, model_requested: inv.model_requested ?? null,
        budget_tokens: inv.budget_tokens ?? null, minutes: inv.minutes ?? null, classes: inv.classes ?? [], allowed_paths: inv.allowed_paths ?? [], expected_output: inv.expected_output ?? null, task: inv.task ?? null,
        kind: inv.kind ?? "task", reply_to: inv.reply_to ?? null, contract: inv.contract ?? null },
      timeline: (a?.actions ?? []).map((x) => ({ ts: x.ts, kind: x.kind, text: x.text })),
      denies: a?.denies ?? [], tools: a?.tools ?? {}, calls: a?.calls ?? 0,
      chrome: { steps: a?.steps ?? [], observations: a?.obs ?? [] },
      // giro 1 (minore 6): ogni campo di testo libero del rapporto passa da redazione e troncatura (deepRedact)
      trace: rep ? deepRedact({ status: rep.status ?? null, status_effective: rep.status_effective ?? null, recalled: ct?.recalled ?? null, epistemic: ct?.epistemic ?? null, strategy: ct?.strategy ?? null,
        hypotheses: ct?.hypotheses ?? null, decisions: ct?.decisions ?? [], why: rep.why ?? null, surprises: ct?.surprises ?? null, surprise_items: ct?.surprise_items ?? [], self_check: ct?.self_check ?? null,
        lesson: rep.lesson ?? null, output_codes: codesIn(rep.output), open_questions: rep.open_questions ?? [], needs_input: rep.needs_input ? { question: String(rep.needs_input.question ?? "") } : null }) : null,
      usage: { tokens: r.used, by_model: r.tokens_by_model, source: r.usage_source, duration_ms: r.duration_ms, completed_at: r.completed_at },
      coherence: r.coherence,
    };
  });
}

const list = (a) => (Array.isArray(a) && a.length ? a.join(", ") : "—");
export function renderShow(views) {
  const out = [];
  for (const v of views) {
    const d = v.dispatch;
    out.push(`# Agente ${v.task_id} (dispatch #${v.seq}) — ${v.state}${v.why ? ` (${v.why})` : ""}`, "");
    out.push("## Dispatch (header registrato da guard-budget)");
    out.push(`- ${d.at} · ${d.type} · scope ${d.scope ?? "—"} · modalità ${d.mode ?? "—"} · tier ${d.tier ?? "—"} · profondità ${d.depth ?? "—"} · modello ${d.model ?? "—"}${d.model_requested && d.model_requested !== d.model ? ` (richiesto ${d.model_requested})` : ""}`);
    out.push(`- budget ${d.budget_tokens ?? "—"} token${d.minutes ? ` · ${d.minutes} min` : ""} · classi ${list(d.classes)}${d.kind !== "task" ? ` · ${d.kind}${d.contract ? ` contratto ${d.contract}` : ""}` : ""}${d.reply_to ? ` · reply_to ${d.reply_to}` : ""}`);
    out.push(`- compito: ${d.task ?? "—"}`, `- output atteso: ${d.expected_output ?? "—"}`, `- allowed_paths: ${list(d.allowed_paths)}`, "");
    out.push(`## Chiamate di strumento (${v.calls}, dall'audit; agent_id ${v.agent_id ?? "non ancora legato"}${v.agent_source ? ` via ${v.agent_source}` : ""})`);
    if (v.timeline.length) for (const x of v.timeline) out.push(`- ${x.ts.slice(11, 19)} ${x.text}`);
    else out.push("- nessuna registrata");
    out.push("");
    if (v.chrome.steps.length || v.chrome.observations.length) {
      out.push("## Esecuzione su Chrome (step-check, observe-append)");
      for (const s of v.chrome.steps) out.push(`- ${s.ts.slice(11, 19)} ${s.plan ?? "?"} passo ${s.step ?? "?"}: ${s.status ?? "?"}${s.kind ? ` (${s.kind}${s.compat ? `, ${s.compat}` : ""})` : ""}`);
      for (const o of v.chrome.observations) out.push(`- ${o.ts.slice(11, 19)} OBS ${o.obs ?? "?"}${o.page_sig ? ` (${o.page_sig})` : ""}`);
      out.push("");
    }
    const t = v.trace;
    out.push("## Traccia cognitiva (dal rapporto, blackboard)");
    if (!t) out.push("- nessun rapporto (compito aperto o mai chiuso)");
    else {
      const rc = t.recalled ?? {};
      out.push(`- status ${t.status ?? "—"} → effettivo ${t.status_effective ?? "—"}`);
      out.push(`- richiamo: semantica ${list(rc.semantic)} · episodica ${list(rc.episodic)} · di lavoro ${list(rc.working)}`);
      if (t.epistemic) out.push(`- forma epistemica: ${t.epistemic.subject ?? "?"} ${t.epistemic.shape_before ?? "?"} → ${t.epistemic.shape_after ?? "?"}`);
      out.push(`- strategia: ${t.strategy ?? "—"}`);
      out.push(`- decisioni: ${list((t.decisions ?? []).map((x) => (typeof x === "string" ? x : x?.code ?? JSON.stringify(x))))}${(t.decisions ?? []).length ? " (perché: /vc why <DEC>)" : ""}`);
      if (t.why && Object.keys(t.why).length) out.push(`- why: ${truncate(redact(JSON.stringify(t.why)), 300)}`);
      out.push(`- sorprese: ${t.surprises ?? 0}${t.surprise_items.length ? ` (${t.surprise_items.map((x) => (typeof x === "string" ? x : x?.item ?? "?")).join(", ")})` : ""}`);
      out.push(`- self-check: ${t.self_check ? `${t.self_check.passed}/10${t.self_check.failed?.length ? `, falliti ${t.self_check.failed.join(", ")}` : ""}` : "—"}`);
      out.push(`- lezione: ${t.lesson ?? "—"} · output: ${list(t.output_codes)} · domande aperte: ${(t.open_questions ?? []).length}`);
    }
    out.push("");
    const u = v.usage;
    out.push("## Token e durata");
    out.push(`- token ${u.tokens ?? "—"}${u.by_model ? ` (${Object.entries(u.by_model).map(([k, n]) => `${k} ${n}`).join(", ")})` : ""} · fonte ${u.source ?? "—"} · durata ${dur(u.duration_ms)}`);
    if (v.denies.length) out.push("", "## Deny dei guard", ...v.denies.map((x) => `- ${x.ts.slice(11, 19)} ${x.guard} ${x.tool ?? ""}: ${x.reason}`));
    out.push("", "## Coerenza rapporto ↔ registrazioni");
    out.push(v.coherence.incoerente ? `- INCOERENTE: ${v.coherence.flags.join(" · ")}` : "- coerente");
    for (const n of v.coherence.notes) out.push(`- nota: ${n}`);
    out.push("");
  }
  return `${out.join("\n")}\n`;
}

// ---- history ----
export function history(c, { scope = null, last = null } = {}) {
  let rows = c.rows.filter((r) => !scope || r.scope === scope);
  if (Number.isInteger(last) && last > 0) rows = rows.slice(-last);
  return rows.map((r) => ({ seq: r.seq, task_id: r.task_id, type: r.type, scope: r.scope, tier: r.tier, started: r.started, duration_ms: r.duration_ms, state: r.state, status_effective: r.status_effective, surprises: r.surprises, lesson: r.lesson, tokens: r.used, calls: r.calls, flag: r.flag ?? null }));
}
export const renderHistory = (h) => `${h.length ? h.map((r) => `#${r.seq} ${r.started?.slice(0, 16) ?? "?"} ${pad(r.task_id, 22)} ${pad(r.type, 16)} ${pad(r.scope, 5)} ${pad(r.tier, 4)} ${pad(r.state, 16)} sorprese ${r.surprises ?? "—"} · chiamate ${r.calls} · token ${r.tokens ?? "—"} · lezione ${r.lesson ?? "—"}${r.flag ? " · INCOERENTE" : ""}`).join("\n") : "(nessun compito)"}\n`;

const strip = (c) => { const { _m, _act, _bb, ...rest } = c; return rest; };

const HELP = `uso: node scripts/admin/agents.mjs status [--json]
       node scripts/admin/agents.mjs show <task_id> [--json]
       node scripts/admin/agents.mjs history [--scope <S>] [--last <N>] [--json]
       node scripts/admin/agents.mjs watch [--interval <secondi>] [--count <n>]
       Opzioni: --session <id|SES.C.AAAAMMGG.NNN> · --workspace <dir> · --help

Console degli agenti (monitor indipendente): lo stato di ogni sub-agente ricavato solo dalle registrazioni degli
hook (audit per agent_id, invocations, blackboard, workflow, controllo dell'utente), mai dal testo del manager.
Sola lettura. \`watch\` si usa da un terminale separato mentre gli agenti lavorano (Ctrl+C per uscire).
Exit: 0 · 1 argomenti o sessione · 2 errore di sistema.`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function run(argv, env = process.env) {
  const { opts, positional } = parseArgs(argv);
  const asJson = !!opts.json;
  if (opts.help) { console.log(HELP); return 0; }
  const [cmd, arg] = positional;
  if (!["status", "show", "history", "watch"].includes(cmd ?? "status") ) { console.log(HELP); return 1; }
  const ws = resolve(opts.workspace || env.JVC_WORKSPACE || env.CLAUDE_PROJECT_DIR || process.cwd());
  try {
    const r = resolveMonitorSession(ws, opts.session, env);
    if (r.error) return fail(asJson, 1, r.error);
    const build = () => buildConsole(ws, r.customer, r.sid, r.session);
    const action = cmd ?? "status";
    if (action === "watch") {
      const every = Math.max(1, Number(opts.interval ?? 5)) * 1000;
      const count = opts.count != null ? Math.max(1, Number(opts.count)) : Infinity;
      for (let i = 0; i < count; i++) {
        // lo stato si rilegge a ogni giro (session.json incluso): nessuna scrittura
        const cur = resolveMonitorSession(ws, opts.session, env);
        const text = cur.error ? `errore: ${cur.error}\n` : renderStatus(buildConsole(ws, cur.customer, cur.sid, cur.session));
        if (process.stdout.isTTY) process.stdout.write("\x1b[2J\x1b[H");
        process.stdout.write(`${text}${cur.warning ? `avviso: ${cur.warning}\n` : ""}— aggiornato ${new Date().toISOString().slice(11, 19)} · ogni ${every / 1000}s · Ctrl+C per uscire\n`);
        if (i + 1 < count) await sleep(every);
      }
      return 0;
    }
    const c = build();
    if (action === "show") {
      if (!arg) return fail(asJson, 1, "show richiede il task_id");
      const v = showTask(c, arg);
      if (!v) return fail(asJson, 1, `nessun dispatch con task_id ${arg} in questa sessione`);
      if (asJson) console.log(JSON.stringify({ ok: true, task_id: arg, dispatches: v })); else process.stdout.write(renderShow(v));
      return 0;
    }
    if (action === "history") {
      const last = opts.last != null ? Number(opts.last) : null;
      if (last != null && !(Number.isInteger(last) && last > 0)) return fail(asJson, 1, "--last: intero positivo");
      const h = history(c, { scope: opts.scope ?? null, last });
      if (asJson) console.log(JSON.stringify({ ok: true, history: h })); else process.stdout.write(renderHistory(h));
      return 0;
    }
    if (asJson) console.log(JSON.stringify({ ok: true, ...strip(c), states: STATES, warning: r.warning }));
    else process.stdout.write(`${renderStatus(c)}${r.warning ? `avviso: ${r.warning}\n` : ""}`);
    return 0;
  } catch (err) { return fail(asJson, 2, `errore di sistema: ${redact(String(err?.message ?? err))}`); }
}

if (isMain(import.meta.url)) run(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(e); process.exit(2); });
