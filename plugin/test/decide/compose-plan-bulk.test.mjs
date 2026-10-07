// Ops veloce, Task 13 (spec 2026-10-06 §3.8): compose-plan preferisce la via massiva quando esiste un TPL per l'oggetto, e
// raggruppa i campi della pagina in un solo passo FILL con fields[]; bindingRefusal lega ogni ref a uno dei SEL di fields.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import YAML from "yaml";
import { writeDraft } from "../../scripts/kb/atlas-write.mjs";
import { composePlan } from "../../scripts/decide/compose-plan.mjs";
import { validatePlan } from "../../scripts/decide/validate-plan.mjs";
import { gateStep } from "../../scripts/decide/step-check.mjs";
import { bindingRefusal } from "../../hooks/lib/guards/config-scope.mjs";

const ENV = { id: "sandbox", type: "sandbox" };
const code = (r, label) => r.written.find((w) => w.label.trim() === label).code;
const FILLED = { path: "runs/RUN.ACME.20261007.1000.ADM/import/de.xlsx", sha256: "a".repeat(64), rows: 3 };
const PAGE_SIG = "adm/import/de#import-data-element";

function bulkAtlas({ withSubmit = true } = {}) {
  const ws = mkdtempSync(join(tmpdir(), "compose-bulk-"));
  mkdirSync(join(ws, "customers/ACME/kb/scopes/ADM/templates"), { recursive: true });
  writeFileSync(join(ws, "customers/ACME/kb/scopes/ADM/templates/C.ACME.ADM.TPL.0001.yaml"), YAML.stringify({
    id: "C.ACME.ADM.TPL.0001", type: "TPL", object: "data element", page: PAGE_SIG, file: "de.xlsx", sheet: "Foglio1", header_row: 1,
    columns: [{ name: "Codice", required: true, type: "text", col: "A" }] }));
  const s = writeDraft({ ws, customer: "ACME", scope: "ADM", draft: { page: { signature: PAGE_SIG, title: "Import data element" }, items: [
    { type: "SEL", label: "Carica file", role: "button", effect: "write" },
    ...(withSubmit ? [{ type: "SEL", label: "Importa", role: "button", effect: "write" }] : [])] } });
  const h = writeDraft({ ws, customer: "ACME", scope: "ADM", draft: { page: { signature: "home#benvenuto" }, items: [{ type: "SEL", label: "Import", role: "link", effect: "read" }] } });
  writeDraft({ ws, customer: "ACME", scope: "ADM", draft: { items: [{ type: "FLW", title: "Percorso: Import data element", trigger: "navigazione", steps: [
    { verb: "NAVIGATE", action_class: "ACT-OBS", target: { url_pattern: "/home" }, expect: { page_sig: "home" } },
    { verb: "CLICK", action_class: "ACT-OBS", target: code(h, "Import"), expect: { page_sig: "adm/import/de" } }] }] } });
  return { ws, sel: (l) => code(s, l) };
}

test("TPL per l'oggetto: senza filled ⇒ gap fill-template; con filled ⇒ percorso + UPLOAD + SUBMIT + READ, nessun FILL, compensazioni su ogni passo ACT-BULK", () => {
  const { ws, sel } = bulkAtlas();
  const base = { ws, customer: "ACME", scope: "ADM", env: ENV, goal: "crea 3 data element", data: {}, planId: "PLAN.ACME.20261007.1000" };
  const none = composePlan(base);
  assert.equal(none.plan, undefined);
  assert.equal(none.gaps[0].kind, "fill-template");
  assert.equal(none.gaps[0].what, "C.ACME.ADM.TPL.0001");
  const r = composePlan({ ...base, filled: FILLED });
  assert.ok(r.plan, JSON.stringify(r.gaps));
  const steps = r.plan.steps;
  assert.deepEqual(steps.slice(-3).map((s) => s.verb), ["UPLOAD", "SUBMIT", "READ"]);
  assert.ok(!steps.some((s) => s.verb === "FILL" || s.verb === "CHOOSE"));
  assert.deepEqual(steps.at(-3).file, FILLED);
  assert.equal(steps.at(-3).target, sel("Carica file"));
  assert.equal(steps.at(-2).target, sel("Importa"));
  assert.deepEqual(steps.slice(-3).map((s) => s.action_class), ["ACT-BULK", "ACT-BULK", "ACT-READ"]);
  assert.deepEqual(validatePlan(r.plan, { env: ENV }).errors, []);
  // ruling: una compensazione deactivate per OGNI passo ACT-BULK di commit (UPLOAD e SUBMIT), altrimenti gateStep nega
  const bulkNs = steps.filter((s) => s.action_class === "ACT-BULK").map((s) => s.n);
  assert.deepEqual(r.plan.compensations.map((c) => c.step).sort(), bulkNs);
  assert.ok(r.plan.compensations.every((c) => c.kind === "deactivate"));
  for (const s of steps.filter((x) => x.action_class === "ACT-BULK" || x.verb === "READ")) {
    const g = gateStep({ plan: r.plan, step: s, env: ENV, records: [], now: new Date(), planFile: "runs/RUN.ACME.20261007.1000.ADM/plan.json" });
    assert.notEqual(g.status, "denied", `${s.verb}: ${g.reason}`);
    if (s.verb === "READ") { assert.equal(g.status, "ok"); assert.deepEqual(g.pending, []); }
  }
});

test("TPL senza pulsante d'avvio visto ⇒ gap no-submit, nessun piano", () => {
  const { ws } = bulkAtlas({ withSubmit: false });
  const r = composePlan({ ws, customer: "ACME", scope: "ADM", env: ENV, goal: "crea 3 data element", data: {}, planId: "PLAN.ACME.20261007.1001", filled: FILLED });
  assert.equal(r.plan, undefined);
  assert.ok(r.gaps.some((g) => g.kind === "no-submit"), JSON.stringify(r.gaps));
});

function formAtlas() {
  const ws = mkdtempSync(join(tmpdir(), "compose-form-"));
  mkdirSync(join(ws, "customers/ACME"), { recursive: true });
  const page = { signature: "p2p/po/new#nuovo-ordine", title: "Nuovo ordine" };
  const f = writeDraft({ ws, customer: "ACME", scope: "P2P", draft: { page, items: [
    { type: "FLD", label: "Descrizione", document: "Nuovo ordine", section: "Testata", field_type: "text", mandatory: "always" },
    { type: "FLD", label: "Divisa", document: "Nuovo ordine", section: "Testata", field_type: "list" },
    { type: "FLD", label: "Centro di costo", document: "Nuovo ordine", section: "Testata", field_type: "text", mandatory: "always" }] } });
  const s = writeDraft({ ws, customer: "ACME", scope: "P2P", draft: { page, items: [
    { type: "SEL", label: "Descrizione", role: "textbox", field: code(f, "Descrizione") },
    { type: "SEL", label: "Divisa", role: "combobox", field: code(f, "Divisa") },
    { type: "SEL", label: "Centro di costo", role: "textbox", field: code(f, "Centro di costo") },
    { type: "SEL", label: "Salva bozza", role: "button" }] } });
  const h = writeDraft({ ws, customer: "ACME", scope: "P2P", draft: { page: { signature: "home#benvenuto" }, items: [{ type: "SEL", label: "Ordini", role: "link" }] } });
  writeDraft({ ws, customer: "ACME", scope: "P2P", draft: { items: [{ type: "FLW", title: "Percorso: Nuovo ordine", trigger: "navigazione", steps: [
    { verb: "NAVIGATE", action_class: "ACT-OBS", target: { url_pattern: "/home" }, expect: { page_sig: "home" } },
    { verb: "CLICK", action_class: "ACT-OBS", target: code(h, "Ordini"), expect: { page_sig: "p2p/po/new" } }] }] } });
  return { ws, sel: (l) => code(s, l) };
}

test("piano a maschera: i campi della pagina con dati diventano UN solo passo FILL con fields[]", () => {
  const { ws, sel } = formAtlas();
  const data = { Descrizione: "Sedie", Divisa: "EUR", "Centro di costo": "IT-0442" };
  const r = composePlan({ ws, customer: "ACME", scope: "P2P", env: ENV, goal: "crea ordine per sedie", data, planId: "PLAN.ACME.PO.0101" });
  assert.ok(r.plan, JSON.stringify(r.gaps));
  assert.deepEqual(r.plan.steps.map((s) => s.verb), ["NAVIGATE", "CLICK", "FILL", "SAVE"]);
  const fill = r.plan.steps.find((s) => s.verb === "FILL");
  assert.equal(fill.fields.length, Object.keys(data).length);
  assert.equal(fill.target, undefined);
  assert.deepEqual(fill.fields.map((f) => f.target).sort(), [sel("Centro di costo"), sel("Descrizione"), sel("Divisa")].sort());
  assert.equal(fill.fields.find((f) => f.target === sel("Divisa")).value, "EUR");
  assert.deepEqual(r.plan.compensations, [{ step: 4, kind: "cancel", entity: "ordine", action: "ordine.cancel" }]);
  assert.deepEqual(validatePlan(r.plan, { env: ENV }).errors, []);
  // un solo campo con dati: il passo resta un FILL con target (nessun raggruppamento)
  const one = composePlan({ ws, customer: "ACME", scope: "P2P", env: ENV, goal: "crea ordine", data: { Descrizione: "x", "Centro di costo": "y" }, planId: "PLAN.ACME.PO.0102" });
  assert.equal(one.plan.steps.filter((s) => s.verb === "FILL").length, 1);
});

// ---- bindingRefusal con fields (fail-closed) ----
const A = "C.ACME.P2P.SEL.0001", B = "C.ACME.P2P.SEL.0002", C = "C.ACME.P2P.SEL.0003", X = "C.ACME.P2P.SEL.0099";
const URL_ = "https://acme-sbx.jaggaer.com/p2p/po/new";
function ctxOf(targets, extra = {}, refs = { e1: A, e2: B, e3: C, e9: X }) {
  return { ws: "/nonexistent", customer: "ACME", tool: "t", call: { family: "playwright" },
    pendingFile: { v: 1, obs_pending: {}, obs_done: [] },
    session: { browser: { current_url: URL_, snapshot: { url: URL_, tab: null, refs } } },
    actions: [{ kind: "input", family: "playwright", op: "fill_form", targets, ...extra }] };
}
const STEP = { n: 3, verb: "FILL", action_class: "ACT-CREATE", fields: [{ target: A, value: "1" }, { target: B, value: "2" }, { target: C, value: "3" }] };

test("bindingRefusal con fields: fill_form con tutti i campi legati ai SEL di fields ⇒ consentito", () => {
  assert.equal(bindingRefusal(ctxOf(["e1", "e2", "e3"]), STEP), null);
  assert.equal(bindingRefusal(ctxOf(["e2"]), STEP), null, "un sottoinsieme dei campi è lecito");
});

test("bindingRefusal con fields: un elemento legato a un SEL fuori da fields ⇒ negato", () => {
  assert.match(bindingRefusal(ctxOf(["e1", "e9"]), STEP) ?? "", /non corrisponde/);
  assert.match(bindingRefusal(ctxOf(["e1", "e404"]), STEP) ?? "", /non corrisponde/, "ref assente dallo snapshot");
});

test("bindingRefusal con fields: elemento senza uid/ref ⇒ negato", () => {
  assert.match(bindingRefusal(ctxOf(["e1"], { untargeted: true }), STEP) ?? "", /senza uid\/ref/);
  assert.match(bindingRefusal(ctxOf([]), STEP) ?? "", /senza uid\/ref/);
});

test("bindingRefusal con fields: lo stesso SEL legato da due elementi (o due volte) nella chiamata ⇒ negato", () => {
  const dup = bindingRefusal(ctxOf(["e1", "e5"], {}, { e1: A, e5: A, e2: B }), STEP);
  assert.match(dup ?? "", /più di un elemento|più volte|stesso campo/);
  assert.match(bindingRefusal(ctxOf(["e1", "e1"]), STEP) ?? "", /più di un elemento|più volte|stesso campo/);
  // anche fra azioni diverse della stessa chiamata (browser_batch)
  const c = ctxOf(["e1"]); c.actions.push({ kind: "input", family: "playwright", op: "type", targets: ["e1"] });
  assert.match(bindingRefusal(c, STEP) ?? "", /più di un elemento|più volte|stesso campo/);
});

test("bindingRefusal con fields malformato ⇒ negato (fail-closed); il passo con target resta com'era", () => {
  assert.match(bindingRefusal(ctxOf(["e1"]), { ...STEP, fields: [] }) ?? "", /fields/);
  assert.match(bindingRefusal(ctxOf(["e1"]), { ...STEP, fields: "x" }) ?? "", /fields/);
  assert.match(bindingRefusal(ctxOf(["e1"]), { ...STEP, fields: [{ target: A }, { target: "non-un-sel" }] }) ?? "", /SEL/);
  assert.match(bindingRefusal(ctxOf(["e1"]), { ...STEP, fields: [{ target: A }, { target: A }] }) ?? "", /fields/, "target ripetuto nel passo");
  const one = { n: 1, verb: "FILL", action_class: "ACT-CREATE", target: A };
  assert.equal(bindingRefusal(ctxOf(["e1"]), one), null);
  assert.match(bindingRefusal(ctxOf(["e2"]), one) ?? "", /non corrisponde/);
});
