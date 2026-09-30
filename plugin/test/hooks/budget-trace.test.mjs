import { test } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import YAML from "yaml";
import { mkWs, seedSession, runHook, decisionOf, reasonOf, ROOT } from "../helpers/hook-env.mjs";
import { verifyChain } from "../../hooks/lib/audit.mjs";

const FIX = join(ROOT, "test/fixtures/transcripts");
const header = (o = {}) => `\`\`\`yaml\n${YAML.stringify({
  task_id: "MSG.sess-1.0001", customer: "ACME", scope: "CAT", mode: "nrt", tier: "T1", depth: "standard",
  budget: { tokens: 40000, minutes: 15 }, allowed_paths: ["customers/ACME/kb/scopes/CAT/**"], task: "Generare i test negativi", ...o,
}).trim()}\n\`\`\`\n\nIstruzioni fisse…`;
const agentCall = (ws, prompt, extra = {}, ti = {}) => runHook("guard-budget", {
  session_id: "sess-1", cwd: ws, hook_event_name: "PreToolUse", tool_name: "Agent",
  tool_input: { subagent_type: "jaggaer-virtual-consultant:scope-expert", description: "test negativi", prompt, model: "sonnet", ...ti }, ...extra,
}, { JVC_WORKSPACE: ws, CLAUDE_PLUGIN_ROOT: ROOT });
const budget = (used, tokens = 200000) => ({ tokens, used, by_model: { haiku: 0, sonnet: used, opus: 0 } });
const readSession = (ws, sid = "sess-1") => JSON.parse(readFileSync(join(ws, `customers/ACME/.sessions/${sid}/session.json`), "utf8"));
const auditEvents = (ws) => {
  const dir = join(ws, "customers/ACME/audit");
  if (!existsSync(dir)) return [];
  const f = readdirSync(dir).find((x) => x.endsWith(".jsonl"));
  return f ? readFileSync(join(dir, f), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
};

// ---------- guard-budget ----------

test("guard-budget: entro budget → nessuna opinione e invocazione registrata", () => {
  const ws = mkWs(); seedSession(ws, { budget: budget(10000) });
  const r = agentCall(ws, header());
  assert.equal(r.status, 0); assert.equal(r.stdout.trim(), "");
  const inv = readFileSync(join(ws, "customers/ACME/.sessions/sess-1/invocations.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(inv.length, 1);
  assert.equal(inv[0].task_id, "MSG.sess-1.0001");
  assert.equal(inv[0].budget_tokens, 40000);
  assert.equal(inv[0].model, "sonnet");
});

test("guard-budget: oltre il budget di sessione → deny", () => {
  const ws = mkWs(); seedSession(ws, { budget: budget(200000) });
  const r = agentCall(ws, header());
  assert.equal(decisionOf(r), "deny");
  assert.match(reasonOf(r), /budget di sessione esaurito/);
  assert.match(reasonOf(r), /use budget/);
});

test("guard-budget: budget del compito oltre il residuo → deny", () => {
  const ws = mkWs(); seedSession(ws, { budget: budget(150000) });
  const r = agentCall(ws, header({ budget: { tokens: 60000 } }));
  assert.equal(decisionOf(r), "deny");
  assert.match(reasonOf(r), /60000.*50000/);
});

test("guard-budget: all'80% → allow con updatedInput = input originale + model: haiku", () => {
  const ws = mkWs(); seedSession(ws, { budget: budget(165000) });
  // WP10d giro 1 (I2): header concorde con il modello richiesto (opus = T2), altrimenti il dispatch è negato
  const prompt = header({ budget: { tokens: 20000 }, tier: "T2" });
  const r = agentCall(ws, prompt, {}, { model: "opus", run_in_background: false });
  assert.equal(decisionOf(r), "allow");
  const u = r.json.hookSpecificOutput.updatedInput;
  assert.equal(u.model, "haiku");
  assert.equal(u.prompt, prompt);
  assert.equal(u.subagent_type, "jaggaer-virtual-consultant:scope-expert");
  assert.equal(u.run_in_background, false);
  assert.match(reasonOf(r), /80%/);
  const inv = JSON.parse(readFileSync(join(ws, "customers/ACME/.sessions/sess-1/invocations.jsonl"), "utf8").trim());
  assert.equal(inv.model, "haiku"); assert.equal(inv.model_requested, "opus");
});

test("guard-budget: prompt senza header agent-prompt, o con header incompleto → deny", () => {
  const ws = mkWs(); seedSession(ws);
  const r = agentCall(ws, "Genera i test negativi del catalogo.");
  assert.equal(decisionOf(r), "deny");
  assert.match(reasonOf(r), /header agent-prompt/);
  for (const k of ["task_id", "customer", "scope", "allowed_paths"]) {
    const h = YAML.parse(header().split("```")[1].replace(/^yaml\n/, ""));
    delete h[k];
    const rr = agentCall(ws, `\`\`\`yaml\n${YAML.stringify(h)}\`\`\`\n`);
    assert.equal(decisionOf(rr), "deny", k);
    assert.match(reasonOf(rr), new RegExp(k));
  }
});

test("guard-budget: header con cliente o scope diversi dalla sessione → deny (il guard usa il file)", () => {
  const ws = mkWs(); seedSession(ws);
  assert.equal(decisionOf(agentCall(ws, header({ customer: "BETA" }))), "deny");
  const r = agentCall(ws, header({ scope: "ADM" }));
  assert.equal(decisionOf(r), "deny");
  assert.match(reasonOf(r), /use scope ADM/);
});

test("guard-budget: senza sessione con cliente → deny; eccezione interna → deny (fail-closed)", () => {
  const ws = mkWs(); seedSession(ws, { customer: null });
  assert.equal(decisionOf(agentCall(ws, header())), "deny");
  const ws2 = mkWs(); seedSession(ws2);
  const r = runHook("guard-budget", { session_id: "sess-1", cwd: ws2, tool_name: "Agent", tool_input: { prompt: header() } }, { JVC_WORKSPACE: ws2, JVC_TEST_THROW: "1" });
  assert.equal(decisionOf(r), "deny");
  assert.match(reasonOf(r), /fail-closed/);
});

test("guard-budget: un sub-agente non può cambiare budget/cliente/scope/modo via session.mjs; la sessione principale sì", () => {
  const ws = mkWs(); seedSession(ws);
  const bash = (command, extra = {}) => runHook("guard-budget", { session_id: "sess-1", cwd: ws, tool_name: "Bash", tool_input: { command }, ...extra }, { JVC_WORKSPACE: ws });
  for (const c of [`node "${ROOT}/scripts/admin/session.mjs" use budget 999999`, "node scripts/admin/session.mjs use customer BETA", "node scripts/admin/'session.mjs' use scope ADM"]) {
    assert.equal(decisionOf(bash(c, { agent_id: "a1", agent_type: "scope-expert" })), "deny", c);
  }
  assert.equal(bash(`node "${ROOT}/scripts/admin/session.mjs" use budget 300000`).stdout.trim(), "");
  assert.equal(bash("node scripts/admin/session.mjs show --json", { agent_id: "a1" }).stdout.trim(), "", "show è sola lettura");
});

// ---------- subagent-trace ----------

function stop(ws, fixtureOrText, { agentId = "agent-a1", agentType = "jaggaer-virtual-consultant:scope-expert", stopHookActive = false, placeTranscript = "agent_transcript_path", lastMessage } = {}) {
  let agentTranscript = null;
  const mainTranscript = join(ws, "main-transcript.jsonl");
  if (!existsSync(mainTranscript)) writeFileSync(mainTranscript, "");
  if (fixtureOrText) {
    const text = fixtureOrText.endsWith(".jsonl") ? readFileSync(join(FIX, fixtureOrText), "utf8") : fixtureOrText;
    agentTranscript = placeTranscript === "subagents-dir"
      ? join(dirname(mainTranscript), "sess-1", "subagents", `agent-${agentId}.jsonl`)
      : join(ws, `t-${agentId}.jsonl`);
    mkdirSync(dirname(agentTranscript), { recursive: true });
    writeFileSync(agentTranscript, text);
  }
  const lines = agentTranscript ? readFileSync(agentTranscript, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
  const lastAssistant = [...lines].reverse().find((l) => l.type === "assistant")?.message.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
  return runHook("subagent-trace", {
    session_id: "sess-1", cwd: ws, hook_event_name: "SubagentStop", transcript_path: mainTranscript,
    agent_id: agentId, agent_type: agentType, stop_hook_active: stopHookActive,
    last_assistant_message: lastMessage ?? lastAssistant,
    ...(placeTranscript === "agent_transcript_path" && agentTranscript ? { agent_transcript_path: agentTranscript } : {}),
  }, { JVC_WORKSPACE: ws });
}

test("subagent-trace: rapporto valido → nessun blocco; uso sommato dal transcript (dedup per message.id) nel budget; blackboard; audit kind agent", () => {
  const ws = mkWs(); seedSession(ws, { budget: budget(1000) });
  agentCall(ws, header());
  const r = stop(ws, "valid-report.jsonl");
  assert.equal(r.status, 0, r.stderr);
  assert.notEqual(r.json?.decision, "block");
  const s = readSession(ws);
  assert.equal(s.budget.used, 1000 + 4000, "1500 (sonnet, una volta) + 2500 (haiku)");
  assert.equal(s.budget.by_model.sonnet, 1000 + 1500);
  assert.equal(s.budget.by_model.haiku, 2500);
  const inv = s.ledger.invocations.find((i) => i.agent_id === "agent-a1");
  assert.equal(inv.task_id, "MSG.sess-1.0001");
  assert.equal(inv.status_effective, "ok");
  assert.equal(inv.lesson, "L.ACME.CAT.LSN.0090");
  assert.equal(inv.usage_source, "transcript");
  assert.equal(s.surprises.at(-1).item, "S.STD.CAT.SEL.0001");
  const bb = YAML.parse(readFileSync(join(ws, "customers/ACME/.sessions/sess-1/blackboard/MSG.sess-1.0001.yaml"), "utf8"));
  assert.equal(bb.status_effective, "ok");
  assert.deepEqual(bb.output.cases, ["NRT.ACME.CAT.NEG.0031", "NRT.ACME.CAT.NEG.0032"]);
  const ev = auditEvents(ws).find((e) => e.kind === "agent");
  assert.equal(ev.correlation.task, "MSG.sess-1.0001");
  assert.equal(ev.payload.decision, "pass");
  assert.equal(verifyChain(join(ws, "customers/ACME/audit", readdirSync(join(ws, "customers/ACME/audit")).find((f) => f.endsWith(".jsonl")))).ok, true);
});

test("subagent-trace: traccia mancante → blocco due volte, al terzo stop passa marcato trace_incomplete (partial)", () => {
  const ws = mkWs(); seedSession(ws);
  agentCall(ws, header());
  const r1 = stop(ws, "missing-trace.jsonl");
  assert.equal(r1.json?.decision, "block");
  assert.match(r1.json.reason, /completa la traccia: mancano .*cognitive_trace/);
  assert.equal(readSession(ws).ledger.trace_blocks["agent-a1"], 1);
  const r2 = stop(ws, "missing-trace.jsonl", { stopHookActive: true });
  assert.equal(r2.json?.decision, "block");
  assert.equal(readSession(ws).ledger.trace_blocks["agent-a1"], 2);
  const r3 = stop(ws, "missing-trace.jsonl", { stopHookActive: true });
  assert.notEqual(r3.json?.decision, "block");
  const s = readSession(ws);
  const inv = s.ledger.invocations.find((i) => i.agent_id === "agent-a1");
  assert.equal(inv.trace_incomplete, true);
  assert.equal(inv.status_effective, "partial");
  assert.equal(s.budget.used, 4000, "l'uso non è contato due volte fra uno stop e l'altro");
  const bb = YAML.parse(readFileSync(join(ws, "customers/ACME/.sessions/sess-1/blackboard/MSG.sess-1.0001.yaml"), "utf8"));
  assert.equal(bb.trace_incomplete, true);
  assert.equal(bb.status_effective, "partial");
});

test("subagent-trace: dopo un blocco il sub-agente completa la traccia → passa ok; l'uso aggiuntivo si somma solo per delta", () => {
  const ws = mkWs(); seedSession(ws);
  agentCall(ws, header());
  assert.equal(stop(ws, "missing-trace.jsonl").json?.decision, "block");
  const more = readFileSync(join(FIX, "missing-trace.jsonl"), "utf8") + readFileSync(join(FIX, "completed-trace.jsonl"), "utf8").trim().split("\n").at(-1) + "\n";
  const r = stop(ws, more, { stopHookActive: true });
  assert.notEqual(r.json?.decision, "block");
  const s = readSession(ws);
  assert.equal(s.ledger.invocations.find((i) => i.agent_id === "agent-a1").status_effective, "ok");
  assert.equal(s.budget.used, 4000 + 2500);
});

test("Review Focus 4: self_check.failed non vuoto → nessun blocco ma status effettivo partial", () => {
  const ws = mkWs(); seedSession(ws);
  agentCall(ws, header());
  const r = stop(ws, "self-check-failed.jsonl");
  assert.notEqual(r.json?.decision, "block");
  const inv = readSession(ws).ledger.invocations.find((i) => i.agent_id === "agent-a1");
  assert.equal(inv.status, "ok");
  assert.equal(inv.status_effective, "partial");
  const bb = YAML.parse(readFileSync(join(ws, "customers/ACME/.sessions/sess-1/blackboard/MSG.sess-1.0001.yaml"), "utf8"));
  assert.equal(bb.status_effective, "partial");
  assert.ok(bb.reclassified.some((x) => /self_check/.test(x)));
});

test("subagent-trace: transcript del sub-agente trovato in <dir>/<session>/subagents/agent-<id>.jsonl; senza transcript uso auto-dichiarato", () => {
  const ws = mkWs(); seedSession(ws);
  agentCall(ws, header());
  stop(ws, "valid-report.jsonl", { placeTranscript: "subagents-dir" });
  assert.equal(readSession(ws).budget.used, 4000);
  const ws2 = mkWs(); seedSession(ws2);
  agentCall(ws2, header());
  const text = JSON.parse(readFileSync(join(FIX, "valid-report.jsonl"), "utf8").trim().split("\n").at(-1)).message.content[0].text;
  stop(ws2, null, { lastMessage: text });
  const s = readSession(ws2);
  assert.equal(s.budget.used, 1000, "tokens_in 999 + tokens_out 1 dal rapporto");
  assert.equal(s.ledger.invocations[0].usage_source, "self-declared");
});

test("subagent-trace: sub-agenti non del plugin non sono bloccati ma il loro uso entra nel budget; stop_hook_active senza blocchi nostri → nessun blocco", () => {
  const ws = mkWs(); seedSession(ws);
  const r = stop(ws, "missing-trace.jsonl", { agentType: "Explore", agentId: "ex1" });
  assert.notEqual(r.json?.decision, "block");
  assert.equal(readSession(ws).budget.used, 4000);
  agentCall(ws, header({ task_id: "MSG.sess-1.0002" }));
  const r2 = stop(ws, "missing-trace.jsonl", { agentId: "a9", stopHookActive: true });
  assert.notEqual(r2.json?.decision, "block", "continuazione non causata da noi: non si blocca");
});

test("subagent-trace: budget del compito superato a consuntivo → partial", () => {
  const ws = mkWs(); seedSession(ws);
  agentCall(ws, header({ budget: { tokens: 3000 } }));
  stop(ws, "valid-report.jsonl");
  const inv = readSession(ws).ledger.invocations[0];
  assert.equal(inv.status_effective, "partial");
  assert.ok(inv.reclassified.some((x) => /budget del compito/.test(x)));
});

test("subagent-trace: eccezione → avviso, mai blocco (fail-open, niente cicli)", () => {
  const ws = mkWs(); seedSession(ws);
  const r = runHook("subagent-trace", { session_id: "sess-1", cwd: ws, agent_id: "a1", agent_type: "scope-expert", last_assistant_message: "x" }, { JVC_WORKSPACE: ws, JVC_TEST_THROW: "1" });
  assert.equal(r.status, 0);
  assert.notEqual(r.json?.decision, "block");
  assert.ok(r.json.systemMessage);
});

test("#14 il task_id dichiarato nel rapporto non decide l'abbinamento: si abbina per tipo e ordine di dispatch; discrepanza = errore di traccia", () => {
  const ws = mkWs(); seedSession(ws);
  agentCall(ws, header());
  const text = readFileSync(join(FIX, "valid-report.jsonl"), "utf8").replace(/MSG\.sess-1\.0001/g, "MSG.sess-1.9999");
  const r = stop(ws, text);
  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /task_id/);
  assert.match(r.json.reason, /MSG\.sess-1\.0001/);
  const inv = readSession(ws).ledger.invocations.find((i) => i.agent_id === "agent-a1");
  assert.equal(inv.task_id, "MSG.sess-1.0001", "abbinato all'invocazione aperta, non al task_id dichiarato");
  stop(ws, text, { stopHookActive: true });
  stop(ws, text, { stopHookActive: true });
  const fin = readSession(ws).ledger.invocations.find((i) => i.agent_id === "agent-a1");
  assert.equal(fin.trace_incomplete, true);
  assert.equal(fin.status_effective, "partial");
  assert.ok(existsSync(join(ws, "customers/ACME/.sessions/sess-1/blackboard/MSG.sess-1.0001.yaml")));
});

// WP10b parte 2 (carry): la profondità dichiarata nella traccia contro quella dell'header registrato da guard-budget
test("subagent-trace: profondità della traccia ≠ profondità del dispatch → partial con errore di traccia (nessun blocco)", () => {
  const ws = mkWs(); seedSession(ws);
  agentCall(ws, header({ depth: "profonda" }));
  const r = stop(ws, "valid-report.jsonl");
  assert.notEqual(r.json?.decision, "block", "si registra, non si chiede di riscrivere la profondità");
  const inv = readSession(ws).ledger.invocations[0];
  assert.equal(inv.status_effective, "partial");
  assert.deepEqual(inv.trace_errors, ["profondità dichiarata standard ≠ profondità del dispatch profonda"]);
  assert.ok(inv.reclassified.some((x) => /profondità dichiarata standard/.test(x)));
  const bb = YAML.parse(readFileSync(join(ws, "customers/ACME/.sessions/sess-1/blackboard/MSG.sess-1.0001.yaml"), "utf8"));
  assert.equal(bb.status_effective, "partial");
  assert.equal(bb.trace_errors.length, 1);
  assert.equal(auditEvents(ws).find((e) => e.kind === "agent").payload.trace_errors.length, 1);
});

test("subagent-trace: stessa profondità, o header senza depth → nessun errore di traccia (ok)", () => {
  for (const depth of ["standard", undefined]) {
    const ws = mkWs(); seedSession(ws);
    agentCall(ws, header(depth ? { depth } : { depth: undefined }));
    stop(ws, "valid-report.jsonl");
    const inv = readSession(ws).ledger.invocations[0];
    assert.equal(inv.status_effective, "ok", `depth ${depth}`);
    assert.equal(inv.trace_errors, undefined);
  }
});

test("console degli agenti: la discordanza di profondità è segnalata fra le incoerenze", async () => {
  const { coherence } = await import("../../scripts/admin/agents.mjs");
  const c = coherence({ reclassified: ["profondità dichiarata rapida ≠ profondità del dispatch standard"], state: "chiuso" }, null, null);
  const flags = Array.isArray(c) ? c : c.flags;
  assert.ok(flags.some((f) => /profondità della traccia/.test(f)), JSON.stringify(c));
});
