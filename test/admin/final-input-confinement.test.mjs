// Revisione finale (MUST FIX in:53): confinamento REALE dei file d'ingresso. Ogni opzione-file degli script usati
// dalla sessione si risolve nel workspace DEGLI HOOK (JVC_WORKSPACE > CLAUDE_PROJECT_DIR > cwd), non in un
// --workspace/--root scelto da chi invoca; realpath dentro il workspace e tetto di dimensione. MANUAL §56.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { envWs, ROOT } from "../helpers/env-fixture.mjs";
import { cleanEnv } from "../helpers/hook-env.mjs";
import { inputFile, confineInputs, INPUT_FILE_MAX } from "../../scripts/lib/text-file.mjs";

const run = (ws, rel, args) => spawnSync(process.execPath, [join(ROOT, rel), ...args], { encoding: "utf8", cwd: ws, env: cleanEnv({ JVC_WORKSPACE: ws, JVC_SESSION_ID: "sess-1" }), timeout: 60000 });

function outside() {
  const evil = realpathSync.native(mkdtempSync(join(tmpdir(), "jvc-altrove-")));
  for (const d of ["customers/ACME/.sessions/sess-1", "snaps"]) mkdirSync(join(evil, d), { recursive: true });
  writeFileSync(join(evil, "f.yaml"), "id: x\nsteps: []\n");
  writeFileSync(join(evil, "f.json"), "{}");
  writeFileSync(join(evil, "f.txt"), "Il campo deve essere compilato");
  return evil;
}

// [script, argomenti] — F = file fuori dal workspace degli hook (assoluto), D = cartella fuori
const CASES = [
  ["scripts/analytics/din-build.mjs", ["--input", "F.yaml"]],
  ["scripts/analytics/query-guard.mjs", ["limit", "--sql-file", "F.txt"]],
  ["scripts/chrome/capture.mjs", ["prepare", "--snapshot", "F.txt", "--plan", "runs/x/plan.json", "--step", "1"]],
  ["scripts/chrome/capture.mjs", ["record", "--spec", "F.json", "--file", "runs/x/01.png", "--kind", "context"]],
  ["scripts/chrome/compile-plan.mjs", ["--plan", "runs/x/plan.json", "--atlas", "F.json"]],
  ["scripts/chrome/compile-plan.mjs", ["verify", "--plan", "runs/x/plan.json", "--spec", "F.txt"]],
  ["scripts/chrome/env-check.mjs", ["--snapshot", "F.txt", "--env", "sandbox"]],
  ["scripts/chrome/env-check.mjs", ["--env-file", "F.yaml", "--snapshot", "F.txt", "--env", "sandbox"]],
  ["scripts/chrome/survey.mjs", ["--snapshots", "D", "--root", ".", "--customer", "ACME"]],
  ["scripts/compile/compile-case.mjs", ["--case", "F.yaml"]],
  ["scripts/compile/compile-cfp.mjs", ["--cfp", "F.yaml"]],
  ["scripts/compile/compile-cfp.mjs", ["--cfp", "S.STD.ADM.CFP.0014", "--params", "F.yaml"]],
  ["scripts/compile/lint-scope.mjs", ["F.yaml"]],
  ["scripts/compile/lint-spec.mjs", ["F.yaml"]],
  ["scripts/config/baseline.mjs", ["capture", "--input", "F.yaml", "--customer", "ACME", "--env", "sandbox"]],
  ["scripts/config/lint.mjs", ["--customer", "ACME", "--baseline", "F.yaml"]],
  ["scripts/decide/depth.mjs", ["--input", "F.yaml"]],
  ["scripts/decide/depth.mjs", ["--precedents", "F.yaml"]],
  ["scripts/decide/dt-eval.mjs", ["DT-001", "--inputs", "F.json"]],
  ["scripts/decide/self-check.mjs", ["--report", "F.txt", "--session", "F.json", "--audit", "F.txt"]],
  ["scripts/decide/step-check.mjs", ["--plan", "runs/x/plan.json", "--step", "1", "--snapshot", "F.txt"]],
  ["scripts/decide/step-check.mjs", ["--plan", "runs/x/plan.json", "--step", "1", "--why", "F.yaml"]],
  ["scripts/decide/strategy-select.mjs", ["--input", "F.json"]],
  ["scripts/decide/validate-plan.mjs", ["F.yaml", "--env-type", "sandbox"]],
  ["scripts/decide/validate-plan.mjs", ["--catalog", "F.yaml", "customers/ACME/x.yaml", "--env-type", "sandbox"]],
  ["scripts/ingest/aliases.mjs", ["learn", "--registry", "customers/ACME/aliases.yaml", "--rows-file", "F.yaml"]],
  ["scripts/ingest/aliases.mjs", ["resolve", "--registry", "F.yaml", "--payload-file", "F.yaml"]],
  ["scripts/ingest/doc-diff.mjs", ["--old", "F.json", "--new", "F.json"]],
  ["scripts/ingest/extract.mjs", ["--units", "F.json", "--doc", "F.json", "--root", "."]],
  ["scripts/ingest/field-table.mjs", ["--doc", "F.json"]],
  ["scripts/ingest/profile-doc.mjs", ["--parsed", "F.json", "--root", "."]],
  ["scripts/kb/backcheck.mjs", ["--item", "F.yaml", "--db", "customers/ACME/knowledge.db"]],
  ["scripts/kb/digest-fields.mjs", ["accept", "--batch", "customers/ACME/b.yaml", "--digested", "F.yaml"]],
  ["scripts/kb/digest-plan.mjs", ["record-answers", "--db", "customers/ACME/knowledge.db", "--answers-file", "F.yaml"]],
  ["scripts/kb/kb.mjs", ["units", "--query-file", "F.txt", "--db", "customers/ACME/knowledge.db"]],
  ["scripts/run/baseline.mjs", ["compare", "--case", "NRT.ACME.P2P.NEG.0001", "--observed", "F.yaml"]],
  ["scripts/run/checks-run.mjs", ["--cluster", "CL-CHK-002", "--customer", "ACME", "--cfp", "F.yaml"]],
  ["scripts/run/checks-run.mjs", ["--cluster", "CL-CHK-002", "--customer", "ACME", "--plan", "F.json"]],
  ["scripts/run/fixtures.mjs", ["resolve", "--case", "F.yaml", "--customer", "ACME"]],
  ["scripts/run/integration.mjs", ["diff", "--golden", "F.json", "--actual", "F.json"]],
  ["scripts/run/integration.mjs", ["stub", "--int", "F.yaml"]],
  ["scripts/run/promotion.mjs", ["evaluate", "--case", "F.yaml"]],
  ["scripts/run/select-suite.mjs", ["--suite", "delta", "--scope", "P2P", "--changed", "F.yaml"]],
  ["scripts/xray/build-payload.mjs", ["--run", "RUN.ACME.20260929.1000.P2P", "--outcomes", "F.yaml"]],
  ["scripts/xray/publish.mjs", ["--run", "RUN.ACME.20260929.1000.P2P", "--dry-run", "--outcomes", "F.yaml"]],
  ["scripts/xray/defect.mjs", ["--finding", "F.yaml"]],
];

test("ogni opzione-file degli script: un file fuori dal workspace degli hook è rifiutato (exit ≠ 0, «fuori dal workspace»), anche con --workspace/--root che lo contengono", () => {
  const ws = envWs({ env: "sandbox", scope: "P2P" });
  const evil = outside();
  const sub = (a) => a.replace(/^F\.(\w+)$/, (_m, ext) => join(evil, `f.${ext}`)).replace(/^D$/, join(evil, "snaps"));
  const failures = [];
  for (const [script, args] of CASES) {
    for (const extra of [[], ["--workspace", evil, "--root", evil]]) {
      const r = run(ws, script, [...args.map(sub), ...extra, "--json"]);
      const out = `${r.stdout}\n${r.stderr}`;
      if (r.status === 0 || !/fuori dal workspace/.test(out)) failures.push(`${script} ${args.join(" ")} ${extra.length ? "(+--workspace)" : ""} → ${r.status}: ${out.trim().slice(0, 160)}`);
    }
  }
  assert.deepEqual(failures, []);
});

test("file relativi: si risolvono nel workspace degli hook, non nel --workspace/--root scelto da chi invoca", () => {
  const ws = envWs({ env: "sandbox", scope: "P2P" });
  const evil = outside();
  writeFileSync(join(evil, "customers/ACME/.sessions/sess-1/t.txt"), "Il campo deve essere compilato");
  for (const [script, args] of [
    ["scripts/decide/intent.mjs", ["--text-file", "customers/ACME/.sessions/sess-1/t.txt", "--workspace", evil]],
    ["scripts/kb/review.mjs", ["reject", "C.ACME.P2P.FLW.0001", "--payload-file", "customers/ACME/.sessions/sess-1/t.txt", "--root", evil, "--customer", "ACME"]],
    ["scripts/analytics/query-guard.mjs", ["limit", "--sql-file", "customers/ACME/.sessions/sess-1/t.txt", "--workspace", evil]],
  ]) {
    const r = run(ws, script, [...args, "--json"]);
    assert.notEqual(r.status, 0, `${script}: il file esiste solo nel --workspace scelto dal chiamante`);
  }
});

test("inputFile/confineInputs: dentro sì (percorso assoluto confinato), fuori no, oltre il tetto no, cartelle solo se richieste", () => {
  const ws = envWs({ env: "sandbox", scope: "P2P" });
  const env = { JVC_WORKSPACE: ws };
  writeFileSync(join(ws, "customers/ACME/in.yaml"), "a: 1\n");
  assert.equal(inputFile("customers/ACME/in.yaml", { env }).abs, join(ws, "customers/ACME/in.yaml"));
  assert.match(inputFile(join(outside(), "f.yaml"), { env }).error, /fuori dal workspace/);
  writeFileSync(join(ws, "customers/ACME/big.txt"), "x".repeat(2048));
  assert.match(inputFile("customers/ACME/big.txt", { env, max: 1024 }).error, /oltre 1 KB/);
  assert.match(inputFile("customers/ACME", { env }).error, /non è un file/);
  assert.ok(inputFile("customers/ACME", { env, dir: true }).abs);
  const opts = { case: "customers/ACME/in.yaml", cfp: "S.STD.ADM.CFP.0014" };
  assert.equal(confineInputs(opts, ["case", "cfp"], { env, skip: (_n, v) => /^[SC]\./.test(v) }), null);
  assert.equal(opts.case, join(ws, "customers/ACME/in.yaml"));
  assert.equal(opts.cfp, "S.STD.ADM.CFP.0014");
  assert.ok(INPUT_FILE_MAX >= 1024 * 1024);
});
