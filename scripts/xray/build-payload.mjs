// xray build-payload (§27.5, §29.8, §29.9, ADR-19/20/21/34): dal dossier del run al payload nativo di Xray.
//
//   UNA Test Execution per run E per scope (lo scope del caso è nel codice NRT.<C>.<SCOPE>.…); Test Plan dello scope da
//   config/xray.yaml (test_plan_by_scope). Per ogni caso di runs/<RUN>/cases/<caso>/:
//   - Test Xray: alm.test_key del caso (customers/<C>/tests/cases/<SCOPE>/<caso>.yaml) o dagli esiti espliciti; senza
//     chiave il caso NON si pubblica (ADR-21: nessuna Test issue creata), salvo allow_test_issue_creation: true
//     (allora testInfo);
//   - esito (§29.9): esplicito (--outcomes <file.yaml> o caso=ESITO[@passo] posizionali) › RPT di test del run e del
//     piano (tabella reports del DB) › esito del piano (results/<plan_id>.yaml: green ⇒ SUCCESS); altrimenti non
//     classificato ⇒ TODO con avviso;
//   - stato Xray con toXrayStatus: EXPECTED-ERROR-AS-SUCCESS ⇒ PASSED; ERROR-ENVIRONMENT ⇒ statuses.error_environment
//     (ABORTED o TODO), MAI FAILED e mai un Defect; ERROR-BLOCKING ⇒ FAILED (Defect proposto);
//   - passi dal piano: prima del passo del fallimento PASSED, il passo del fallimento con lo stato del test, dopo TODO;
//   - evidenze (DT-009, evidence/select.mjs): solo il sink xray (pubblicabili, profilo strict, al più attachments_cap per
//     caso, i failure per primi), SUL PASSO (steps[n-1].evidence), citate per file (materializzate all'invio).
//   Scrive customers/<C>/runs/<RUN>/xray-payload.json: { run, customer, generated_at, executions: { <SCOPE>: { execution,
//   results, cases[], defects_suggested[] } }, skipped[], warnings[] }.
//
// CLI: node scripts/xray/build-payload.mjs --run <RUN> [--scope S] [--outcomes <file.yaml>] [caso=ESITO[@passo]…]
//      [--customer C] [--workspace <dir>] [--json]
// Exit: 0 ok · 1 argomenti o configurazione · 2 errore di sistema.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve as resolvePath, extname } from "node:path";
import YAML from "yaml";
import { parseArgs } from "../lib/args.mjs";
import { isMain } from "../lib/is-main.mjs";
import { runRefusal } from "../lib/run-code.mjs";
import { writeFileAtomic } from "../../hooks/lib/fsx.mjs";
import { OUTCOMES, toXrayStatus } from "../report/outcome.mjs";
import { selectEvidence } from "../evidence/select.mjs";
import { contentTypeOf } from "../../mcp/alm-server/payload.mjs";
import { payloadFile } from "../../mcp/alm-server/queue.mjs";
import { strictText, ISSUE_KEY } from "../../mcp/alm-server/adapter.mjs";
import { loadXrayConfig } from "../../mcp/alm-server/factory.mjs";
import { XrayError, failWith, kv } from "./common.mjs";
import { workspaceCustomer } from "../run/fixtures.mjs";
import { confineInputs } from "../lib/text-file.mjs";

const CASE_RE = /^NRT\.([A-Z0-9]{3,4})\.([A-Z0-9]{3})\.[A-Z]{3}\.\d{4}$/;
const readYaml = (f) => { try { return YAML.parse(readFileSync(f, "utf8")); } catch { return null; } };
const readJson = (f) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return null; } };

// Esiti espliciti: { caso: "ESITO" | { outcome, step?, test_key?, reason? } } da file o da caso=ESITO[@passo].
export function parseOutcomes({ file = null, pairs = {} } = {}) {
  const out = {};
  const add = (c, v) => {
    if (!CASE_RE.test(c)) throw new XrayError(1, `caso non valido negli esiti: ${c}`);
    const o = typeof v === "string" ? { outcome: v } : v && typeof v === "object" ? { ...v } : null;
    if (!o) throw new XrayError(1, `esito non valido per ${c}`);
    if (typeof o.outcome === "string" && o.outcome.includes("@")) { const [x, s] = o.outcome.split("@"); o.outcome = x; o.step = Number(s); }
    if (o.outcome != null && !OUTCOMES.includes(o.outcome)) throw new XrayError(1, `esito ${o.outcome} fuori dalla tassonomia di §29.9 (${OUTCOMES.join(", ")})`);
    if (o.step != null && !(Number.isInteger(Number(o.step)) && Number(o.step) > 0)) throw new XrayError(1, `passo non valido per ${c}: ${o.step}`);
    if (o.test_key != null && !ISSUE_KEY.test(o.test_key)) throw new XrayError(1, `test_key non valida per ${c}: ${o.test_key}`);
    out[c] = { ...o, ...(o.step != null ? { step: Number(o.step) } : {}) };
  };
  if (file) {
    const doc = readYaml(file);
    if (!doc || typeof doc !== "object") throw new XrayError(1, `file degli esiti illeggibile: ${file}`);
    for (const [c, v] of Object.entries(doc.outcomes ?? doc)) add(c, v);
  }
  for (const [c, v] of Object.entries(pairs)) add(c, v);
  return out;
}

function caseFile(ws, customer, scope, caseId) {
  const f = join(ws, "customers", customer, "tests", "cases", scope, `${caseId}.yaml`);
  return existsSync(f) ? readYaml(f) : null;
}

async function reportOutcomes(ws, customer, run) {
  const f = join(ws, "customers", customer, "knowledge.db");
  if (!existsSync(f)) return new Map();
  try {
    const { openDb } = await import("../kb/db.mjs");
    const db = openDb(f);
    try {
      const rows = db.prepare("select plan, outcome, code, created_at from reports where kind = 'test' and run = ? order by created_at").all(run);
      return new Map(rows.filter((r) => r.plan).map((r) => [r.plan, { outcome: r.outcome, report: r.code }]));
    } finally { db.close(); }
  } catch { return new Map(); }
}

// Primo passo divergente del piano nei checkpoint del run (sorpresa, stop o divergenze).
function failingStepFromCheckpoints(runDir, planId) {
  const d = join(runDir, "checkpoints");
  if (!existsSync(d)) return null;
  const bad = readdirSync(d).filter((f) => /^\d+\.json$/.test(f)).map((f) => readJson(join(d, f)))
    .filter((c) => c?.plan_id === planId && (c.stop || c.status === "surprise" || (c.divergences ?? []).length)).map((c) => c.step).filter(Number.isInteger);
  return bad.length ? Math.min(...bad) : null;
}

export async function buildPayload(ws, { customer, run, scope = null, outcomes = {}, config = null, now = new Date() }) {
  const bad = runRefusal(ws, customer, run);
  if (bad) throw new XrayError(1, bad);
  const cfg = config ?? await loadXrayConfig(ws, customer);
  const runDir = join(ws, "customers", customer, "runs", run);
  const casesDir = join(runDir, "cases");
  if (!existsSync(casesDir)) throw new XrayError(1, `nessun caso nel run: runs/${run}/cases/ assente`);
  const selection = selectEvidence(ws, { customer, run, xrayCap: cfg.attachments_cap ?? 5 });
  const fromDb = await reportOutcomes(ws, customer, run);
  const warnings = [];
  const skipped = [];
  const executions = {};
  const cases = readdirSync(casesDir, { withFileTypes: true }).filter((d) => d.isDirectory() && CASE_RE.test(d.name)).map((d) => d.name).sort();
  for (const c of readdirSync(casesDir, { withFileTypes: true }).filter((d) => d.isDirectory() && !CASE_RE.test(d.name))) warnings.push(`cartella non riconosciuta come caso NRT: cases/${c.name}`);
  for (const caseId of cases) {
    const S = CASE_RE.exec(caseId)[2];
    if (scope && S !== scope) continue;
    const plan = readJson(join(casesDir, caseId, "plan.json"));
    const steps = Array.isArray(plan?.steps) ? plan.steps : [];
    const def = caseFile(ws, customer, S, caseId);
    const exp = outcomes[caseId] ?? {};
    const testKey = exp.test_key ?? def?.alm?.test_key ?? null;
    let testInfo = null;
    if (!testKey) {
      if (cfg.allow_test_issue_creation !== true) { skipped.push({ case: caseId, reason: "senza alm.test_key: il plugin non crea Test issue (ADR-21); collegare il caso a un Test esistente" }); continue; }
      testInfo = { summary: strictText(def?.title ?? caseId).slice(0, 250), type: "Manual", projectKey: cfg.project, labels: [`scope:${S}`, "nrt"], steps: steps.map((s) => ({ action: `${s.verb ?? ""} ${s.note ?? s.target ?? ""}`.trim() || `passo ${s.n}` })) };
    }
    // esito
    let outcome = exp.outcome ?? null; let source = outcome ? "esplicito" : null; let reason = exp.reason ?? null;
    if (!outcome && plan?.plan_id && fromDb.has(plan.plan_id)) { outcome = fromDb.get(plan.plan_id).outcome; source = `RPT ${fromDb.get(plan.plan_id).report}`; }
    if (!outcome && plan?.plan_id) {
      const r = readYaml(join(runDir, "results", `${plan.plan_id}.yaml`));
      if (String(r?.status ?? "").toLowerCase() === "green") { outcome = "SUCCESS"; source = "results (green)"; }
      else if (r?.status) warnings.push(`${caseId}: esito del piano ${r.status} non classificato (build-report --kind test o --outcomes): pubblicato come TODO`);
    }
    if (!outcome) { source = source ?? "nessuno"; if (!plan?.plan_id) warnings.push(`${caseId}: plan.json assente o senza plan_id`); }
    const status = !outcome ? "TODO" : outcome === "ERROR-ENVIRONMENT" ? (cfg.statuses?.error_environment ?? "ABORTED") : toXrayStatus(outcome);
    if (status === "FAILED" && outcome === "ERROR-ENVIRONMENT") throw new XrayError(2, "invariante violata: ERROR-ENVIRONMENT mai FAILED");
    // passo del fallimento
    const ev = selection.cases[caseId]?.xray ?? [];
    const failing = status === "PASSED" || status === "TODO" ? null : exp.step ?? ev.find((e) => e.kind === "failure" && Number.isInteger(e.step))?.step ?? failingStepFromCheckpoints(runDir, plan?.plan_id) ?? null;
    const n = Math.max(steps.length, ...ev.map((e) => (Number.isInteger(e.step) ? e.step : 0)));
    const stepResults = Array.from({ length: n }, (_, i) => ({ status: status === "PASSED" ? "PASSED" : status === "TODO" || failing == null ? "TODO" : i + 1 < failing ? "PASSED" : i + 1 === failing ? status : "TODO" }));
    const testLevel = [];
    for (const e of ev) {
      const item = { file: e.file, filename: `${e.id}${extname(e.file)}`, contentType: contentTypeOf(e.file) };
      if (Number.isInteger(e.step) && e.step >= 1 && e.step <= n) (stepResults[e.step - 1].evidence ??= []).push(item);
      else testLevel.push(item);
    }
    if (status !== "PASSED" && status !== "TODO" && failing == null) warnings.push(`${caseId}: ${status} senza passo del fallimento determinabile: passi TODO`);
    const comment = strictText(`${outcome ?? "non classificato"}${reason ? ` — ${reason}` : ""} (esito: ${source})`).slice(0, 500);
    const test = { ...(testKey ? { testKey } : { testInfo }), status, comment, ...(stepResults.length ? { steps: stepResults } : {}), ...(testLevel.length ? { evidence: testLevel } : {}) };
    const x = (executions[S] ??= { execution: null, results: null, cases: [], defects_suggested: [], _tests: [] });
    x._tests.push(test);
    x.cases.push({ case: caseId, plan_id: plan?.plan_id ?? null, test_key: testKey, outcome, source, status, failing_step: failing, evidence: ev.length });
    if (outcome === "ERROR-BLOCKING") x.defects_suggested.push({ case: caseId, step: failing, test_key: testKey });
  }
  for (const [S, x] of Object.entries(executions)) {
    const testPlanKey = cfg.test_plan_by_scope?.[S] ?? null;
    if (!testPlanKey) warnings.push(`scope ${S}: nessun Test Plan in test_plan_by_scope (config/xray.yaml)`);
    const summary = `${run} — scope ${S}`;
    const description = `Run NRT ${run}, scope ${S}: ${x.cases.length} casi (pass ${x.cases.filter((c) => c.status === "PASSED").length} · fail ${x.cases.filter((c) => c.status === "FAILED").length} · altri ${x.cases.filter((c) => !["PASSED", "FAILED"].includes(c.status)).length}). Dossier: customers/${customer}/runs/${run}/`;
    x.execution = { summary, scope: S, run, project: cfg.project ?? null, testPlanKey, description };
    x.results = { info: { ...(cfg.project ? { project: cfg.project } : {}), summary, description, ...(testPlanKey ? { testPlanKey } : {}), labels: [`scope:${S}`] }, tests: x._tests };
    delete x._tests;
  }
  const doc = { run, customer, generated_at: now.toISOString(), executions, skipped, warnings };
  writeFileAtomic(payloadFile(ws, customer, run), `${JSON.stringify(doc, null, 2)}\n`);
  return { file: `runs/${run}/xray-payload.json`, ...doc };
}

export function summary(doc) {
  return Object.entries(doc.executions).map(([S, x]) => ({ scope: S, testPlanKey: x.execution.testPlanKey, tests: x.results.tests.length,
    statuses: x.results.tests.reduce((m, t) => ({ ...m, [t.status]: (m[t.status] ?? 0) + 1 }), {}),
    evidence: x.results.tests.reduce((n, t) => n + (t.evidence?.length ?? 0) + (t.steps ?? []).reduce((k, s) => k + (s.evidence?.length ?? 0), 0), 0), defects_suggested: x.defects_suggested.length }));
}

const HELP = `uso: node scripts/xray/build-payload.mjs --run <RUN> [--scope S] [--outcomes <file.yaml>] [caso=ESITO[@passo]…]
       [--customer C] [--workspace <dir>] [--json] [--help]

Payload nativo di Xray dal dossier del run: una Test Execution per run e per scope, stati da §29.9 (errore atteso ⇒
PASSED; ERROR-ENVIRONMENT ⇒ ABORTED/TODO, mai FAILED), evidenze DT-009 strict sul passo. Scrive
customers/<C>/runs/<RUN>/xray-payload.json. Esiti espliciti: file YAML { <caso>: ESITO | { outcome, step, test_key } }
o posizionali NRT.<C>.<S>.<G>.<SEQ>=ESITO[@passo].

Exit code: 0 ok · 1 argomenti o configurazione · 2 errore di sistema.`;

export async function run(argv, env = process.env) {
  const { opts, positional } = parseArgs(argv);
  const asJson = !!opts.json;
  if (opts.help) { console.log(HELP); return 0; }
  { const bad = confineInputs(opts, ["outcomes"], { env }); if (bad) return failWith(asJson, new XrayError(1, bad)); }
  try {
    if (!opts.run) throw new XrayError(1, "richiesto --run <RUN>");
    const { ws, customer } = workspaceCustomer(opts, env);
    if (!customer) throw new XrayError(1, "cliente non determinato: --customer <C> o una sessione attiva");
    const outcomes = parseOutcomes({ file: opts.outcomes ? resolvePath(ws, opts.outcomes) : null, pairs: kv(positional) });
    const doc = await buildPayload(ws, { customer, run: opts.run, scope: opts.scope ?? null, outcomes });
    const s = summary(doc);
    console.log(asJson ? JSON.stringify({ ok: true, file: doc.file, executions: s, skipped: doc.skipped, warnings: doc.warnings })
      : [`${doc.file}`, ...s.map((x) => `  ${x.scope}: ${x.tests} test (${Object.entries(x.statuses).map(([k, v]) => `${k} ${v}`).join(" · ")}), ${x.evidence} evidenze sul passo, piano ${x.testPlanKey ?? "—"}`),
        ...doc.skipped.map((x) => `  saltato ${x.case}: ${x.reason}`), ...doc.warnings.map((w) => `  avviso: ${w}`)].join("\n"));
    return 0;
  } catch (err) { return failWith(asJson, err); }
}

// exitCode, non process.exit: su Windows (Node 24) process.exit dopo più fetch termina il processo con 0xC0000409
if (isMain(import.meta.url)) run(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (e) => { console.error(e); process.exitCode = 2; });
