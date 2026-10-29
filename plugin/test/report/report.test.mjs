// K6.6 — esiti (§29.9) e report (§29.8): errore atteso in NEG ⇒ EXPECTED-ERROR-AS-SUCCESS (Xray PASSED);
// ERROR-ENVIRONMENT mai un Defect; ABORTED-BY-POLICY senza lezione; RPT azione e test con codice dal DB.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import YAML from "yaml";
import Database from "../../scripts/kb/sqlite.mjs";
import { envWs, patchSession, writePlan, ROOT } from "../helpers/env-fixture.mjs";
import { cleanEnv } from "../helpers/hook-env.mjs";
import { demoPlan, PLAN } from "../helpers/k6-fixture.mjs";
import { classifyOutcome, toXrayStatus, OUTCOMES } from "../../scripts/report/outcome.mjs";
import { buildReport } from "../../scripts/report/build-report.mjs";
import { validateWith } from "../../scripts/lib/schemas.mjs";
import { selfCheck } from "../../scripts/decide/self-check.mjs";

const ERR = { code: "REQ-VAL-014", category: "validation", message: "Il centro di costo non è attivo per la società selezionata" };

test("tassonomia chiusa di §29.9", () => {
  assert.deepEqual(OUTCOMES, ["SUCCESS", "SUCCESS-WITH-ASSUMPTION", "EXPECTED-ERROR-AS-SUCCESS", "ERROR-AS-LESSON", "ERROR-BLOCKING", "ERROR-ENVIRONMENT", "PARTIAL", "ABORTED-BY-POLICY", "ABORTED-BY-USER"]);
});

test("errore atteso ricevuto in un test NEG ⇒ EXPECTED-ERROR-AS-SUCCESS, Xray PASSED, successo pieno", () => {
  const r = classifyOutcome({ expected: { error: { code: "REQ-VAL-014" } }, observed: {}, errors: [ERR], completed: true });
  assert.equal(r.outcome, "EXPECTED-ERROR-AS-SUCCESS");
  assert.equal(toXrayStatus(r.outcome), "PASSED");
  assert.equal(r.completion, true); assert.equal(r.defect, false);
  // l'errore atteso NON ricevuto è un fallimento del test
  const miss = classifyOutcome({ expected: { error: { code: "REQ-VAL-014" } }, observed: {}, errors: [], completed: true });
  assert.equal(miss.outcome, "ERROR-BLOCKING"); assert.equal(toXrayStatus(miss.outcome), "FAILED");
});

test("ERROR-ENVIRONMENT non propone mai un Defect; ABORTED-BY-POLICY non ha lezione", () => {
  const env = classifyOutcome({ errors: [{ category: "timeout", message: "ERP QAS non risponde" }], completed: false });
  assert.equal(env.outcome, "ERROR-ENVIRONMENT");
  assert.equal(env.defect, false);
  assert.notEqual(toXrayStatus(env.outcome), "FAILED");
  const pol = classifyOutcome({ policyAbort: true, errors: [ERR], completed: false });
  assert.equal(pol.outcome, "ABORTED-BY-POLICY");
  assert.equal(pol.lesson, false); assert.equal(pol.defect, false);
  assert.equal(classifyOutcome({ userAbort: true }).outcome, "ABORTED-BY-USER");
});

test("errori inattesi: capito e completato ⇒ ERROR-AS-LESSON (completamento sì, evento di apprendimento sì); non capito ⇒ ERROR-BLOCKING", () => {
  const l = classifyOutcome({ errors: [ERR], understoodError: true, completed: true, expected: { state: "DRAFT" }, observed: { state: "DRAFT" } });
  assert.equal(l.outcome, "ERROR-AS-LESSON");
  assert.equal(l.completion, true); assert.equal(l.learning_event, true); assert.equal(l.lesson, true);
  const b = classifyOutcome({ errors: [ERR], understoodError: false, completed: true });
  assert.equal(b.outcome, "ERROR-BLOCKING"); assert.equal(b.completion, false); assert.equal(b.defect, true);
  assert.equal(classifyOutcome({ expected: { state: "DRAFT" }, observed: { state: "DRAFT" }, completed: true }).outcome, "SUCCESS");
  assert.equal(classifyOutcome({ expected: { state: "DRAFT" }, observed: { state: "DRAFT" }, completed: true, assumption: "referente = utente corrente" }).outcome, "SUCCESS-WITH-ASSUMPTION");
  assert.equal(classifyOutcome({ completed: false }).outcome, "PARTIAL");
  assert.equal(classifyOutcome({ expected: { state: "PENDING_APPROVAL" }, observed: { state: "DRAFT" }, completed: true }).outcome, "ERROR-BLOCKING");
});

function reportWs() {
  const ws = envWs({ env: "sandbox", scope: "P2P" });
  const file = writePlan(ws, demoPlan(), "RUN.ACME.20260922.1100.ADM");
  patchSession(ws, (s) => { s.session_code = "SES.ACME.20260923.001"; s.mode = "ops"; s.budget.used = 41200; s.pending.compensations = [{ plan: PLAN, step: 3, kind: "cancel", entity: "requisition", action: "requisition.cancel", status: "pending" }]; });
  const wf = join(ws, "customers/ACME/.sessions/sess-1/workflow.jsonl");
  const ev = [
    { kind: "task_start", payload: { task: "RdA di prova", steps: [{ n: 1, agent: "p2p-expert", class: "ACT-OBS", desc: "apertura nuova richiesta" }, { n: 2, agent: "p2p-expert", class: "ACT-CREATE", desc: "compilazione, CdC IT-0442" }, { n: 3, agent: "p2p-expert", class: "ACT-CREATE", desc: "salvataggio in bozza" }] } },
    { kind: "step_end", payload: { n: 1, status: "ok", note: "pagina nuova richiesta", evidence: ["EV-01"] } },
    { kind: "step_end", payload: { n: 2, status: "ok", note: "5 sedie, CdC IT-0442", evidence: ["EV-02"] } },
    { kind: "step_end", payload: { n: 3, status: "ok", note: "NRT-20260923-B2C1-REQ-001 in bozza", evidence: ["EV-03"], compensation: "requisition.cancel" } },
  ].map((e, i) => JSON.stringify({ seq: i + 1, ts: `2026-09-23T10:4${i}:00.000Z`, ...e }));
  writeFileSync(wf, `${ev.join("\n")}\n`);
  return { ws, file };
}

test("build-report: RPT azione con codice RPT.<C>.<AAAAMMGG>.<SEQ> dal DB, markdown + YAML validato, esito classificato; SEQ successivo", async () => {
  const { ws, file } = reportWs();
  const r = await buildReport({ ws, sid: "sess-1", kind: "action", planFile: file, title: "Creazione RdA di prova in bozza", intent: "Su ACME sandbox crea una RdA di prova per 5 sedie da catalogo, CdC IT-0442, lasciala in bozza",
    expected: { state: "DRAFT" }, observed: { state: "DRAFT" }, now: new Date("2026-09-23T11:00:00Z") });
  assert.equal(r.code, "RPT.ACME.20260923.0001");
  assert.equal(r.outcome, "SUCCESS");
  const y = YAML.parse(readFileSync(join(ws, "customers/ACME/reports/RPT.ACME.20260923.0001.yaml"), "utf8"));
  const v = validateWith("rpt.schema.json", y);
  assert.ok(v.ok, v.errors?.join("; "));
  assert.equal(y.kind, "action"); assert.equal(y.execution.length, 3); assert.equal(y.entities[0].compensation, "requisition.cancel");
  const md = readFileSync(join(ws, "customers/ACME/reports/RPT.ACME.20260923.0001.md"), "utf8");
  assert.match(md, /^RPT\.ACME\.20260923\.0001 — Creazione RdA di prova in bozza/);
  assert.match(md, /Esito +SUCCESS/); assert.match(md, /Budget +41\.200 token/); assert.match(md, /sandbox/);
  const r2 = await buildReport({ ws, sid: "sess-1", kind: "action", planFile: file, title: "bis", expected: { state: "DRAFT" }, observed: { state: "DRAFT" }, now: new Date("2026-09-23T12:00:00Z") });
  assert.equal(r2.code, "RPT.ACME.20260923.0002");
  const db = new Database(join(ws, "customers/ACME/knowledge.db"), { readonly: true });
  assert.equal(db.prepare("select count(*) n from reports").get().n, 2);
  db.close();
  // self-check #11 accetta il codice RPT del report
  const sc = selfCheck({ report: { task_id: "T", status: "ok", output: { actions: ["x"], report: r.code } }, session: {}, kbExists: (c) => c === r.code, depth: "rapida" });
  assert.ok(!sc.failed.some((f) => f.n === 11), JSON.stringify(sc.failed));
});

test("build-report: RPT di test (NEG con errore atteso) e CLI", async () => {
  const { ws, file } = reportWs();
  const r = await buildReport({ ws, sid: "sess-1", kind: "test", planFile: file, title: "NEG CdC non attivo", run: "RUN.ACME.20260922.1100.ADM", release: "R25.3",
    expected: { error: { code: "REQ-VAL-014" } }, errors: [ERR], now: new Date("2026-09-23T11:00:00Z") });
  assert.equal(r.outcome, "EXPECTED-ERROR-AS-SUCCESS");
  const y = YAML.parse(readFileSync(join(ws, `customers/ACME/reports/${r.code}.yaml`), "utf8"));
  assert.ok(validateWith("rpt.schema.json", y).ok);
  assert.equal(y.xray.status, "PASSED"); assert.equal(y.results.expected_errors_received, 1);
  mkdirSync(join(ws, "x"), { recursive: true });
  const cli = spawnSync(process.execPath, [join(ROOT, "scripts/report/build-report.mjs"), "--kind", "action", "--plan", file, "--title", "da CLI", "--json"], { encoding: "utf8", env: cleanEnv({ JVC_WORKSPACE: ws, JVC_SESSION_ID: "sess-1" }) });
  assert.equal(cli.status, 0, cli.stdout + cli.stderr);
  assert.match(JSON.parse(cli.stdout).code, /^RPT\.ACME\.\d{8}\.\d{4}$/);
  assert.equal(spawnSync(process.execPath, [join(ROOT, "scripts/report/build-report.mjs"), "--kind", "boh", "--json"], { encoding: "utf8", env: cleanEnv({ JVC_WORKSPACE: ws, JVC_SESSION_ID: "sess-1" }) }).status, 1);
});
