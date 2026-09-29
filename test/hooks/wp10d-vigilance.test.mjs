// WP10d D2 — regole di orchestrazione applicate dal codice in guard-budget (fail-closed): vigilanza cognitiva per
// scope (§23.2), una sola escalation di tier per compito (DT-002), handoff solo via agent-manager con contratto HND.
// Sblocco della vigilanza solo dall'utente (SBLOCCA SCOPE <S>, catturata da approval-capture e confermata nel
// transcript); la frase è negata in ogni input di strumento da guard-phrase.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync, writeFileSync, mkdtempSync, appendFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import YAML from "yaml";
import { mkWs, seedSession, runHook, decisionOf, reasonOf, ROOT } from "../helpers/hook-env.mjs";
import { readControl, controlFile } from "../../hooks/lib/control.mjs";

const E = (ws) => ({ JVC_WORKSPACE: ws, CLAUDE_PLUGIN_ROOT: ROOT });
const header = (o = {}) => `\`\`\`yaml\n${YAML.stringify({
  task_id: "T-1", customer: "ACME", scope: "CAT", mode: "nrt", tier: "T1", depth: "standard",
  budget: { tokens: 20000, minutes: 15 }, allowed_paths: ["customers/ACME/kb/scopes/CAT/**"], task: "compito", ...o,
}).trim()}\n\`\`\`\n\nIstruzioni fisse…`;
const dispatch = (ws, h = {}, extra = {}, ti = {}) => runHook("guard-budget", {
  session_id: "sess-1", cwd: ws, hook_event_name: "PreToolUse", tool_name: "Agent",
  tool_input: { subagent_type: "jaggaer-virtual-consultant:scope-expert", description: "x", prompt: header(h), model: "sonnet", ...ti }, ...extra,
}, E(ws));
const closed = (i, status, surprises, scope = "CAT", min = 60 - i) => ({ agent_id: `a${i}`, agent_type: "scope-expert", inv_seq: null, task_id: `OLD-${i}`, enforced: true, tokens: 100, tokens_by_model: {}, blocks: 0,
  scope, surprises, status, status_effective: status, completed_at: new Date(Date.now() - min * 60000).toISOString() });
const withLedger = (entries) => { const ws = mkWs(); seedSession(ws, { extra: { ledger: { invocations: entries, trace_blocks: {} } } }); return ws; };
const denied = (r) => decisionOf(r) === "deny";
const userLine = (p, ts = new Date()) => JSON.stringify({ type: "user", isSidechain: false, userType: "external", message: { role: "user", content: p }, timestamp: ts.toISOString() });
const transcript = () => { const f = join(mkdtempSync(join(tmpdir(), "tr-")), "sess-1.jsonl"); writeFileSync(f, ""); return f; };
const say = (ws, tr, prompt, { write = true } = {}) => {
  if (write) appendFileSync(tr, `${userLine(prompt)}\n`);
  return runHook("approval-capture", { session_id: "sess-1", cwd: ws, hook_event_name: "UserPromptSubmit", prompt, transcript_path: tr }, E(ws));
};
const ctxOf = (r) => r.json?.hookSpecificOutput?.additionalContext ?? "";
const auditOf = (ws) => { const d = join(ws, "customers/ACME/audit"); const f = join(d, `${new Date().toISOString().slice(0, 7)}.jsonl`); return existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []; };

test("vigilanza: al terzo compito consecutivo fermato per sorprese sullo stesso scope ogni nuovo Agent() su quello scope è negato con il messaggio esatto", () => {
  const ws = withLedger([closed(1, "partial", 1), closed(2, "escalate", 2), closed(3, "needs-input", 1)]);
  const r = dispatch(ws);
  assert.ok(denied(r));
  assert.match(reasonOf(r), /il modello di questo scope va rifatto prima di continuare/);
  assert.match(reasonOf(r), /SBLOCCA SCOPE CAT/);
  assert.ok(auditOf(ws).some((e) => e.kind === "guard" && /il modello di questo scope va rifatto/.test(e.payload.reason)), "deny in audit");
});

test("vigilanza: un compito ok azzera il contatore; esiti senza sorprese o di altri scope non contano; due soli fermati non bloccano", () => {
  assert.equal(decisionOf(dispatch(withLedger([closed(1, "partial", 1), closed(2, "partial", 1), closed(3, "ok", 0), closed(4, "escalate", 1)]))), null);
  assert.equal(decisionOf(dispatch(withLedger([closed(1, "partial", 1), closed(2, "partial", 1), closed(3, "partial", 1, "ADM")]))), null);
  assert.equal(decisionOf(dispatch(withLedger([closed(1, "partial", 1), closed(2, "blocked", 0), closed(3, "partial", 1)]))), null);
  // un compito senza sorprese in mezzo non azzera: la serie continua
  assert.ok(denied(dispatch(withLedger([closed(1, "partial", 1), closed(2, "partial", 0), closed(3, "partial", 1), closed(4, "escalate", 1)]))));
});

test("vigilanza: SBLOCCA SCOPE <S> dell'utente (approval-capture, actor user, confermata nel transcript) sblocca; senza la riga nel transcript no", () => {
  const ws = withLedger([closed(1, "partial", 1), closed(2, "escalate", 2), closed(3, "needs-input", 1)]);
  const tr = transcript();
  // UserPromptSubmit: il prompt non è ancora nel transcript
  const c = say(ws, tr, "SBLOCCA SCOPE CAT", { write: false });
  assert.match(ctxOf(c), /SBLOCCA SCOPE CAT/);
  const recs = readControl(controlFile(ws, "ACME", "sess-1")).records;
  assert.equal(recs.length, 1); assert.equal(recs[0].kind, "unlock"); assert.equal(recs[0].scope, "CAT");
  assert.ok(auditOf(ws).some((e) => e.actor === "user" && e.payload?.control === "unlock" && e.payload?.scope === "CAT"), "audit actor user");
  // non confermata nel transcript: la riduzione di protezione non vale
  assert.ok(denied(dispatch(ws, {}, { transcript_path: tr })));
  // Claude Code scrive il prompt dell'utente nel transcript: alla chiamata successiva vale, e la conferma resta nel registro
  appendFileSync(tr, `${userLine("SBLOCCA SCOPE CAT")}\n`);
  assert.equal(decisionOf(dispatch(ws, {}, { transcript_path: tr })), null);
  assert.ok(readControl(controlFile(ws, "ACME", "sess-1")).records.some((r) => r.kind === "confirm"));
  assert.equal(decisionOf(dispatch(ws, { task_id: "T-2" })), null, "confermata una volta, vale anche dopo");
  // un nuovo record di sblocco il cui prompt non è nel transcript (frase mai scritta dall'utente) non sblocca
  const ws2 = withLedger([closed(1, "partial", 1), closed(2, "escalate", 2), closed(3, "needs-input", 1)]);
  const tr2 = transcript();
  say(ws2, tr2, "SBLOCCA SCOPE CAT", { write: false });
  assert.ok(denied(dispatch(ws2, {}, { transcript_path: tr2 })));
  // prompt già nel transcript al momento della cattura: confermato subito da approval-capture
  const ws3 = withLedger([closed(1, "partial", 1), closed(2, "escalate", 2), closed(3, "needs-input", 1)]);
  const tr3 = transcript();
  say(ws3, tr3, "SBLOCCA SCOPE CAT");
  assert.deepEqual(readControl(controlFile(ws3, "ACME", "sess-1")).records.map((r) => r.kind), ["unlock", "confirm"]);
  assert.equal(decisionOf(dispatch(ws3)), null);
  // chiusure fermate DOPO lo sblocco ricominciano a contare
  const s = JSON.parse(readFileSync(join(ws, "customers/ACME/.sessions/sess-1/session.json"), "utf8"));
  s.ledger.invocations.push(closed(5, "partial", 1, "CAT", -1), closed(6, "partial", 1, "CAT", -2), closed(7, "escalate", 1, "CAT", -3));
  writeFileSync(join(ws, "customers/ACME/.sessions/sess-1/session.json"), JSON.stringify(s));
  assert.ok(denied(dispatch(ws, { task_id: "T-3" })));
});

test("una sola escalation di tier per compito: T0 → T1 (reply_to) consentito, poi T2 negato; stesso tier ripetuto consentito", () => {
  const ws = mkWs(); seedSession(ws);
  assert.equal(decisionOf(dispatch(ws, { task_id: "X-1", tier: "T0" })), null);
  assert.equal(decisionOf(dispatch(ws, { task_id: "X-1b", reply_to: "X-1", tier: "T1" })), null, "prima escalation");
  const r = dispatch(ws, { task_id: "X-1c", reply_to: "X-1", tier: "T2" });
  assert.ok(denied(r)); assert.match(reasonOf(r), /una sola escalation di tier per compito/);
  assert.equal(decisionOf(dispatch(ws, { task_id: "X-1", tier: "T1" })), null, "ripresa allo stesso tier già raggiunto");
  // tier dal modello quando l'header non lo dichiara
  assert.equal(decisionOf(dispatch(ws, { task_id: "Y-1", tier: undefined }, {}, { model: "haiku" })), null);
  assert.equal(decisionOf(dispatch(ws, { task_id: "Y-1", tier: undefined }, {}, { model: "sonnet" })), null);
  assert.ok(denied(dispatch(ws, { task_id: "Y-1", tier: undefined }, {}, { model: "opus" })));
  const inv = readFileSync(join(ws, "customers/ACME/.sessions/sess-1/invocations.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(inv.slice(0, 2).map((x) => [x.task_key, x.tier]), [["X-1", "T0"], ["X-1", "T1"]]);
});

test("handoff: kind handoff richiede via: agent-manager e un contratto HND esistente che dichiara lo scope; un sub-agente non invoca Agent", () => {
  const ws = mkWs(); seedSession(ws);
  writeFileSync(join(ws, "customers/ACME/kb/handoffs/C.ACME.XSC.HND.0004.yaml"), YAML.stringify({ id: "C.ACME.XSC.HND.0004", type: "HND", from_scope: "ADM", to_scope: "CAT", contract: "x", owner_of_test: "CAT", stop_at_step: 3, does_not_pass: ["y"] }));
  writeFileSync(join(ws, "customers/ACME/kb/handoffs/C.ACME.XSC.HND.0005.yaml"), YAML.stringify({ id: "C.ACME.XSC.HND.0005", type: "HND", from_scope: "ADM", to_scope: "P2P" }));
  const H = (o) => ({ task_id: `H-${Math.random().toString(36).slice(2, 7)}`, kind: "handoff", via: "agent-manager", contract: "C.ACME.XSC.HND.0004", ...o });
  for (const [o, re] of [[{ via: undefined }, /via: agent-manager/], [{ via: "adm-expert" }, /via: agent-manager/], [{ contract: undefined }, /contratto HND/], [{ contract: "C.ACME.XSC.CFG.0004" }, /contratto HND/],
    [{ contract: "C.ACME.XSC.HND.0009" }, /inesistente/], [{ contract: "C.ACME.XSC.HND.0005" }, /non dichiara lo scope CAT/]]) {
    const r = dispatch(ws, H(o));
    assert.ok(denied(r), JSON.stringify(o)); assert.match(reasonOf(r), re);
  }
  assert.equal(decisionOf(dispatch(ws, H({}))), null);
  const sub = dispatch(ws, { task_id: "S-1" }, { agent_id: "a9", agent_type: "jaggaer-virtual-consultant:scope-expert" });
  assert.ok(denied(sub)); assert.match(reasonOf(sub), /sub-agente non invoca altri agenti/);
});

test("guard-phrase: le frasi di controllo (maiuscole) sono negate in ogni input di strumento; il testo minuscolo 'passo passo' no", () => {
  const ws = mkWs(); seedSession(ws);
  const g = (ti, tool = "Write") => runHook("guard-phrase", { session_id: "sess-1", cwd: ws, hook_event_name: "PreToolUse", tool_name: tool, tool_input: ti }, E(ws));
  for (const p of ["SBLOCCA SCOPE CAT", "PAUSA AGENTE T-1", "PAUSA TUTTI", "RIPRENDI AGENTE T-1", "FERMA AGENTE T-1", "PASSO PASSO OFF", "PASSO PASSO TUTTI", "LIMITI DISPATCH 500 60"]) {
    assert.ok(denied(g({ file_path: join(ws, "customers/ACME/lessons/x.md"), content: `nota: ${p}` })), p);
    assert.ok(denied(g({ message: p }, "mcp__plugin_x_slack__send_message")), p);
  }
  assert.equal(g({ file_path: join(ws, "customers/ACME/lessons/x.md"), content: "procedere passo passo con la pausa agente" }).stdout.trim(), "");
});
