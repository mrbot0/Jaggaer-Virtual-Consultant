// Giro di correzione 1 di WP04 (revisione: Important #1, #3, #4, #5; Minor #2). Il nome del test porta il numero.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { openDb } from "../../scripts/kb/db.mjs";
import * as SC from "../../scripts/decide/self-check.mjs";
const { selfCheck } = SC;
import { deliberationDepth } from "../../scripts/decide/depth.mjs";
import { applyObservation, newBeliefState, isBlocked } from "../../scripts/kb/belief-update.mjs";
import { validateWith } from "../../scripts/lib/schemas.mjs";

const DT_EVAL = fileURLToPath(new URL("../../scripts/decide/dt-eval.mjs", import.meta.url));
const SELF_CHECK = fileURLToPath(new URL("../../scripts/decide/self-check.mjs", import.meta.url));
const node = (args) => spawnSync(process.execPath, args, { encoding: "utf8" });
const INPUTS = JSON.stringify({ risk: "R2", shape: "libresco", mandatory_missing: false, open_contradiction: false, novelty: false });

function writeDec(dir, dbFile, extra = []) {
  const r = node([DT_EVAL, "--table", "DT-002", "--inputs", INPUTS, "--db", dbFile, "--root", dir, "--customer", "ACME", "--scope", "ADM",
    "--agent", "adm-expert", "--strategy", "STR-DRY-RUN", "--write-dec", "--json", ...extra]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return JSON.parse(r.stdout).dec_code;
}

test("#1 dt-eval --write-dec senza --effects registra effects NULL (ignoto), --effects 1, --no-effects 0", () => {
  const dir = mkdtempSync(join(tmpdir(), "fx1-"));
  const dbFile = join(dir, "knowledge.db");
  openDb(dbFile).close();
  const a = writeDec(dir, dbFile);
  const b = writeDec(dir, dbFile, ["--effects"]);
  const c = writeDec(dir, dbFile, ["--no-effects"]);
  const db = openDb(dbFile);
  const eff = (code) => db.prepare("select effects from decision_context where decision_code=?").get(code).effects;
  assert.equal(eff(a), null);
  assert.equal(eff(b), 1);
  assert.equal(eff(c), 0);
});

function scFixture(dir, dbFile, dec) {
  const plan = {
    plan_id: "PLAN.0001", customer: "ACME", env: "sandbox", goal: "salvare il profilo",
    steps: [{ n: 1, verb: "SAVE", target: "S.STD.ADM.SEL.0120", expect: { toast: "S.STD.ADM.SEL.0121" } }],
    repair_policy: { skip_allowed: [], substitute_allowed: [], abort_on: [1] },
  };
  const report = {
    task_id: "T-1", status: "ok", output: { report: "L.ACME.ADM.RPT.0001" },
    cognitive_trace: { depth: "standard", recalled: { semantic: [], episodic: [], working: [] },
      epistemic: { subject: "C.ACME.ADM.CFG.0019", shape_before: "libresco", shape_after: "libresco" },
      strategy: "STR-DRY-RUN", hypotheses: null, decisions: [dec], surprises: [], self_check: { passed: 10, failed: [] } },
    lesson: "L.ACME.ADM.LSN.0001",
  };
  const lesson = `---\nid: L.ACME.ADM.LSN.0001\nexpected_outcomes: []\n---\n## 1. C\nx\n## 2. T\nx\n## 3. O\nx\n## 4. D\nx\n## 5. E\nx\n## 6. L\nx\n## 7. N\ndipende da F5\n## 8. Q\nnessuna\n`;
  const db = openDb(dbFile);
  const item = db.prepare("insert into items(code,level,customer,scope,type,title,summary,facets,status,path,hash,updated_at) values (?,?,?,?,?,?,?,?,?,?,?,?)");
  for (const c of ["S.STD.ADM.SEL.0120", "S.STD.ADM.SEL.0121", "C.ACME.ADM.CFG.0019", "L.ACME.ADM.RPT.0001"]) item.run(c, c[0], c.split(".")[1], "ADM", c.split(".")[3], "t", "s", "{}", "validato", "p", "h", "2026-09-22");
  db.prepare("insert into lessons(code) values (?)").run("L.ACME.ADM.LSN.0001");
  db.close();
  writeFileSync(join(dir, "report.yaml"), YAML.stringify(report));
  writeFileSync(join(dir, "session.json"), JSON.stringify({ allowed_paths: [], pending: { compensations: [], expected_outcomes: [] }, surprises: [], ledger: {} }));
  writeFileSync(join(dir, "audit.jsonl"), "");
  writeFileSync(join(dir, "plan.yaml"), YAML.stringify(plan));
  writeFileSync(join(dir, "lesson.md"), lesson);
  return ["--report", join(dir, "report.yaml"), "--session", join(dir, "session.json"), "--audit", join(dir, "audit.jsonl"),
    "--plan", join(dir, "plan.yaml"), "--lesson", join(dir, "lesson.md"), "--db", dbFile, "--json"];
}

test("#1 dt-eval senza --effects, poi self-check su un piano con SAVE e nessun esito atteso → #5 fallisce (exit 3)", () => {
  const dir = mkdtempSync(join(tmpdir(), "fx1b-"));
  const dbFile = join(dir, "knowledge.db");
  openDb(dbFile).close();
  const dec = writeDec(dir, dbFile);
  const r = node([SELF_CHECK, ...scFixture(dir, dbFile, dec)]);
  assert.equal(r.status, 3, r.stdout + r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).failed.map((f) => f.n), [5]);
});

test("#1 un compito con effetti prevale su effects:false della DEC che cita come effetto; altrimenti la contraddizione è segnalata", () => {
  const base = {
    report: { task_id: "T", status: "ok", output: { effects: [{ decision: "L.ACME.ADM.DEC.0001" }], report: "L.ACME.ADM.RPT.0001" },
      cognitive_trace: { epistemic: { shape_before: "libresco", shape_after: "libresco" }, decisions: ["L.ACME.ADM.DEC.0001", "L.ACME.ADM.DEC.0002"], surprises: [] },
      lesson: null },
    kbExists: () => true,
    getDecision: () => ({ table: "DT-002", strategy: "STR-DRY-RUN", effects: false }),
  };
  const r = selfCheck(base);
  const f5 = r.failed.find((f) => f.n === 5);
  assert.ok(f5, "la DEC citata in output.effects ha effetti anche se registrata senza");
  assert.match(f5.reason, /DEC\.0001/);
  assert.doesNotMatch(f5.reason, /DEC\.0002/);
  assert.ok(r.signals.some((s) => /DEC\.0002/.test(s.reason) && /effetti/.test(s.reason)), "DEC senza effetti in un compito con effetti: segnalata");
});

test("#3 sostituzione senza successore (terza osservazione o seconda esecuzione contraria senza `with`) → errore, blocco intatto", () => {
  const ITEM = "C.ACME.ADM.CFG.0019";
  let s = newBeliefState({ [ITEM]: { confidence: 0.81 } });
  s = applyObservation(s, { item: ITEM, coherent: false, kind: "obs", with: "L.ACME.ADM.OBS.0001" }).state;
  s = applyObservation(s, { item: ITEM, coherent: false, kind: "obs", with: "L.ACME.ADM.OBS.0002" }).state;
  const before = structuredClone(s);
  assert.throws(() => applyObservation(s, { item: ITEM, coherent: false, kind: "obs" }), /successore/);
  assert.deepEqual(s, before, "lo stato ricevuto non cambia");
  assert.equal(isBlocked(s, ITEM, "R2"), true);
  const e = applyObservation(newBeliefState(), { item: ITEM, coherent: false, kind: "exec", with: "RUN.ACME.20260922.1130.ADM" }).state;
  assert.throws(() => applyObservation(e, { item: ITEM, coherent: false, kind: "exec" }), /successore/);
  assert.equal(isBlocked(e, ITEM, "R3"), true);
});

test("#4 rilevatori di spreco (§29.10 'Controllo fallito'): #12 e #13 bloccano; trace_self_check.failed porta ogni controllo fallito 1–13", () => {
  const input = {
    report: { task_id: "T", status: "ok", output: {}, cognitive_trace: { epistemic: { shape_before: "consolidato", shape_after: "consolidato" }, decisions: [], surprises: [] }, lesson: null },
    kbExists: () => true,
    session: { ledger: { calls: [{ cmd: "kb find", args: "--scope ADM" }, { cmd: "kb find", args: "--scope ADM" }] } },
    observations: [{ kind: "snapshot", page_sig: "adm/x" }, { kind: "snapshot", page_sig: "adm/x" }],
  };
  const r = selfCheck(input);
  const f12 = r.failed.find((f) => f.n === 12);
  const f13 = r.failed.find((f) => f.n === 13);
  assert.equal(f12.action, "block");
  assert.equal(f13.action, "block");
  assert.equal(r.blocked, true);
  assert.deepEqual(r.trace_self_check.failed, r.failed.map((f) => f.n).sort((a, b) => a - b));
  assert.ok(r.trace_self_check.failed.includes(12) && r.trace_self_check.failed.includes(13));
  assert.ok(r.trace_self_check.passed <= 10);
  // lo schema della traccia cognitiva accetta i numeri oltre il 10 in `failed`
  const trace = { depth: "standard", recalled: { semantic: [], episodic: [], working: [] },
    epistemic: { subject: "C.ACME.ADM.CFG.0019", shape_before: "consolidato", shape_after: "consolidato" },
    strategy: "STR-REPLAY", hypotheses: null, decisions: [], surprises: [], self_check: r.trace_self_check };
  assert.ok(validateWith("cognitive-trace.schema.json", trace).ok);
});

test("Minor #2 un solo insieme di controlli: depth pubblica quelli che self-check esegue", () => {
  const rapida = deliberationDepth({ risk: "R1", shape: "consolidato", surprises: 0, precedent: "confermato-d<0.2", graph_radius: 2 });
  assert.equal(rapida.depth, "rapida");
  assert.deepEqual(rapida.self_check_controls, SC.SELF_CHECK_CONTROLS?.rapida);
  assert.deepEqual(selfCheck({ report: {}, kbExists: () => true, depth: "rapida" }).controls_run, SC.SELF_CHECK_CONTROLS?.rapida);
  const standard = deliberationDepth({ risk: "R1", shape: "libresco", precedent: "nessuno" });
  assert.deepEqual(standard.self_check_controls, SC.SELF_CHECK_CONTROLS?.full);
  assert.deepEqual(selfCheck({ report: {}, kbExists: () => true }).controls_run, SC.SELF_CHECK_CONTROLS?.full);
});

test("#5 self-check CLI senza --db → exit 1; la libreria senza kbExists non dà per esistenti i codici (controllo 1 fallito)", () => {
  const dir = mkdtempSync(join(tmpdir(), "fx5-"));
  const dbFile = join(dir, "knowledge.db");
  openDb(dbFile).close();
  const args = scFixture(dir, dbFile, "L.ACME.ADM.DEC.0001");
  const i = args.indexOf("--db");
  const r = node([SELF_CHECK, ...args.slice(0, i), ...args.slice(i + 2)]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(JSON.parse(r.stdout).error, /--db/);
  const lib = selfCheck({ report: { task_id: "T", status: "ok", output: { note: "vedi C.ACME.ADM.CFG.0019" } } });
  const f1 = lib.failed.find((f) => f.n === 1);
  assert.ok(f1, "senza verifica dei codici il controllo 1 non passa");
  assert.match(f1.reason, /non eseguit/);
  assert.equal(lib.blocked, true);
});
