// 18/11/2026 (ciclo di bug fixing 5): /nrt report con report.yaml scritto dall'agente — `errors` come UNA voce
// (mappa) invece che come elenco non manda in crash build-report (prima: exit 2 "errors.map is not a function"); una
// voce che non è né mappa né elenco è un errore d'uso (exit 1).
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import YAML from "yaml";
import { envWs, patchSession, ROOT } from "../helpers/env-fixture.mjs";
import { cleanEnv } from "../helpers/hook-env.mjs";

const BR = join(ROOT, "scripts/report/build-report.mjs");

test("build-report --payload-file: errors come mappa singola ⇒ un errore nel report; errors scalare ⇒ exit 1", () => {
  const ws = envWs({ env: "sandbox", scope: "P2P" });
  patchSession(ws, (s) => { s.session_code = "SES.ACME.20261118.001"; });
  const sdir = join(ws, "customers/ACME/.sessions/sess-1");
  writeFileSync(join(sdir, "report.yaml"), YAML.stringify({ title: "NEG CdC non attivo", release: "R25.3",
    expected: { error: { code: "REQ-VAL-014" } }, errors: { code: "REQ-VAL-014", category: "validation", message: "Il centro di costo non è attivo" } }));
  const env = cleanEnv({ JVC_WORKSPACE: ws, JVC_SESSION_ID: "sess-1" });
  const r = spawnSync(process.execPath, [BR, "--kind", "test", "--run", "RUN.ACME.20261118.1000.P2P", "--payload-file", "customers/ACME/.sessions/sess-1/report.yaml", "--json"], { encoding: "utf8", env });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.outcome, "EXPECTED-ERROR-AS-SUCCESS");
  const y = YAML.parse(readFileSync(join(ws, `customers/ACME/reports/${out.code}.yaml`), "utf8"));
  assert.equal(y.errors.length, 1);
  writeFileSync(join(sdir, "report2.yaml"), YAML.stringify({ title: "x", errors: "nessuno" }));
  const bad = spawnSync(process.execPath, [BR, "--kind", "test", "--payload-file", "customers/ACME/.sessions/sess-1/report2.yaml", "--json"], { encoding: "utf8", env });
  assert.equal(bad.status, 1, bad.stdout + bad.stderr);
  assert.match(JSON.parse(bad.stdout).error, /errors/);
});
