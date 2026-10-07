// K5.4 — catalogo delle azioni (§29.4) e validazione dei piani (§52.1 strato 2):
// 15 classi ACT come item di product/kb/actions; un piano con una classe fuori
// catalogo o ACT-DELETE in prod è invalido (scritture in prod con approvazione:
// spec 2026-10-06 §3.3).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import YAML from "yaml";
import { validateItem } from "../../scripts/kb/validate-schema.mjs";
import { reindex } from "../../scripts/kb/reindex.mjs";
import { openDb } from "../../scripts/kb/db.mjs";
import { loadCatalog, validatePlan } from "../../scripts/decide/validate-plan.mjs";
import { ROOT, cleanEnv } from "../helpers/hook-env.mjs";

const DIR = join(ROOT, "product/kb/actions");
const EXPECTED = ["ACT-OBS", "ACT-READ", "ACT-QRY", "ACT-CREATE", "ACT-UPDATE", "ACT-UPLOAD", "ACT-SUBMIT", "ACT-APPROVE", "ACT-TRANSMIT",
  "ACT-CLOSE", "ACT-PUBLISH", "ACT-CFG-READ", "ACT-CFG-CHANGE", "ACT-BULK", "ACT-DELETE"];
const ENV = { sandbox: { id: "sandbox", type: "sandbox" }, preprod: { id: "preprod", type: "preprod" }, prod: { id: "prod", type: "prod" } };

const step = (n, verb, action_class, extra = {}) => ({ n, verb, action_class, expect: { page_sig: "x" }, ...(verb === "NAVIGATE" || verb === "READ" || verb === "CLICK" || verb === "FILL" || verb === "SAVE" || verb === "SUBMIT" || verb === "TOGGLE" ? { target: "S.STD.P2P.SEL.0001" } : {}), ...extra });
const plan = (env, steps, extra = {}) => ({ plan_id: "PLAN.0042", customer: "ACME", env, goal: "prova", steps, repair_policy: { skip_allowed: [], substitute_allowed: [], abort_on: [] }, ...extra });

test("15 file S.STD.XSC.ACT.00nn (nome file = id), uno per classe di §29.4, tutti validi per validate-schema", () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith(".yaml")).sort();
  assert.equal(files.length, 15);
  const codes = [];
  for (const f of files) {
    const it = YAML.parse(readFileSync(join(DIR, f), "utf8"));
    assert.equal(`${it.id}.yaml`, f, "il codice è il nome del file");
    assert.match(it.id, /^S\.STD\.XSC\.ACT\.00\d\d$/);
    assert.equal(it.type, "ACT");
    const r = validateItem(it);
    assert.deepEqual(r.errors, [], f);
    codes.push(it.code);
  }
  assert.deepEqual([...codes].sort(), [...EXPECTED].sort());
});

test("act.schema: un ACT senza campi di §29.4 o con valori fuori vocabolario è rifiutato", () => {
  const it = YAML.parse(readFileSync(join(DIR, readdirSync(DIR).find((f) => f.endsWith(".yaml"))), "utf8"));
  for (const k of ["code", "risk", "environments", "approvals", "evidence_min", "report_kind", "db_writes", "budget_tokens", "verbs_allowed", "effect"]) {
    const bad = structuredClone(it); delete bad[k];
    assert.equal(validateItem(bad).ok, false, `senza ${k}`);
  }
  assert.equal(validateItem({ ...structuredClone(it), environments: { ...it.environments, prod: "forse" } }).ok, false);
  assert.equal(validateItem({ ...structuredClone(it), effect: "delete" }).ok, false);
  assert.equal(validateItem({ ...structuredClone(it), code: "ACT-obs" }).ok, false);
  assert.equal(validateItem({ ...structuredClone(it), verbs_allowed: ["DELETE"] }).ok, false, "DELETE appartiene solo ad ACT-DELETE");
  assert.equal(validateItem({ ...structuredClone(it), verbs_allowed: ["TELEPORT"] }).ok, false, "verbo fuori vocabolario");
});

test("act.schema (difesa in profondità): una classe con effect write non può essere libera in produzione (solo approval o never)", () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith(".yaml"));
  const items = files.map((f) => YAML.parse(readFileSync(join(DIR, f), "utf8")));
  const create = items.find((i) => i.code === "ACT-CREATE");
  assert.equal(create.effect, "write");
  assert.equal(validateItem(structuredClone(create)).ok, true);
  for (const prod of ["allowed", "referent", "3A"]) {
    const bad = structuredClone(create); bad.environments.prod = prod;
    assert.equal(validateItem(bad).ok, false, `un effect write con prod ${prod} non passa la validazione`);
  }
  const never = structuredClone(create); never.environments.prod = "never";
  assert.equal(validateItem(never).ok, true);
  for (const i of items.filter((x) => x.effect === "write")) assert.ok(["approval", "never"].includes(i.environments.prod), i.code);
  const read = structuredClone(items.find((i) => i.code === "ACT-OBS"));
  assert.equal(read.environments.prod, "allowed");
  assert.equal(validateItem(read).ok, true, "le letture restano libere in produzione");
});

test("catalogo: produzione = letture libere, scritture e configurazione con approvazione, ACT-DELETE mai (spec 2026-10-06 §3.3)", () => {
  const cat = loadCatalog();
  assert.equal(cat.size, 15);
  const prodAllowed = [...cat.values()].filter((a) => a.environments.prod === "allowed").map((a) => a.code).sort();
  assert.deepEqual(prodAllowed, ["ACT-CFG-READ", "ACT-OBS", "ACT-QRY", "ACT-READ"]);
  const prodApproval = [...cat.values()].filter((a) => a.environments.prod === "approval").map((a) => a.code).sort();
  assert.deepEqual(prodApproval, ["ACT-APPROVE", "ACT-BULK", "ACT-CFG-CHANGE", "ACT-CLOSE", "ACT-CREATE", "ACT-PUBLISH", "ACT-SUBMIT", "ACT-TRANSMIT", "ACT-UPDATE", "ACT-UPLOAD"]);
  assert.deepEqual([...cat.values()].filter((a) => a.environments.prod === "never").map((a) => a.code), ["ACT-DELETE"]);
  assert.equal(cat.get("ACT-CFG-CHANGE").approvals.prod, 3);
  assert.equal(cat.get("ACT-BULK").approvals.prod, 3);
  const del = cat.get("ACT-DELETE");
  assert.deepEqual(del.environments, { sandbox: "approval", preprod: "approval", prod: "never" });
  assert.equal(del.risk, "R3");
  assert.deepEqual(del.verbs_allowed, ["DELETE", "CLICK", "READ", "VERIFY", "CAPTURE", "WAIT", "NAVIGATE"]);
  assert.equal(cat.get("ACT-BULK").environments.preprod, "approval");
  assert.equal(cat.get("ACT-APPROVE").environments.preprod, "referent");
});

test("reindex accetta gli ACT di product/kb", () => {
  const db = join(mkdtempSync(join(tmpdir(), "act-")), "k.db");
  const stats = reindex(join(ROOT, "product"), db, { clustersDir: null });
  assert.equal(stats.invalid, 0);
  const d = openDb(db);
  assert.equal(d.prepare("select count(*) n from items where type='ACT'").get().n, 15);
  d.close();
});

test("validatePlan: env prod + ACT-CREATE → valido con avviso di approvazione (spec 2026-10-06 §3.3); ACT-DELETE in prod invalido", () => {
  const p = plan("prod", [step(1, "NAVIGATE", "ACT-OBS"), step(2, "FILL", "ACT-CREATE", { data: "x" }), step(3, "SAVE", "ACT-CREATE")]);
  const r = validatePlan(p, { env: ENV.prod });
  assert.deepEqual(r.errors, []);
  assert.ok(r.warnings.some((w) => /ACT-CREATE/.test(w) && /approvazione/.test(w)), r.warnings.join(" ; "));
  const del = validatePlan({ ...p, steps: [{ n: 1, verb: "DELETE", action_class: "ACT-DELETE", target: "S.STD.P2P.SEL.0001", expect: { page_sig: "x" } }] }, { env: ENV.prod });
  assert.equal(del.ok, false);
  assert.ok(del.errors.some((e) => /ACT-DELETE/.test(e) && /prod/.test(e)), del.errors.join(" ; "));
  const s = validatePlan({ ...p, env: "sandbox" }, { env: ENV.sandbox });
  assert.deepEqual(s.errors, []);
});

test("validatePlan: ACT-DELETE solo col verbo DELETE e in sandbox/preprod; classi fuori catalogo invalide ovunque", () => {
  const del = (n = 1) => ({ n, verb: "DELETE", action_class: "ACT-DELETE", target: "S.STD.P2P.SEL.0001", expect: { page_sig: "x" } });
  for (const e of ["sandbox", "preprod"]) assert.equal(validatePlan(plan(e, [del()]), { env: ENV[e] }).ok, true, e);
  assert.equal(validatePlan(plan("prod", [del()]), { env: ENV.prod }).ok, false, "prod");
  assert.equal(validatePlan(plan("sandbox", [step(1, "CLICK", "ACT-DELETE")]), { env: ENV.sandbox }).ok, true, "CLICK è un verbo ammesso di ACT-DELETE");
  assert.equal(validatePlan(plan("sandbox", [step(1, "SAVE", "ACT-DELETE")]), { env: ENV.sandbox }).ok, false, "SAVE non appartiene ad ACT-DELETE");
  assert.equal(validatePlan(plan("sandbox", [step(1, "CLICK", "ACT-TELEPORT")]), { env: ENV.sandbox }).ok, false);
  assert.equal(validatePlan(plan("sandbox", [{ n: 1, verb: "DELETE", target: "S.STD.P2P.SEL.0001", action_class: "ACT-UPDATE", expect: { x: 1 } }]), { env: ENV.sandbox }).ok, false, "DELETE con una classe diversa da ACT-DELETE");
  assert.equal(validatePlan(plan("sandbox", [{ n: 1, verb: "READ", target: "S.STD.P2P.SEL.0001", expect: { x: 1 } }]), { env: ENV.sandbox }).ok, false, "passo senza classe di azione");
});

test("validatePlan: in prod ammesse tutte le classi tranne ACT-DELETE (colonna \"never\" del catalogo); le scritture avvisano", () => {
  const cat = loadCatalog();
  for (const a of cat.values()) {
    if (a.code === "ACT-CFG-CHANGE" || a.code === "ACT-DELETE") continue;
    const verb = a.verbs_allowed.includes("CLICK") ? "CLICK" : a.verbs_allowed[0];
    const r = validatePlan(plan("prod", [step(1, verb, a.code, a.code === "ACT-BULK" || a.code === "ACT-UPLOAD" ? { file: { path: "runs/RUN.ACME.20261007.1000.P2P/x.xlsx", sha256: "a".repeat(64), rows: 1 } } : {})]), { env: ENV.prod });
    assert.equal(r.ok, a.environments.prod !== "never", `${a.code}: ${r.errors.join("; ")}`);
    assert.equal(r.warnings.length > 0, a.environments.prod === "approval", a.code);
  }
});

test("validatePlan: ACT-CFG-CHANGE in prod con approvazione (niente più approvals: 3A) e il perimetro del passo; verbi fuori classe rifiutati; env del piano = ambiente", () => {
  const cfg = step(2, "TOGGLE", "ACT-CFG-CHANGE", { config: { object: "C.ACME.ADM.CFG.0019", area: "CL-CFG-020", level: "giallo" } });
  const p = plan("prod", [step(1, "NAVIGATE", "ACT-OBS"), cfg]);
  const r = validatePlan(p, { env: ENV.prod });
  assert.deepEqual(r.errors, []);
  assert.ok(r.warnings.some((w) => /ACT-CFG-CHANGE/.test(w)));
  const noScope = plan("prod", [step(1, "TOGGLE", "ACT-CFG-CHANGE")]);
  assert.ok(validatePlan(noScope, { env: ENV.prod }).errors.some((e) => /config/.test(e)), "passo di configurazione senza oggetto/area/livello");
  assert.equal(validatePlan(plan("sandbox", [step(1, "SAVE", "ACT-OBS")]), { env: ENV.sandbox }).ok, false, "SAVE non è un verbo di ACT-OBS");
  assert.equal(validatePlan(plan("sandbox", [step(1, "READ", "ACT-OBS")]), { env: ENV.prod }).ok, false, "il piano dichiara sandbox, l'ambiente è prod");
  const bulk = (e) => validatePlan(plan(e, [step(1, "CLICK", "ACT-BULK")]), { env: ENV[e] });
  assert.equal(bulk("preprod").ok, true, "ACT-BULK in pre-produzione: con approvazione");
  assert.equal(bulk("preprod").warnings.length, 1);
});

test("CLI validate-plan: 0 valido · 3 policy (prod + ACT-DELETE) · 1 malformato", () => {
  const dir = mkdtempSync(join(tmpdir(), "vp-"));
  const w = (name, obj) => { const f = join(dir, name); writeFileSync(f, YAML.stringify(obj)); return f; };
  const CLI = join(ROOT, "scripts/decide/validate-plan.mjs");
  // revisione finale: i file d'ingresso degli script stanno nel workspace degli hook (JVC_WORKSPACE)
  const run = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: cleanEnv({ JVC_WORKSPACE: dir }) });
  assert.equal(run([w("ok.yaml", plan("sandbox", [step(1, "READ", "ACT-OBS")])), "--env-type", "sandbox", "--json"]).status, 0);
  const bad = run([w("prod.yaml", plan("prod", [step(1, "DELETE", "ACT-DELETE", { target: "S.STD.P2P.SEL.0001" })])), "--env-type", "prod", "--json"]);
  assert.equal(bad.status, 3, bad.stdout + bad.stderr);
  assert.equal(run([w("m.yaml", { plan_id: "x" }), "--env-type", "sandbox", "--json"]).status, 1);
  assert.equal(run(["--help"]).status, 0);
});
