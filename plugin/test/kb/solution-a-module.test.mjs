// Soluzione A — modulo di appartenenza (richiesta dell'utente, 30/09/2026): ogni pagina, e quindi SEL, FLD e percorsi,
// porta il modulo JAGGAER ricavato dalle briciole di pane o dal percorso di menu; copertura per modulo; compose-plan
// distingue lo stesso modulo di creazione in moduli diversi.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import YAML from "yaml";
import { buildDrafts, atlasBuild } from "../../scripts/kb/atlas-build.mjs";
import { composePlan } from "../../scripts/decide/compose-plan.mjs";
import { validatePlan } from "../../scripts/decide/validate-plan.mjs";

const ENV = { id: "sandbox", type: "sandbox" };
const H1 = (name) => ({ i: 0, parent: null, role: "heading", name, level: 1 });
const ws0 = () => { const ws = mkdtempSync(join(tmpdir(), "sa-mod-")); mkdirSync(join(ws, "customers/ACME/.sessions/s1/atlas"), { recursive: true }); return ws; };
const click = (from, name) => ({ kind: "click", from_sig: from, target: { name } });
const page = (sig, h1, extra = []) => ({ kind: "page", page_sig: sig, title: h1, url_path: `/${sig.split("#")[0]}`, elements: [H1(h1), ...extra.map((e, k) => ({ i: k + 1, parent: null, ...e }))] });

test("modulo dalle briciole di pane della pagina", () => {
  const els = [H1("Nuovo ordine"), { i: 1, parent: null, role: "navigation", name: "Breadcrumb" }, { i: 2, parent: 1, role: "link", name: "Acquisti" }, { i: 3, parent: 1, role: "link", name: "Ordini" },
    { i: 4, parent: null, role: "textbox", name: "Descrizione" }];
  const d = buildDrafts([{ kind: "page", page_sig: "p2p/po/new#nuovo-ordine", title: "Nuovo ordine", url_path: "/p2p/po/new", elements: els }]);
  assert.equal(d.pages.get("p2p/po/new#nuovo-ordine").module, "Acquisti › Ordini");
  assert.equal(d.fields.find((f) => f.label === "Descrizione").module, "Acquisti › Ordini");
});

test("modulo dal percorso di menu: i click verso pagine che non sono moduli di creazione, al più due", () => {
  const LOG = [page("home#home", "Home", [{ role: "link", name: "Acquisti" }]), click("home#home", "Acquisti"),
    page("p2p#acquisti", "Acquisti", [{ role: "link", name: "Ordini" }]), click("p2p#acquisti", "Ordini"),
    page("p2p/po#ordini", "Ordini", [{ role: "button", name: "Nuovo ordine" }]), click("p2p/po#ordini", "Nuovo ordine"),
    page("p2p/po/new#nuovo-ordine", "Nuovo ordine", [{ role: "textbox", name: "Descrizione" }, { role: "button", name: "Salva bozza" }])];
  const d = buildDrafts(LOG);
  assert.equal(d.pages.get("home#home").module ?? null, null);
  assert.equal(d.pages.get("p2p#acquisti").module, "Acquisti");
  assert.equal(d.pages.get("p2p/po#ordini").module, "Acquisti › Ordini");
  assert.equal(d.pages.get("p2p/po/new#nuovo-ordine").module, "Acquisti › Ordini");
});

test("atlas-build scrive il modulo su SEL, FLD e percorsi e riassume la copertura per modulo", () => {
  const ws = ws0();
  const LOG = [page("home#home", "Home", [{ role: "link", name: "Ordini" }]), click("home#home", "Ordini"),
    page("p2p/po#ordini", "Ordini", [{ role: "button", name: "Nuovo ordine" }]), click("p2p/po#ordini", "Nuovo ordine"),
    page("p2p/po/new#nuovo-ordine", "Nuovo ordine", [{ role: "combobox", name: "Divisa" }, { role: "button", name: "Salva bozza" }])];
  writeFileSync(join(ws, "customers/ACME/.sessions/s1/atlas/pages.jsonl"), `${LOG.map((l) => JSON.stringify(l)).join("\n")}\n`);
  const r = atlasBuild({ ws, customer: "ACME", scope: "P2P", sid: "s1" });
  const kb = join(ws, "customers/ACME/kb/scopes/P2P");
  const load = (dir) => readdirSync(join(kb, dir)).map((f) => YAML.parse(readFileSync(join(kb, dir, f), "utf8")));
  assert.equal(load("fields").find((f) => f.label.it === "Divisa").module, "Ordini");
  assert.equal(load("selectors").find((s) => s.label === "Salva bozza").module, "Ordini");
  assert.equal(load("flows").find((f) => f.title === "Percorso: Nuovo ordine").module, "Ordini");
  assert.equal(r.modules.Ordini.pages, 2, JSON.stringify(r.modules));
  assert.ok(r.modules.Ordini.fields >= 1 && r.modules.Ordini.todo >= 1, JSON.stringify(r.modules));
  assert.ok(r.todo.every((t) => "module" in t));
});

test("lo stesso 'Nuovo ordine' in due moduli: campi distinti; compose-plan senza modulo ⇒ ambiguo, con --modulo ⇒ piano", () => {
  const ws = ws0();
  const form = () => [{ role: "textbox", name: "Descrizione" }, { role: "button", name: "Salva bozza" }];
  const LOG = [page("home#home", "Home", [{ role: "link", name: "Acquisti" }, { role: "link", name: "Contratti" }]),
    click("home#home", "Acquisti"), page("p2p#acquisti", "Acquisti", [{ role: "button", name: "Nuovo ordine" }]),
    click("p2p#acquisti", "Nuovo ordine"), page("p2p/po/new#nuovo-ordine", "Nuovo ordine", form()),
    page("home#home", "Home", [{ role: "link", name: "Acquisti" }, { role: "link", name: "Contratti" }]),
    click("home#home", "Contratti"), page("con#contratti", "Contratti", [{ role: "button", name: "Nuovo ordine" }]),
    click("con#contratti", "Nuovo ordine"), page("con/po/new#nuovo-ordine", "Nuovo ordine", form())];
  writeFileSync(join(ws, "customers/ACME/.sessions/s1/atlas/pages.jsonl"), `${LOG.map((l) => JSON.stringify(l)).join("\n")}\n`);
  atlasBuild({ ws, customer: "ACME", scope: "P2P", sid: "s1" });
  const flds = readdirSync(join(ws, "customers/ACME/kb/scopes/P2P/fields")).map((f) => YAML.parse(readFileSync(join(ws, "customers/ACME/kb/scopes/P2P/fields", f), "utf8")));
  assert.equal(flds.filter((f) => f.label.it === "Descrizione").length, 2, "un campo per modulo");
  const amb = composePlan({ ws, customer: "ACME", scope: "P2P", env: ENV, goal: "crea ordine", data: { Descrizione: "x" }, planId: "PLAN.ACME.MOD.1" });
  assert.ok(amb.gaps?.some((g) => g.kind === "ambiguous" && g.what === "modulo" && /Acquisti/.test(g.hint) && /Contratti/.test(g.hint)), JSON.stringify(amb));
  const r = composePlan({ ws, customer: "ACME", scope: "P2P", env: ENV, goal: "crea ordine", data: { Descrizione: "x" }, module: "Contratti", planId: "PLAN.ACME.MOD.2" });
  assert.ok(r.plan, JSON.stringify(r.gaps));
  assert.deepEqual(validatePlan(r.plan, { env: ENV }).errors, []);
  assert.equal(r.plan.steps.filter((s) => s.verb === "CLICK").length, 2);
});
