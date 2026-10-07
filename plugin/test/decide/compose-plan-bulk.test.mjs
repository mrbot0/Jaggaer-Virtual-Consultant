// Ops veloce, Task 13 (spec 2026-10-06 §3.8): compose-plan preferisce la via massiva quando esiste un TPL per l'oggetto, e
// raggruppa i campi della pagina in un solo passo FILL con fields[]; bindingRefusal lega ogni ref a uno dei SEL di fields.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import YAML from "yaml";
import { writeDraft } from "../../scripts/kb/atlas-write.mjs";
import { composePlan, main, tplMatch, pluralOf } from "../../scripts/decide/compose-plan.mjs";
import { validatePlan } from "../../scripts/decide/validate-plan.mjs";
import { gateStep } from "../../scripts/decide/step-check.mjs";
import { bindingRefusal } from "../../hooks/lib/guards/config-scope.mjs";

const ENV = { id: "sandbox", type: "sandbox" };
const code = (r, label) => r.written.find((w) => w.label.trim() === label).code;
const FILLED = { path: "runs/RUN.ACME.20261007.1000.ADM/import/de.xlsx", sha256: "a".repeat(64), rows: 3 };
const PAGE_SIG = "adm/import/de#import-data-element";

function tplYaml(ws, n, object, page = PAGE_SIG) {
  writeFileSync(join(ws, `customers/ACME/kb/scopes/ADM/templates/C.ACME.ADM.TPL.000${n}.yaml`), YAML.stringify({
    id: `C.ACME.ADM.TPL.000${n}`, type: "TPL", object, page, file: "x.xlsx", sheet: "Foglio1", header_row: 1,
    columns: [{ name: "Codice", required: true, type: "text", col: "A" }] }));
}
function bulkAtlas({ withSubmit = true, extraSels = [], routeTitle = "Percorso: Import data element" } = {}) {
  const ws = mkdtempSync(join(tmpdir(), "compose-bulk-"));
  mkdirSync(join(ws, "customers/ACME/kb/scopes/ADM/templates"), { recursive: true });
  tplYaml(ws, 1, "data element");
  const s = writeDraft({ ws, customer: "ACME", scope: "ADM", draft: { page: { signature: PAGE_SIG, title: "Import data element" }, items: [
    { type: "SEL", label: "Carica file", role: "button", effect: "write" }, ...extraSels,
    ...(withSubmit ? [{ type: "SEL", label: "Importa", role: "button", effect: "write" }] : [])] } });
  const h = writeDraft({ ws, customer: "ACME", scope: "ADM", draft: { page: { signature: "home#benvenuto" }, items: [{ type: "SEL", label: "Import", role: "link", effect: "read" }] } });
  writeDraft({ ws, customer: "ACME", scope: "ADM", draft: { items: [{ type: "FLW", title: routeTitle, trigger: "navigazione", steps: [
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
  assert.deepEqual(steps.at(-1).expect, { page_sig: "adm/import/de" }, "la READ finale confronta la pagina (l'esito lo legge import-result)");
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

// ---- selezione del TPL (ruling): verbo + oggetto come parola intera, plurali, accentate ----
test("tplMatch / pluralOf: verbo di creazione + (numero, articolo) + oggetto o plurale, confini Unicode", () => {
  assert.equal(pluralOf("fornitore"), "fornitori"); assert.equal(pluralOf("contratto"), "contratti"); assert.equal(pluralOf("fattura"), "fatture");
  assert.equal(pluralOf("attività"), "attività"); assert.equal(pluralOf("data element"), "data element");
  const yes = [["fornitore", "crea 5 fornitori"], ["fornitore", "Crea un fornitore"], ["data element", "importa i data element"], ["data element", "crea un data element"],
    ["data element", "crea 3 data element"], ["attività", "crea 3 attività"], ["attività", "crea l'attività"], ["fattura", "aggiungi le fatture"], ["fornitore", "nuovo fornitore"]];
  for (const [o, g] of yes) assert.ok(tplMatch(o, g) >= 0, `${o} / ${g}`);
  const no = [["fornitore", "crea ordine per il fornitore ACME"], ["data element", "elimina il data element DE01"], ["fornitore", "crea fornitoriale"],
    ["attività", "crea attivitàx"], ["fornitore", "modifica il fornitore ACME"], ["fornitore", "il fornitore crea"], ["data element", "crea data elements"]];
  for (const [o, g] of no) assert.equal(tplMatch(o, g), -1, `${o} / ${g}`);
});

test("composePlan: crea ordine per il fornitore ACME non usa il TPL fornitore; elimina il data element non usa il TPL", () => {
  const { ws } = bulkAtlas(); tplYaml(ws, 2, "fornitore", "adm/import/sup#x");
  const base = { ws, customer: "ACME", scope: "ADM", env: ENV, data: {}, planId: "PLAN.ACME.20261007.1002" };
  const a = composePlan({ ...base, goal: "crea ordine per il fornitore ACME" });
  assert.ok(!a.gaps?.some((g) => g.kind === "fill-template"), JSON.stringify(a.gaps));
  const b = composePlan({ ...base, goal: "elimina il data element DE01" });
  assert.ok(!b.gaps?.some((g) => g.kind === "fill-template"), JSON.stringify(b.gaps));
  assert.equal(composePlan({ ...base, goal: "crea 5 fornitori" }).gaps[0].what, "C.ACME.ADM.TPL.0002");
  assert.equal(composePlan({ ...base, goal: "importa i data element" }).gaps[0].what, "C.ACME.ADM.TPL.0001");
});

test("composePlan: più TPL ⇒ vince il match che comincia prima; a parità l'oggetto più lungo; oggetto accentato", () => {
  const { ws } = bulkAtlas(); tplYaml(ws, 2, "element"); tplYaml(ws, 3, "attività");
  const base = { ws, customer: "ACME", scope: "ADM", env: ENV, data: {}, planId: "PLAN.ACME.20261007.1003" };
  assert.equal(composePlan({ ...base, goal: "crea un data element" }).gaps[0].what, "C.ACME.ADM.TPL.0001", "element da solo non segue il verbo");
  assert.equal(composePlan({ ...base, goal: "crea 3 attività" }).gaps[0].what, "C.ACME.ADM.TPL.0003");
  assert.equal(composePlan({ ...base, goal: "importa gli element e crea 2 attività" }).gaps[0].what, "C.ACME.ADM.TPL.0002");
  assert.equal(composePlan({ ...base, goal: "crea 2 attività e importa i data element" }).gaps[0].what, "C.ACME.ADM.TPL.0003");
  // a parità di inizio: l'oggetto più lungo ("data element" batte "data")
  tplYaml(ws, 4, "data");
  assert.equal(composePlan({ ...base, goal: "crea data element" }).gaps[0].what, "C.ACME.ADM.TPL.0001");
});

test("filled senza nessun TPL che corrisponde ⇒ gap no-template, mai il piano a maschera", () => {
  const { ws } = bulkAtlas();
  const r = composePlan({ ws, customer: "ACME", scope: "ADM", env: ENV, goal: "crea ordine per il fornitore ACME", data: {}, planId: "PLAN.ACME.20261007.1004", filled: FILLED });
  assert.equal(r.plan, undefined);
  assert.equal(r.gaps[0].kind, "no-template");
  const f = formAtlas();
  const r2 = composePlan({ ws: f.ws, customer: "ACME", scope: "P2P", env: ENV, goal: "crea ordine", data: { Descrizione: "x", "Centro di costo": "y" }, planId: "PLAN.ACME.PO.0103", filled: FILLED });
  assert.equal(r2.plan, undefined); assert.equal(r2.gaps[0].kind, "no-template");
});

test("via massiva: percorso solo se l'FLW comincia con 'Percorso:'; più SEL di caricamento o d'avvio ⇒ ambiguous", () => {
  const base = { customer: "ACME", scope: "ADM", env: ENV, goal: "crea 3 data element", data: {}, planId: "PLAN.ACME.20261007.1005", filled: FILLED };
  const noRoute = composePlan({ ...base, ws: bulkAtlas({ routeTitle: "Crea data element" }).ws });
  assert.ok(noRoute.gaps.some((g) => g.kind === "no-route"), JSON.stringify(noRoute));
  const up = composePlan({ ...base, ws: bulkAtlas({ extraSels: [{ type: "SEL", label: "Upload file", role: "button", effect: "write" }] }).ws });
  assert.ok(up.gaps.some((g) => g.kind === "ambiguous" && g.what === "caricamento"), JSON.stringify(up));
  const st = composePlan({ ...base, ws: bulkAtlas({ extraSels: [{ type: "SEL", label: "Conferma", role: "button", effect: "write" }] }).ws });
  assert.ok(st.gaps.some((g) => g.kind === "ambiguous" && g.what === "avvio import"), JSON.stringify(st));
});

test("CLI --filled: RUN uguale a quello di --out, niente backslash; valido ⇒ piano scritto con file e sha", async () => {
  const { ws } = bulkAtlas();
  mkdirSync(join(ws, "customers/ACME/config"), { recursive: true });
  writeFileSync(join(ws, "customers/ACME/config/environments.yaml"), YAML.stringify({ environments: [{ id: "sandbox", type: "sandbox" }] }));
  const out = "runs/RUN.ACME.20261007.1000.ADM/plan.json";
  const sha = "b".repeat(64);
  const argv = (filled) => ["--goal", "crea 3 data element", "--scope", "ADM", "--env", "sandbox", "--out", out, "--customer", "ACME", "--workspace", ws, "--json", "--filled", filled];
  const env = { JVC_WORKSPACE: ws };
  const quiet = async (a) => { const l = console.log; console.log = () => {}; try { return await main(a, env); } finally { console.log = l; } };
  assert.equal(await quiet(argv(`runs/RUN.ACME.20261007.1111.ADM/import/de.xlsx:${sha}:3`)), 1, "RUN diverso da --out");
  assert.equal(await quiet(argv(`runs/RUN.ACME.20261007.1000.ADM/import\\de.xlsx:${sha}:3`)), 1, "backslash");
  assert.equal(await quiet(argv(`runs/RUN.ACME.20261007.1000.ADM/import/de.xlsx:abc:3`)), 1, "sha non valido");
  assert.equal(await quiet(argv(`runs/RUN.ACME.20261007.1000.ADM/import/de.xlsx:${sha}:3`)), 0);
  const plan = JSON.parse(readFileSync(join(ws, "customers/ACME", out), "utf8"));
  assert.deepEqual(plan.steps.find((x) => x.verb === "UPLOAD").file, { path: "runs/RUN.ACME.20261007.1000.ADM/import/de.xlsx", sha256: sha, rows: 3 });
});

function formAtlas({ only = null } = {}) {
  const ws = mkdtempSync(join(tmpdir(), "compose-form-"));
  mkdirSync(join(ws, "customers/ACME"), { recursive: true });
  const keep = (l) => !only || only.includes(l);
  const page = { signature: "p2p/po/new#nuovo-ordine", title: "Nuovo ordine" };
  const f = writeDraft({ ws, customer: "ACME", scope: "P2P", draft: { page, items: [
    { type: "FLD", label: "Descrizione", document: "Nuovo ordine", section: "Testata", field_type: "text", mandatory: "always" },
    { type: "FLD", label: "Divisa", document: "Nuovo ordine", section: "Testata", field_type: "list" },
    { type: "FLD", label: "Centro di costo", document: "Nuovo ordine", section: "Testata", field_type: "text", mandatory: "always" }].filter((x) => keep(x.label)) } });
  const s = writeDraft({ ws, customer: "ACME", scope: "P2P", draft: { page, items: [
    ...[["Descrizione", "textbox"], ["Divisa", "combobox"], ["Centro di costo", "textbox"]].filter(([l]) => keep(l)).map(([l, role]) => ({ type: "SEL", label: l, role, field: code(f, l) }))].concat([{ type: "SEL", label: "Salva bozza", role: "button" }]) } });
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
});

test("piano a maschera con UN solo campo con dati: resta un FILL con target, senza fields", () => {
  const { ws, sel } = formAtlas({ only: ["Descrizione"] });
  const one = composePlan({ ws, customer: "ACME", scope: "P2P", env: ENV, goal: "crea ordine", data: { Descrizione: "x" }, planId: "PLAN.ACME.PO.0102" });
  assert.ok(one.plan, JSON.stringify(one.gaps));
  const fills = one.plan.steps.filter((s) => s.verb === "FILL");
  assert.equal(fills.length, 1);
  assert.equal(fills[0].target, sel("Descrizione"));
  assert.equal(fills[0].fields, undefined);
  assert.equal(fills[0].data, "x");
  assert.deepEqual(validatePlan(one.plan, { env: ENV }).errors, []);
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
  assert.match(bindingRefusal(ctxOf(["e1", "e9"]), STEP) ?? "", /non corrisponde a uno dei SEL del passo/);
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

test("bindingRefusal con fields malformato ⇒ negato (fail-closed); il passo con target mantiene il testo storico del rifiuto", () => {
  assert.match(bindingRefusal(ctxOf(["e1"]), { ...STEP, fields: [] }) ?? "", /fields/);
  assert.match(bindingRefusal(ctxOf(["e1"]), { ...STEP, fields: "x" }) ?? "", /fields/);
  assert.match(bindingRefusal(ctxOf(["e1"]), { ...STEP, fields: [{ target: A }, { target: "non-un-sel" }] }) ?? "", /SEL/);
  assert.match(bindingRefusal(ctxOf(["e1"]), { ...STEP, fields: [{ target: A }, { target: A }] }) ?? "", /fields/, "target ripetuto nel passo");
  const one = { n: 1, verb: "FILL", action_class: "ACT-CREATE", target: A };
  assert.equal(bindingRefusal(ctxOf(["e1"]), one), null);
  assert.match(bindingRefusal(ctxOf(["e2"]), one) ?? "", /non corrisponde al SEL del passo C\.ACME\.P2P\.SEL\.0001/);
  assert.match(bindingRefusal(ctxOf(["e1"], { untargeted: true }), one) ?? "", /non si può legare al SEL del passo C\.ACME\.P2P\.SEL\.0001/);
});
