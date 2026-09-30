// Test funzionali dei guard di partizione (processi separati, stdin simulato).
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readdirSync, readFileSync, mkdtempSync, realpathSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { mkWs, seedSession, runHook, decisionOf, reasonOf, ROOT } from "../helpers/hook-env.mjs";

const call = (guard, ws, tool, tool_input, extra = {}, env = {}) =>
  runHook(guard, { session_id: "sess-1", cwd: ws, hook_event_name: "PreToolUse", tool_name: tool, tool_input, ...extra }, { JVC_WORKSPACE: ws, CLAUDE_PLUGIN_ROOT: ROOT, ...env });
const denied = (r) => decisionOf(r) === "deny";
const silent = (r) => r.status === 0 && r.stdout.trim() === "";

test("guard-scope: lettura nella cella consentita; fuori cella negata con suggerimento di handoff", () => {
  const ws = mkWs(); seedSession(ws);
  const X = { agent_type: "scope-expert", agent_id: "a1" };
  assert.ok(silent(call("guard-scope", ws, "Read", { file_path: join(ws, "customers/ACME/kb/scopes/CAT/flows/C.ACME.CAT.FLW.0001.yaml") }, X)));
  assert.ok(silent(call("guard-scope", ws, "Read", { file_path: join(ws, "product/kb/scopes/CAT/x.yaml") }, X)));
  assert.ok(silent(call("guard-scope", ws, "Read", { file_path: join(ws, "customers/ACME/kb/scopes/XSC/integrations/C.ACME.XSC.INT.0001.yaml") }, X)));
  assert.ok(silent(call("guard-scope", ws, "Write", { file_path: join(ws, "customers/ACME/tests/cases/CAT/NRT.ACME.CAT.NEG.0031.yaml"), content: "x" }, X)));
  assert.ok(silent(call("guard-scope", ws, "Write", { file_path: join(ws, "customers/ACME/lessons/L.ACME.CAT.LSN.0090.md"), content: "x" }, X)));
  const r = call("guard-scope", ws, "Read", { file_path: join(ws, "customers/ACME/kb/scopes/ADM/configs/C.ACME.ADM.CFG.0019.yaml") }, X);
  assert.ok(denied(r));
  assert.match(reasonOf(r), /handoff tramite il manager/);
  assert.ok(denied(call("guard-scope", ws, "Read", { file_path: join(ws, "product/kb/scopes/ADM/x.yaml") }, X)));
  assert.ok(denied(call("guard-scope", ws, "Write", { file_path: join(ws, "customers/ACME/_inbox/ADM/x.md"), content: "x" }, X)));
  assert.ok(denied(call("guard-scope", ws, "Write", { file_path: join(ws, "customers/ACME/kb/scopes/XSC/integrations/x.yaml"), content: "x" }, X)), "INT possedute: sola lettura");
});

test("guard-scope: scrittura negata a tutti su product/**, decision-tables/strategies/clusters del plugin, stato di sessione (§29.6, T9)", () => {
  const ws = mkWs(); seedSession(ws);
  for (const f of [join(ws, "product/kb/scopes/CAT/x.yaml"), join(ws, "product/config/defaults.yaml"), join(ROOT, "decision-tables/DT-003.yaml"),
    join(ROOT, "strategies/STR-REPLAY.yaml"), join(ROOT, "clusters/CL-CFG/CL-CFG-001.yaml"), join(ws, "customers/ACME/.sessions/sess-1/session.json"), join(ws, ".jvc/sessions/sess-1.json")]) {
    const r = call("guard-scope", ws, "Edit", { file_path: f, old_string: "a", new_string: "b" });
    assert.ok(denied(r), f);
  }
  assert.ok(silent(call("guard-scope", ws, "Read", { file_path: join(ROOT, "decision-tables/DT-003.yaml") })), "lettura delle DT consentita");
});

test("guard-scope: Glob/Grep controllano path e prefisso del pattern", () => {
  const ws = mkWs(); seedSession(ws);
  assert.ok(silent(call("guard-scope", ws, "Grep", { pattern: "strict_import", path: join(ws, "customers/ACME/kb/scopes/CAT") })));
  assert.ok(silent(call("guard-scope", ws, "Glob", { pattern: "customers/ACME/kb/scopes/CAT/**/*.yaml", path: ws })));
  assert.ok(silent(call("guard-scope", ws, "Glob", { pattern: "**/*.md", path: join(ws, "customers/ACME/lessons") })));
  assert.ok(denied(call("guard-scope", ws, "Glob", { pattern: "customers/ACME/kb/scopes/*/**", path: ws })));
  assert.ok(denied(call("guard-scope", ws, "Grep", { pattern: "x", path: join(ws, "customers/ACME/kb") })), "ricerca su un antenato della cella");
  assert.ok(denied(call("guard-scope", ws, "Grep", { pattern: "x" })), "ricerca sull'intero workspace");
  assert.ok(denied(call("guard-scope", ws, "Glob", { pattern: "*.yaml", path: join(ws, "customers/ACME/kb/scopes") })), "pattern senza / è ricorsivo");
});

test("guard-scope: senza scope (o senza cliente) le celle sono negate", () => {
  const ws = mkWs(); seedSession(ws, { scope: null, allowed_paths: [] });
  assert.ok(denied(call("guard-scope", ws, "Read", { file_path: join(ws, "customers/ACME/kb/scopes/CAT/flows/C.ACME.CAT.FLW.0001.yaml") })));
  const ws2 = mkWs(); seedSession(ws2, { customer: null });
  assert.ok(denied(call("guard-scope", ws2, "Read", { file_path: join(ws2, "product/kb/scopes/CAT/x.yaml") })));
});

test("guard-customer: solo il cliente attivo + product/; senza cliente customers/** negato salvo `session.mjs use customer`", () => {
  const ws = mkWs(); seedSession(ws);
  assert.ok(silent(call("guard-customer", ws, "Read", { file_path: join(ws, "customers/ACME/lessons/x.md") })));
  assert.ok(silent(call("guard-customer", ws, "Read", { file_path: join(ws, "product/kb/scopes/CAT/x.yaml") })));
  const r = call("guard-customer", ws, "Read", { file_path: join(ws, "customers/BETA/kb/scopes/CAT/secret.yaml") });
  assert.ok(denied(r)); assert.match(reasonOf(r), /BETA/);
  assert.ok(denied(call("guard-customer", ws, "Glob", { pattern: "customers/*/lessons/**", path: ws })));
  const ws2 = mkWs(); seedSession(ws2, { customer: null });
  assert.ok(denied(call("guard-customer", ws2, "Read", { file_path: join(ws2, "customers/ACME/lessons/x.md") })));
  assert.ok(silent(call("guard-customer", ws2, "Bash", { command: `node "${ROOT}/scripts/admin/session.mjs" use customer ACME --new --json` })));
  assert.ok(denied(call("guard-customer", ws2, "Bash", { command: "cat customers/ACME/lessons/x.md" })));
});

test("guard-customer: eccezione weekly-digest in sola lettura su lessons|decisions|outcomes|observations|kb di ogni cliente", () => {
  const ws = mkWs(); seedSession(ws);
  const W = { agent_type: "jaggaer-virtual-consultant:weekly-digest", agent_id: "w1" };
  assert.ok(silent(call("guard-customer", ws, "Read", { file_path: join(ws, "customers/BETA/lessons/L.BETA.CAT.LSN.0001.md") }, W)));
  assert.ok(silent(call("guard-customer", ws, "Glob", { pattern: "customers/*/lessons/**", path: ws }, W)));
  assert.ok(silent(call("guard-customer", ws, "Read", { file_path: join(ws, "customers/BETA/kb/scopes/CAT/secret.yaml") }, W)));
  assert.ok(silent(call("guard-scope", ws, "Read", { file_path: join(ws, "customers/BETA/kb/scopes/CAT/secret.yaml") }, W)));
  assert.ok(denied(call("guard-customer", ws, "Write", { file_path: join(ws, "customers/BETA/lessons/x.md"), content: "x" }, W)));
  assert.ok(denied(call("guard-customer", ws, "Read", { file_path: join(ws, "customers/BETA/runs/r.json") }, W)));
  assert.ok(denied(call("guard-customer", ws, "Read", { file_path: join(ws, "customers/BETA/lessons/x.md") }, { agent_type: "scope-expert" })));
});

test("guard-domain-boundary: scrittura in kb/ che cita analysis/ o PAT/PBK/BRF/RUL, in analysis/ che cita NRT.* → deny (regex di validate-boundary)", () => {
  const ws = mkWs(); seedSession(ws);
  const kbFile = join(ws, "customers/ACME/kb/scopes/CAT/flows/C.ACME.CAT.FLW.0002.yaml");
  assert.ok(denied(call("guard-domain-boundary", ws, "Write", { file_path: kbFile, content: "note: vedi analysis/patterns\n" })));
  assert.ok(denied(call("guard-domain-boundary", ws, "Edit", { file_path: kbFile, old_string: "a", new_string: "rif S.STD.CAT.PAT.0002" })));
  assert.ok(denied(call("guard-domain-boundary", ws, "MultiEdit", { file_path: kbFile, edits: [{ old_string: "a", new_string: "ok" }, { old_string: "b", new_string: "C.ACME.CAT.RUL.0001" }] })));
  assert.ok(silent(call("guard-domain-boundary", ws, "Write", { file_path: kbFile, content: "id: C.ACME.CAT.FLW.0002\n" })));
  const anFile = join(ws, "customers/ACME/analysis/patterns/C.ACME.CAT.PAT.0001.yaml");
  const r = call("guard-domain-boundary", ws, "Write", { file_path: anFile, content: "prevention_test: NRT.ACME.CAT.NEG.0031\n" }, { agent_type: "root-cause-analyst" });
  assert.ok(denied(r)); assert.match(reasonOf(r), /test/);
});

test("guard-domain-boundary: letture di analysis/ solo per i ruoli analitici o scope-expert in diag sul BRF del proprio scope", () => {
  const ws = mkWs(); seedSession(ws, { mode: "diag" });
  const brfCat = join(ws, "customers/ACME/analysis/briefings/C.ACME.CAT.BRF.0001.yaml");
  const brfAdm = join(ws, "customers/ACME/analysis/briefings/C.ACME.ADM.BRF.0001.yaml");
  const pat = join(ws, "customers/ACME/analysis/patterns/C.ACME.CAT.PAT.0001.yaml");
  for (const t of ["root-cause-analyst", "failure-triage", "jaggaer-virtual-consultant:defect-reporter"]) {
    assert.ok(silent(call("guard-domain-boundary", ws, "Read", { file_path: pat }, { agent_type: t })), t);
  }
  assert.ok(silent(call("guard-domain-boundary", ws, "Read", { file_path: brfCat }, { agent_type: "scope-expert" })));
  assert.ok(denied(call("guard-domain-boundary", ws, "Read", { file_path: brfAdm }, { agent_type: "scope-expert" })));
  assert.ok(denied(call("guard-domain-boundary", ws, "Read", { file_path: pat }, { agent_type: "scope-expert" })));
  assert.ok(denied(call("guard-domain-boundary", ws, "Grep", { pattern: "x", path: join(ws, "customers/ACME/analysis") }, { agent_type: "scope-expert" })));
  assert.ok(denied(call("guard-domain-boundary", ws, "Read", { file_path: pat })), "sessione principale");
  const ws2 = mkWs(); seedSession(ws2, { mode: "nrt" });
  assert.ok(denied(call("guard-domain-boundary", ws2, "Read", { file_path: join(ws2, "customers/ACME/analysis/briefings/C.ACME.CAT.BRF.0001.yaml") }, { agent_type: "scope-expert" })));
});

test("guard: ogni deny è registrato in audit (kind guard, actor hook:<guard>)", () => {
  const ws = mkWs(); seedSession(ws);
  call("guard-scope", ws, "Read", { file_path: join(ws, "customers/ACME/kb/scopes/ADM/configs/C.ACME.ADM.CFG.0019.yaml") }, { agent_type: "scope-expert", agent_id: "cat-1" });
  const dir = join(ws, "customers/ACME/audit");
  const f = join(dir, readdirSync(dir).find((x) => x.endsWith(".jsonl")));
  const ev = readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l)).find((e) => e.kind === "guard");
  assert.equal(ev.actor, "hook:guard-scope");
  assert.equal(ev.payload.decision, "deny");
  assert.equal(ev.payload.agent_id, "cat-1");
  assert.match(ev.payload.input_summary, /ADM/);
});

test("guard: fuori da un workspace JVC nessuna opinione", () => {
  const plain = realpathSync.native(mkdtempSync(join(tmpdir(), "plain-")));
  mkdirSync(join(plain, "src"));
  for (const g of ["guard-scope", "guard-customer", "guard-domain-boundary"]) {
    const r = runHook(g, { session_id: "x", cwd: plain, tool_name: "Read", tool_input: { file_path: join(plain, "src/a.js") } }, { CLAUDE_PROJECT_DIR: plain, CLAUDE_PLUGIN_ROOT: ROOT });
    assert.ok(silent(r), `${g}: ${r.stdout}`);
  }
});
