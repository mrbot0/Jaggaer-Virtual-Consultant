// guard-control (PreToolUse su OGNI strumento, FAIL-CLOSED) — WP10d D8: il controllo dell'utente sugli agenti,
// applicato dai guard e non dal modello. Solo le chiamate dei sub-agenti (agent_id presente): la sessione principale
// esce subito, senza leggere nulla (percorso veloce: gira a ogni chiamata di strumento).
//  - legame agente → compito: alla prima chiamata dell'agent_id, dal task_id dell'header del primo prompt nel
//    transcript del sub-agente (scritto dal dispatcher e verificato da guard-budget); senza transcript, il solo
//    dispatch aperto dello stesso tipo non ancora legato; più candidati ⇒ identità ambigua (vale il più restrittivo).
//    Stato in customers/<C>/.sessions/<sid>/agents/<agent_id>.json (protetto, lo scrive solo questo guard);
//  - FERMA AGENTE/TUTTI ⇒ deny (l'agente restituisce subito il rapporto blocked; l'invocazione l'ha già chiusa
//    approval-capture come aborted-by-user); PAUSA AGENTE/TUTTI ⇒ deny finché RIPRENDI (confermata nel transcript);
//  - limiti per dispatch: chiamate di strumento (default 200) e durata dal dispatch (default 30 minuti; se l'header
//    dichiara budget.minutes vale il minore) — solo l'utente li cambia (LIMITI DISPATCH, confermata); oltre ⇒ deny e
//    l'agente restituisce partial;
//  - PASSO PASSO <task_id|TUTTI>: ogni azione con effetto (browser input/click/upload/invio/script, strumenti MCP non
//    di sola lettura, scritture su file o via shell fuori dalle cartelle di lavoro del dispatch) richiede il `sì`
//    dell'utente, lo stesso meccanismo delle azioni R2 (K5.6): il guard registra la richiesta in
//    session.pending.approvals (kind action, plan PLAN.PASSO.<compito>, impronta dell'azione), approval-capture
//    registra il sì, il guard lo conferma nel transcript e lo consuma (monouso) sulla STESSA azione.
// Ogni deny è in audit (kind guard, actor hook:guard-control, agent_id).
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, openSync, readSync, closeSync, fstatSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { deny } from "../io.mjs";
import { loadHookState, invocationsFile, sessionDir, baseAgentType, pluginRoot } from "../workspace.mjs";
import { appendAudit } from "../audit.mjs";
import { summarizeInput } from "../tool-summary.mjs";
import { readJsonl } from "../state-summary.mjs";
import { invocationType, sessionTtlMs } from "../invocations.mjs";
import { withFileLock, writeFileAtomic } from "../fsx.mjs";
import { allows } from "../policy.mjs";
import { controlFile, agentsDir, agentStateFile, readControl, confirmPending, controlState, transcriptCandidates, ALL, safeName } from "../control.mjs";

const G = "guard-control";
const HEAD_BYTES = 64 * 1024;
const TASK_RE = /^task_id:\s*["']?([A-Za-z0-9][A-Za-z0-9._:-]{0,127})/m;

function readJson(f) { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return null; } }

function denyA(st, input, reason, extra = {}) {
  try {
    appendAudit(st.ws, { session: st.sid, customer: st.customer, scope: st.session?.scope ?? null, kind: "guard", actor: `hook:${G}`, correlation: { task: extra.task ?? null },
      payload: { decision: "deny", tool: String(input.tool_name ?? ""), reason, input_summary: summarizeInput(input.tool_name, input.tool_input), agent_type: baseAgentType(input.agent_type), agent_id: String(input.agent_id) } });
  } catch { /* l'audit non cambia la decisione */ }
  return deny(`[${G}] ${reason}`);
}

// ---- legame agent_id → compito ----
function agentTranscript(input) {
  const out = [];
  if (typeof input.agent_transcript_path === "string") out.push(input.agent_transcript_path);
  const tp = typeof input.transcript_path === "string" ? input.transcript_path : null;
  if (tp) {
    if (/[\\/]subagents[\\/][^\\/]+\.jsonl$/.test(tp)) out.push(tp);
    else if (input.session_id) out.push(join(dirname(tp), String(input.session_id), "subagents", `agent-${input.agent_id}.jsonl`));
  }
  return out.find((p) => existsSync(p)) ?? null;
}

// task_id dell'header del primo prompt (riga user) nel transcript del sub-agente (lettura della sola testa).
export function headerTaskId(file) {
  if (!file) return null;
  let text;
  const fd = openSync(file, "r");
  try { const len = Math.min(fstatSync(fd).size, HEAD_BYTES); const buf = Buffer.alloc(len); readSync(fd, buf, 0, len, 0); text = buf.toString("utf8"); } finally { closeSync(fd); }
  for (const l of text.split("\n")) {
    let ev;
    try { ev = JSON.parse(l); } catch { continue; }
    if (ev?.type !== "user" || !ev.message) continue;
    const c = ev.message.content;
    const t = typeof c === "string" ? c : Array.isArray(c) ? c.filter((p) => p?.type === "text").map((p) => p.text).join("\n") : "";
    if (!t.trim()) continue;
    const s = t.replace(/^\s+/, "").replace(/\r\n/g, "\n");
    const h = /^\s*```ya?ml[ \t]*\n([\s\S]*?)\n```/.exec(s) ?? /^\s*---[ \t]*\n([\s\S]*?)\n---[ \t]*(\n|$)/.exec(s);
    return h ? TASK_RE.exec(h[1])?.[1] ?? null : null;
  }
  return null;
}

// giro 1 (minore 2): un legame non risolto (ambiguo o senza candidati) si ricalcola a ogni chiamata finché non si
// risolve; senza candidati del suo tipo l'agente vale per OGNI dispatch ancora in attesa di un agente (il più
// restrittivo, come l'ambiguità: ogni dispatch aperto). "In attesa di un agente": non reclamato da una voce del ledger con agent_id, non
// chiuso a mano né scaduto (una voce user-stop senza agent_id resta: l'agente fermato non è ancora tornato).
const UNRESOLVED = new Set(["none", "ambiguous"]);
function bind(st, input, now) {
  const f = agentStateFile(st.ws, st.customer, st.sid, input.agent_id);
  const cur = readJson(f);
  const mine = cur && cur.agent_id === String(input.agent_id) ? cur : null;
  if (mine && !UNRESOLVED.has(mine.source)) return { f, a: mine };
  const invs = readJsonl(invocationsFile(st.ws, st.customer, st.sid)).map((x, seq) => ({ ...x, seq }));
  const dir = agentsDir(st.ws, st.customer, st.sid);
  const bound = new Set();
  if (existsSync(dir)) for (const n of readdirSync(dir)) { const s = n.endsWith(".json") ? readJson(join(dir, n)) : null; if (Number.isInteger(s?.inv_seq) && s.agent_id !== String(input.agent_id)) bound.add(s.inv_seq); }
  for (const e of st.session.ledger?.invocations ?? []) if (Number.isInteger(e?.inv_seq) && (e.agent_id || (e.completed_at && e.closed_by !== "user-stop"))) bound.add(e.inv_seq);
  const ttl = sessionTtlMs(sessionDir(st.ws, st.customer, st.sid));
  const waiting = invs.filter((x) => !bound.has(x.seq) && !(now - Date.parse(x.ts) > ttl));
  const type = baseAgentType(input.agent_type) ?? "general-purpose";
  let task = null;
  let inv = null;
  let source;
  let candidates = [];
  const hdr = headerTaskId(agentTranscript(input));
  if (hdr) {
    const same = invs.filter((x) => String(x.task_id) === hdr);
    inv = same.filter((x) => !bound.has(x.seq)).at(-1) ?? same.at(-1) ?? null;
    task = hdr;
    source = inv ? "header" : "header-unregistered";
  } else {
    const open = waiting.filter((x) => invocationType(x) === type);
    candidates = [...new Set(open.map((x) => String(x.task_id)))];
    if (candidates.length === 1) { inv = open[0]; task = candidates[0]; candidates = []; source = "dispatch-order"; }
    else if (candidates.length) source = "ambiguous";
    else {
      // nessun candidato del suo tipo: vale per ogni dispatch aperto della sessione (anche già legato ad altri agenti)
      const closed = new Set((st.session.ledger?.invocations ?? []).filter((e) => Number.isInteger(e?.inv_seq) && e.completed_at && e.closed_by !== "user-stop").map((e) => e.inv_seq));
      source = "none";
      candidates = [...new Set(invs.filter((x) => !closed.has(x.seq) && !(now - Date.parse(x.ts) > ttl)).map((x) => String(x.task_id)))];
    }
  }
  if (mine) {
    // ancora non risolto: candidati aggiornati, nessuna scrittura; risolto: si registra conservando chiamate e inizio
    if (UNRESOLVED.has(source)) return { f, a: { ...mine, candidates, source } };
    const a = { ...mine, task_id: task, candidates: [], inv_seq: inv?.seq ?? null, source, rebound_at: new Date(now).toISOString() };
    withFileLock(`${f}.lock`, () => { const s = readJson(f) ?? {}; writeFileAtomic(f, JSON.stringify({ ...a, calls: s.calls ?? mine.calls ?? 0, last_ts: s.last_ts ?? null })); });
    return { f, a };
  }
  const a = { agent_id: String(input.agent_id), agent_type: type, task_id: task, candidates, inv_seq: inv?.seq ?? null, source, first_ts: new Date(now).toISOString(), last_ts: null, calls: 0 };
  mkdirSync(dirname(f), { recursive: true });
  return withFileLock(`${f}.lock`, () => {
    const again = readJson(f);
    if (again && again.agent_id === a.agent_id) return { f, a: again };
    writeFileAtomic(f, JSON.stringify(a));
    return { f, a };
  });
}

// ---- azioni con effetto (passo-passo) ----
const WRITE_FILE = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const READ_ONLY = new Set(["Read", "Glob", "Grep", "LS", "TodoWrite", "WebSearch", "ToolSearch", "ListMcpResourcesTool", "ReadMcpResourceTool"]);
const EFFECT_KINDS = new Set(["input", "click", "upload", "script", "other"]);

async function effectOf(st, input, allowedPaths) {
  const tool = String(input.tool_name ?? "");
  const ti = input.tool_input && typeof input.tool_input === "object" ? input.tool_input : {};
  if (READ_ONLY.has(tool)) return null;
  const { isBrowserTool, classify } = await import("../browser-tools.mjs");
  if (isBrowserTool(tool)) {
    const c = classify(tool, ti);
    const acts = c.actions ?? [c];
    const eff = acts.filter((a) => EFFECT_KINDS.has(a.kind) || a.submits === true || (a.kind === "dialog" && a.submits));
    return eff.length ? `${tool.replace(/^mcp__/, "")} (${[...new Set(eff.map((a) => (a.submits ? `${a.kind}+invio` : a.kind)))].join(", ")})` : null;
  }
  if (/^mcp__/.test(tool)) {
    const { classifyAlm } = await import("../alm.mjs");
    const alm = classifyAlm(tool);
    if (alm && alm.category === "read") return null;
    return `${tool.replace(/^mcp__/, "")}${alm ? ` (${alm.category} ${alm.object})` : " (strumento MCP)"}`;
  }
  const { resolveTarget, subset } = await import("../paths.mjs");
  const cwd = input.cwd ? resolve(String(input.cwd)) : st.ws;
  const outside = (T) => T.abs.size > 0 && (T.ws.size === 0 || [...T.ws].some((p) => !allowedPaths.some((q) => subset(p, q))) || (T.outside?.size ?? 0) > 0);
  if (WRITE_FILE.has(tool)) {
    const p = ti.file_path ?? ti.notebook_path;
    if (typeof p !== "string" || !p) return `${tool} senza percorso`;
    let T;
    try { T = resolveTarget(p, { cwd, ws: st.ws, plugin: pluginRoot() }); } catch { return `${tool} ${p}`; }
    return outside(T) ? `${tool} ${summarizeInput(tool, ti)}` : null;
  }
  if (tool === "Bash" || tool === "PowerShell") {
    const cmd = ti.command;
    if (typeof cmd !== "string" || !cmd.trim()) return null;
    const { shellWriteTargets } = await import("./common.mjs");
    for (const { tok, cwds } of shellWriteTargets({ cwd, ws: st.ws }, cmd)) {
      for (const d of cwds) {
        let T;
        try { T = resolveTarget(tok, { cwd: d, ws: st.ws }); } catch { return `${tool} (scrittura non analizzabile)`; }
        if (outside(T)) return `${tool} ${summarizeInput(tool, ti)}`;
      }
    }
    return null;
  }
  return READ_ONLY.has(tool) ? null : null;
}

const actionSha = (input) => createHash("sha256").update(`${input.tool_name}\n${JSON.stringify(input.tool_input ?? null)}`).digest("hex");

async function stepRefusal(st, input, a, task, stepRec, allowedPaths) {
  const what = await effectOf(st, input, allowedPaths);
  if (!what) return null;
  const { approvalsFile, readApprovals, confirmInTranscript, consumeStepToken } = await import("../../../scripts/admin/approvals.mjs");
  const plan = `PLAN.PASSO.${safeName(task ?? a.agent_id)}`;
  const sha = actionSha(input);
  const file = approvalsFile(st.ws, st.customer, st.sid);
  const reg = readApprovals(file);
  if (!reg.ok) return `passo-passo: registro delle approvazioni corrotto (${reg.reason}): nessuna azione con effetto`;
  const used = new Set(reg.records.filter((r) => r.kind === "consume").map((r) => r.ref));
  const tok = reg.records.find((r) => r.kind === "action" && r.plan === plan && r.action_sha === sha && !used.has(r.hash));
  const phrase = `PASSO PASSO ${stepRec.target === ALL ? "TUTTI" : stepRec.target}`;
  if (tok) {
    const conf = transcriptCandidates(input).some((p) => existsSync(p) && confirmInTranscript(p, [tok]).ok);
    if (!conf) return `passo-passo (${phrase}): il sì per questa azione non è confermato nel transcript dell'utente`;
    const c = consumeStepToken(file, plan, tok.step, { kind: "action" });
    if (!c || c.hash !== tok.hash) return `passo-passo (${phrase}): il sì per questa azione è già stato usato (vale una volta)`;
    return null;
  }
  const pending = Array.isArray(st.session.pending?.approvals) ? st.session.pending.approvals : [];
  const mine = pending.find((p) => p?.step_mode && p.plan === plan);
  if (mine && mine.action_sha === sha) return `passo-passo (${phrase}): l'azione «${what}» attende il sì dell'utente; il manager glielo chiede, poi ripeti ESATTAMENTE la stessa chiamata (se non puoi attendere, restituisci il rapporto needs-input)`;
  if (mine) return `passo-passo (${phrase}): c'è già un'azione in attesa del sì dell'utente («${mine.summary ?? "?"}»): ripeti quella dopo il sì, oppure restituisci il rapporto needs-input`;
  const others = pending.filter((p) => p?.kind === "action");
  if (others.length) return `passo-passo (${phrase}): un'altra conferma è in attesa dell'utente (${others.map((p) => p.task_id ?? p.plan).join(", ")}): un sì vale per una sola richiesta aperta; riprova dopo`;
  const n = 1 + Math.max(0, ...reg.records.filter((r) => r.plan === plan && Number.isInteger(r.step)).map((r) => r.step));
  const { updateSessionFile } = await import("../session-state.mjs");
  updateSessionFile(st.sessionFile, (x) => {
    x.pending.approvals = (x.pending.approvals ?? []).filter((p) => !(p?.step_mode && p.plan === plan));
    x.pending.approvals.push({ kind: "action", plan, step: n, step_mode: true, task_id: task ?? null, agent_id: a.agent_id, action_sha: sha, summary: what.slice(0, 200), requested_at: new Date().toISOString() });
  });
  return `passo-passo (${phrase}): azione con effetto «${what}» in attesa della conferma dell'utente. Il manager chiede all'utente di rispondere \`sì\` (una sola azione); poi ripeti ESATTAMENTE la stessa chiamata. Se non puoi attendere, restituisci il rapporto needs-input con l'output parziale`;
}

function countCall(f, now) {
  return withFileLock(`${f}.lock`, () => {
    const s = readJson(f) ?? {};
    s.calls = (Number.isInteger(s.calls) ? s.calls : 0) + 1;
    s.last_ts = new Date(now).toISOString();
    writeFileAtomic(f, JSON.stringify(s));
    return s;
  });
}

export async function decide(input, env = process.env) {
  if (!input.agent_id) return null;                       // sessione principale: nessuna opinione, nessuna lettura
  const st = loadHookState(input, env);
  if (!st.jvc || !st.customer || !st.session) return null;
  const now = Date.now();
  const cf = controlFile(st.ws, st.customer, st.sid);
  const ctl = readControl(cf);
  if (!ctl.ok) return denyA(st, input, `registro di controllo dell'utente manomesso (${ctl.reason}): ogni chiamata dei sub-agenti è negata finché non è ripristinato — restituisci il rapporto blocked`);
  const records = ctl.exists ? confirmPending(cf, ctl.records, transcriptCandidates(input), { now }) : [];
  const state = controlState(records);
  const { f, a } = bind(st, input, now);
  const tasks = a.task_id ? [a.task_id] : a.candidates ?? [];
  const t = state.forTasks(tasks);
  const amb = UNRESOLVED.has(a.source) && tasks.length ? ` (identità ${a.source === "none" ? "sconosciuta: nessun dispatch del suo tipo, vale per ogni dispatch in attesa" : "ambigua"} fra ${tasks.join(", ")}: transcript del sub-agente assente, vale il più restrittivo)` : "";
  const label = a.task_id ?? (tasks.length ? tasks.join("|") : a.agent_id);
  if (t.stopped) return denyA(st, input, `sub-agente ${label} fermato dall'utente (FERMA ${t.stopped.target === ALL ? "TUTTI" : `AGENTE ${t.stopped.target}`} alle ${t.stopped.ts})${amb}: non eseguire altro; restituisci subito il rapporto con status blocked e l'output parziale`, { task: a.task_id });
  if (t.paused) return denyA(st, input, `sub-agente ${label} in pausa per volontà dell'utente (PAUSA ${t.paused.target === ALL ? "TUTTI" : `AGENTE ${t.paused.target}`} alle ${t.paused.ts})${amb}: nessuno strumento finché l'utente non scrive ${t.paused.target === ALL ? "RIPRENDI TUTTI" : `RIPRENDI AGENTE ${t.paused.target}`}; se non puoi attendere, restituisci il rapporto needs-input con l'output parziale`, { task: a.task_id });
  // limiti per dispatch
  const inv = Number.isInteger(a.inv_seq) ? readJsonl(invocationsFile(st.ws, st.customer, st.sid))[a.inv_seq] ?? null : null;
  const lim = effectiveLimits(state.limits, st.session, inv);
  const minutes = lim.minutes;
  const start = Date.parse(inv?.ts ?? a.first_ts);
  if ((a.calls ?? 0) >= lim.calls) return denyA(st, input, `limite del dispatch superato: ${lim.calls} chiamate di strumento (${a.calls} eseguite) — restituisci subito il rapporto con status partial e l'output parziale; il limite lo cambia solo l'utente (LIMITI DISPATCH <chiamate> <minuti>)`, { task: a.task_id });
  if (Number.isFinite(start) && now - start > minutes * 60000) return denyA(st, input, `limite del dispatch superato: ${minutes} minuti dal dispatch (${Math.round((now - start) / 60000)} trascorsi) — restituisci subito il rapporto con status partial e l'output parziale; il limite lo cambia solo l'utente (LIMITI DISPATCH <chiamate> <minuti>)`, { task: a.task_id });
  if (t.step) {
    const allowedPaths = Array.isArray(inv?.allowed_paths) && inv.allowed_paths.length ? inv.allowed_paths : [];
    const r = await stepRefusal(st, input, a, a.task_id, t.step, allowedPaths);
    if (r) return denyA(st, input, r, { task: a.task_id });
  }
  countCall(f, now);
  return null;
}

// Limiti di un dispatch (richiesta dell'utente, 05/10/2026): in modalità esplorazione nessun tetto predefinito di chiamate
// e durata (si impara il più possibile; resta il budget di token della sessione, PAUSA/FERMA dell'utente); i limiti
// dichiarati dall'utente con LIMITI DISPATCH valgono sempre; fuori esplorazione i predefiniti e i minuti dell'header.
export function effectiveLimits(limits, session, inv) {
  if (allows(session, "limiti_dispatch_illimitati") && !limits?.set_at) return { calls: Infinity, minutes: Infinity };
  const headerMin = typeof inv?.minutes === "number" && inv.minutes > 0 ? inv.minutes : Infinity;
  return { calls: limits.calls, minutes: Math.min(limits.minutes, headerMin) };
}
