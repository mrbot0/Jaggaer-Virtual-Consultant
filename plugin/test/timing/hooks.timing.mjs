// Soglie di tempo spostate dalla suite principale (revisione finale, in:52/in:54): lì resta solo un tetto generoso
// perché i file di test girano in parallelo e si contendono la CPU; qui, da soli e senza concorrenza
// (`npm run test:timing`), con riscaldamento, mediana/p95 e fino a 3 tentativi (vale il migliore).
//   - K4 "kb fields --mandatory-in < 1 s" su 1000 FLD: mediana del processo completo della CLI;
//   - session-context (SessionStart) < 2 s: mediana del processo completo;
//   - audit-append in-process < 100 ms per evento: p95;
//   - approval-capture (sintesi degli agenti a ogni prompt) in-process < 100 ms: p95.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import YAML from "yaml";
import { mkWs, seedSession, runHook, ROOT } from "../helpers/hook-env.mjs";
import { agentsFixture, SID } from "../helpers/agents-fixture.mjs";
import { reindex } from "../../scripts/kb/reindex.mjs";
import { handle as auditHandle } from "../../hooks/scripts/audit-append.mjs";

const ATTEMPTS = 3;
const q = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
// fino a ATTEMPTS tentativi di `sample()` (un array di ms dopo il riscaldamento): vale il valore migliore
function best(sample, stat, limit) {
  let v = Infinity;
  for (let i = 0; i < ATTEMPTS && v >= limit; i++) v = Math.min(v, stat(sample()));
  return v;
}

test("K4: kb fields --mandatory-in su 1000 FLD — mediana del processo completo della CLI < 1 s", { concurrency: false }, () => {
  const FIX = YAML.parse(readFileSync(join(ROOT, "test/fixtures/items/S.STD.P2P.FLD.0117.yaml"), "utf8"));
  const root = mkdtempSync(join(tmpdir(), "kbf-timing-"));
  const dir = join(root, "kb", "scopes", "P2P", "items");
  mkdirSync(dir, { recursive: true });
  const states = ["DRAFT", "PENDING_APPROVAL", "APPROVED", "ORDERED"];
  const kinds = ["always", "conditional", "never", "undocumented"];
  for (let i = 0; i < 1000; i++) {
    const id = `S.STD.P2P.FLD.${String(i + 1).padStart(4, "0")}`;
    const k = kinds[i % 4]; const m = { kind: k };
    if (k === "conditional") { m.in_states = [states[i % 4], states[(i + 1) % 4]]; if (i % 3 === 0) m.when = `document.company IN (IT0${i % 5})`; }
    writeFileSync(join(dir, `${id}.yaml`), YAML.stringify({ id, type: "FLD", title: `Campo ${id}`, summary: `Campo ${i} di prova.`, sources: [{ doc: "t" }],
      document: i % 2 ? "document.requisition" : "document.purchase_order", label: { it: `Campo ${i}` }, section: `sec.${i % 20}`, field_type: "text",
      facets: FIX.facets, technical_name: `F_${i}`, mandatory: m, custom: i % 7 === 0 }));
  }
  const dbPath = join(root, "knowledge.db");
  assert.equal(reindex(root, dbPath).invalid, 0);
  const KB = join(ROOT, "scripts/kb/kb.mjs");
  const once = () => { const t0 = performance.now(); const r = spawnSync(process.execPath, [KB, "fields", "--mandatory-in", "PENDING_APPROVAL", "--db", dbPath, "--json"], { encoding: "utf8" }); assert.equal(r.status, 0, r.stderr); return performance.now() - t0; };
  once(); // riscaldamento
  const med = best(() => Array.from({ length: 5 }, once), (a) => q(a, 0.5), 1000);
  console.log(`kb fields CLI (1000 FLD): mediana ${med.toFixed(0)} ms`);
  assert.ok(med < 1000, `${med.toFixed(0)} ms`);
});

test("session-context (SessionStart): mediana del processo completo < 2 s", { concurrency: false }, () => {
  const ws = mkWs(); seedSession(ws);
  const once = () => runHook("session-context", { session_id: "sess-1", cwd: ws, hook_event_name: "SessionStart", source: "startup" }, { JVC_WORKSPACE: ws, CLAUDE_PLUGIN_ROOT: ROOT }).ms;
  once();
  const med = best(() => Array.from({ length: 5 }, once), (a) => q(a, 0.5), 2000);
  console.log(`session-context: mediana ${med.toFixed(0)} ms`);
  assert.ok(med < 2000, `${med.toFixed(0)} ms`);
});

test("audit-append in-process: p95 < 100 ms per evento", { concurrency: false }, () => {
  const ws = mkWs(); seedSession(ws, { sid: "s9" });
  const input = { session_id: "s9", cwd: ws, tool_name: "Read", tool_input: { file_path: "x" } };
  for (let i = 0; i < 3; i++) auditHandle(input, { JVC_WORKSPACE: ws });
  const p95 = best(() => Array.from({ length: 40 }, () => { const t0 = performance.now(); auditHandle(input, { JVC_WORKSPACE: ws }); return performance.now() - t0; }), (a) => q(a, 0.95), 100);
  console.log(`audit-append in-process: p95 ${p95.toFixed(1)} ms`);
  assert.ok(p95 < 100, `${p95.toFixed(1)} ms`);
});

test("approval-capture (sintesi degli agenti) in-process: p95 < 100 ms", { concurrency: false }, async () => {
  const { ws } = agentsFixture();
  const { capture } = await import("../../scripts/admin/approvals.mjs");
  const env = { JVC_WORKSPACE: ws, CLAUDE_PLUGIN_ROOT: ROOT };
  const input = { session_id: SID, cwd: ws, prompt: "e ora?" };
  for (let i = 0; i < 3; i++) await capture(input, env);
  let p95 = Infinity;
  for (let a = 0; a < ATTEMPTS && p95 >= 100; a++) {
    const times = [];
    for (let i = 0; i < 20; i++) { const t0 = performance.now(); await capture(input, env); times.push(performance.now() - t0); }
    p95 = Math.min(p95, q(times, 0.95));
  }
  console.log(`approval-capture in-process: p95 ${p95.toFixed(1)} ms`);
  assert.ok(p95 < 100, `${p95.toFixed(1)} ms`);
});
