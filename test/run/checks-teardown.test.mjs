// WP09b D — checks-run (check §62 da script, passi READ per il browser, un pre-check fallito blocca: exit 3) e teardown
// (compensazioni close/cancel pianificate e marcate, voce che cancella rifiutata, 0 orfani; nessuna azione reale).
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { SCRIPT_CHECKS, runChecks } from "../../scripts/run/checks-run.mjs";
import { planTeardown, markDone, report, writeTeardownPlan } from "../../scripts/run/teardown.mjs";
import { registerCreated } from "../../scripts/run/fixtures.mjs";
import { writeCompensations } from "../../scripts/lib/compensations-store.mjs";
import { envWs, patchSession, readSession } from "../helpers/env-fixture.mjs";
import { writeItem, writeYaml, cfp } from "../helpers/wp09b-items.mjs";
import { ROOT } from "../helpers/hook-env.mjs";

const CHECKS = fileURLToPath(new URL("../../scripts/run/checks-run.mjs", import.meta.url));
const TEAR = fileURLToPath(new URL("../../scripts/run/teardown.mjs", import.meta.url));
const RUN = "RUN.ACME.20260929.1000.ADM";

test("catalogo §62: ogni check con how.script ha l'implementazione in checks-run", () => {
  const base = join(ROOT, "product/kb/scopes");
  for (const s of readdirSync(base)) {
    const d = join(base, s, "checks");
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d)) {
      const c = YAML.parse(readFileSync(join(d, f), "utf8"));
      if (c.how.script) assert.equal(typeof SCRIPT_CHECKS[c.how.script], "function", `${c.id}: ${c.how.script}`);
      else assert.ok(["READ", "ENV-CHECK", "QUERY", "OBS"].includes(c.how.verb), `${c.id}: senza script deve andare sul browser`);
    }
  }
});

function ws() {
  const w = envWs({ env: "sandbox" });
  // il catalogo di prodotto nel workspace (come lo porta il plugin)
  for (const s of ["ADM", "XSC", "VEN"]) {
    const d = join(ROOT, "product/kb/scopes", s, "checks");
    for (const f of readdirSync(d)) writeYaml(w, `product/kb/scopes/${s}/checks/${f}`, YAML.parse(readFileSync(join(d, f), "utf8")));
  }
  return w;
}

test("CL-CHK-002 prima di una CFP R2: snapshot mancante e rollback non provato ⇒ blocca (exit 3); con snapshot e run verde del rollback ⇒ passa; READ del workflow come passo del browser", () => {
  const w = ws();
  writeItem(w, cfp("S.STD.ADM.CFP.0014"));
  const session = () => readSession(w);
  const ctx = () => ({ ws: w, customer: "ACME", session: session(), run: RUN, cfp: cfp("S.STD.ADM.CFP.0014"), now: new Date() });
  let r = runChecks(ctx(), { cluster: "CL-CHK-002" });
  assert.equal(r.blocked, true);
  const by = Object.fromEntries(r.results.map((x) => [x.code, x]));
  assert.equal(by["S.STD.ADM.CHK.0051"].status, "fail"); assert.match(by["S.STD.ADM.CHK.0051"].detail, /kb snapshot S\.STD\.ADM\.CFG\.0031/);
  assert.equal(by["S.STD.ADM.CHK.0052"].status, "fail");
  assert.equal(by["S.STD.XSC.CHK.0001"].status, "pass");
  assert.equal(by["S.STD.ADM.CHK.0019"].via, "browser");
  assert.deepEqual(r.plan_steps.map((s) => [s.verb, s.target]), [["READ", "S.STD.ADM.SEL.0130"], ["READ", "S.STD.ADM.SEL.0131"]]);
  // snapshot degli oggetti governati e run verde della CFP di rollback negli ultimi 14 giorni
  patchSession(w, (s) => { s.snapshots = [{ objects: ["S.STD.ADM.CFG.0031"], ts: new Date().toISOString(), source: "kb-snapshot", obs: ["L.ACME.ADM.OBS.0001"] }]; });
  writeYaml(w, "customers/ACME/runs/RUN.ACME.20260925.0900.ADM/result.yaml", { plan_id: "PLAN.S.STD.ADM.CFP.0015", status: "green", completed_at: new Date(Date.now() - 3 * 86400e3).toISOString() });
  r = runChecks(ctx(), { cluster: "CL-CHK-002" });
  assert.equal(r.blocked, false, JSON.stringify(r.results.filter((x) => x.status === "fail")));
  // CLI: il pre-check che fallisce blocca con exit 3; i passi del browser vanno nel run
  patchSession(w, (s) => { s.snapshots = []; });
  const cli = spawnSync(process.execPath, [CHECKS, "--cluster", "CL-CHK-002", "--cfp", "S.STD.ADM.CFP.0014", "--run", RUN, "--workspace", w, "--session", "sess-1", "--json"], { encoding: "utf8" });
  assert.equal(cli.status, 3, cli.stdout + cli.stderr);
  assert.ok(existsSync(join(w, "customers/ACME", JSON.parse(cli.stdout).plan_file)));
});

test("check da script: budget residuo, persone di produzione solo amministrative, storageState, entità vecchie (elenco, mai cancellazione), fornitori duplicati", () => {
  const w = ws();
  const s = readSession(w);
  const now = new Date();
  assert.equal(SCRIPT_CHECKS["budget-residual"]({ session: s, cost: 1000, now }).status, "pass");
  assert.equal(SCRIPT_CHECKS["budget-residual"]({ session: { ...s, budget: { ...s.budget, used: s.budget.tokens - 10 } }, cost: 1000, now }).status, "fail");
  assert.equal(SCRIPT_CHECKS["prod-personas-admin"]({ ws: w, customer: "ACME", session: s, now }).status, "pass");
  const prod = { ...s, env: { ...s.env, id: "prod", type: "prod" } };
  assert.equal(SCRIPT_CHECKS["prod-personas-admin"]({ ws: w, customer: "ACME", session: prod, now }).status, "pass", "fixture: admin-readonly, admin-config");
  const envs = YAML.parse(readFileSync(join(w, "customers/ACME/config/environments.yaml"), "utf8"));
  envs.environments.find((e) => e.id === "prod").personas.push("buyer");
  writeFileSync(join(w, "customers/ACME/config/environments.yaml"), YAML.stringify(envs));
  assert.equal(SCRIPT_CHECKS["prod-personas-admin"]({ ws: w, customer: "ACME", session: prod, now }).status, "fail");
  assert.equal(SCRIPT_CHECKS["storage-state-valid"]({ ws: w, customer: "ACME", session: s, now }).status, "fail", "nessuno storageState registrato");
  const old = registerCreated(w, "ACME", RUN, { entity: "supplier", attrs: { vat: "IT1" }, now: new Date(Date.now() - 40 * 86400e3) });
  registerCreated(w, "ACME", RUN, { entity: "supplier", attrs: { vat: "IT1" } });
  const stale = SCRIPT_CHECKS["stale-test-entities"]({ ws: w, customer: "ACME", now });
  assert.equal(stale.status, "report"); assert.deepEqual(stale.items.map((x) => x.ref), [old.ref]);
  assert.equal(SCRIPT_CHECKS["duplicate-test-suppliers"]({ ws: w, customer: "ACME", now }).status, "fail");
});

test("teardown: piano dalle compensazioni del run (cancel ok, delete rifiutata ⇒ exit 3), done ⇒ entità compensate, report 0 orfani; nulla viene cancellato", () => {
  const w = envWs({ env: "sandbox" });
  const runDir = join(w, "customers/ACME/runs", RUN);
  const ent = registerCreated(w, "ACME", RUN, { entity: "requisition", case: "NRT.ACME.P2P.POS.0001", step: 3 });
  writeCompensations(runDir, [{ plan: "PLAN.NRT.ACME.P2P.POS.0001", step: 3, kind: "cancel", entity: "requisition", action: "requisition.cancel-draft", ref: ent.ref, status: "pending" }]);
  patchSession(w, (s) => { s.pending.compensations = [{ plan: "PLAN.NRT.ACME.P2P.POS.0001", step: 3, kind: "cancel", ref: ent.ref }]; });
  let t = planTeardown(w, { customer: "ACME", run: RUN, session: readSession(w) });
  assert.equal(t.items.length, 1); assert.equal(t.items[0].recipe.kind, "ask");
  assert.deepEqual(t.refused, []);
  assert.equal(writeTeardownPlan(w, "ACME", t), `runs/${RUN}/teardown/plan.yaml`);
  assert.equal(report(w, { customer: "ACME", run: RUN }).orphans.length, 1);
  const before = readdirSync(runDir).sort();
  const done = spawnSync(process.execPath, [TEAR, "done", "--run", RUN, "--plan", "PLAN.NRT.ACME.P2P.POS.0001", "--step", "3", "--customer", "ACME", "--workspace", w, "--session", "sess-1", "--json"], { encoding: "utf8" });
  assert.equal(done.status, 0, done.stdout + done.stderr);
  assert.deepEqual(JSON.parse(done.stdout).compensation.compensated_entities, [ent.ref]);
  assert.equal(readSession(w).pending.compensations.length, 0);
  const rep = spawnSync(process.execPath, [TEAR, "report", "--run", RUN, "--customer", "ACME", "--workspace", w, "--json"], { encoding: "utf8" });
  assert.equal(rep.status, 0, rep.stdout); assert.deepEqual(JSON.parse(rep.stdout).orphans, []);
  assert.deepEqual(readdirSync(runDir).sort(), before, "il teardown non cancella file: registra l'esito");
  // una compensazione che cancella è rifiutata
  writeCompensations(runDir, [{ plan: "PLAN.X", step: 1, kind: "cancel", action: "supplier.delete", status: "pending" }]);
  t = planTeardown(w, { customer: "ACME", run: RUN });
  assert.equal(t.refused.length, 1); assert.match(t.refused[0].reason, /mai si cancella/);
  assert.equal(spawnSync(process.execPath, [TEAR, "plan", "--run", RUN, "--customer", "ACME", "--workspace", w, "--json"], { encoding: "utf8" }).status, 3);
  assert.equal(spawnSync(process.execPath, [TEAR, "report", "--run", RUN, "--customer", "ACME", "--workspace", w, "--json"], { encoding: "utf8" }).status, 3, "compensazione pendente");
});

test("teardown: la ricetta di una compensazione con ref CFP è il piano della CFP di rollback (compile-cfp)", () => {
  const w = envWs({ env: "sandbox" });
  writeItem(w, cfp("S.STD.ADM.CFP.0015", { title: "Disattivare il campo", risk: "R1", rollback: undefined, verification_test: undefined, verification: undefined,
    steps: [{ n: 1, verb: "NAVIGATE", target: { url_pattern: "/setup/forms" } }, { n: 2, verb: "TOGGLE", target: "S.STD.ADM.SEL.0113", data: false }, { n: 3, verb: "SAVE", target: "S.STD.ADM.SEL.0120" }] }));
  writeCompensations(join(w, "customers/ACME/runs", RUN), [{ plan: "PLAN.C.ACME.ADM.CFP.0002", step: 7, kind: "deactivate", ref: "S.STD.ADM.CFP.0015", status: "pending" }]);
  const t = planTeardown(w, { customer: "ACME", run: RUN });
  assert.equal(t.items[0].recipe.kind, "cfp");
  assert.equal(t.items[0].recipe.plan.plan_id, "PLAN.S.STD.ADM.CFP.0015");
  writeTeardownPlan(w, "ACME", t);
  assert.ok(existsSync(join(w, "customers/ACME/runs", RUN, "teardown", "PLAN.C.ACME.ADM.CFP.0002.7.plan.json")));
  assert.ok(markDone(w, { customer: "ACME", run: RUN, plan: "PLAN.C.ACME.ADM.CFP.0002", step: 7 }));
  assert.deepEqual(report(w, { customer: "ACME", run: RUN }), { run: RUN, orphans: [], pending: [] });
});
