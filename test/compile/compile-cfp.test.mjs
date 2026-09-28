// WP09b C — compile-cfp (C1.1, C1.4, §28.3, §28.6): composizione S + deviazioni C in ordine di passo, piano con
// ACT-CFG-CHANGE sui passi di modifica, --dry-run (SAVE/SUBMIT → CAPTURE), verificatore NRT.*.CFG con obbligatorietà
// verificata campo per campo; verbo fuori vocabolario ⇒ invalida; rollback obbligatorio per R ≥ R2.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { composeCfp, cfpPlan, verifierCase, CfpError } from "../../scripts/compile/compile-cfp.mjs";
import { compileCase } from "../../scripts/compile/compile-case.mjs";
import { validatePlan } from "../../scripts/decide/validate-plan.mjs";
import { kbWs, writeItem, writeYaml, cfp, cfpClient, sel } from "../helpers/wp09b-items.mjs";

const CLI = fileURLToPath(new URL("../../scripts/compile/compile-cfp.mjs", import.meta.url));
const PARAMS = { form: { name: "RdA" }, field: { label: "Centro di costo", type: "lista", mandatory: true } };
function ws() {
  const w = kbWs();
  writeItem(w, cfp("S.STD.ADM.CFP.0014"));
  writeItem(w, cfp("S.STD.ADM.CFP.0015", { title: "Disattivare un campo personalizzato", risk: "R1", verification_test: undefined, rollback: undefined, verification: undefined }));
  writeItem(w, cfpClient("C.ACME.ADM.CFP.0002"));
  for (const n of ["0102", "0103", "0110", "0111", "0112", "0113", "0120", "0121"]) writeItem(w, sel(`S.STD.ADM.SEL.${n}`, { label: `E${n}` }));
  writeItem(w, sel("C.ACME.ADM.SEL.0007", { label: "Pubblica" }));
  return w;
}

test("composeCfp: S + deviazioni C in ordine di passo (inserimento dopo il 7, passo 5 deviato), rinumerati, con l'origine", () => {
  const S = cfp("S.STD.ADM.CFP.0014"); const C = cfpClient("C.ACME.ADM.CFP.0002");
  const r = composeCfp(S, C);
  assert.deepEqual(r.steps.map((s) => [s.n, s.verb]), [[1, "NAVIGATE"], [2, "SELECT"], [3, "CLICK"], [4, "FILL"], [5, "CHOOSE"], [6, "TOGGLE"], [7, "SAVE"], [8, "CLICK"], [9, "VERIFY"]]);
  assert.equal(r.steps[7].target, "C.ACME.ADM.SEL.0007");
  assert.equal(r.steps[4].options_from, "C.ACME.ADM.CFG.0019");
  assert.deepEqual(r.origin.map((o) => o.from), ["S.STD.ADM.CFP.0014#1", "S.STD.ADM.CFP.0014#2", "S.STD.ADM.CFP.0014#3", "S.STD.ADM.CFP.0014#4", "S.STD.ADM.CFP.0014#5 (C.ACME.ADM.CFP.0002)", "S.STD.ADM.CFP.0014#6", "S.STD.ADM.CFP.0014#7", "C.ACME.ADM.CFP.0002@after-7", "S.STD.ADM.CFP.0014#8"]);
  assert.throws(() => composeCfp(S, cfpClient("C.ACME.ADM.CFP.0002", { deviations: [{ step: 42, reason: "boh", source: { doc: "x" } }] })), /passo 42/);
});

test("piano dalla CFP cliente: ACT-CFG-CHANGE con config (object, area, livello DT-007) sui passi di modifica, READ altrove; rollback come compensazione deactivate", () => {
  const w = ws();
  const r = cfpPlan(w, cfpClient("C.ACME.ADM.CFP.0002"), { customer: "ACME", params: PARAMS });
  assert.equal(r.plan.plan_id, "PLAN.C.ACME.ADM.CFP.0002");
  assert.equal(validatePlan(r.plan, { env: { id: "sandbox", type: "sandbox" } }).ok, true);
  assert.deepEqual(r.plan.steps.filter((s) => s.action_class === "ACT-CFG-CHANGE").map((s) => [s.n, s.verb]), [[5, "CHOOSE"], [6, "TOGGLE"], [7, "SAVE"]]);
  assert.deepEqual(r.plan.steps[6].config, { object: "S.STD.ADM.CFG.0031", area: "CL-CFG-005", level: "giallo" });
  assert.equal(r.plan.steps[5].data, true); assert.equal(r.plan.steps[3].data, "Centro di costo");
  assert.deepEqual(r.plan.compensations, [{ step: 7, kind: "deactivate", ref: "S.STD.ADM.CFP.0015", entity: "S.STD.ADM.CFG.0031", note: "rollback proposto, non applicato in autonomia (§28.1): disattivare, mai eliminare" }]);
  assert.deepEqual(r.sidecar.checks.pre, ["S.STD.ADM.CHK.0019", "S.STD.ADM.CHK.0051"]);
  assert.deepEqual(r.sidecar.snapshot_before, ["S.STD.ADM.CFG.0031"]);
  assert.equal(r.plan.steps[7].target, "C.ACME.ADM.SEL.0007");
  // in produzione il piano porta approvals: 3A
  assert.equal(cfpPlan(w, cfpClient("C.ACME.ADM.CFP.0002"), { customer: "ACME", params: PARAMS, env: "prod" }).plan.approvals, "3A");
  // più oggetti governati ⇒ config.governs (guard-config-scope vuole uno snapshot che li copra tutti)
  const multi = cfpPlan(w, cfp("S.STD.ADM.CFP.0014", { governs: ["S.STD.ADM.CFG.0031", "S.STD.ADM.CFG.0032"] }), { customer: "ACME", params: PARAMS });
  assert.deepEqual(multi.plan.steps[6].config.governs, ["S.STD.ADM.CFG.0031", "S.STD.ADM.CFG.0032"]);
});

test("--dry-run (STR-DRY-RUN): SAVE e SUBMIT sostituiti da CAPTURE, nessuna compensazione, piano .DRY", () => {
  const w = ws();
  const r = cfpPlan(w, cfp("S.STD.ADM.CFP.0014"), { customer: "ACME", params: PARAMS, dryRun: true });
  assert.equal(r.plan.plan_id, "PLAN.S.STD.ADM.CFP.0014.DRY");
  assert.equal(r.plan.strategy, "STR-DRY-RUN");
  assert.ok(!r.plan.steps.some((s) => ["SAVE", "SUBMIT"].includes(s.verb)));
  assert.equal(r.plan.steps[6].verb, "CAPTURE"); assert.equal(r.plan.steps[6].action_class, "ACT-CFG-READ");
  assert.equal(r.plan.compensations, undefined);
  assert.equal(validatePlan(r.plan, { env: { id: "sandbox", type: "sandbox" } }).ok, true);
});

test("C1.1: verbo fuori vocabolario (DELETE, ERASE) ⇒ CFP invalida (exit 1); R2 senza rollback invalida; parametri mancanti ⇒ errore; dominio analitico ⇒ rifiuto", () => {
  const w = ws();
  for (const verb of ["DELETE", "ERASE"]) {
    const bad = cfp("S.STD.ADM.CFP.0014"); bad.steps[5] = { n: 6, verb, target: "S.STD.ADM.SEL.0113" };
    assert.throws(() => cfpPlan(w, bad, { customer: "ACME", params: PARAMS }), (e) => e instanceof CfpError && e.code === 1 && /verb/.test(e.message));
    const f = writeYaml(w, `tmp/${verb}.yaml`, bad);
    assert.equal(spawnSync(process.execPath, [CLI, "--cfp", f, "--customer", "ACME", "--workspace", w, "--json"], { encoding: "utf8" }).status, 1);
  }
  const noRb = cfp("S.STD.ADM.CFP.0014"); delete noRb.rollback;
  assert.throws(() => cfpPlan(w, noRb, { customer: "ACME", params: PARAMS }), /rollback/);
  assert.throws(() => cfpPlan(w, cfp("S.STD.ADM.CFP.0014"), { customer: "ACME", params: {} }), /parametri mancanti/);
  assert.throws(() => cfpPlan(w, cfp("S.STD.ADM.CFP.0014", { summary: "come S.STD.ADM.RUL.0001" }), { customer: "ACME", params: PARAMS }), (e) => e.code === 3);
});

test("C1.4 verify: NRT.ACME.ADM.CFG.0014 dalla CFP — il campo compare, accetta i valori, obbligatorietà verificata campo per campo; compila in un piano", () => {
  const w = ws();
  const two = cfp("S.STD.ADM.CFP.0014", { verification: { fields: [
    { sel: "S.STD.ADM.SEL.0111", label: "Centro di costo", mandatory: true, accepts: ["CC-100"], form: { url_pattern: "/requisition/new" }, save: "S.STD.ADM.SEL.0120", error: "S.STD.P2P.ERR.0007" },
    { sel: "S.STD.ADM.SEL.0112", label: "Commessa", mandatory: true, form: { url_pattern: "/requisition/new" }, save: "S.STD.ADM.SEL.0120", error_text: "Commessa obbligatoria" },
    { sel: "S.STD.ADM.SEL.0113", label: "Note", mandatory: false, form: { url_pattern: "/requisition/new" } },
  ] } });
  const c = verifierCase(two, { customer: "ACME" });
  assert.equal(c.id, "NRT.ACME.ADM.CFG.0014");
  const saves = c.composition.steps.filter((s) => s.verb === "SAVE");
  assert.equal(saves.length, 2, "un salvataggio a campo vuoto per ciascun campo obbligatorio");
  assert.deepEqual(saves.map((s) => s.expect.messages[0]), ["Centro di costo obbligatorio", "Commessa obbligatoria"]);
  // prima di ciascun salvataggio si svuota proprio quel campo
  for (const s of saves) { const prev = c.composition.steps[s.n - 2]; assert.equal(prev.verb, "FILL"); assert.equal(prev.data, ""); }
  assert.deepEqual(c.composition.steps.filter((s) => s.verb === "READ").map((s) => s.target), ["S.STD.ADM.SEL.0111", "S.STD.ADM.SEL.0112", "S.STD.ADM.SEL.0113"]);
  assert.ok(c.composition.steps.some((s) => s.verb === "FILL" && s.data === "CC-100" && s.expect.value === "CC-100"));
  assert.deepEqual(c.compensations.map((x) => x.step), saves.map((s) => s.n));
  assert.deepEqual(c.expected_errors, ["S.STD.P2P.ERR.0007"]);
  assert.deepEqual(c.derivation.from, ["S.STD.ADM.CFP.0014", "S.STD.ADM.CFG.0031"]);
  const plan = compileCase(w, c).plan;
  assert.ok(plan.compensations.length === 2 && plan.steps.length === c.composition.steps.length);
  // CLI --verify scrive il caso in customers/<C>/tests/cases/<SCOPE>/
  const r = spawnSync(process.execPath, [CLI, "--cfp", "C.ACME.ADM.CFP.0002", "--verify", "--customer", "ACME", "--workspace", w, "--json"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const f = join(w, "customers/ACME/tests/cases/ADM/NRT.ACME.ADM.CFG.0014.yaml");
  assert.ok(existsSync(f)); assert.equal(YAML.parse(readFileSync(f, "utf8")).genre, "CFG");
});

test("CLI: piano con parametri chiave=valore e --out (piano + sidecar)", () => {
  const w = ws();
  const out = join(w, "customers/ACME/runs/RUN.ACME.20260929.1100.ADM/plan.json");
  const r = spawnSync(process.execPath, [CLI, "--cfp", "C.ACME.ADM.CFP.0002", "form.name=RdA", "field.label=Centro di costo", "field.type=lista", "field.mandatory=true", "--customer", "ACME", "--workspace", w, "--out", out, "--json"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(JSON.parse(readFileSync(out, "utf8")).steps[5].data, true);
  assert.ok(existsSync(out.replace(/\.json$/, ".cfp.yaml")));
});
