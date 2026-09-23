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
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import YAML from "yaml";
import { runHook, block } from "../lib/io.mjs";
import { loadHookState, baseAgentType, invocationsFile, sessionDir } from "../lib/workspace.mjs";
import { appendAudit } from "../lib/audit.mjs";
import { readJsonl } from "../lib/state-summary.mjs";
import { extractReport, validateReport } from "../../scripts/admin/agent-report.mjs";
import { updateSession } from "../../scripts/admin/session.mjs";
import { isMain } from "../../scripts/lib/is-main.mjs";

export const MAX_BLOCKS = 2;
// Le quindici definizioni foglia di §44.2.
export const PLUGIN_AGENTS = new Set([
  "scope-expert", "scope-extractor", "scope-digester", "customer-profiler", "process-mapper", "cluster-validator", "weekly-digest",
  "root-cause-analyst", "config-designer", "lesson-validator", "analytics-learner", "test-mechanic", "failure-triage", "config-auditor", "defect-reporter",
]);
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export const modelKey = (m) => (/haiku/i.test(m ?? "") ? "haiku" : /sonnet/i.test(m ?? "") ? "sonnet" : /opus/i.test(m ?? "") ? "opus" : "other");

function agentTranscript(input) {
  if (input.agent_transcript_path && existsSync(input.agent_transcript_path)) return input.agent_transcript_path;
  if (input.transcript_path && input.session_id && input.agent_id) {
    const f = join(dirname(input.transcript_path), String(input.session_id), "subagents", `agent-${input.agent_id}.jsonl`);
    if (existsSync(f)) return f;
  }
  return null;
}

// Uso dal transcript: una voce per message.id (le righe di uno stesso
// messaggio ripetono lo stesso usage), input + output + cache_creation.
export function transcriptUsage(file) {
  const byId = new Map();
  let lastText = null;
  readJsonl(file).forEach((ev, i) => {
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
  return { total, by_model, source: "transcript", lastText };
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
  const v = validateReport(report);
  const measured = measuredT && measuredT.total > 0 ? measuredT : selfDeclared(report);

  const invs = readJsonl(invocationsFile(st.ws, st.customer, st.sid));
  let outcome = null;
  const session = updateSession(st.sessionFile, (s) => {
    const done = new Set(s.ledger.invocations.map((i) => i.task_id).filter(Boolean));
    const match = [...invs].reverse().find((i) => report?.task_id && i.task_id === String(report.task_id))
      ?? invs.find((i) => !done.has(i.task_id) && baseAgentType(i.subagent_type) === agentType);
    const enforce = !!match || PLUGIN_AGENTS.has(agentType);
    let entry = s.ledger.invocations.find((i) => i.agent_id === agentId);
    if (!entry) { entry = { agent_id: agentId, agent_type: agentType, task_id: report?.task_id ?? match?.task_id ?? null, enforced: enforce, tokens: 0, tokens_by_model: {}, blocks: 0 }; s.ledger.invocations.push(entry); }
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
    if (enforce && !v.ok && blocks < MAX_BLOCKS && continuationOfOurs) {
      s.ledger.trace_blocks[agentId] = blocks + 1;
      entry.blocks = blocks + 1;
      outcome = { decision: "block", reason: `completa la traccia: mancano ${missingList(v)}. Il tuo ultimo messaggio deve essere solo il rapporto YAML (§46.2) con cognitive_trace e lesson. Blocco ${blocks + 1}/${MAX_BLOCKS}.`, blocks: blocks + 1, match };
      return;
    }
    const reclassified = [...v.reclassified];
    let effective = v.ok ? v.status_effective : "partial";
    if (match?.budget_tokens && entry.tokens > match.budget_tokens) {
      reclassified.push(`budget del compito superato (${entry.tokens}/${match.budget_tokens})`);
      if (effective === "ok") effective = "partial";
    }
    Object.assign(entry, {
      task_id: entry.task_id ?? report?.task_id ?? match?.task_id ?? null,
      status: report?.status ?? null, status_effective: effective, error_class: report?.error_class ?? null,
      trace_incomplete: enforce && !v.ok, reclassified, lesson: report?.lesson ?? null, model: match?.model ?? null,
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
      trace_incomplete: entry.trace_incomplete, reclassified: entry.reclassified, output: report?.output ?? null, lesson: entry.lesson,
      cognitive_trace: ct ? { depth: ct.depth, strategy: ct.strategy, decisions: ct.decisions, surprises: Array.isArray(ct.surprises) ? ct.surprises.length : 0, self_check: ct.self_check } : null,
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
      tokens: entry?.tokens ?? 0, usage_source: entry?.usage_source ?? null, missing: v.ok ? [] : v.missing, stop_hook_active: !!input.stop_hook_active,
    },
  });
  return outcome.decision === "block" ? block(outcome.reason) : null;
}

if (isMain(import.meta.url)) runHook((input) => handle(input), { name: "subagent-trace", failClosed: false });
