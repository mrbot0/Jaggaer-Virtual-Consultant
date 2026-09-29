// WP10a giro di correzione 1: file d'ingresso confinati al workspace (minore 2), build-report da file (I3), kb epistemic
// per soggetto (I4), find --cluster e ingest --kind (minore 1), doctor plugin-root (minore 3), avviso sui template
// ignorati (minore 5), /vc senza argomenti con le azioni suggerite (minore 7).
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { envWs, ROOT } from "../helpers/env-fixture.mjs";
import { cleanEnv } from "../helpers/hook-env.mjs";
import { confinedPath } from "../../scripts/lib/text-file.mjs";

const run = (ws, rel, args, env = {}) => {
  const r = spawnSync(process.execPath, [join(ROOT, rel), ...args], { encoding: "utf8", cwd: ws, env: cleanEnv({ JVC_WORKSPACE: ws, JVC_SESSION_ID: "sess-1", ...env }), timeout: 60000 });
  let json = null;
  try { json = JSON.parse(r.stdout.trim().split("\n").filter(Boolean).at(-1)); } catch { json = null; }
  return { ...r, json };
};

// ---------------- minore 2: file d'ingresso confinati al workspace ----------------
test("minore 2: confinedPath — dentro il workspace sì; assoluto fuori, .. che esce, vuoto ⇒ errore", () => {
  const ws = envWs({ env: "sandbox", scope: "P2P" });
  assert.ok(confinedPath(ws, "customers/ACME/x.txt").abs);
  assert.ok(confinedPath(ws, join(ws, "customers", "ACME", "x.txt")).abs);
  for (const bad of [join(tmpdir(), "altrove.txt"), "../fuori.txt", "customers/../../fuori.txt", "", "C:/Windows/win.ini"]) assert.ok(confinedPath(ws, bad).error, `accettato: ${bad}`);
});

test("minore 2: ogni file d'ingresso fuori dal workspace è rifiutato (text-file, payload-file, sql-file)", () => {
  const ws = envWs({ env: "sandbox", scope: "P2P" });
  const out = mkdtempSync(join(tmpdir(), "jvc-fuori-"));
  writeFileSync(join(out, "t.txt"), "Su ACME sandbox apri l'ultima RdA");
  writeFileSync(join(out, "p.yaml"), "n: 1\nstatus: ok\n");
  writeFileSync(join(out, "q.sql"), "select 1 from t");
  const abs = (f) => join(out, f);
  const rel = (f) => join("..", out.split(/[\\/]/).pop(), f);
  for (const f of [abs("t.txt"), rel("t.txt")]) {
    assert.equal(run(ws, "scripts/decide/intent.mjs", ["--text-file", f, "--json"]).status, 1, `intent ${f}`);
    assert.equal(run(ws, "scripts/kb/kb.mjs", ["resolve", "--text-file", f, "--db", "customers/ACME/knowledge.db", "--json"]).status, 1, `kb resolve ${f}`);
  }
  assert.equal(run(ws, "scripts/admin/workflow.mjs", ["event", "--kind", "step_end", "--payload-file", abs("p.yaml"), "--json"]).status, 1);
  assert.equal(run(ws, "scripts/analytics/query-guard.mjs", ["limit", "--sql-file", abs("q.sql"), "--json"]).status, 1);
  assert.equal(run(ws, "scripts/kb/review.mjs", ["reject", "C.ACME.P2P.FLW.0001", "--payload-file", abs("p.yaml"), "--root", ws, "--customer", "ACME"]).status, 1);
  assert.equal(run(ws, "scripts/kb/compensation.mjs", ["add", "--step", "1", "--payload-file", abs("p.yaml"), "--json"]).status, 1);
  assert.equal(run(ws, "scripts/run/fixtures.mjs", ["register", "--run", "RUN.ACME.20260923.1000.P2P", "--payload-file", abs("p.yaml"), "--customer", "ACME", "--json"]).status, 1);
  // dentro il workspace: stessi comandi accettati
  const d = join(ws, "customers/ACME/.sessions/sess-1");
  writeFileSync(join(d, "q.sql"), "select 1 from t");
  const ok = run(ws, "scripts/analytics/query-guard.mjs", ["limit", "--sql-file", "customers/ACME/.sessions/sess-1/q.sql", "--json"]);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
});
