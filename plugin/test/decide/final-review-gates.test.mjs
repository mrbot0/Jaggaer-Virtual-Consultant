// Revisione finale (Ruling F1, F2, F6 e minori): import di configurazione in produzione con istantanea e compensazioni
// restore; un passo DELETE non segue passi che spuntano righe; write_data false nega massivi e cancellazioni ovunque;
// TPL senza pagina ⇒ mancanza tpl-no-page; planNeedsApproval con livello predefinito basso.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import YAML from "yaml";
import { writeDraft } from "../../scripts/kb/atlas-write.mjs";
import { composePlan, main } from "../../scripts/decide/compose-plan.mjs";
import { validatePlan } from "../../scripts/decide/validate-plan.mjs";
import { gateStep, planNeedsApproval } from "../../scripts/decide/step-check.mjs";

const RUN = "RUN.ACME.20261007.1000.ADM";
const FILLED = { path: `runs/${RUN}/import/de.xlsx`, sha256: "a".repeat(64), rows: 3 };
const SNAP = `runs/${RUN}/evidence/data-elements-prima.xlsx`;
const PAGE_SIG = "adm/import/de#import-data-element";
const PROD = { id: "prod", type: "prod", policy: { write_data: true, second_approver_required: false } };
const PREPROD = { id: "preprod", type: "preprod", policy: { write_data: true } };
const code = (r, label) => r.written.find((w) => w.label.trim() === label).code;

function bulkWs({ kind, page = PAGE_SIG, snapshot = true } = {}) {
  const ws = mkdtempSync(join(tmpdir(), "final-gates-"));
  mkdirSync(join(ws, "customers/ACME/kb/scopes/ADM/templates"), { recursive: true });
  writeFileSync(join(ws, "customers/ACME/kb/scopes/ADM/templates/C.ACME.ADM.TPL.0001.yaml"), YAML.stringify({
    id: "C.ACME.ADM.TPL.0001", type: "TPL", object: "data element", ...(kind ? { kind } : {}), page, file: "x.xlsx", sheet: "Foglio1", header_row: 1,
    columns: [{ name: "Codice", required: true, type: "text", col: 0 }] }));
  writeDraft({ ws, customer: "ACME", scope: "ADM", draft: { page: { signature: PAGE_SIG, title: "Import data element" }, items: [
    { type: "SEL", label: "Carica file", role: "button", effect: "write" }, { type: "SEL", label: "Importa", role: "button", effect: "write" }] } });
  const h = writeDraft({ ws, customer: "ACME", scope: "ADM", draft: { page: { signature: "home#benvenuto" }, items: [{ type: "SEL", label: "Import", role: "link", effect: "read" }] } });
  writeDraft({ ws, customer: "ACME", scope: "ADM", draft: { items: [{ type: "FLW", title: "Percorso: Import data element", trigger: "navigazione", steps: [
    { verb: "NAVIGATE", action_class: "ACT-OBS", target: { url_pattern: "/home" }, expect: { page_sig: "home" } },
    { verb: "CLICK", action_class: "ACT-OBS", target: code(h, "Import"), expect: { page_sig: "adm/import/de" } }] }] } });
  if (snapshot) { mkdirSync(join(ws, "customers/ACME/runs", RUN, "evidence"), { recursive: true }); writeFileSync(join(ws, "customers/ACME", SNAP), "export dei data element attuali"); }
  return ws;
}
const base = (ws, env, extra = {}) => ({ ws, customer: "ACME", scope: "ADM", env: { id: env.id, type: env.type }, goal: "crea 3 data element", data: {}, planId: "PLAN.ACME.20261007.1000", filled: FILLED, ...extra });
const gate = (ws, plan, step, env, extra = {}) => gateStep({ plan, step, env, records: [], now: new Date(), planFile: `runs/${RUN}/plan.json`, autonomy: "alto", custDir: join(ws, "customers/ACME"), run: RUN, ...extra });

test("F1: TPL di configurazione in produzione senza istantanea ⇒ mancanza config-snapshot; con istantanea ⇒ restore sui passi ACT-BULK", () => {
  for (const kind of [undefined, "config"]) {   // voce vecchia senza kind = configurazione (fail-closed)
    const ws = bulkWs({ kind });
    const none = composePlan(base(ws, PROD));
    assert.equal(none.plan, undefined);
    assert.equal(none.gaps[0].kind, "config-snapshot", JSON.stringify(none.gaps));
    assert.match(none.gaps[0].hint, /--istantanea runs\/<RUN>\/evidence\//);
    const r = composePlan(base(ws, PROD, { snapshot: SNAP }));
    assert.ok(r.plan, JSON.stringify(r.gaps));
    assert.equal(r.plan.config_import, true);
    const bulk = r.plan.steps.filter((s) => s.action_class === "ACT-BULK");
    assert.deepEqual(r.plan.compensations.map((c) => [c.step, c.kind, c.ref]), bulk.map((s) => [s.n, "restore", SNAP]));
    assert.deepEqual(validatePlan(r.plan, { env: PROD }).errors, []);
    // gateStep in produzione: l'istantanea c'è ⇒ non negato (chiede le approvazioni)
    for (const s of bulk) assert.equal(gate(ws, r.plan, s, PROD).status, "approval_required", s.verb);
  }
  // istantanea dichiarata ma assente ⇒ mancanza
  const ws2 = bulkWs({ kind: "config", snapshot: false });
  const miss = composePlan(base(ws2, PROD, { snapshot: SNAP }));
  assert.equal(miss.gaps?.[0]?.kind, "config-snapshot", JSON.stringify(miss));
});

test("F1: gateStep in produzione — import di configurazione senza restore verificabile ⇒ negato; dati ⇒ invariato; sandbox/preprod ⇒ istantanea facoltativa", () => {
  const ws = bulkWs({ kind: "config" });
  const r = composePlan(base(ws, PROD, { snapshot: SNAP }));
  const up = r.plan.steps.find((s) => s.verb === "UPLOAD");
  // compensazione deactivate (piano scritto a mano) o file sparito ⇒ negato
  const deact = { ...r.plan, compensations: r.plan.compensations.map((c) => ({ step: c.step, kind: "deactivate", entity: "data element" })) };
  const d1 = gate(ws, deact, up, PROD);
  assert.equal(d1.status, "denied"); assert.match(d1.reason, /istantanea/);
  // config_import assente in un piano di produzione con ACT-BULK = configurazione (fail-closed)
  const { config_import: _ci, ...noFlag } = deact;
  assert.equal(gate(ws, noFlag, up, PROD).status, "denied");
  const d2 = gate(ws, r.plan, up, PROD, { run: "RUN.ACME.20261007.1001.ADM" });
  assert.equal(d2.status, "denied", "istantanea di un altro run");
  // TPL di dati: deactivate, nessuna istantanea, nessun diniego per l'istantanea
  const wsd = bulkWs({ kind: "data", snapshot: false });
  const rd = composePlan(base(wsd, PROD));
  assert.ok(rd.plan, JSON.stringify(rd.gaps));
  assert.equal(rd.plan.config_import, false);
  assert.ok(rd.plan.compensations.every((c) => c.kind === "deactivate"));
  for (const s of rd.plan.steps.filter((x) => x.action_class === "ACT-BULK")) assert.equal(gate(wsd, rd.plan, s, PROD).status, "approval_required");
  // pre-produzione: configurazione senza istantanea ⇒ deactivate, nessun diniego
  const wsp = bulkWs({ kind: "config", snapshot: false });
  const rp = composePlan(base(wsp, PREPROD));
  assert.ok(rp.plan, JSON.stringify(rp.gaps));
  assert.ok(rp.plan.compensations.every((c) => c.kind === "deactivate"));
  for (const s of rp.plan.steps.filter((x) => x.action_class === "ACT-BULK")) assert.equal(gate(wsp, rp.plan, s, PREPROD).status, "ok");
});

test("F1: CLI --istantanea — dello stesso RUN di --out, sotto evidence/; senza ⇒ exit 3 con config-snapshot", async () => {
  const ws = bulkWs({ kind: "config" });
  mkdirSync(join(ws, "customers/ACME/config"), { recursive: true });
  writeFileSync(join(ws, "customers/ACME/config/environments.yaml"), YAML.stringify({ environments: [{ id: "prod", type: "prod" }] }));
  const out = `runs/${RUN}/plan.json`;
  const env = { JVC_WORKSPACE: ws };
  const argv = (...extra) => ["--goal", "crea 3 data element", "--scope", "ADM", "--env", "prod", "--out", out, "--customer", "ACME", "--workspace", ws, "--json", "--filled", `${FILLED.path}:${FILLED.sha256}:3`, ...extra];
  const lines = [];
  const quiet = async (a) => { const l = console.log; const e = console.error; console.log = (x) => lines.push(String(x)); console.error = (x) => lines.push(String(x)); try { return await main(a, env); } finally { console.log = l; console.error = e; } };
  assert.equal(await quiet(argv()), 3);
  assert.match(lines.join("\n"), /config-snapshot/);
  assert.equal(await quiet(argv("--istantanea", `runs/RUN.ACME.20261007.1001.ADM/evidence/x.xlsx`)), 1, "altro RUN");
  assert.equal(await quiet(argv("--istantanea", `runs/${RUN}/import/x.xlsx`)), 1, "fuori da evidence/");
  assert.equal(await quiet(argv("--istantanea", `runs/${RUN}/evidence/../plan.json`)), 1, "risalita");
  assert.equal(await quiet(argv("--istantanea", SNAP)), 0, lines.join("\n"));
  const plan = JSON.parse(readFileSync(join(ws, "customers/ACME", out), "utf8"));
  assert.equal(plan.config_import, true);
  assert.ok(plan.compensations.every((c) => c.kind === "restore" && c.ref === SNAP));
});

test("minore: TPL senza pagina di import ⇒ mancanza tpl-no-page con l'indicazione di reimparare con --page", () => {
  const ws = bulkWs({ kind: "data", page: null });
  const r = composePlan(base(ws, PREPROD));
  assert.equal(r.plan, undefined);
  assert.equal(r.gaps[0].kind, "tpl-no-page", JSON.stringify(r.gaps));
  assert.match(r.gaps[0].hint, /template-learn.*--page/);
});

// ---- Ruling F2: un DELETE non segue passi che spuntano righe ----
const SEL_BOX = "C.ACME.P2P.SEL.0300";
const SEL_BTN = "C.ACME.P2P.SEL.0301";
const SEL_DEL = "C.ACME.P2P.SEL.0200";
const EV = `runs/${RUN}/evidence/before.json`;
function delWs() {
  const ws = mkdtempSync(join(tmpdir(), "final-del-"));
  mkdirSync(join(ws, "customers/ACME/runs", RUN, "evidence"), { recursive: true });
  writeFileSync(join(ws, "customers/ACME", EV), "{}");
  return ws;
}
const ROLES = { [SEL_BOX]: { role: "checkbox", label: "Seleziona riga" }, [SEL_BTN]: { role: "button", label: "Apri" }, [SEL_DEL]: { role: "button", label: "Elimina" } };
const resolve = (c) => (ROLES[c] ? { code: c, ...ROLES[c] } : null);
const delPlan = (before) => ({ plan_id: "PLAN.ACME.20261007.1000", customer: "ACME", env: "preprod", goal: "cancella", steps: [...before.map((s, i) => ({ n: i + 1, expect: { page_sig: "x" }, ...s })),
  { n: before.length + 1, verb: "DELETE", action_class: "ACT-DELETE", target: SEL_DEL, expect: { elements: [] } }],
  compensations: [{ step: before.length + 1, kind: "restore", ref: EV }], repair_policy: { skip_allowed: [], substitute_allowed: [], abort_on: [] } });

test("F2: DELETE dopo un passo ACT-BULK, TOGGLE, SELECT o CLICK su una checkbox (o su un SEL non risolto) ⇒ negato", () => {
  const ws = delWs();
  const cases = [
    [{ verb: "SUBMIT", action_class: "ACT-BULK", target: SEL_BTN }],
    [{ verb: "TOGGLE", action_class: "ACT-UPDATE", target: SEL_BTN }],
    [{ verb: "SELECT", action_class: "ACT-OBS", target: SEL_BTN }],
    [{ verb: "CLICK", action_class: "ACT-OBS", target: SEL_BOX }],
    [{ verb: "CLICK", action_class: "ACT-OBS", target: "C.ACME.P2P.SEL.0999" }],
  ];
  for (const before of cases) {
    const p = delPlan(before);
    const g = gate(ws, p, p.steps.at(-1), PREPROD, { resolve });
    assert.equal(g.status, "denied", JSON.stringify(before));
    assert.match(g.reason, /spunt|selezion|più righe/i);
  }
  // senza risolutore dei SEL un CLICK precedente non si verifica ⇒ negato (fail-closed)
  const pc = delPlan([{ verb: "CLICK", action_class: "ACT-OBS", target: SEL_BTN }]);
  assert.equal(gate(ws, pc, pc.steps.at(-1), PREPROD).status, "denied");
  // CLICK su un pulsante e NAVIGATE prima del DELETE ⇒ consentito (A1 ad alto)
  const ok = delPlan([{ verb: "NAVIGATE", action_class: "ACT-OBS", target: { url_pattern: "/x" } }, { verb: "CLICK", action_class: "ACT-OBS", target: SEL_BTN }]);
  assert.notEqual(gate(ws, ok, ok.steps.at(-1), PREPROD, { resolve }).status, "denied");
  // passi DOPO il DELETE non contano
  const after = { ...delPlan([]), steps: [...delPlan([]).steps, { n: 2, verb: "TOGGLE", action_class: "ACT-UPDATE", target: SEL_BTN, expect: { page_sig: "x" } }] };
  assert.notEqual(gate(ws, after, after.steps[0], PREPROD, { resolve }).status, "denied");
});

test("F6: write_data false in qualunque ambiente ⇒ ACT-BULK e ACT-DELETE negati da gateStep", () => {
  const ws = delWs();
  for (const type of ["sandbox", "preprod", "prod"]) {
    const env = { id: type, type, policy: { write_data: false } };
    const p = delPlan([]);
    if (type !== "prod") {
      const g = gate(ws, p, p.steps[0], env, { resolve });
      assert.equal(g.status, "denied", type); assert.match(g.reason, /write_data/);
    }
    const bulk = { ...p, steps: [{ n: 1, verb: "SUBMIT", action_class: "ACT-BULK", target: SEL_BTN, expect: { page_sig: "x" } }], compensations: [{ step: 1, kind: "restore", ref: EV }], config_import: false };
    const gb = gate(ws, bulk, bulk.steps[0], env, { resolve });
    assert.equal(gb.status, "denied", type); assert.match(gb.reason, /write_data/);
  }
  // write_data true (o assente in sandbox) ⇒ nessun diniego per write_data
  const p = delPlan([]);
  assert.notEqual(gate(ws, p, p.steps[0], { id: "sandbox", type: "sandbox", policy: {} }, { resolve }).status, "denied");
});

test("minore: planNeedsApproval senza livello vale basso (pre-produzione ⇒ sì; sandbox con solo creazione ⇒ no)", () => {
  const p = { plan_id: "PLAN.X", steps: [{ n: 1, verb: "SAVE", action_class: "ACT-CREATE", target: SEL_BTN, expect: { page_sig: "x" } }] };
  assert.equal(planNeedsApproval(p, { type: "preprod", policy: {} }), true);
  assert.equal(planNeedsApproval(p, { type: "sandbox", policy: {} }), false);
  assert.equal(planNeedsApproval.length, 2, "il terzo parametro ha un predefinito");
});

test("minore: lo schema del piano limita file.path di UPLOAD a un file in runs/<RUN>/import/", () => {
  const up = (path) => ({ plan_id: "PLAN.ACME.X", customer: "ACME", env: "sandbox", goal: "g", steps: [{ n: 1, verb: "UPLOAD", action_class: "ACT-BULK", target: SEL_BTN, file: { path, sha256: "a".repeat(64), rows: 1 }, expect: { page_sig: "x" } }],
    compensations: [{ step: 1, kind: "deactivate" }], repair_policy: { skip_allowed: [], substitute_allowed: [], abort_on: [] } });
  const env = { id: "sandbox", type: "sandbox" };
  assert.deepEqual(validatePlan(up(`runs/${RUN}/import/de.xlsx`), { env }).errors, []);
  for (const bad of [`runs/${RUN}/evidence/de.xlsx`, `runs/${RUN}/plan.json`, `runs/${RUN}/import/sub/de.xlsx`, `runs/${RUN}/import/..`, `runs/${RUN}/import/a${String.fromCharCode(92)}b.xlsx`]) {
    assert.equal(validatePlan(up(bad), { env }).ok, false, bad);
  }
});
