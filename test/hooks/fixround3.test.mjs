// Fix round 3 (re-review del giro 2): F3 fallback senza transcript, F5 livello cartella e `>|`.
// Ogni probe del revisore è un caso di test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from "node:fs";
import YAML from "yaml";
import { mkWs, seedSession, runHook, runSessionCli, decisionOf, ROOT } from "../helpers/hook-env.mjs";

const FIX = join(ROOT, "test/fixtures/transcripts");
const SUB = { agent_id: "a1", agent_type: "scope-expert" };
const env = (ws) => ({ CLAUDE_PROJECT_DIR: ws, CLAUDE_PLUGIN_ROOT: ROOT });
const pre = (guard, ws, tool, tool_input, extra = {}) =>
  runHook(guard, { session_id: "sess-1", cwd: ws, hook_event_name: "PreToolUse", tool_name: tool, tool_input, ...extra }, env(ws));
const denied = (r) => decisionOf(r) === "deny";
const silent = (r) => r.status === 0 && r.stdout.trim() === "";
const SHELL = ["guard-budget", "guard-scope", "guard-customer"];
const anyDeny = (ws, command, extra) => SHELL.some((g) => denied(pre(g, ws, "Bash", { command }, extra)));
const allSilent = (ws, command, extra) => SHELL.every((g) => silent(pre(g, ws, "Bash", { command }, extra)));
const readSess = (ws) => JSON.parse(readFileSync(join(ws, "customers/ACME/.sessions/sess-1/session.json"), "utf8"));
const cli = (ws, ...args) => runSessionCli([...args, "--workspace", ws, "--json"]);

// ---------- F3: fallback senza transcript, dispatch paralleli dello stesso tipo ----------

const header = (task_id) => `\`\`\`yaml\n${YAML.stringify({
  task_id, customer: "ACME", scope: "CAT", mode: "nrt", tier: "T1", depth: "standard",
  budget: { tokens: 40000, minutes: 15 }, allowed_paths: ["customers/ACME/kb/scopes/CAT/**"], task: "x",
}).trim()}\n\`\`\`\n`;
const dispatch = (ws, task) => runHook("guard-budget", {
  session_id: "sess-1", cwd: ws, hook_event_name: "PreToolUse", tool_name: "Agent",
  tool_input: { subagent_type: "jaggaer-virtual-consultant:scope-expert", description: "d", prompt: header(task), model: "sonnet" },
}, env(ws));
const reportText = (task) => JSON.parse(readFileSync(join(FIX, "valid-report.jsonl"), "utf8").trim().split("\n").at(-1)).message.content[0].text.replace(/MSG\.sess-1\.0001/g, task);
const stopNoTranscript = (ws, agentId, task, stopHookActive = false) => runHook("subagent-trace", {
  session_id: "sess-1", cwd: ws, hook_event_name: "SubagentStop", agent_id: agentId, agent_type: "jaggaer-virtual-consultant:scope-expert",
  stop_hook_active: stopHookActive, last_assistant_message: reportText(task),
}, env(ws));

test("F3 fallback: due dispatch paralleli dello stesso tipo senza transcript, rapporti onesti in ordine inverso → nessuno dei due è bloccato; entrambi con avviso di traccia", () => {
  const ws = mkWs(); seedSession(ws);
  dispatch(ws, "MSG.sess-1.0001");
  dispatch(ws, "MSG.sess-1.0002");
  const r2 = stopNoTranscript(ws, "b2", "MSG.sess-1.0002");
  assert.notEqual(r2.json?.decision, "block", r2.stdout);
  const r1 = stopNoTranscript(ws, "a1", "MSG.sess-1.0001");
  assert.notEqual(r1.json?.decision, "block", r1.stdout);
  const inv = readSess(ws).ledger.invocations;
  for (const id of ["a1", "b2"]) {
    const e = inv.find((i) => i.agent_id === id);
    assert.notEqual(e.trace_incomplete, true, id);
    assert.equal(e.status_effective, "ok", id);
    assert.ok(e.trace_warnings?.length, `${id}: avviso di traccia`);
  }
  assert.deepEqual(readSess(ws).ledger.trace_blocks, {});
});

test("F3 fallback: un task_id dichiarato che non è un dispatch dello stesso tipo resta un errore di traccia (blocco)", () => {
  const ws = mkWs(); seedSession(ws);
  dispatch(ws, "MSG.sess-1.0001");
  dispatch(ws, "MSG.sess-1.0002");
  assert.equal(stopNoTranscript(ws, "b2", "MSG.sess-1.9999").json?.decision, "block");
});

// ---------- F5: cartelle che contengono stato, cp/mv dentro una cartella, `>|` ----------

const PROBES = [
  "rm -rf customers/ACME/.sessions/sess-1",
  "rm -rf customers/ACME/.sessions",
  "Remove-Item -Recurse customers/ACME/.sessions/sess-1",
  "mv customers/ACME/.sessions/sess-1 /tmp/zz",
  "cp /tmp/invocations.jsonl customers/ACME/.sessions/sess-1/",
  "mv /tmp/x/invocations.jsonl customers/ACME/.sessions/sess-1/",
  "echo x >| customers/ACME/.sessions/sess-1/invocations.jsonl",
];

test("F5 sub-agente: le sette probe del revisore sono negate", () => {
  const ws = mkWs(); seedSession(ws);
  for (const c of PROBES) assert.ok(denied(pre("guard-scope", ws, "Bash", { command: c }, SUB)), c);
});

test("F5 sub-agente: anche gli antenati di .jvc, audit, blackboard e kb sono protetti; le cartelle di lavoro no", () => {
  const ws = mkWs(); seedSession(ws);
  for (const c of [
    "rm -rf .jvc", "rm -rf .jvc/sessions", "mv customers/ACME/audit /tmp/a", "rm -r customers/ACME/.sessions/sess-1/blackboard",
    "rm -rf customers/ACME/kb/scopes/CAT", "Move-Item customers/ACME/kb /tmp/k", "cp -r /tmp/x customers/ACME/kb/scopes/CAT/",
    "Copy-Item /tmp/x -Destination customers/ACME/.sessions/sess-1", "rd /s /q customers\\ACME\\.sessions",
  ]) assert.ok(denied(pre("guard-scope", ws, "Bash", { command: c }, SUB)), c);
  for (const c of ["rm -rf customers/ACME/runs/tmp", "cp /tmp/x customers/ACME/lessons/", "mv customers/ACME/reports/a.md customers/ACME/reports/b.md",
    "sed -n 1,5p customers/ACME/kb/scopes/CAT/flows/C.ACME.CAT.FLW.0001.yaml", "perl -ne print customers/ACME/lessons/x.md"]) {
    assert.ok(silent(pre("guard-scope", ws, "Bash", { command: c }, SUB)), c);
  }
  for (const c of ["sed -i s/a/b/ customers/ACME/kb/scopes/CAT/flows/C.ACME.CAT.FLW.0001.yaml", "perl -pi -e s/a/b/ customers/ACME/.sessions/sess-1/session.json"]) {
    assert.ok(denied(pre("guard-scope", ws, "Bash", { command: c }, SUB)), c);
  }
});

test("F5 end-to-end: con un dispatch aperto il sub-agente non può cancellare lo stato per aggirare #8", () => {
  const ws = mkWs(); seedSession(ws);
  appendFileSync(join(ws, "customers/ACME/.sessions/sess-1/invocations.jsonl"), `${JSON.stringify({ ts: new Date().toISOString(), task_id: "MSG.sess-1.0001", subagent_type: "scope-expert" })}\n`);
  assert.equal(cli(ws, "use", "scope", "ADM").status, 3);
  assert.ok(anyDeny(ws, "rm -rf customers/ACME/.sessions/sess-1", SUB));
  assert.ok(existsSync(join(ws, "customers/ACME/.sessions/sess-1/invocations.jsonl")));
  assert.equal(cli(ws, "use", "scope", "ADM").status, 3, "i sotto-compiti restano aperti");
});

test("F5 sessione principale: la stessa logica degli antenati vale per session.json, invocations.jsonl e .jvc (scelta: negato anche cancellare la propria .sessions/<sid>); il resto invariato", () => {
  const ws = mkWs(); seedSession(ws);
  for (const c of ["rm -rf customers/ACME/.sessions/sess-1", "rm -rf .jvc", "mv customers/ACME/.sessions /tmp/s", "echo x >| .jvc/current-session", "cp /tmp/invocations.jsonl customers/ACME/.sessions/sess-1/"]) {
    assert.ok(denied(pre("guard-scope", ws, "Bash", { command: c })), c);
  }
  mkdirSync(join(ws, "customers/ACME/runs/tmp"), { recursive: true });
  for (const c of ["rm -rf customers/ACME/runs/tmp", "rm -rf customers/ACME/.sessions/sess-1/blackboard/old.yaml", "cp /tmp/x customers/ACME/lessons/", "sed -n 1p .jvc/current-session", "ls customers | tee listing.txt"]) {
    assert.ok(silent(pre("guard-scope", ws, "Bash", { command: c })), c);
  }
  assert.ok(allSilent(ws, "node scripts/kb/kb.mjs find --scope CAT > out.txt 2>&1"));
});
