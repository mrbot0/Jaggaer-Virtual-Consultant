// WP10b PARTE 1 — giro di correzione 1 (revisione .superpowers/sdd/wp10b-review-part1.md, ruling del controller):
// I1 numeri negli input nome=valore di dt-eval; I2 cartella di scrittura dedotta da --db solo per customers/<C> del
// cliente dichiarato; I3 validateReport giudica `passed` sull'insieme di controlli della profondità dichiarata;
// minori: --text-file di deontic, --summary-file di defect, prefisso del tipo di agente per cross_read, schema di
// cross_read più stretto.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseKeyValues } from "../../scripts/decide/dt-eval.mjs";
import { openDb } from "../../scripts/kb/db.mjs";
import { validateReport } from "../../scripts/admin/agent-report.mjs";
import { controlsFor, reportedControlsFor } from "../../scripts/decide/self-check-controls.mjs";
import { validateSession } from "../../scripts/admin/session.mjs";
import { mkWs, seedSession, runHook, runSessionCli, decisionOf, ROOT, cleanEnv } from "../helpers/hook-env.mjs";

const node = (script, args, opts = {}) => spawnSync(process.execPath, [join(ROOT, script), ...args], { encoding: "utf8", timeout: 30000, ...opts });
const tmp = () => realpathSync.native(mkdtempSync(join(tmpdir(), "jvc-fr1-")));

// ---- I1 ----

test("I1 parseKeyValues: interi, decimali e negativi diventano numeri; 'd', '1e3', testo restano testo; true/false/null tipizzati", () => {
  assert.deepEqual(parseKeyValues(["a=5", "b=0.3", "c=-2", "d=-0.25", "e=d", "f=1e3", "g=R2", "h=true", "i=false", "j=null", "k=5.", "l=.5"]),
    { a: 5, b: 0.3, c: -2, d: -0.25, e: "d", f: "1e3", g: "R2", h: true, i: false, j: null, k: "5.", l: ".5" });
  assert.throws(() => parseKeyValues(["senza-uguale"]), /nome=valore/);
});

test("I1 CLI: una tabella con input a intervallo (DT-022, DT-010) dà lo stesso esito con nome=valore e con --inputs", () => {
  const d = tmp();
  const cases = [
    ["DT-022", { coverage_deficit: 0.2, r2_critical_missing: false, critical_missing: false, below_type_threshold: false }],
    ["DT-010", { portability_class: "condizionata", p_value: 0.9, quality_class: "affidabile", p_ge_08: true, open_product_ctr: false }],
  ];
  for (const [table, inputs] of cases) {
    const f = join(d, `${table}.json`);
    writeFileSync(f, JSON.stringify(inputs));
    const a = node("scripts/decide/dt-eval.mjs", ["--table", table, ...Object.entries(inputs).map(([k, v]) => `${k}=${v}`), "--json"]);
    const b = node("scripts/decide/dt-eval.mjs", ["--table", table, "--inputs", f, "--json"], { env: cleanEnv({ JVC_WORKSPACE: d }) });
    assert.equal(a.status, 0, `${table}: ${a.stdout}${a.stderr}`);
    assert.equal(b.status, 0, `${table}: ${b.stdout}${b.stderr}`);
    const ja = JSON.parse(a.stdout); const jb = JSON.parse(b.stdout);
    assert.equal(ja.outcome, jb.outcome, table);
    assert.equal(ja.score, jb.score, table);
  }
});

// ---- I2 ----

test("I2 --write-dec: la cartella si deduce da --db solo se è customers/<C> del --customer dichiarato; altrimenti --root obbligatorio (exit 1), niente DEC in product/", () => {
  const ws = tmp();
  for (const dir of ["product", "customers/ACME", "customers/ACME/kb", "customers/BETA"]) { mkdirSync(join(ws, dir), { recursive: true }); openDb(join(ws, dir, "knowledge.db")).close(); }
  const args = (db, customer = "ACME") => ["--table", "DT-002", "risk=R1", "shape=consolidato", "mandatory_missing=false", "open_contradiction=false", "novelty=false",
    "--customer", customer, "--scope", "CAT", "--db", db, "--write-dec", "--json"];
  for (const db of ["product/knowledge.db", "customers/ACME/kb/knowledge.db", "customers/BETA/knowledge.db"]) {
    const r = node("scripts/decide/dt-eval.mjs", args(db), { cwd: ws });
    assert.equal(r.status, 1, `${db}: ${r.stdout}`);
  }
  assert.ok(!existsSync(join(ws, "product", "decisions")), "nessuna DEC in product/");
  const ok = node("scripts/decide/dt-eval.mjs", args("customers/ACME/knowledge.db", "acme".toUpperCase()), { cwd: ws });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.ok(existsSync(join(ws, "customers/ACME/decisions", `${JSON.parse(ok.stdout).dec_code}.yaml`)));
  // learn validate e kb cluster: stessa regola
  assert.equal(node("scripts/digest/learn.mjs", ["validate", "--db", "product/knowledge.db", "--json"], { cwd: ws }).status, 1);
  assert.equal(node("scripts/digest/learn.mjs", ["validate", "--db", "customers/ACME/knowledge.db", "--json"], { cwd: ws }).status, 1, "senza --customer");
  assert.equal(node("scripts/digest/learn.mjs", ["validate", "--db", "customers/ACME/knowledge.db", "--customer", "ACME", "--json"], { cwd: ws }).status, 0);
});

test("I2 un sub-agente non mette una DEC in product/: senza --root lo script rifiuta, con --root product il guard nega", () => {
  const ws = mkWs(); seedSession(ws);
  const run = (command) => runHook("guard-scope", { session_id: "sess-1", cwd: ws, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, agent_type: "scope-expert", agent_id: "a1" }, { JVC_WORKSPACE: ws, CLAUDE_PLUGIN_ROOT: ROOT });
  assert.equal(decisionOf(run(`node "${ROOT}/scripts/decide/dt-eval.mjs" --table DT-002 risk=R1 --customer ACME --scope CAT --db product/knowledge.db --root product --write-dec --json`)), "deny");
});

// ---- I3 ----

const report = (depth, passed, failed = []) => ({
  task_id: "MSG.SES.ACME.20260929.001.0001", status: "ok", output: {},
  cognitive_trace: { depth, recalled: { semantic: ["C.ACME.CAT.FLW.0001"], episodic: [], working: [] }, epistemic: { subject: "C.ACME.CAT.FLW.0001", shape_before: "consolidato", shape_after: "consolidato" },
    strategy: "STR-REPLAY", hypotheses: null, decisions: [], surprises: [], self_check: { passed, failed } },
  lesson: "L.ACME.CAT.LSN.0001", why: {}, usage: { model: "haiku" }, needs_input: null, open_questions: [],
});

test("I3 validateReport: `passed` giudicato sull'insieme della profondità (rapida 1, 3, 9, 11 = 4; standard/profonda 10); failed non vuoto ⇒ partial", () => {
  assert.deepEqual(reportedControlsFor("rapida"), [1, 3, 9, 11]);
  assert.equal(reportedControlsFor("standard").length, 10);
  assert.deepEqual(controlsFor("rapida"), [1, 3, 9, 11]);
  assert.equal(validateReport(report("rapida", 4)).status_effective, "ok");
  assert.equal(validateReport(report("rapida", 3)).status_effective, "partial");
  assert.equal(validateReport(report("rapida", 4, [9])).status_effective, "partial");
  assert.equal(validateReport(report("standard", 10)).status_effective, "ok");
  assert.equal(validateReport(report("profonda", 9)).status_effective, "partial");
  assert.equal(validateReport(report("standard", 4)).status_effective, "partial", "4/10 a profondità standard");
});

// ---- minori ----

test("minore 1: deontic --text-file legge la frase da un file (testo non fidato fuori dalla riga di comando)", () => {
  const d = tmp();
  const f = join(d, "frase.txt");
  writeFileSync(f, 'Il campo "Centro di costo" è obbligatorio $HOME `x` salvo per il buyer.\n');
  // WP10b parte 2: il file sta nel workspace (--workspace), come per gli altri --text-file
  const a = node("scripts/ingest/deontic.mjs", ["--text-file", f, "--workspace", d, "--lang", "it", "--json"], { env: cleanEnv({ JVC_WORKSPACE: d }) });
  assert.equal(a.status, 0, a.stdout + a.stderr);
  assert.equal(JSON.parse(a.stdout).ok, true);
  assert.equal(node("scripts/ingest/deontic.mjs", ["--text-file", join(d, "manca.txt"), "--workspace", d, "--json"], { env: cleanEnv({ JVC_WORKSPACE: d }) }).status, 1);
});

test("minore 1: defect --summary-file prende il summary da un file (vince su summary=), file illeggibile ⇒ errore", async () => {
  const { loadFinding } = await import("../../scripts/xray/defect.mjs");
  const d = tmp();
  writeFileSync(join(d, "summary.txt"), 'Import accetta "codici" duplicati $X\n');
  const f = loadFinding({ "summary-file": "summary.txt" }, ["case=NRT.ACME.CAT.NEG.0031", "run=RUN.ACME.20260929.1015.CAT", "step=4"], d);
  assert.equal(f.summary, 'Import accetta "codici" duplicati $X');
  assert.equal(f.case, "NRT.ACME.CAT.NEG.0031");
  assert.throws(() => loadFinding({ "summary-file": "manca.txt" }, [], d), /summary/);
  assert.match(node("scripts/xray/defect.mjs", ["--help"]).stdout, /--summary-file/);
});

test("minore 3: il permesso cross_read vale solo per il tipo del plugin (con o senza prefisso), non per un agente omonimo di un altro plugin", () => {
  const ws = mkWs(); seedSession(ws);
  mkdirSync(join(ws, "product/kb/scopes/ADM"), { recursive: true });
  assert.equal(runSessionCli(["use", "paths", "--agent", "process-mapper", "--grant", "--session", "sess-1", "--workspace", ws, "--json"], { CLAUDECODE: "1" }).status, 0);
  const read = (agent_type) => runHook("guard-scope", { session_id: "sess-1", cwd: ws, hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: join(ws, "product/kb/scopes/ADM/x.yaml") }, agent_type, agent_id: "pm" }, { JVC_WORKSPACE: ws, CLAUDE_PLUGIN_ROOT: ROOT });
  assert.equal(decisionOf(read("process-mapper")), null);
  assert.equal(decisionOf(read("jaggaer-virtual-consultant:process-mapper")), null);
  assert.equal(decisionOf(read("altro-plugin:process-mapper")), "deny");
});

test("minore 4: schema cross_read — nessuna chiave in più, date-time, analysis/ esclusa anche in maiuscolo", () => {
  const ws = mkWs();
  const s = JSON.parse(readFileSync(seedSession(ws), "utf8"));
  const now = new Date();
  const entry = { mode: "read", allowed_paths: ["product/kb/scopes/**"], granted_at: now.toISOString(), expires_at: new Date(+now + 3600e3).toISOString(), granted_by: "main-session" };
  const v = (e) => validateSession({ ...s, cross_read: { "process-mapper": e } }).ok;
  assert.equal(v(entry), true);
  assert.equal(v({ ...entry, write: true }), false, "chiave in più");
  assert.equal(v({ ...entry, expires_at: "domani" }), false, "date-time");
  assert.equal(v({ ...entry, allowed_paths: ["customers/ACME/ANALYSIS/**"] }), false, "analysis in maiuscolo");
});
