// WP10d giro di correzione 1 — I1 FERMA TUTTI vale solo per i dispatch esistenti alla cattura; I2 tier effettivo
// (il maggiore fra header e modello, disaccordo ⇒ deny, modello assente ⇒ tier massimo); minori: riga per prompt anche
// per needs-input, agente senza candidati trattato come il più restrittivo, scansione incrementale del transcript,
// vigilanza con le sorprese di step-check, redazione di show --json.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, appendFileSync, openSync, writeSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import YAML from "yaml";
import { mkWs, seedSession, runHook, decisionOf, reasonOf, cleanEnv, ROOT } from "../helpers/hook-env.mjs";
import { agentsFixture } from "../helpers/agents-fixture.mjs";
import { appendAudit } from "../../hooks/lib/audit.mjs";
import { readControl, controlFile } from "../../hooks/lib/control.mjs";

const SID = "sess-1";
const MIN = 60000;
const E = (ws, extra = {}) => ({ JVC_WORKSPACE: ws, CLAUDE_PLUGIN_ROOT: ROOT, ...extra });
const hdr = (o = {}) => `\`\`\`yaml\n${YAML.stringify({ task_id: "T-1", customer: "ACME", scope: "CAT", mode: "nrt", tier: "T1", budget: { tokens: 20000, minutes: 15 }, allowed_paths: ["customers/ACME/tests/**/CAT/**"], task: "x", ...o }).trim()}\n\`\`\`\n\nIstruzioni…`;
const dispatch = (ws, h = {}, ti = {}, extra = {}) => runHook("guard-budget", { session_id: SID, cwd: ws, hook_event_name: "PreToolUse", tool_name: "Agent",
  tool_input: { subagent_type: "jaggaer-virtual-consultant:scope-expert", description: "x", prompt: hdr(h), model: "sonnet", ...ti }, ...extra }, E(ws));
const denied = (r) => decisionOf(r) === "deny";
const allowed = (r) => r.status === 0 && r.stdout.trim() === "";
const userLine = (p, ts = new Date()) => JSON.stringify({ type: "user", isSidechain: false, userType: "external", message: { role: "user", content: p }, timestamp: ts.toISOString() });
const newTranscript = () => { const d = mkdtempSync(join(tmpdir(), "tr-")); const f = join(d, `${SID}.jsonl`); writeFileSync(f, ""); return { dir: d, tr: f }; };
const say = (ws, tr, p, { write = true } = {}) => {
  if (write) appendFileSync(tr, `${userLine(p)}\n`);
  return runHook("approval-capture", { session_id: SID, cwd: ws, hook_event_name: "UserPromptSubmit", prompt: p, transcript_path: tr }, E(ws));
};
const ctxOf = (r) => r.json?.hookSpecificOutput?.additionalContext ?? "";
const invsOf = (ws) => readFileSync(join(ws, "customers/ACME/.sessions", SID, "invocations.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const ctl = (ws, tr, agent, tool = "Read", ti = { file_path: "x" }, extra = {}) => runHook("guard-control", { session_id: SID, cwd: ws, hook_event_name: "PreToolUse", tool_name: tool, tool_input: ti, transcript_path: tr,
  ...(agent ? { agent_id: agent, agent_type: "jaggaer-virtual-consultant:scope-expert" } : {}), ...extra }, E(ws));
function subTranscript(dir, agent, task) {
  mkdirSync(join(dir, SID, "subagents"), { recursive: true });
  writeFileSync(join(dir, SID, "subagents", `agent-${agent}.jsonl`), `${JSON.stringify({ type: "user", isSidechain: true, agentId: agent, message: { role: "user", content: hdr({ task_id: task }) }, timestamp: new Date().toISOString() })}\n`);
}

// ---- I1 ----
test("I1 FERMA TUTTI ferma solo i dispatch esistenti alla cattura: un nuovo compito si dispaccia e lavora; i fermati restano fermati (anche dopo RIPRENDI TUTTI)", () => {
  const ws = mkWs(); seedSession(ws);
  const { dir, tr } = newTranscript();
  assert.equal(decisionOf(dispatch(ws, { task_id: "T-1" }, {}, { transcript_path: tr })), null);
  assert.equal(decisionOf(dispatch(ws, { task_id: "T-2" }, {}, { transcript_path: tr })), null);
  subTranscript(dir, "a1", "T-1"); subTranscript(dir, "a9", "T-9");
  const c = say(ws, tr, "FERMA TUTTI");
  assert.match(ctxOf(c), /T-1, T-2/); assert.match(ctxOf(c), /i dispatch successivi non sono toccati/);
  assert.deepEqual(readControl(controlFile(ws, "ACME", SID)).records[0].tasks, ["T-1", "T-2"]);
  assert.ok(denied(ctl(ws, tr, "a1")), "T-1 fermato");
  assert.ok(denied(dispatch(ws, { task_id: "T-1" }, {}, { transcript_path: tr })), "T-1 non si ridispaccia");
  assert.equal(decisionOf(dispatch(ws, { task_id: "T-9" }, {}, { transcript_path: tr })), null, "nuovo compito consentito");
  assert.ok(allowed(ctl(ws, tr, "a9")), "e il suo agente lavora");
  say(ws, tr, "RIPRENDI TUTTI");
  assert.ok(denied(ctl(ws, tr, "a1")), "lo stop resta terminale per i fermati");
  assert.match(readFileSync(join(ROOT, "docs/orchestration.md"), "utf8"), /FERMA TUTTI.*dispatch esistenti/s);
});

// ---- I2 ----
test("I2 tier effettivo: header e modello in disaccordo ⇒ deny; modello assente ⇒ tier massimo; le sonde del revisore sono negate; la console mostra il tier effettivo", () => {
  const ws = mkWs(); seedSession(ws);
  assert.equal(decisionOf(dispatch(ws, { task_id: "X-1", tier: "T0" }, { model: "haiku" })), null);
  assert.equal(decisionOf(dispatch(ws, { task_id: "X-1b", reply_to: "X-1", tier: "T1" }, { model: "sonnet" })), null, "prima escalation");
  for (const [h, ti, re] of [[{ tier: "T1" }, { model: "opus" }, /tier dell'header T1 ≠ tier del modello opus \(T2\)/], [{ tier: "T0" }, { model: "opus" }, /≠ tier del modello/],
    [{ tier: undefined }, { model: undefined }, /una sola escalation di tier per compito/]]) {
    const r = dispatch(ws, { task_id: "X-1c", reply_to: "X-1", ...h }, ti);
    assert.ok(denied(r), JSON.stringify([h, ti])); assert.match(reasonOf(r), re);
  }
  // modello assente, header T1 su un compito nuovo: tier effettivo T2 registrato
  assert.equal(decisionOf(dispatch(ws, { task_id: "Z-1", tier: undefined }, { model: undefined })), null);
  const z = invsOf(ws).find((x) => x.task_id === "Z-1");
  assert.equal(z.tier, "T2"); assert.equal(z.tier_declared, null); assert.equal(z.model_tier, null);
  const x = invsOf(ws).find((i) => i.task_id === "X-1b");
  assert.equal(x.tier, "T1"); assert.equal(x.tier_declared, "T1"); assert.equal(x.model_tier, "T1");
  const r = spawnSync(process.execPath, [join(ROOT, "scripts/admin/agents.mjs"), "status", "--json", "--workspace", ws, "--session", SID], { env: cleanEnv(), encoding: "utf8" });
  assert.equal(JSON.parse(r.stdout).rows.find((y) => y.task_id === "Z-1").tier, "T2");
});

// ---- minori ----
test("minore 1: la riga per prompt compare anche per un agente tornato needs-input finché non c'è un dispatch di seguito (reply_to)", () => {
  const { ws, sdir } = agentsFixture();
  const s = JSON.parse(readFileSync(join(sdir, "session.json"), "utf8"));
  s.ledger.invocations[0].status_effective = "needs-input"; s.ledger.invocations[0].status = "needs-input";
  s.ledger.invocations.push({ agent_id: "b1", inv_seq: 1, task_id: "T-B", status_effective: "ok", status: "ok", surprises: 0, completed_at: new Date().toISOString() },
    { agent_id: null, inv_seq: 2, task_id: "T-C", closed_by: "close-stale", completed_at: new Date().toISOString() });
  writeFileSync(join(sdir, "session.json"), JSON.stringify(s));
  const r = runHook("approval-capture", { session_id: SID, cwd: ws, hook_event_name: "UserPromptSubmit", prompt: "allora?" }, E(ws));
  assert.match(ctxOf(r), /1 in attesa dell'utente/); assert.match(ctxOf(r), /T-A/);
  appendFileSync(join(sdir, "invocations.jsonl"), `${JSON.stringify({ ts: new Date().toISOString(), task_id: "T-A2", reply_to: "T-A", task_key: "T-A", subagent_type: "scope-expert", scope: "CAT", tier: "T1" })}\n`);
  s.ledger.invocations.push({ agent_id: "c1", inv_seq: 3, task_id: "T-A2", status_effective: "ok", status: "ok", surprises: 0, completed_at: new Date().toISOString() });
  writeFileSync(join(sdir, "session.json"), JSON.stringify(s));
  assert.equal(runHook("approval-capture", { session_id: SID, cwd: ws, hook_event_name: "UserPromptSubmit", prompt: "allora?" }, E(ws)).stdout.trim(), "", "ripreso con reply_to: niente più attesa");
});

test("minore 2: un agente senza candidati è trattato come il più restrittivo (ogni compito aperto) e il legame si ricontrolla", () => {
  const ws = mkWs(); seedSession(ws);
  const { dir, tr } = newTranscript();
  const sdir = join(ws, "customers/ACME/.sessions", SID);
  writeFileSync(join(sdir, "invocations.jsonl"), `${JSON.stringify({ ts: new Date().toISOString(), task_id: "T-1", subagent_type: "scope-expert", scope: "CAT", tier: "T1" })}\n`);
  subTranscript(dir, "a1", "T-1");
  assert.ok(allowed(ctl(ws, tr, "a1")));
  say(ws, tr, "PAUSA AGENTE T-1");
  // agente di un altro tipo, senza transcript: nessun candidato del suo tipo ⇒ vale ogni compito aperto (T-1 in pausa)
  const yy = runHook("guard-control", { session_id: SID, cwd: ws, tool_name: "Read", tool_input: {}, agent_id: "yy", agent_type: "jaggaer-virtual-consultant:config-auditor" }, E(ws));
  assert.ok(denied(yy)); assert.match(reasonOf(yy), /identità/);
  // il legame si ricontrolla: arriva il suo dispatch (e il transcript) ⇒ legato, e non è in pausa
  appendFileSync(join(sdir, "invocations.jsonl"), `${JSON.stringify({ ts: new Date().toISOString(), task_id: "T-7", subagent_type: "config-auditor", scope: "CAT", tier: "T0" })}\n`);
  subTranscript(dir, "yy", "T-7");
  assert.ok(allowed(ctl(ws, tr, "yy", "Read", {}, { agent_type: "jaggaer-virtual-consultant:config-auditor" })));
  assert.equal(JSON.parse(readFileSync(join(sdir, "agents", "yy.json"), "utf8")).task_id, "T-7");
});

test("minore 4: con una frase che riduce la protezione non confermata, transcript grande letto in modo incrementale (< 300 ms per chiamata)", () => {
  const ws = mkWs(); seedSession(ws);
  const { dir, tr } = newTranscript();
  writeFileSync(join(ws, "customers/ACME/.sessions", SID, "invocations.jsonl"), `${JSON.stringify({ ts: new Date().toISOString(), task_id: "T-1", subagent_type: "scope-expert", scope: "CAT", tier: "T1" })}\n`);
  subTranscript(dir, "a1", "T-1");
  // ~40 MB di storia della sessione principale
  const filler = `${JSON.stringify({ type: "assistant", message: { id: "m", role: "assistant", content: [{ type: "text", text: "x".repeat(4000) }] } })}\n`.repeat(250);
  const fd = openSync(tr, "a"); for (let i = 0; i < 40; i++) writeSync(fd, filler); closeSync(fd);
  say(ws, tr, "PAUSA AGENTE T-1");
  say(ws, tr, "RIPRENDI AGENTE T-1", { write: false });   // non ancora nel transcript
  const times = [];
  for (let i = 0; i < 3; i++) { const r = ctl(ws, tr, "a1"); assert.ok(denied(r)); times.push(r.ms); }
  appendFileSync(tr, `${userLine("RIPRENDI AGENTE T-1")}\n`);
  const ok = ctl(ws, tr, "a1");
  assert.ok(allowed(ok)); times.push(ok.ms);
  console.log(`guard-control con transcript di 40 MB: ${times.map((t) => t.toFixed(0)).join(" · ")} ms`);
  assert.ok(times.every((t) => t < 300), times.join(","));
  // incrementale: il record parte dalla dimensione del transcript alla cattura (meno un margine), la scansione ha
  // un offset in cache per percorso (file protetto) e arriva alla fine del transcript
  const size = readFileSync(tr).length;
  const resume = readControl(controlFile(ws, "ACME", SID)).records.find((r) => r.kind === "resume");
  assert.ok(resume.tx_offset > 40 * 1000 * 1000 && resume.tx_offset < size, String(resume.tx_offset));
  const scan = JSON.parse(readFileSync(join(ws, "customers/ACME/.sessions", SID, "control-scan.json"), "utf8"));
  assert.equal(Object.values(scan)[0].offset, size);
});

test("minore 5: la vigilanza conta anche le sorprese registrate da step-check per l'agente, non solo quelle dichiarate", () => {
  const ws = mkWs(); seedSession(ws);
  const sdir = join(ws, "customers/ACME/.sessions", SID);
  const invs = [1, 2, 3].map((i) => ({ ts: new Date(Date.now() - (10 - i) * MIN).toISOString(), task_id: `S-${i}`, subagent_type: "jaggaer-virtual-consultant:scope-expert", scope: "CAT", tier: "T1", budget_tokens: 1000 }));
  writeFileSync(join(sdir, "invocations.jsonl"), invs.map((x) => JSON.stringify(x)).join("\n") + "\n");
  for (const i of [1, 2, 3]) {
    appendAudit(ws, { session: SID, customer: "ACME", scope: "CAT", kind: "run", actor: "step-check", payload: { action: "check", plan: "PLAN.0001", step: i, status: "surprise", kind: "elemento-assente" } });
    appendAudit(ws, { session: SID, customer: "ACME", scope: "CAT", kind: "tool", actor: "scope-expert", payload: { tool: "Bash", input_summary: "{\"command\":\"node scripts/decide/step-check.mjs --plan p --step 1\"}", ok: true, agent_id: `s${i}` } });
    // il rapporto dichiara 0 sorprese e status partial
    const rep = "```yaml\n" + YAML.stringify({ task_id: `S-${i}`, status: "partial", output: {}, lesson: "L.ACME.CAT.LSN.0001", why: {}, needs_input: null, open_questions: [],
      cognitive_trace: { depth: "standard", recalled: { semantic: [], episodic: [], working: [] }, epistemic: { subject: "x", shape_before: "consolidato", shape_after: "consolidato" }, strategy: "STR-REPLAY", hypotheses: null, decisions: [], surprises: [], self_check: { passed: 10, failed: [] } } }) + "```";
    runHook("subagent-trace", { session_id: SID, cwd: ws, hook_event_name: "SubagentStop", agent_id: `s${i}`, agent_type: "jaggaer-virtual-consultant:scope-expert", last_assistant_message: rep }, E(ws));
  }
  const led = JSON.parse(readFileSync(join(sdir, "session.json"), "utf8")).ledger.invocations;
  assert.deepEqual(led.map((e) => [e.surprises_declared, e.surprises_recorded, e.surprises]), [[0, 1, 1], [0, 1, 1], [0, 1, 1]]);
  const r = dispatch(ws, { task_id: "S-4" });
  assert.ok(denied(r)); assert.match(reasonOf(r), /il modello di questo scope va rifatto prima di continuare/);
});

test("minore 6: show --json redige i campi di testo libero del rapporto", () => {
  const { ws, sdir } = agentsFixture();
  const bb = YAML.parse(readFileSync(join(sdir, "blackboard", "T-A.yaml"), "utf8"));
  bb.open_questions = ["scrivi a mario.rossi@acme.it con password=hunter22"];
  bb.cognitive_trace.strategy = "STR-REPLAY token=abcdef123456";
  bb.cognitive_trace.hypotheses = [{ h: "api_key=zzzzzz999999" }];
  bb.cognitive_trace.surprise_items = [{ item: "S.STD.CAT.SEL.0140", note: "Bearer abcdefghijkl" }];
  writeFileSync(join(sdir, "blackboard", "T-A.yaml"), YAML.stringify(bb));
  const r = spawnSync(process.execPath, [join(ROOT, "scripts/admin/agents.mjs"), "show", "T-A", "--json", "--workspace", ws, "--session", SID], { env: cleanEnv(), encoding: "utf8" });
  assert.equal(r.status, 0);
  for (const s of ["hunter22", "mario.rossi@acme.it", "abcdef123456", "zzzzzz999999", "abcdefghijkl"]) assert.ok(!r.stdout.includes(s), s);
  assert.match(r.stdout, /S\.STD\.CAT\.SEL\.0140/);
});

test("minore 7: docs/orchestration.md dichiara fra i rischi residui la dipendenza da reply_to", () => {
  assert.match(readFileSync(join(ROOT, "docs/orchestration.md"), "utf8"), /## 7\. Rischi residui[\s\S]*reply_to/);
});
