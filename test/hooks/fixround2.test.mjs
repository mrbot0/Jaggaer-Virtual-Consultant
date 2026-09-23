// Fix round 2 (re-review WP03): F1–F5, un test per ogni probe del revisore.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, appendFileSync } from "node:fs";
import YAML from "yaml";
import { mkWs, seedSession, runHook, runSessionCli, decisionOf, reasonOf, ROOT, SESSION_CLI } from "../helpers/hook-env.mjs";
import { validateSession } from "../../scripts/admin/session.mjs";

const FIX = join(ROOT, "test/fixtures/transcripts");
const SUB = { agent_id: "a1", agent_type: "scope-expert" };
const env = (ws) => ({ CLAUDE_PROJECT_DIR: ws, CLAUDE_PLUGIN_ROOT: ROOT });
const pre = (guard, ws, tool, tool_input, extra = {}) =>
  runHook(guard, { session_id: "sess-1", cwd: ws, hook_event_name: "PreToolUse", tool_name: tool, tool_input, ...extra }, env(ws));
const denied = (r) => decisionOf(r) === "deny";
const silent = (r) => r.status === 0 && r.stdout.trim() === "";
const PART = ["guard-domain-boundary", "guard-scope", "guard-customer"];
const SHELL = ["guard-budget", "guard-scope", "guard-customer"];
const sessFile = (ws, c = "ACME") => join(ws, `customers/${c}/.sessions/sess-1/session.json`);
const readSess = (ws, c = "ACME") => JSON.parse(readFileSync(sessFile(ws, c), "utf8"));
const cliJson = ["--workspace"];
const cli = (ws, ...args) => runSessionCli([...args, ...cliJson, ws, "--json"]);
const plugCmd = (args) => `node "${SESSION_CLI}" ${args}`;
const auditOf = (ws, c = "ACME") => {
  const dir = join(ws, "customers", c, "audit");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((x) => x.endsWith(".jsonl")).flatMap((f) => readFileSync(join(dir, f), "utf8").trim().split("\n").map((l) => JSON.parse(l)));
};

// ---------- F1: un solo predicato "stato leggibile e coerente" per hook e CLI ----------

function readAllowedAgain(ws) {
  const lesson = join(ws, "customers/ACME/lessons/L.ACME.CAT.LSN.0001.md");
  writeFileSync(lesson, "x\n");
  for (const g of PART) assert.ok(silent(pre(g, ws, "Read", { file_path: lesson })), `${g}: Read di nuovo consentita`);
}

test("F1 session.json con customer diverso dal puntatore: hook e CLI lo vedono corrotto; use customer lo ripara (backup, customer riscritto, budget dal massimo noto) e la Read torna consentita", () => {
  const ws = mkWs(); seedSession(ws, { budget: { tokens: 200000, used: 7000, by_model: { haiku: 0, sonnet: 7000, opus: 0 } } });
  const s = readSess(ws); s.customer = "BETA"; writeFileSync(sessFile(ws), JSON.stringify(s));
  const lesson = join(ws, "customers/ACME/lessons/x.md");
  for (const g of PART) assert.ok(denied(pre(g, ws, "Read", { file_path: lesson })), g);
  assert.equal(cli(ws, "show").status, 1, "la CLI usa lo stesso predicato degli hook");
  const r = cli(ws, "use", "customer", "ACME");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const after = readSess(ws);
  assert.equal(after.customer, "ACME");
  assert.equal(validateSession(after).ok, true);
  assert.equal(after.budget.used, 7000);
  assert.ok(readdirSync(dirname(sessFile(ws))).some((x) => x.startsWith("session.json.corrupt-")));
  assert.equal(cli(ws, "show").status, 0);
  readAllowedAgain(ws);
});

test("F1 session.json parsabile ma non valido per lo schema (senza ledger): hook negano, show exit 1; use customer ripara con exit 0 e la Read torna consentita", () => {
  const ws = mkWs(); seedSession(ws, { budget: { tokens: 200000, used: 3000, by_model: { haiku: 0, sonnet: 3000, opus: 0 } } });
  const s = readSess(ws); delete s.ledger; writeFileSync(sessFile(ws), JSON.stringify(s));
  for (const g of PART) assert.ok(denied(pre(g, ws, "Read", { file_path: join(ws, "customers/ACME/lessons/x.md") })), g);
  assert.equal(cli(ws, "show").status, 1);
  const r = cli(ws, "use", "customer", "ACME");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const after = readSess(ws);
  assert.equal(validateSession(after).ok, true);
  assert.equal(after.budget.used, 3000);
  readAllowedAgain(ws);
});

test("F1 il validatore precompilato usato dagli hook è aggiornato rispetto allo schema e concorda con Ajv", async () => {
  const { generate, GENERATED } = await import("../../scripts/lib/build-session-validator.mjs");
  assert.equal(readFileSync(GENERATED, "utf8"), generate(), "rigenera con node scripts/lib/build-session-validator.mjs");
  const { checkSessionText } = await import("../../hooks/lib/session-state.mjs");
  const ws = mkWs(); seedSession(ws);
  const good = readSess(ws);
  const cases = [good, { ...good, ledger: undefined }, { ...good, mode: "configurazione" }, { ...good, budget: { ...good.budget, used: -1 } }, { ...good, updated_at: "ieri" }, { ...good, scope: "XXX" }];
  for (const c of cases) {
    const obj = JSON.parse(JSON.stringify(c));
    assert.equal(checkSessionText(JSON.stringify(obj)).ok, validateSession(obj).ok, JSON.stringify(obj).slice(0, 80));
  }
  assert.equal(checkSessionText(JSON.stringify(good), { customer: "BETA" }).ok, false);
  assert.equal(checkSessionText(JSON.stringify(good), { customer: "ACME", sid: "sess-2" }).ok, false);
});

// ---------- F2: la riparazione non vale per i sub-agenti ----------

test("F2 stato corrotto: un sub-agente che lancia il comando di riparazione è negato dai tre guard di shell", () => {
  const ws = mkWs(); seedSession(ws);
  writeFileSync(sessFile(ws), "{rotto");
  for (const c of [plugCmd("use customer BETA --json"), plugCmd("show --json")]) {
    for (const g of SHELL) assert.ok(denied(pre(g, ws, "Bash", { command: c }, SUB)), `${g}: ${c}`);
    for (const g of SHELL) assert.ok(silent(pre(g, ws, "Bash", { command: c })), `sessione principale ${g}: ${c}`);
  }
});

// ---------- F3: identità del dispatch dall'header del primo prompt nel transcript ----------

const header = (task_id, tokens) => `\`\`\`yaml\n${YAML.stringify({
  task_id, customer: "ACME", scope: "CAT", mode: "nrt", tier: "T1", depth: "standard",
  budget: { tokens, minutes: 15 }, allowed_paths: ["customers/ACME/kb/scopes/CAT/**"], task: "Generare i test negativi",
}).trim()}\n\`\`\`\n\nIstruzioni fisse…`;
const dispatch = (ws, prompt) => runHook("guard-budget", {
  session_id: "sess-1", cwd: ws, hook_event_name: "PreToolUse", tool_name: "Agent",
  tool_input: { subagent_type: "jaggaer-virtual-consultant:scope-expert", description: "d", prompt, model: "sonnet" },
}, env(ws));
// Transcript del sub-agente: primo messaggio user = prompt del dispatcher; poi il lavoro
// della fixture valid-report con il rapporto riferito a `reportTask`.
function transcript(ws, agentId, prompt, reportTask) {
  const lines = readFileSync(join(FIX, "valid-report.jsonl"), "utf8").trim().split("\n");
  lines[0] = JSON.stringify({ type: "user", message: { role: "user", content: prompt } });
  const f = join(ws, `t-${agentId}.jsonl`);
  writeFileSync(f, lines.join("\n").replace(/MSG\.sess-1\.0001/g, reportTask) + "\n");
  return f;
}
function stopWith(ws, agentId, { tfile = null, last = null, stopHookActive = false } = {}) {
  const lastText = last ?? (() => {
    const ls = readFileSync(tfile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    return [...ls].reverse().find((l) => l.type === "assistant").message.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
  })();
  const main = join(ws, "main-transcript.jsonl");
  if (!existsSync(main)) writeFileSync(main, "");
  return runHook("subagent-trace", {
    session_id: "sess-1", cwd: ws, hook_event_name: "SubagentStop", transcript_path: main,
    agent_id: agentId, agent_type: "jaggaer-virtual-consultant:scope-expert", stop_hook_active: stopHookActive,
    last_assistant_message: lastText, ...(tfile ? { agent_transcript_path: tfile } : {}),
  }, env(ws));
}
const entryOf = (ws, id) => readSess(ws).ledger.invocations.find((i) => i.agent_id === id);

test("F3 due dispatch paralleli dello stesso tipo che finiscono in ordine inverso: ciascun rapporto va al proprio MSG, nessun blocco, ciascuno col proprio budget", () => {
  const ws = mkWs(); seedSession(ws);
  const p1 = header("MSG.sess-1.0001", 40000);
  const p2 = header("MSG.sess-1.0002", 3000);
  assert.ok(silent(dispatch(ws, p1)));
  assert.ok(silent(dispatch(ws, p2)));
  const r2 = stopWith(ws, "b2", { tfile: transcript(ws, "b2", p2, "MSG.sess-1.0002") });
  assert.notEqual(r2.json?.decision, "block", r2.stdout);
  const e2 = entryOf(ws, "b2");
  assert.equal(e2.task_id, "MSG.sess-1.0002");
  assert.equal(e2.status_effective, "partial", "4000 token contro il budget 3000 del proprio compito");
  assert.ok(e2.reclassified.some((x) => /4000\/3000/.test(x)), JSON.stringify(e2.reclassified));
  const r1 = stopWith(ws, "a1", { tfile: transcript(ws, "a1", p1, "MSG.sess-1.0001") });
  assert.notEqual(r1.json?.decision, "block", r1.stdout);
  const e1 = entryOf(ws, "a1");
  assert.equal(e1.task_id, "MSG.sess-1.0001");
  assert.equal(e1.status_effective, "ok");
  assert.equal(e1.trace_incomplete, false);
  const bb = join(ws, "customers/ACME/.sessions/sess-1/blackboard");
  assert.equal(YAML.parse(readFileSync(join(bb, "MSG.sess-1.0002.yaml"), "utf8")).agent_id, "b2");
  assert.equal(YAML.parse(readFileSync(join(bb, "MSG.sess-1.0001.yaml"), "utf8")).agent_id, "a1");
});

test("F3 senza transcript: abbinamento per tipo e ordine; un task_id dichiarato che è un altro dispatch aperto dello stesso tipo non blocca, resta come avviso di traccia", () => {
  const ws = mkWs(); seedSession(ws);
  dispatch(ws, header("MSG.sess-1.0001", 40000));
  dispatch(ws, header("MSG.sess-1.0002", 40000));
  const text = JSON.parse(readFileSync(join(FIX, "valid-report.jsonl"), "utf8").trim().split("\n").at(-1)).message.content[0].text.replace(/MSG\.sess-1\.0001/g, "MSG.sess-1.0002");
  const r = stopWith(ws, "b2", { last: text });
  assert.notEqual(r.json?.decision, "block", r.stdout);
  const e = entryOf(ws, "b2");
  assert.ok(Array.isArray(e.trace_warnings) && e.trace_warnings.some((w) => /MSG\.sess-1\.0002/.test(w)), JSON.stringify(e));
});

// ---------- F4: le invocazioni aperte non bloccano per sempre ----------

const openInv = (ws, ageMs, task = "MSG.sess-1.0001") =>
  appendFileSync(join(ws, "customers/ACME/.sessions/sess-1/invocations.jsonl"), `${JSON.stringify({ ts: new Date(Date.now() - ageMs).toISOString(), task_id: task, subagent_type: "scope-expert", budget_tokens: 1000 })}\n`);

test("F4 un'invocazione più vecchia del TTL (2 h) non conta più come aperta: use scope passa (CLI e guard-budget)", () => {
  const ws = mkWs(); seedSession(ws);
  openInv(ws, 3 * 3600 * 1000);
  assert.ok(silent(pre("guard-budget", ws, "Bash", { command: plugCmd("use scope ADM --json") })));
  assert.equal(cli(ws, "use", "scope", "ADM").status, 0);
  const ws2 = mkWs(); seedSession(ws2);
  openInv(ws2, 10 * 60 * 1000);
  assert.equal(cli(ws2, "use", "scope", "ADM").status, 3, "dentro il TTL resta aperta");
});

test("F4 use close-stale: la sessione principale chiude a mano le invocazioni aperte (audit); poi use scope passa; un sub-agente è negato", () => {
  const ws = mkWs(); seedSession(ws);
  openInv(ws, 10 * 60 * 1000);
  assert.ok(denied(pre("guard-budget", ws, "Bash", { command: plugCmd("use close-stale --json") }, SUB)));
  assert.ok(silent(pre("guard-budget", ws, "Bash", { command: plugCmd("use close-stale --json") })));
  const r = cli(ws, "use", "close-stale");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(r.json.closed, ["MSG.sess-1.0001"]);
  const ev = auditOf(ws).find((e) => e.payload?.action === "close-stale");
  assert.ok(ev, "evento di audit");
  assert.deepEqual(ev.payload.closed, ["MSG.sess-1.0001"]);
  assert.equal(cli(ws, "use", "scope", "ADM").status, 0);
  assert.equal(cli(ws, "use", "close-stale").json.closed.length, 0, "niente da chiudere");
  assert.match(readFileSync(join(ROOT, "commands/use.md"), "utf8"), /close-stale/);
});

// ---------- F5 (#11): scritture via shell sui file di stato ----------

test("F5 sub-agente: scritture via shell su session.json, invocations.jsonl, .jvc/**, audit, blackboard, kb → deny (probe del revisore e varianti)", () => {
  const ws = mkWs(); seedSession(ws);
  for (const c of [
    "echo {} > customers/ACME/.sessions/sess-1/session.json",
    ": > customers/ACME/.sessions/sess-1/invocations.jsonl",
    "echo x > .jvc/current-session",
    "echo x >> customers/ACME/audit/2026-09.jsonl",
    "echo x | tee -a customers/ACME/.sessions/sess-1/blackboard/MSG.x.yaml",
    "Set-Content -Path customers/ACME/kb/scopes/CAT/flows/x.yaml -Value x",
    "'{}' | Out-File customers\\ACME\\.sessions\\sess-1\\session.json",
    "cp /tmp/x customers/ACME/.sessions/sess-1/session.json",
    "mv customers/ACME/.sessions/sess-1/invocations.jsonl /tmp/y",
    "rm -f customers/ACME/.sessions/sess-1/invocations.jsonl",
    "Remove-Item .jvc\\sessions\\sess-1.json",
    "Copy-Item x -Destination customers/ACME/lessons/session.json",
    "cd customers/ACME/.sessions/sess-1 && echo {} > session.json",
  ]) assert.ok(denied(pre("guard-scope", ws, "Bash", { command: c }, SUB)), c);
  for (const c of ["echo x > customers/ACME/lessons/L.ACME.CAT.LSN.0099.md", "node scripts/kb/kb.mjs find --scope CAT 2>&1", "ls customers/ACME/lessons > customers/ACME/reports/r.txt"]) {
    assert.ok(silent(pre("guard-scope", ws, "Bash", { command: c }, SUB)), c);
  }
});

test("F5 sessione principale: redirezioni su session.json, invocations.jsonl e .jvc/** negate; il resto no", () => {
  const ws = mkWs(); seedSession(ws);
  for (const c of [
    "echo {} > customers/ACME/.sessions/sess-1/session.json",
    ": > customers/ACME/.sessions/sess-1/invocations.jsonl",
    "echo x > .jvc/current-session",
  ]) {
    const r = pre("guard-scope", ws, "Bash", { command: c });
    assert.ok(denied(r), c);
    assert.match(reasonOf(r), /\/use|hook/);
  }
  for (const c of ["node scripts/kb/kb.mjs find --scope CAT > out.txt 2>&1", "echo x > customers/ACME/lessons/x.md", plugCmd("show --json")]) {
    assert.ok(silent(pre("guard-scope", ws, "Bash", { command: c })), c);
  }
});
