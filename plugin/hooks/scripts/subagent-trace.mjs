// SubagentStop (§42 M2, M3): vigilanza cognitiva e contabilità del budget.
//  1. rapporto = last_assistant_message (o ultimo testo assistant del
//     transcript del sub-agente) → extractReport + validateReport;
//  2. traccia o lezione mancanti/invalide su un sub-agente del plugin e blocchi
//     per quell'agent_id < 2 ⇒ {decision:"block", reason:"completa la traccia: mancano …"};
//     al terzo stop passa marcato trace_incomplete ⇒ status effettivo partial;
//  3. uso: somma delle righe assistant del transcript (dedup per message.id;
//     input + output + cache_creation) nel budget.used/by_model, per delta fra
//     uno stop e l'altro; in assenza di transcript, l'usage del rapporto
//     (usage_source: self-declared);
//  4. rapporto compatto in blackboard/<task_id>.yaml; evento di audit kind agent.
// stop_hook_active: si blocca di nuovo solo una continuazione causata da noi
// (trace_blocks[agent_id] ≥ 1); il contatore garantisce la terminazione.
// Fail-OPEN: un'eccezione non blocca mai (niente cicli), avvisa.
import { existsSync, readFileSync, writeFileSync, mkdirSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { allows } from "../lib/policy.mjs";
import YAML from "yaml";
import { runHook, block } from "../lib/io.mjs";
import { loadHookState, baseAgentType, invocationsFile, sessionDir } from "../lib/workspace.mjs";
import { matchInvocation, claimedSeqs, invocationType } from "../lib/invocations.mjs";
import { appendAudit } from "../lib/audit.mjs";
import { readJsonl } from "../lib/state-summary.mjs";
import { extractReport, validateReport } from "../../scripts/admin/agent-report.mjs";
import { parsePromptHeader } from "../../scripts/admin/agent-prompt.mjs";
import { updateSession } from "../../scripts/admin/session.mjs";
import { isMain } from "../../scripts/lib/is-main.mjs";
import { agentStateFile } from "../lib/control.mjs";
import { auditTail, stepCheckSurprises } from "../lib/agents-model.mjs";

export const MAX_BLOCKS = 2;
// Le quindici definizioni foglia di §44.2.
export const PLUGIN_AGENTS = new Set([
  "scope-expert", "scope-extractor", "scope-digester", "customer-profiler", "process-mapper", "cluster-validator", "weekly-digest",
  "root-cause-analyst", "config-designer", "lesson-validator", "analytics-learner", "test-mechanic", "failure-triage", "config-auditor", "defect-reporter",
]);
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
// WP10b parte 2: le profondità di DT-023 (cognitive-trace.schema.json)
const DEPTHS = new Set(["rapida", "standard", "profonda"]);

export const modelKey = (m) => (/haiku/i.test(m ?? "") ? "haiku" : /sonnet/i.test(m ?? "") ? "sonnet" : /opus/i.test(m ?? "") ? "opus" : "other");

function agentTranscript(input) {
  if (input.agent_transcript_path && existsSync(input.agent_transcript_path)) return input.agent_transcript_path;
  if (input.transcript_path && input.session_id && input.agent_id) {
    const f = join(dirname(input.transcript_path), String(input.session_id), "subagents", `agent-${input.agent_id}.jsonl`);
    if (existsSync(f)) return f;
  }
  return null;
}

const textOf = (m) => (Array.isArray(m?.content) ? m.content.filter((c) => c?.type === "text").map((c) => c.text).join("\n") : typeof m?.content === "string" ? m.content : "");

// Uso dal transcript: una voce per message.id (le righe di uno stesso
// messaggio ripetono lo stesso usage), input + output + cache_creation.
// `firstPrompt`: il testo del primo messaggio user = il prompt scritto dal
// dispatcher (con l'header che guard-budget ha verificato).
export function transcriptUsage(file) {
  const byId = new Map();
  let lastText = null;
  let firstPrompt = null;
  readJsonl(file).forEach((ev, i) => {
    if (firstPrompt == null && ev?.type === "user" && ev.message) { const t = textOf(ev.message); if (t.trim()) firstPrompt = t; }
    if (ev?.type !== "assistant" || !ev.message) return;
    const m = ev.message;
    if (m.usage) byId.set(m.id ?? `line-${i}`, { usage: m.usage, model: m.model });
    const text = Array.isArray(m.content) ? m.content.filter((c) => c?.type === "text").map((c) => c.text).join("\n") : typeof m.content === "string" ? m.content : "";
    if (text.trim()) lastText = text;
  });
  const by_model = {};
  let total = 0;
  for (const { usage: u, model } of byId.values()) {
    if (model === "<synthetic>") continue;
    const n = (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    const k = modelKey(model);
    by_model[k] = (by_model[k] ?? 0) + n;
    total += n;
  }
  return { total, by_model, source: "transcript", lastText, firstPrompt };
}

function selfDeclared(report) {
  const u = report?.usage;
  if (!u) return { total: 0, by_model: {}, source: "none" };
  const n = (Number.isInteger(u.tokens_in) ? u.tokens_in : 0) + (Number.isInteger(u.tokens_out) ? u.tokens_out : 0);
  return { total: n, by_model: n ? { [modelKey(u.model)]: n } : {}, source: "self-declared" };
}

function missingList(v) {
  if (v.missing.includes("rapporto")) return "il rapporto finale in un blocco ```yaml conforme a schemas/agent-report.schema.json (task_id, status, cognitive_trace, lesson)";
  const parts = [...v.missing, ...(v.invalid ?? []).map((x) => `${x} (non valido)`)];
  return parts.length ? parts.join(", ") : v.errors.join("; ");
}

export function handle(input, env = process.env) {
  const st = loadHookState(input, env);
  if (!st.jvc || !st.session) return null;
  const agentId = String(input.agent_id ?? "unknown");
  const agentType = baseAgentType(input.agent_type);
  const tfile = agentTranscript(input);
  const measuredT = tfile ? transcriptUsage(tfile) : null;
  const text = typeof input.last_assistant_message === "string" && input.last_assistant_message.trim() ? input.last_assistant_message : measuredT?.lastText ?? "";
  const report = extractReport(text);
  const v0 = validateReport(report);
  const measured = measuredT && measuredT.total > 0 ? measuredT : selfDeclared(report);
  // Identità del dispatch (fix round 2 F3): dall'header del primo prompt nel
  // transcript del sub-agente — scritto dal dispatcher, verificato da
  // guard-budget, non autodichiarato. Senza transcript: tipo + ordine.
  const hdr = measuredT?.firstPrompt ? parsePromptHeader(measuredT.firstPrompt) : null;
  const hdrTask = hdr?.task_id != null ? String(hdr.task_id) : null;

  const invs = readJsonl(invocationsFile(st.ws, st.customer, st.sid));
  let recordedSurprises = 0;
  try { recordedSurprises = stepCheckSurprises(auditTail(st.ws, st.customer, st.sid, { bytes: 4 * 1024 * 1024 })).get(agentId) ?? 0; } catch { recordedSurprises = 0; }
  let bound = null;
  try { bound = JSON.parse(readFileSync(agentStateFile(st.ws, st.customer, st.sid, agentId), "utf8")); } catch { bound = null; }
  let outcome = null;
  let v = v0;
  const session = updateSession(st.sessionFile, (s) => {
    // Il task_id dichiarato nel rapporto non sceglie mai l'invocazione (#14).
    // 1) header del primo prompt nel transcript (F3): l'invocazione non ancora
    //    reclamata con quel task_id (o, se chiusa a mano, l'ultima con quel task_id);
    // 2) senza transcript: primo dispatch libero dello stesso tipo, in ordine.
    let entry = s.ledger.invocations.find((i) => i.agent_id === agentId);
    let seq = null;
    let source = entry?.task_id_source ?? null;
    if (entry) seq = Number.isInteger(entry.inv_seq) ? entry.inv_seq : null;
    else {
      // L'header vale solo se corrisponde a un dispatch registrato da guard-budget
      // (altrimenti non è verificato: si ricade su tipo + ordine).
      if (hdrTask) {
        const claimed = claimedSeqs(invs, s.ledger.invocations);
        let k = invs.findIndex((x, i) => !claimed.has(i) && String(x?.task_id) === hdrTask);
        if (k < 0) k = invs.findLastIndex((x) => String(x?.task_id) === hdrTask);
        if (k >= 0) { seq = k; source = "header"; }
      }
    }
    // WP10d: senza header, il legame registrato da guard-control alla prima chiamata dell'agente (agents/<id>.json,
    // protetto) precede l'ordine di dispatch
    if (!entry && source !== "header" && Number.isInteger(bound?.inv_seq) && invs[bound.inv_seq]) { seq = bound.inv_seq; source = "guard-control"; }
    if (!entry && source !== "header" && source !== "guard-control") {
      seq = matchInvocation(invs, s.ledger.invocations, agentType);
      source = seq != null ? "dispatch-order" : "declared";
    }
    // WP10d (D8): FERMA AGENTE ha già chiuso l'invocazione (voce senza agent_id, closed_by user-stop): la si adotta
    if (!entry && seq != null) {
      const stopped = s.ledger.invocations.find((e) => e?.inv_seq === seq && e.closed_by === "user-stop" && !e.agent_id);
      if (stopped) Object.assign(stopped, { agent_id: agentId, agent_type: agentType, task_id_source: source, tokens: stopped.tokens ?? 0, tokens_by_model: stopped.tokens_by_model ?? {}, blocks: stopped.blocks ?? 0 }), entry = stopped;
    }
    const match = seq != null ? invs[seq] ?? null : null;
    const enforce = entry ? !!entry.enforced : !!match || PLUGIN_AGENTS.has(agentType);
    if (!entry) {
      entry = { agent_id: agentId, agent_type: agentType, inv_seq: seq, task_id: match?.task_id ?? report?.task_id ?? null, task_id_source: source, enforced: enforce, tokens: 0, tokens_by_model: {}, blocks: 0 };
      s.ledger.invocations.push(entry);
    }
    const declared = report?.task_id != null ? String(report.task_id) : null;
    const expected = entry.task_id != null ? String(entry.task_id) : null;
    v = v0;
    if (declared && expected && declared !== expected && (source === "header" || match)) {
      // Con identità solo per ordine (niente transcript) e il task_id dichiarato
      // che è un altro dispatch aperto dello stesso tipo, l'ordine può essere
      // sbagliato (dispatch paralleli): avviso di traccia, non blocco (F3).
      // Ambiguo anche se quel dispatch è già stato reclamato da un altro stop
      // abbinato per ordine (il "gemello" finito prima: fix round 3).
      const claimed = claimedSeqs(invs, s.ledger.invocations);
      const byOrder = new Set(s.ledger.invocations.filter((e) => e !== entry && e?.task_id_source === "dispatch-order" && Number.isInteger(e.inv_seq)).map((e) => e.inv_seq));
      const ambiguous = source === "dispatch-order" && invs.some((x, i) => i !== seq && (!claimed.has(i) || byOrder.has(i)) && String(x?.task_id) === declared && invocationType(x) === agentType);
      if (ambiguous) {
        const w = `task_id dichiarato ${declared} ≠ ${expected} abbinato per ordine di dispatch (transcript assente, dispatch paralleli dello stesso tipo): identità non verificabile`;
        entry.trace_warnings = [...new Set([...(entry.trace_warnings ?? []), w])];
      } else {
        v = { ...v0, ok: false, invalid: [...(v0.invalid ?? []), `task_id: il rapporto dichiara ${declared} ma il dispatch è ${expected}`], errors: [...v0.errors, `task_id ${declared} ≠ ${expected}`] };
      }
    }
    // Uso: si somma solo il delta rispetto a quanto già contato per questo agente.
    for (const [k, n] of Object.entries(measured.by_model)) {
      const delta = n - (entry.tokens_by_model[k] ?? 0);
      if (delta > 0) {
        s.budget.used += delta;
        s.budget.by_model[k] = (s.budget.by_model[k] ?? 0) + delta;
        entry.tokens_by_model[k] = n;
        entry.tokens += delta;
      }
    }
    entry.usage_source = measured.source;
    const blocks = s.ledger.trace_blocks[agentId] ?? 0;
    const continuationOfOurs = !input.stop_hook_active || blocks >= 1;
    // WP10d (D8): un agente fermato dall'utente non si blocca per completare la traccia
    if (enforce && !v.ok && blocks < MAX_BLOCKS && continuationOfOurs && entry.closed_by !== "user-stop") {
      s.ledger.trace_blocks[agentId] = blocks + 1;
      entry.blocks = blocks + 1;
      outcome = { decision: "block", reason: `completa la traccia: mancano ${missingList(v)}. Il tuo ultimo messaggio deve essere solo il rapporto YAML (§46.2) con cognitive_trace e lesson. Blocco ${blocks + 1}/${MAX_BLOCKS}.`, blocks: blocks + 1, match };
      return;
    }
    const reclassified = [...(v.reclassified ?? [])];
    if (v !== v0 && declared !== expected) reclassified.push(`task_id dichiarato ${declared} ≠ task_id del dispatch ${expected}`);
    let effective = v.ok ? v.status_effective : "partial";
    if (entry.closed_by === "user-stop") effective = "aborted-by-user";
    // WP10b parte 2 (carry): la profondità dichiarata nella traccia deve essere quella dell'header del dispatch
    // (registrata da guard-budget in invocations.jsonl, non autodichiarata). Discordanza ⇒ partial con errore di
    // traccia: il self_check si giudica sui controlli della profondità dichiarata, e una profondità più bassa di
    // quella chiesta ne salterebbe alcuni. Nessun blocco: si registra, non si chiede all'agente di riscriverla.
    const traceErrors = [];
    const hdrDepth = DEPTHS.has(match?.depth) ? match.depth : null;
    const declDepth = report?.cognitive_trace?.depth ?? null;
    if (hdrDepth && declDepth != null && declDepth !== hdrDepth) {
      const e = `profondità dichiarata ${declDepth} ≠ profondità del dispatch ${hdrDepth}`;
      traceErrors.push(e);
      reclassified.push(e);
      if (effective === "ok") effective = "partial";
    }
    if (match?.budget_tokens && entry.tokens > match.budget_tokens) {
      reclassified.push(`budget del compito superato (${entry.tokens}/${match.budget_tokens})`);
      if (effective === "ok") effective = "partial";
    }
    // WP10d (D2 vigilanza, D1 console): scope e tier del dispatch (registrati da guard-budget, non dal rapporto) e numero
    // di sorprese dichiarate nella traccia
    const surprisesN = Array.isArray(report?.cognitive_trace?.surprises) ? report.cognitive_trace.surprises.length : 0;
    // giro 1 (minore 5): la vigilanza non si fida della sola autodichiarazione — vale il maggiore fra le sorprese
    // dichiarate e quelle registrate da step-check per questo agente (audit)
    const recordedN = recordedSurprises;
    Object.assign(entry, {
      task_id: entry.task_id ?? null, scope: match?.scope ?? entry.scope ?? null, tier: match?.tier ?? entry.tier ?? null, surprises: Math.max(surprisesN, recordedN), surprises_declared: surprisesN, surprises_recorded: recordedN,
      status: report?.status ?? null, status_effective: effective, error_class: report?.error_class ?? null,
      trace_incomplete: enforce && !v.ok, reclassified, ...(traceErrors.length ? { trace_errors: traceErrors } : {}), lesson: report?.lesson ?? null, model: match?.model ?? null,
      completed_at: new Date().toISOString(),
    });
    for (const x of report?.cognitive_trace?.surprises ?? []) {
      s.surprises.push(typeof x === "object" && x ? { at: x.at ?? new Date().toISOString(), item: x.item ?? null, obs: x.obs ?? null, task: entry.task_id } : { at: new Date().toISOString(), item: String(x), obs: null, task: entry.task_id });
    }
    outcome = { decision: "pass", entry: { ...entry }, match };
  });

  const entry = outcome.entry ?? session.ledger.invocations.find((i) => i.agent_id === agentId);
  const taskId = entry?.task_id ?? report?.task_id ?? null;
  if (outcome.decision === "pass" && (entry.enforced || report)) {
    const bbDir = join(sessionDir(st.ws, st.customer, st.sid), "blackboard");
    mkdirSync(bbDir, { recursive: true });
    const name = taskId && SAFE_NAME.test(String(taskId)) ? String(taskId).replace(/:/g, "_") : `agent-${agentId.replace(/[^A-Za-z0-9._-]/g, "_")}`;
    const ct = report?.cognitive_trace;
    writeFileSync(join(bbDir, `${name}.yaml`), YAML.stringify({
      task_id: taskId, agent_type: agentType, agent_id: agentId, status: entry.status, status_effective: entry.status_effective,
      trace_incomplete: entry.trace_incomplete, reclassified: entry.reclassified, trace_errors: entry.trace_errors ?? [], output: report?.output ?? null, lesson: entry.lesson,
      // WP10d (D7): anche richiamo, forma epistemica prima/dopo, ipotesi e i `why` delle DEC (solo codici e riassunti)
      cognitive_trace: ct ? { depth: ct.depth, recalled: ct.recalled ?? null, epistemic: ct.epistemic ?? null, strategy: ct.strategy, hypotheses: ct.hypotheses ?? null, decisions: ct.decisions,
        surprises: Array.isArray(ct.surprises) ? ct.surprises.length : 0, surprise_items: Array.isArray(ct.surprises) ? ct.surprises.slice(0, 10) : [], self_check: ct.self_check } : null,
      why: report?.why ?? null, declared_tools: Number.isInteger(report?.output?.tool_calls) ? report.output.tool_calls : null,
      needs_input: report?.needs_input ?? null, open_questions: report?.open_questions ?? [],
      usage: { tokens: entry.tokens, by_model: entry.tokens_by_model, source: entry.usage_source }, at: new Date().toISOString(),
    }));
  }
  appendAudit(st.ws, {
    session: st.sid, customer: st.customer, scope: session.scope, kind: "agent", actor: "hook:subagent-trace", code: entry?.lesson ?? null,
    correlation: { task: taskId },
    payload: {
      decision: outcome.decision, agent_type: agentType, agent_id: agentId, blocks: session.ledger.trace_blocks[agentId] ?? 0,
      status: entry?.status ?? report?.status ?? null, status_effective: entry?.status_effective ?? null, trace_incomplete: entry?.trace_incomplete ?? null,
      tokens: entry?.tokens ?? 0, usage_source: entry?.usage_source ?? null, missing: v.ok ? [] : v.missing, trace_errors: entry?.trace_errors ?? [], stop_hook_active: !!input.stop_hook_active,
    },
  });
  // 28/10/2026 (decisione dell'utente: imparare il più possibile per una seconda run veloce): a fine compito in esplorazione
  // atlas-build trasforma il registro della sessione in FLD, SEL e percorsi della conoscenza, in background (processo
  // staccato: non rallenta la chiusura); idempotente, i doppioni non si riscrivono. Esito in atlas/auto-build.json.
  if (outcome.decision !== "block" && allows(session, "apprendimento_automatico")) {
    try {
      const log = join(sessionDir(st.ws, st.customer, st.sid), "atlas", "pages.jsonl");
      // giro 2: un solo atlas-build alla volta per sessione (lock con l'ora: scade dopo 10 minuti)
      const lock = join(dirname(log), "auto-build.lock");
      let busy = false;
      try { busy = Date.now() - Number(readFileSync(lock, "utf8")) < 600000; } catch { busy = false; }
      if (existsSync(log) && !busy) {
        writeFileSync(lock, String(Date.now()));
        const out = openSync(join(dirname(log), "auto-build.json"), "w");
        const script = fileURLToPath(new URL("../../scripts/kb/atlas-build.mjs", import.meta.url));
        spawn(process.execPath, [script, "--session", st.sid, "--customer", st.customer, "--workspace", st.ws, "--json"], { detached: true, stdio: ["ignore", out, out], windowsHide: true }).unref();
      }
    } catch { /* l'apprendimento si recupera con health-keeper */ }
  }
  return outcome.decision === "block" ? block(outcome.reason) : null;
}

if (isMain(import.meta.url)) runHook((input) => handle(input), { name: "subagent-trace", failClosed: false });
