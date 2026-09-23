// K5.4 — catalogo delle azioni (§29.4) e validazione dei piani (§52.1 strato 2):
// 15 classi ACT come item di product/kb/actions; un piano con una classe fuori
// catalogo, ACT-DELETE, o una scrittura in prod è invalido.
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
  assert.equal(validateItem({ ...structuredClone(it), verbs_allowed: ["DELETE"] }).ok, false, "DELETE non è nel vocabolario dei verbi");
});

test("catalogo: produzione = solo osservare, leggere, interrogare, leggere la configurazione; configurare con 3A; ACT-DELETE mai", () => {
  const cat = loadCatalog();
  assert.equal(cat.size, 15);
  const prodAllowed = [...cat.values()].filter((a) => a.environments.prod === "allowed").map((a) => a.code).sort();
  assert.deepEqual(prodAllowed, ["ACT-CFG-READ", "ACT-OBS", "ACT-QRY", "ACT-READ"]);
  assert.equal(cat.get("ACT-CFG-CHANGE").environments.prod, "3A");
  for (const a of cat.values()) if (a.effect === "write") assert.equal(a.environments.prod, "never", a.code);
  const del = cat.get("ACT-DELETE");
  assert.deepEqual(del.environments, { sandbox: "never", preprod: "never", prod: "never" });
  assert.deepEqual(del.verbs_allowed, []);
  assert.equal(cat.get("ACT-BULK").environments.preprod, "never");
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

test("validatePlan: env prod + ACT-CREATE → invalido (§52.1 strato 2); in sandbox lo stesso piano è valido", () => {
  const p = plan("prod", [step(1, "NAVIGATE", "ACT-OBS"), step(2, "FILL", "ACT-CREATE", { data: "x" }), step(3, "SAVE", "ACT-CREATE")]);
  const r = validatePlan(p, { env: ENV.prod });
  assert.equal(r.ok, false);
  assert.ok(r.policy.length > 0);
  assert.ok(r.errors.some((e) => /ACT-CREATE/.test(e) && /prod/.test(e)), r.errors.join("\n"));
  const s = validatePlan({ ...p, env: "sandbox" }, { env: ENV.sandbox });
  assert.deepEqual(s.errors, []);
});

test("validatePlan: ACT-DELETE e classi fuori catalogo invalidi ovunque; verbo DELETE rifiutato dallo schema", () => {
  for (const e of ["sandbox", "preprod", "prod"]) {
    const r = validatePlan(plan(e, [step(1, "CLICK", "ACT-DELETE")]), { env: ENV[e] });
    assert.equal(r.ok, false, e);
    assert.ok(r.errors.some((x) => /ACT-DELETE/.test(x)));
  }
  assert.equal(validatePlan(plan("sandbox", [step(1, "CLICK", "ACT-TELEPORT")]), { env: ENV.sandbox }).ok, false);
  assert.equal(validatePlan(plan("sandbox", [{ n: 1, verb: "DELETE", target: "S.STD.P2P.SEL.0001", action_class: "ACT-UPDATE", expect: { x: 1 } }]), { env: ENV.sandbox }).ok, false);
  assert.equal(validatePlan(plan("sandbox", [{ n: 1, verb: "READ", target: "S.STD.P2P.SEL.0001", expect: { x: 1 } }]), { env: ENV.sandbox }).ok, false, "passo senza classe di azione");
});

test("validatePlan: ogni classe di scrittura in prod è invalida; le letture passano", () => {
  const cat = loadCatalog();
  for (const a of cat.values()) {
    if (a.code === "ACT-CFG-CHANGE" || a.code === "ACT-DELETE") continue;
    const verb = a.verbs_allowed.includes("CLICK") ? "CLICK" : a.verbs_allowed[0];
    const r = validatePlan(plan("prod", [step(1, verb, a.code)]), { env: ENV.prod });
    assert.equal(r.ok, a.environments.prod === "allowed", `${a.code}: ${r.errors.join("; ")}`);
  }
});

test("validatePlan: ACT-CFG-CHANGE in prod richiede approvals: 3A e il perimetro del passo; verbi fuori classe rifiutati; env del piano = ambiente", () => {
  const cfg = step(2, "TOGGLE", "ACT-CFG-CHANGE", { config: { object: "C.ACME.ADM.CFG.0019", area: "CL-CFG-020", level: "giallo" } });
  const p = plan("prod", [step(1, "NAVIGATE", "ACT-OBS"), cfg]);
  const r = validatePlan(p, { env: ENV.prod });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /3A/.test(e)));
  assert.deepEqual(validatePlan({ ...p, approvals: "3A" }, { env: ENV.prod }).errors, []);
  const noScope = plan("prod", [step(1, "TOGGLE", "ACT-CFG-CHANGE")], { approvals: "3A" });
  assert.ok(validatePlan(noScope, { env: ENV.prod }).errors.some((e) => /config/.test(e)), "passo di configurazione senza oggetto/area/livello");
  assert.equal(validatePlan(plan("sandbox", [step(1, "SAVE", "ACT-OBS")]), { env: ENV.sandbox }).ok, false, "SAVE non è un verbo di ACT-OBS");
  assert.equal(validatePlan(plan("sandbox", [step(1, "READ", "ACT-OBS")]), { env: ENV.prod }).ok, false, "il piano dichiara sandbox, l'ambiente è prod");
  const bulk = validatePlan(plan("preprod", [step(1, "CLICK", "ACT-BULK")]), { env: ENV.preprod });
  assert.equal(bulk.ok, false, "ACT-BULK in pre-produzione: mai");
});

test("CLI validate-plan: 0 valido · 3 policy (prod + scrittura) · 1 malformato", () => {
  const dir = mkdtempSync(join(tmpdir(), "vp-"));
  const w = (name, obj) => { const f = join(dir, name); writeFileSync(f, YAML.stringify(obj)); return f; };
  const CLI = join(ROOT, "scripts/decide/validate-plan.mjs");
  const run = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: cleanEnv() });
  assert.equal(run([w("ok.yaml", plan("sandbox", [step(1, "READ", "ACT-OBS")])), "--env-type", "sandbox", "--json"]).status, 0);
  const bad = run([w("prod.yaml", plan("prod", [step(1, "SAVE", "ACT-CREATE")])), "--env-type", "prod", "--json"]);
  assert.equal(bad.status, 3, bad.stdout + bad.stderr);
  assert.equal(run([w("m.yaml", { plan_id: "x" }), "--env-type", "sandbox", "--json"]).status, 1);
  assert.equal(run(["--help"]).status, 0);
});
