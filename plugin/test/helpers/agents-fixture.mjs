// Fixture di sessione per la console degli agenti (WP10d D1, D7): tre dispatch scritti come li scrivono gli hook —
//  #0 T-A (scope-expert, CAT, T1) chiuso partial con 1 sorpresa (agent a1), rapporto che dichiara 2 strumenti;
//  #1 T-B (scope-expert, CAT, T0) in corso (agent b1, legato da guard-control), step-check con una sorpresa;
//  #2 T-C (config-auditor, ADM) scaduto (dispatch 3 h fa, nessun rapporto).
// L'audit è scritto con appendAudit (catena valida); le OBS in observations.jsonl.
import { writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { mkWs, seedSession } from "./hook-env.mjs";
import { appendAudit } from "../../hooks/lib/audit.mjs";

export const SID = "sess-1";
export const iso = (msAgo, now = Date.now()) => new Date(now - msAgo).toISOString();
const MIN = 60000;

export function agentsFixture({ now = Date.now(), extraLedger = [] } = {}) {
  const ws = mkWs("jvc-agents-");
  const sdir = join(ws, "customers/ACME/.sessions", SID);
  const invs = [
    { ts: iso(20 * MIN, now), task_id: "T-A", subagent_type: "jaggaer-virtual-consultant:scope-expert", model: "sonnet", budget_tokens: 40000, scope: "CAT", tier: "T1", task_key: "T-A", kind: "task", mode: "nrt", depth: "standard", minutes: 15, task: "Test negativi CAT", allowed_paths: ["customers/ACME/tests/**/CAT/**"], expected_output: "{\"type\":\"nrt-cases\"}", classes: [] },
    { ts: iso(5 * MIN, now), task_id: "T-B", subagent_type: "jaggaer-virtual-consultant:scope-expert", model: "haiku", budget_tokens: 30000, scope: "CAT", tier: "T0", task_key: "T-B", kind: "task", mode: "config", depth: "rapida", minutes: 10, task: "Esecuzione piano", allowed_paths: ["customers/ACME/runs/**"], expected_output: null, classes: ["ACT-OBS"] },
    { ts: iso(180 * MIN, now), task_id: "T-C", subagent_type: "jaggaer-virtual-consultant:config-auditor", model: "haiku", budget_tokens: 10000, scope: "ADM", tier: "T0", task_key: "T-C", kind: "task", mode: "config", classes: [] },
  ];
  seedSession(ws, {
    sid: SID, budget: { tokens: 200000, used: 22000, by_model: { haiku: 0, sonnet: 22000, opus: 0 } },
    extra: {
      session_code: "SES.ACME.20260929.001",
      ledger: { invocations: [
        { agent_id: "a1", agent_type: "scope-expert", inv_seq: 0, task_id: "T-A", task_id_source: "header", enforced: true, tokens: 22000, tokens_by_model: { sonnet: 22000 }, blocks: 0, usage_source: "transcript",
          scope: "CAT", tier: "T1", surprises: 1, status: "partial", status_effective: "partial", error_class: null, trace_incomplete: false, reclassified: [], lesson: "L.ACME.CAT.LSN.0090", completed_at: iso(8 * MIN, now) },
        ...extraLedger,
      ], trace_blocks: {} },
    },
  });
  writeFileSync(join(sdir, "invocations.jsonl"), invs.map((x) => JSON.stringify(x)).join("\n") + "\n");
  mkdirSync(join(sdir, "agents"), { recursive: true });
  writeFileSync(join(sdir, "agents", "b1.json"), JSON.stringify({ agent_id: "b1", agent_type: "scope-expert", task_id: "T-B", inv_seq: 1, source: "header", first_ts: iso(4 * MIN, now), last_ts: iso(1 * MIN, now), calls: 2 }));
  writeFileSync(join(sdir, "blackboard", "T-A.yaml"), YAML.stringify({
    task_id: "T-A", agent_type: "scope-expert", agent_id: "a1", status: "partial", status_effective: "partial", trace_incomplete: false, reclassified: [],
    output: { cases: ["NRT.ACME.CAT.NEG.0031"], note: "contenuto mai mostrato" }, lesson: "L.ACME.CAT.LSN.0090",
    cognitive_trace: { depth: "standard", recalled: { semantic: ["C.ACME.CAT.KEY.0002"], episodic: [], working: [] }, epistemic: { subject: "C.ACME.CAT.KEY.0002", shape_before: "consolidato", shape_after: "contraddittorio" },
      strategy: "STR-REPLAY", hypotheses: null, decisions: ["L.ACME.CAT.DEC.0421"], surprises: 1, surprise_items: [{ item: "S.STD.CAT.SEL.0140" }], self_check: { passed: 9, failed: [3] } },
    why: { "L.ACME.CAT.DEC.0421": "DT-002 → procedi-con-assunzione" }, declared_tools: 2, needs_input: null, open_questions: ["Q1"], usage: { tokens: 22000, by_model: { sonnet: 22000 }, source: "transcript" }, at: iso(8 * MIN, now),
  }));
  const A = (fields, msAgo) => appendAudit(ws, { session: SID, customer: "ACME", scope: "CAT", ...fields }, { date: new Date(now - msAgo) });
  // a1: 3 Read + 1 Bash kb find, un deny di guard-scope
  A({ kind: "tool", actor: "scope-expert", payload: { tool: "Read", input_summary: "{\"file_path\":\"customers/ACME/kb/scopes/CAT/flows/C.ACME.CAT.FLW.0001.yaml\"}", ok: true, agent_id: "a1" } }, 19 * MIN);
  A({ kind: "guard", actor: "hook:guard-scope", payload: { decision: "deny", tool: "Read", reason: "fuori cella (cella ACME×CAT): customers/acme/kb/scopes/adm/x.yaml", agent_id: "a1" } }, 18 * MIN);
  A({ kind: "tool", actor: "scope-expert", payload: { tool: "Read", input_summary: "{\"file_path\":\"a.yaml\"}", ok: true, agent_id: "a1" } }, 17 * MIN);
  A({ kind: "tool", actor: "scope-expert", payload: { tool: "Read", input_summary: "{\"file_path\":\"b.yaml\"}", ok: true, agent_id: "a1" } }, 16 * MIN);
  A({ kind: "tool", actor: "scope-expert", payload: { tool: "Bash", input_summary: "{\"command\":\"node scripts/kb/kb.mjs find --text strict password=hunter22\"}", ok: true, agent_id: "a1" } }, 15 * MIN);
  // manager: dispatch e un comando di dominio seguito dal dispatch
  A({ kind: "tool", actor: "manager", payload: { tool: "Agent", input_summary: "{\"subagent_type\":\"scope-expert\",\"task_id\":\"T-B\"}", ok: true } }, 5 * MIN);
  // b1: step-check (l'evento dello script precede quello di audit-append della Bash), un browser click
  A({ kind: "run", actor: "step-check", payload: { action: "check", plan: "PLAN.0042", step: 2, status: "surprise", kind: "elemento-assente", compat: "incompatibile" } }, 3 * MIN);
  A({ kind: "tool", actor: "scope-expert", payload: { tool: "Bash", input_summary: "{\"command\":\"node scripts/decide/step-check.mjs --plan runs/p.yaml --step 2\"}", ok: true, agent_id: "b1" } }, 3 * MIN - 500);
  A({ kind: "tool", actor: "scope-expert", payload: { tool: "mcp__chrome-devtools__take_snapshot", input_summary: "{}", ok: true, agent_id: "b1" } }, 1 * MIN);
  appendFileSync(join(sdir, "observations.jsonl"), `${JSON.stringify({ kind: "page", page_sig: "adm/x", obs: "L.ACME.ADM.OBS.0301", ts: iso(1 * MIN - 800, now) })}\n`);
  writeFileSync(join(sdir, "workflow.jsonl"), [
    { seq: 1, ts: iso(6 * MIN, now), kind: "task_start", payload: { steps: [{ n: 1, agent: "scope-expert", class: "ACT-OBS", desc: "apri" }, { n: 2, agent: "scope-expert", class: "ACT-OBS", desc: "leggi" }] } },
    { seq: 2, ts: iso(5 * MIN, now), kind: "step_start", payload: { n: 2 } },
  ].map((x) => JSON.stringify(x)).join("\n") + "\n");
  return { ws, sdir, now };
}
