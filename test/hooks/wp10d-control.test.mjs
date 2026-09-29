// WP10d D8 — controllo dell'utente sugli agenti, applicato dai guard e non dal modello: guard-control (PreToolUse su
// ogni strumento, FAIL-CLOSED) nega le chiamate dei sub-agenti in pausa o fermati, chiede il `sì` in passo-passo,
// applica i limiti per dispatch (chiamate, durata). Le frasi le cattura approval-capture (actor user in audit).
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, appendFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import YAML from "yaml";
import { mkWs, seedSession, runHook, decisionOf, reasonOf, ROOT } from "../helpers/hook-env.mjs";
import { readControl, controlFile } from "../../hooks/lib/control.mjs";
import { readApprovals, approvalsFile } from "../../scripts/admin/approvals.mjs";

const SID = "sess-1";
const E = (ws, extra = {}) => ({ JVC_WORKSPACE: ws, CLAUDE_PLUGIN_ROOT: ROOT, ...extra });
const MIN = 60000;
const prompt = (task, o = {}) => `\`\`\`yaml\n${YAML.stringify({ task_id: task, customer: "ACME", scope: "CAT", mode: "config", tier: "T1", budget: { tokens: 20000, minutes: 15 }, allowed_paths: ["customers/ACME/tests/**/CAT/**"], task: "x", ...o }).trim()}\n\`\`\`\n\nIstruzioni…`;
const userLine = (p, ts = new Date()) => JSON.stringify({ type: "user", isSidechain: false, userType: "external", message: { role: "user", content: p }, timestamp: ts.toISOString() });

// Workspace con due dispatch aperti (T-1, T-2) e i transcript dei sub-agenti a1, a2 (header del primo prompt).
function setup({ invs } = {}) {
  const ws = mkWs("jvc-ctl-");
  seedSession(ws);
  const sdir = join(ws, "customers/ACME/.sessions", SID);
  const list = invs ?? [
    { ts: new Date(Date.now() - 2 * MIN).toISOString(), task_id: "T-1", subagent_type: "jaggaer-virtual-consultant:scope-expert", model: "sonnet", budget_tokens: 20000, scope: "CAT", tier: "T1", task_key: "T-1", minutes: 15, allowed_paths: ["customers/ACME/tests/**/CAT/**"] },
    { ts: new Date(Date.now() - 1 * MIN).toISOString(), task_id: "T-2", subagent_type: "jaggaer-virtual-consultant:scope-expert", model: "sonnet", budget_tokens: 20000, scope: "CAT", tier: "T1", task_key: "T-2", minutes: 15, allowed_paths: ["customers/ACME/tests/**/CAT/**"] },
  ];
  writeFileSync(join(sdir, "invocations.jsonl"), list.map((x) => JSON.stringify(x)).join("\n") + "\n");
  const tdir = mkdtempSync(join(tmpdir(), "tr-"));
  const tr = join(tdir, `${SID}.jsonl`);
  writeFileSync(tr, "");
  mkdirSync(join(tdir, SID, "subagents"), { recursive: true });
  for (const [a, t] of [["a1", "T-1"], ["a2", "T-2"]]) writeFileSync(join(tdir, SID, "subagents", `agent-${a}.jsonl`), `${JSON.stringify({ type: "user", isSidechain: true, agentId: a, message: { role: "user", content: prompt(t) }, timestamp: new Date().toISOString() })}\n`);
  return { ws, sdir, tr };
}
const call = (ws, tr, agent, tool = "Read", ti = null, env = {}) => runHook("guard-control", {
  session_id: SID, cwd: ws, hook_event_name: "PreToolUse", tool_name: tool, transcript_path: tr,
  tool_input: ti ?? { file_path: join(ws, "customers/ACME/kb/scopes/CAT/flows/C.ACME.CAT.FLW.0001.yaml") },
  ...(agent ? { agent_id: agent, agent_type: "jaggaer-virtual-consultant:scope-expert" } : {}),
}, E(ws, env));
const say = (ws, tr, p, { write = true } = {}) => {
  if (write) appendFileSync(tr, `${userLine(p)}\n`);
  return runHook("approval-capture", { session_id: SID, cwd: ws, hook_event_name: "UserPromptSubmit", prompt: p, transcript_path: tr }, E(ws));
};
const allowed = (r) => r.status === 0 && r.stdout.trim() === "";
const denied = (r) => decisionOf(r) === "deny";
const session = (ws) => JSON.parse(readFileSync(join(ws, "customers/ACME/.sessions", SID, "session.json"), "utf8"));
const audit = (ws) => { const d = join(ws, "customers/ACME/audit"); return existsSync(d) ? readdirSync(d).flatMap((f) => readFileSync(join(d, f), "utf8").trim().split("\n").map((l) => JSON.parse(l))) : []; };
const click = { uid: "1_7" };

test("guard-control: la sessione principale non è mai toccata; inerte fuori da un workspace JVC; le chiamate dei sub-agenti sono legate al compito dall'header del transcript", () => {
  const { ws, sdir, tr } = setup();
  assert.ok(allowed(call(ws, tr, null)));
  assert.ok(!existsSync(join(sdir, "agents")), "nessuno stato per la sessione principale");
  assert.ok(allowed(call(ws, tr, "a1")));
  const st = JSON.parse(readFileSync(join(sdir, "agents", "a1.json"), "utf8"));
  assert.equal(st.task_id, "T-1"); assert.equal(st.inv_seq, 0); assert.equal(st.source, "header"); assert.equal(st.calls, 1);
  const out = realTmp();
  assert.ok(allowed(runHook("guard-control", { session_id: SID, cwd: out, tool_name: "Read", tool_input: {}, agent_id: "a1" }, { JVC_WORKSPACE: out, CLAUDE_PLUGIN_ROOT: ROOT })));
});
const realTmp = () => mkdtempSync(join(tmpdir(), "nojvc-"));

test("PAUSA AGENTE: la prossima chiamata dell'agente è negata con il motivo, gli altri agenti non sono toccati; RIPRENDI AGENTE (confermata nel transcript) la consente; tutto in audit con actor user", () => {
  const { ws, tr } = setup();
  assert.ok(allowed(call(ws, tr, "a1")));
  say(ws, tr, "PAUSA AGENTE T-1");
  const r = call(ws, tr, "a1");
  assert.ok(denied(r)); assert.match(reasonOf(r), /in pausa.*PAUSA AGENTE T-1/s); assert.match(reasonOf(r), /RIPRENDI AGENTE T-1/);
  assert.ok(allowed(call(ws, tr, "a2")), "gli altri agenti proseguono");
  assert.ok(allowed(call(ws, tr, null)), "la sessione principale prosegue");
  say(ws, tr, "RIPRENDI AGENTE T-1");
  assert.ok(allowed(call(ws, tr, "a1")));
  const acts = audit(ws).filter((e) => e.actor === "user").map((e) => [e.payload.control, e.payload.target]);
  assert.deepEqual(acts, [["pause", "T-1"], ["resume", "T-1"]]);
  assert.ok(audit(ws).some((e) => e.kind === "guard" && e.actor === "hook:guard-control" && e.payload.agent_id === "a1"), "deny in audit");
});

test("PAUSA TUTTI ferma ogni agente e ogni nuovo dispatch; RIPRENDI AGENTE ne riprende uno solo; RIPRENDI TUTTI tutti; una ripresa mai scritta dall'utente non vale", () => {
  const { ws, tr } = setup();
  say(ws, tr, "PAUSA TUTTI");
  assert.ok(denied(call(ws, tr, "a1"))); assert.ok(denied(call(ws, tr, "a2")));
  const d = runHook("guard-budget", { session_id: SID, cwd: ws, hook_event_name: "PreToolUse", tool_name: "Agent", transcript_path: tr, tool_input: { subagent_type: "scope-expert", model: "sonnet", prompt: prompt("T-9") } }, E(ws));
  assert.ok(denied(d)); assert.match(reasonOf(d), /pausa/);
  say(ws, tr, "RIPRENDI AGENTE T-2");
  assert.ok(denied(call(ws, tr, "a1"))); assert.ok(allowed(call(ws, tr, "a2")));
  say(ws, tr, "RIPRENDI TUTTI", { write: false });   // il prompt non arriva mai nel transcript: non confermata
  assert.ok(denied(call(ws, tr, "a1")));
  say(ws, tr, "RIPRENDI TUTTI");
  assert.ok(allowed(call(ws, tr, "a1")));
});

test("FERMA AGENTE: chiamate negate, invocazione chiusa subito (aborted-by-user), subagent-trace adotta la voce senza bloccare, il compito non si ridispaccia", () => {
  const { ws, sdir, tr } = setup();
  assert.ok(allowed(call(ws, tr, "a1")));
  const c = say(ws, tr, "FERMA AGENTE T-1");
  assert.match(c.json.hookSpecificOutput.additionalContext, /invocazioni chiuse: T-1/);
  const r = call(ws, tr, "a1");
  assert.ok(denied(r)); assert.match(reasonOf(r), /fermato dall'utente/); assert.match(reasonOf(r), /status blocked/);
  let led = session(ws).ledger.invocations;
  assert.equal(led.length, 1); assert.equal(led[0].closed_by, "user-stop"); assert.equal(led[0].status_effective, "aborted-by-user"); assert.equal(led[0].inv_seq, 0);
  // l'agente si ferma senza traccia completa: nessun blocco, voce adottata
  const s = runHook("subagent-trace", { session_id: SID, cwd: ws, hook_event_name: "SubagentStop", agent_id: "a1", agent_type: "jaggaer-virtual-consultant:scope-expert", transcript_path: tr,
    last_assistant_message: "```yaml\ntask_id: T-1\nstatus: blocked\n```", stop_hook_active: false }, E(ws));
  assert.notEqual(s.json?.decision, "block");
  led = session(ws).ledger.invocations;
  assert.equal(led.length, 1, "nessuna voce duplicata");
  assert.equal(led[0].agent_id, "a1"); assert.equal(led[0].status_effective, "aborted-by-user");
  assert.equal(YAML.parse(readFileSync(join(sdir, "blackboard", "T-1.yaml"), "utf8")).status_effective, "aborted-by-user");
  const d = runHook("guard-budget", { session_id: SID, cwd: ws, hook_event_name: "PreToolUse", tool_name: "Agent", transcript_path: tr, tool_input: { subagent_type: "scope-expert", model: "sonnet", prompt: prompt("T-1") } }, E(ws));
  assert.ok(denied(d)); assert.match(reasonOf(d), /fermato dall'utente/);
  assert.ok(allowed(call(ws, tr, "a2")));
});

test("PASSO PASSO: click dell'agente negato senza conferma (richiesta sì registrata), consentito una volta dopo il sì; letture e scritture nelle cartelle di lavoro senza conferma; PASSO PASSO OFF spegne", () => {
  const { ws, tr } = setup();
  say(ws, tr, "PASSO PASSO T-1");
  assert.ok(allowed(call(ws, tr, "a1")), "lettura: nessuna conferma");
  assert.ok(allowed(call(ws, tr, "a1", "Write", { file_path: join(ws, "customers/ACME/tests/cases/CAT/n1.yaml"), content: "x" })), "scrittura nella cartella di lavoro");
  const w = call(ws, tr, "a1", "Write", { file_path: join(ws, "customers/ACME/lessons/x.md"), content: "x" });
  assert.ok(denied(w)); assert.match(reasonOf(w), /passo-passo/);
  // la richiesta aperta è quella della scrittura: il click attende che sia risolta
  let r = call(ws, tr, "a1", "mcp__chrome-devtools__click", click);
  assert.ok(denied(r));
  say(ws, tr, "sì");
  assert.ok(allowed(call(ws, tr, "a1", "Write", { file_path: join(ws, "customers/ACME/lessons/x.md"), content: "x" })), "consentita la stessa scrittura, una volta");
  r = call(ws, tr, "a1", "mcp__chrome-devtools__click", click);
  assert.ok(denied(r)); assert.match(reasonOf(r), /sì/);
  const pend = session(ws).pending.approvals;
  assert.equal(pend.length, 1); assert.equal(pend[0].step_mode, true); assert.equal(pend[0].task_id, "T-1"); assert.match(pend[0].plan, /^PLAN\.PASSO\./);
  assert.ok(allowed(call(ws, tr, "a2", "mcp__chrome-devtools__click", click)), "un altro agente non è in passo-passo");
  say(ws, tr, "sì");
  assert.ok(allowed(call(ws, tr, "a1", "mcp__chrome-devtools__click", click)));
  assert.ok(denied(call(ws, tr, "a1", "mcp__chrome-devtools__click", click)), "il sì vale una volta sola");
  const recs = readApprovals(approvalsFile(ws, "ACME", SID)).records;
  assert.equal(recs.filter((x) => x.kind === "action").length, 2); assert.equal(recs.filter((x) => x.kind === "consume").length, 2);
  say(ws, tr, "PASSO PASSO OFF");
  assert.ok(allowed(call(ws, tr, "a1", "mcp__chrome-devtools__click", { uid: "1_8" })));
});

test("limiti per dispatch: 200 chiamate e 30 minuti di default; LIMITI DISPATCH dell'utente (confermata) li cambia; oltre il limite il guard nega e chiede partial", () => {
  const { ws, sdir, tr } = setup();
  assert.ok(allowed(call(ws, tr, "a1")));
  const f = join(sdir, "agents", "a1.json");
  const st = JSON.parse(readFileSync(f, "utf8"));
  writeFileSync(f, JSON.stringify({ ...st, calls: 200 }));
  let r = call(ws, tr, "a1");
  assert.ok(denied(r)); assert.match(reasonOf(r), /200 chiamate/); assert.match(reasonOf(r), /partial/);
  say(ws, tr, "LIMITI DISPATCH 300 60");
  assert.deepEqual(readControl(controlFile(ws, "ACME", SID)).records.map((x) => x.kind), ["limits", "confirm"]);
  assert.ok(allowed(call(ws, tr, "a1")));
  // durata: dispatch 16 minuti fa con budget.minutes 15 nell'header ⇒ vale il minore (15)
  const inv = readFileSync(join(sdir, "invocations.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  inv[1].ts = new Date(Date.now() - 16 * MIN).toISOString();
  writeFileSync(join(sdir, "invocations.jsonl"), inv.map((x) => JSON.stringify(x)).join("\n") + "\n");
  r = call(ws, tr, "a2");
  assert.ok(denied(r)); assert.match(reasonOf(r), /15 minuti/);
  // default: 30 minuti senza budget.minutes nell'header
  const b = setup({ invs: [{ ts: new Date(Date.now() - 31 * MIN).toISOString(), task_id: "T-1", subagent_type: "scope-expert", model: "sonnet", budget_tokens: 20000, scope: "CAT", tier: "T1", task_key: "T-1" }] });
  r = call(b.ws, b.tr, "a1");
  assert.ok(denied(r)); assert.match(reasonOf(r), /30 minuti/);
});

test("fail-closed: registro di controllo manomesso ⇒ ogni chiamata dei sub-agenti negata; eccezione interna ⇒ deny; identità ambigua con un compito in pausa ⇒ deny", () => {
  const { ws, sdir, tr } = setup();
  say(ws, tr, "PAUSA AGENTE T-1");
  appendFileSync(join(sdir, "control.jsonl"), `${JSON.stringify({ kind: "resume", target: "T-1", ts: new Date().toISOString(), prev_hash: "x", hash: "y" })}\n`);
  const r = call(ws, tr, "a2");
  assert.ok(denied(r)); assert.match(reasonOf(r), /manomesso/);
  assert.ok(allowed(call(ws, tr, null)));
  const t = call(ws, tr, "a2", "Read", null, { JVC_TEST_THROW: "1" });
  assert.ok(denied(t)); assert.match(reasonOf(t), /fail-closed/);
  // agente senza transcript, due dispatch aperti dello stesso tipo: identità ambigua; T-1 in pausa ⇒ negato
  const b = setup();
  say(b.ws, b.tr, "PAUSA AGENTE T-1");
  const amb = runHook("guard-control", { session_id: SID, cwd: b.ws, hook_event_name: "PreToolUse", tool_name: "Read", tool_input: {}, agent_id: "zz", agent_type: "scope-expert" }, E(b.ws));
  assert.ok(denied(amb)); assert.match(reasonOf(amb), /ambigu/);
});

test("console: lo stato dei sub-agenti riflette il controllo dell'utente (in-pausa, in-attesa-utente per il passo-passo, fermato)", async () => {
  const { buildConsole, resolveMonitorSession } = await import("../../scripts/admin/agents.mjs");
  const { ws, tr } = setup();
  const rows = () => buildConsole(ws, "ACME", SID, resolveMonitorSession(ws, SID).session).rows.map((r) => [r.task_id, r.state]);
  assert.ok(allowed(call(ws, tr, "a1"))); assert.ok(allowed(call(ws, tr, "a2")));
  assert.deepEqual(rows(), [["T-1", "in-corso"], ["T-2", "in-corso"]]);
  say(ws, tr, "PAUSA AGENTE T-1");
  say(ws, tr, "PASSO PASSO T-2");
  assert.ok(denied(call(ws, tr, "a2", "mcp__chrome-devtools__click", click)));
  assert.deepEqual(rows(), [["T-1", "in-pausa"], ["T-2", "in-attesa-utente"]]);
  say(ws, tr, "FERMA AGENTE T-1");
  assert.deepEqual(rows(), [["T-1", "fermato"], ["T-2", "in-attesa-utente"]]);
});
