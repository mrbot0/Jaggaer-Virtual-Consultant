// Criterio di uscita K2 (spec §33): un compito con handoff CAT→ADM attraversa
// il manager e il sub-agente CAT non ha mai letto un file di ADM — il tentativo
// è negato e compare in audit. Simulazione end-to-end con i processi reali
// degli hook (stdin simulato) e la CLI di sessione, nell'ordine di §45.3/§24.2.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import YAML from "yaml";
import { mkWs, runHook, runSessionCli, decisionOf, ROOT } from "../helpers/hook-env.mjs";
import { verifyChain } from "../../hooks/lib/audit.mjs";

const SID = "handoff-1";
const TRACE = (subject) => ({
  depth: "standard", recalled: { semantic: [subject], episodic: [], working: [] },
  epistemic: { subject, shape_before: "consolidato", shape_after: "consolidato" }, strategy: "STR-REPLAY",
  hypotheses: null, decisions: [], surprises: [], self_check: { passed: 10, failed: [] },
});
const report = (o) => "```yaml\n" + YAML.stringify({ status: "ok", why: {}, needs_input: null, open_questions: [], ...o }) + "```";
const prompt = (h) => "```yaml\n" + YAML.stringify({ mode: "nrt", tier: "T1", depth: "standard", budget: { tokens: 40000, minutes: 15 }, ...h }) + "```\n\n(istruzioni fisse del template)";

test("K2 exit: handoff CAT→ADM via manager; cat-expert non legge mai ADM (deny in audit); adm-expert sì", () => {
  const ws = mkWs();
  const env = { JVC_WORKSPACE: ws, CLAUDE_PLUGIN_ROOT: ROOT };
  const hook = (name, input) => runHook(name, { session_id: SID, cwd: ws, ...input }, env);
  const pre = (input) => ["guard-domain-boundary", "guard-scope", "guard-customer", "guard-budget"].map((g) => ({ g, r: hook(g, { hook_event_name: "PreToolUse", ...input }) }));
  const verdict = (rs) => (rs.some(({ r }) => decisionOf(r) === "deny") ? "deny" : "allow");
  const post = (input) => hook("audit-append", { hook_event_name: "PostToolUse", ...input });
  const log = [];

  // 0. avvio di sessione e contesto (SessionStart, /use customer, /use scope)
  hook("session-context", { source: "startup" });
  assert.equal(runSessionCli(["use", "customer", "ACME", "--session", SID, "--workspace", ws, "--json"]).status, 0);
  assert.equal(runSessionCli(["use", "scope", "CAT", "--session", SID, "--workspace", ws, "--json"]).status, 0);
  const sess = () => JSON.parse(readFileSync(join(ws, `customers/ACME/.sessions/${SID}/session.json`), "utf8"));
  const catPaths = sess().allowed_paths;

  // 1. manager → cat-expert
  const catTask = { subagent_type: "jaggaer-virtual-consultant:scope-expert", model: "sonnet", description: "test negativi CAT",
    prompt: prompt({ task_id: `MSG.${SID}.0001`, customer: "ACME", scope: "CAT", allowed_paths: catPaths, task: "Test negativi sulle chiavi promosse" }) };
  assert.equal(verdict(pre({ tool_name: "Agent", tool_input: catTask })), "allow");
  log.push("manager → Agent(scope-expert, CAT) · allow");

  // 2. cat-expert legge la propria cella
  const CAT = { agent_type: "jaggaer-virtual-consultant:scope-expert", agent_id: "cat-1" };
  const catFile = join(ws, "customers/ACME/kb/scopes/CAT/flows/C.ACME.CAT.FLW.0001.yaml");
  assert.equal(verdict(pre({ tool_name: "Read", tool_input: { file_path: catFile }, ...CAT })), "allow");
  post({ tool_name: "Read", tool_input: { file_path: catFile }, tool_response: { success: true }, ...CAT });
  log.push("cat-1 Read CAT/flows/C.ACME.CAT.FLW.0001.yaml · allow");

  // 3. cat-expert tenta di leggere ADM (fuori cella) — anche con un traversal e via Bash
  const admFile = join(ws, "customers/ACME/kb/scopes/ADM/configs/C.ACME.ADM.CFG.0019.yaml");
  for (const ti of [{ tool_name: "Read", tool_input: { file_path: admFile } },
    { tool_name: "Read", tool_input: { file_path: `${ws}/customers/ACME/kb/scopes/CAT/../ADM/configs/C.ACME.ADM.CFG.0019.yaml` } },
    { tool_name: "Grep", tool_input: { pattern: "strict_import", path: join(ws, "customers/ACME/kb/scopes") } }]) {
    const rs = pre({ ...ti, ...CAT });
    assert.equal(verdict(rs), "deny", JSON.stringify(ti));
    log.push(`cat-1 ${ti.tool_name} ${ti.tool_input.file_path ? ti.tool_input.file_path.replace(ws, "<ws>") : ti.tool_input.path.replace(ws, "<ws>")} · deny (${rs.filter(({ r }) => decisionOf(r) === "deny").map(({ g }) => g).join(", ")})`);
  }

  // 4. cat-expert chiude con una richiesta di handoff nel rapporto (mai direttamente ad ADM)
  const catReport = report({ task_id: `MSG.${SID}.0001`, status: "needs-input", output: { handoff: { kind: "handoff", from: "cat-expert", via: "agent-manager", to: "adm-expert", contract: "C.ACME.XSC.HND.0004", request: "strict_import = true su C.ACME.ADM.CFG.0019", justification: "NRT.ACME.CAT.NEG.0031", risk_declared: "R2" } },
    needs_input: { question: "Approvi l'handoff verso ADM (R2)?", options: ["sì", "no"], gap: "cella ADM" }, cognitive_trace: TRACE("C.ACME.CAT.KEY.0002"), lesson: "L.ACME.CAT.LSN.0090" });
  const s1 = hook("subagent-trace", { hook_event_name: "SubagentStop", ...CAT, last_assistant_message: catReport, stop_hook_active: false });
  assert.notEqual(s1.json?.decision, "block");
  log.push("SubagentStop cat-1 · rapporto valido (needs-input con handoff) · pass");

  // 5. il manager media l'handoff: cambia cella; un dispatch con lo scope vecchio è negato
  assert.equal(runSessionCli(["use", "scope", "ADM", "--session", SID, "--workspace", ws, "--json"]).status, 0);
  const admPaths = sess().allowed_paths;
  assert.notDeepEqual(admPaths, catPaths, "allowed_paths distinti per le due invocazioni");
  assert.equal(verdict(pre({ tool_name: "Agent", tool_input: { ...catTask, prompt: prompt({ task_id: `MSG.${SID}.0003`, customer: "ACME", scope: "CAT", allowed_paths: catPaths, task: "x" }) } })), "deny");
  const admTask = { subagent_type: "jaggaer-virtual-consultant:scope-expert", model: "sonnet", description: "handoff ADM",
    prompt: prompt({ task_id: `MSG.${SID}.0002`, customer: "ACME", scope: "ADM", allowed_paths: admPaths, task: "Impostare strict_import = true su C.ACME.ADM.CFG.0019" }) };
  assert.equal(verdict(pre({ tool_name: "Agent", tool_input: admTask })), "allow");
  log.push("manager → use scope ADM → Agent(scope-expert, ADM) · allow");

  // 6. adm-expert legge ADM (nella sua cella)
  const ADM = { agent_type: "jaggaer-virtual-consultant:scope-expert", agent_id: "adm-1" };
  assert.equal(verdict(pre({ tool_name: "Read", tool_input: { file_path: admFile }, ...ADM })), "allow");
  post({ tool_name: "Read", tool_input: { file_path: admFile }, tool_response: { success: true }, ...ADM });
  log.push("adm-1 Read ADM/configs/C.ACME.ADM.CFG.0019.yaml · allow");
  const s2 = hook("subagent-trace", { hook_event_name: "SubagentStop", ...ADM, last_assistant_message: report({ task_id: `MSG.${SID}.0002`, output: { evidence: "C.ACME.ADM.EVD.0001" }, cognitive_trace: TRACE("C.ACME.ADM.CFG.0019"), lesson: "L.ACME.ADM.LSN.0001" }) });
  assert.notEqual(s2.json?.decision, "block");
  log.push("SubagentStop adm-1 · pass");

  // 7. audit: catena valida; cat-1 non ha nessun accesso ADM riuscito; i tentativi sono guard/deny
  const dir = join(ws, "customers/ACME/audit");
  const file = join(dir, readdirSync(dir).find((f) => f.endsWith(".jsonl")));
  const chain = verifyChain(file);
  assert.equal(chain.ok, true, JSON.stringify(chain));
  const events = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const cat = events.filter((e) => e.payload.agent_id === "cat-1");
  const catToolAdm = cat.filter((e) => e.kind === "tool" && /\/ADM\/|\\\\ADM\\\\/i.test(e.payload.input_summary));
  assert.deepEqual(catToolAdm, [], "nessuna lettura ADM riuscita da cat-1");
  const catDenied = cat.filter((e) => e.kind === "guard" && e.payload.decision === "deny");
  assert.ok(catDenied.length >= 3);
  assert.ok(catDenied.every((e) => e.actor === "hook:guard-scope"));
  assert.ok(events.some((e) => e.kind === "tool" && e.payload.agent_id === "adm-1" && /ADM/.test(e.payload.input_summary)));
  const inv = readFileSync(join(ws, `customers/ACME/.sessions/${SID}/invocations.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(inv.map((i) => i.scope), ["CAT", "ADM"]);
  const bb = readdirSync(join(ws, `customers/ACME/.sessions/${SID}/blackboard`)).sort();
  assert.deepEqual(bb, [`MSG.${SID}.0001.yaml`, `MSG.${SID}.0002.yaml`]);

  const evidence = [
    ...log,
    `audit ${file.replace(ws, "<ws>")}: ${chain.lines} eventi, catena ${chain.ok ? "valida" : "ROTTA"}`,
    ...events.map((e) => `  ${e.kind.padEnd(7)} ${e.actor.padEnd(24)} ${(e.payload.agent_id ?? "").padEnd(6)} ${e.payload.decision ?? e.payload.action ?? e.payload.tool ?? ""} ${(e.payload.input_summary ?? "").replace(/C:\\\\[^"]*?customers|\/[^"]*?customers/g, "…customers").slice(0, 110)}`),
  ].join("\n");
  writeFileSync(join(ws, "evidence.txt"), evidence);
  console.log(`--- evidenza handoff CAT→ADM ---\n${evidence}\n--- fine ---`);
});
