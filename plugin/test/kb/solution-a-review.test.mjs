// Soluzione A — revisione finale: ogni finding Critical/Important riprodotto da un test (RED prima della correzione).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseSnapshot } from "../../scripts/chrome/snapshot-parse.mjs";
import { pageRecord } from "../../hooks/lib/atlas-log.mjs";
import { buildDrafts, atlasBuild, main as atlasBuildMain } from "../../scripts/kb/atlas-build.mjs";
import { writeDraft } from "../../scripts/kb/atlas-write.mjs";
import { atlasIndex, atlasMatch } from "../../scripts/chrome/atlas.mjs";
import { composePlan } from "../../scripts/decide/compose-plan.mjs";

const ENV = { id: "sandbox", type: "sandbox" };
const ws0 = () => { const ws = mkdtempSync(join(tmpdir(), "sa-rev-")); mkdirSync(join(ws, "customers/ACME"), { recursive: true }); mkdirSync(join(ws, "customers/BETA/.sessions/sb/atlas"), { recursive: true }); return ws; };
const quiet = async (fn) => { const l = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = l; } };
const code = (r, label) => r.written.find((w) => w.label.trim() === label)?.code;

// Critical 1 — isolamento dei clienti: --session e --scope mai usati come percorso senza validazione
test("C1: atlas-build rifiuta una sessione con percorso e uno scope fuori registro; compose-plan rifiuta uno scope fuori registro", async () => {
  const ws = ws0();
  writeFileSync(join(ws, "customers/BETA/.sessions/sb/atlas/pages.jsonl"), `${JSON.stringify({ kind: "page", page_sig: "x#y", title: "Y", url_path: "/x", elements: [{ i: 0, parent: null, role: "button", name: "Segreto BETA" }] })}\n`);
  assert.throws(() => atlasBuild({ ws, customer: "ACME", scope: "P2P", sid: "../../BETA/.sessions/sb" }), (e) => e.code === 1);
  assert.throws(() => atlasBuild({ ws, customer: "ACME", scope: "../../../BETA", sid: "sa" }), (e) => e.code === 1);
  assert.equal(await quiet(() => atlasBuildMain(["--session", "../../BETA/.sessions/sb", "--customer", "ACME", "--scope", "P2P", "--workspace", ws], {})), 1);
  assert.throws(() => composePlan({ ws, customer: "ACME", scope: "../../../BETA/kb/scopes/P2P", env: ENV, goal: "crea ordine", data: {}, planId: "PLAN.ACME.X.1" }), /scope/);
});

function form(ws, buttons, { fields = [["Descrizione", "text", "always"]] } = {}) {
  const page = { signature: "p2p/po/new#nuovo-ordine", title: "Nuovo ordine" };
  const f = writeDraft({ ws, customer: "ACME", scope: "P2P", draft: { page, items: fields.map(([label, field_type, mandatory]) => ({ type: "FLD", label, document: "Nuovo ordine", section: "Testata", field_type, mandatory })) } });
  const s = writeDraft({ ws, customer: "ACME", scope: "P2P", draft: { page, items: [...fields.map(([label]) => ({ type: "SEL", label, role: "textbox", field: code(f, label) })), ...buttons.map((b) => ({ type: "SEL", label: b, role: "button" }))] } });
  const h = writeDraft({ ws, customer: "ACME", scope: "P2P", draft: { page: { signature: "home#benvenuto" }, items: [{ type: "SEL", label: "Ordini", role: "link" }] } });
  writeDraft({ ws, customer: "ACME", scope: "P2P", draft: { items: [{ type: "FLW", title: "Percorso: Nuovo ordine", trigger: "navigazione", steps: [
    { verb: "NAVIGATE", action_class: "ACT-OBS", target: { url_pattern: "/home" }, expect: { page_sig: "home" } },
    { verb: "CLICK", action_class: "ACT-OBS", target: code(h, "Ordini"), expect: { page_sig: "p2p/po/new" } }] }] } });
  return (label) => code(s, label);
}

// Critical 2 — il salvataggio non può premere un pulsante che invia senza il "sì"
test("C2: SAVE mai su 'Salva e invia'; più salvataggi non di bozza ⇒ ambiguo; solo 'Salva e invia' ⇒ no-save", () => {
  let ws = ws0();
  let sel = form(ws, ["Salva e invia", "Salva"]);
  let r = composePlan({ ws, customer: "ACME", scope: "P2P", env: ENV, goal: "crea ordine", data: { Descrizione: "x" }, planId: "PLAN.ACME.C2.1" });
  assert.ok(r.plan, JSON.stringify(r.gaps));
  assert.equal(r.plan.steps.find((s) => s.verb === "SAVE").target, sel("Salva"));
  ws = ws0(); form(ws, ["Salva e invia"]);
  r = composePlan({ ws, customer: "ACME", scope: "P2P", env: ENV, goal: "crea ordine", data: { Descrizione: "x" }, planId: "PLAN.ACME.C2.2" });
  assert.ok(r.gaps?.some((g) => g.kind === "no-save"), JSON.stringify(r));
  ws = ws0(); form(ws, ["Salva", "Salva e chiudi"]);
  r = composePlan({ ws, customer: "ACME", scope: "P2P", env: ENV, goal: "crea ordine", data: { Descrizione: "x" }, planId: "PLAN.ACME.C2.3" });
  assert.ok(r.gaps?.some((g) => g.kind === "ambiguous"), JSON.stringify(r));
});

// Important 3 — stessa etichetta due volte nella pagina ⇒ mancanza "ambiguous", mai una scelta a caso
test("I3: 'Descrizione' in Testata e in Righe ⇒ compose-plan restituisce ambiguous", () => {
  const ws = ws0();
  mkdirSync(join(ws, "customers/ACME/.sessions/sa/atlas"), { recursive: true });
  const home = { kind: "page", page_sig: "home#benvenuto", title: "Home", url_path: "/home", elements: [{ i: 0, parent: null, role: "heading", name: "Benvenuto", level: 1 }, { i: 1, parent: null, role: "link", name: "Ordini" }] };
  const frm = { kind: "page", page_sig: "p2p/po/new#nuovo-ordine", title: "Nuovo ordine", url_path: "/p2p/po/new", elements: [
    { i: 0, parent: null, role: "heading", name: "Nuovo ordine", level: 1 }, { i: 1, parent: null, role: "group", name: "Testata" }, { i: 2, parent: 1, role: "textbox", name: "Descrizione" },
    { i: 3, parent: null, role: "group", name: "Righe" }, { i: 4, parent: 3, role: "textbox", name: "Descrizione" }, { i: 5, parent: null, role: "button", name: "Salva bozza" }] };
  writeFileSync(join(ws, "customers/ACME/.sessions/sa/atlas/pages.jsonl"), [home, { kind: "click", from_sig: "home#benvenuto", target: { name: "Ordini" } }, frm].map((l) => JSON.stringify(l)).join("\n") + "\n");
  atlasBuild({ ws, customer: "ACME", scope: "P2P", sid: "sa" });
  const r = composePlan({ ws, customer: "ACME", scope: "P2P", env: ENV, goal: "crea ordine", data: { Descrizione: "x" }, planId: "PLAN.ACME.I3.1" });
  assert.ok(r.gaps?.some((g) => g.kind === "ambiguous" && g.what === "Descrizione"), JSON.stringify(r));
});

// Important 4 e 5 — registro: niente intestazioni di riga dei record, percorso dell'URL redatto
test("I4/I5: rowheader dentro le righe escluso; url_path redatto", () => {
  const snap = `uid=1_0 RootWebArea "X" url="https://h/p2p/users/mario.rossi@acme.it/orders"\n  uid=1_1 table "T"\n    uid=1_2 row\n      uid=1_3 columnheader "Ordine"\n    uid=1_4 row\n      uid=1_5 rowheader "PO-123 Giuseppe Verdi"\n`;
  const r = pageRecord(parseSnapshot(snap), { pageSig: "x", profile: "strict", env: {} });
  // esplorazione completa (05/10/2026): l'intestazione di riga di un record si registra marcata record
  assert.equal(r.elements.find((e) => /Giuseppe/.test(e.name))?.record, true, JSON.stringify(r));
  assert.ok(r.elements.some((e) => e.name === "Ordine"));
  assert.ok(!r.url_path.includes("mario.rossi"), r.url_path);
});

// Important 6 — più visite della stessa pagina: opzioni e obbligo uniti
test("I6: la seconda visita (tendina aperta, required) arricchisce il campo", () => {
  const v1 = { kind: "page", page_sig: "p#f", title: "Nuovo ordine", url_path: "/p", elements: [{ i: 0, parent: null, role: "heading", name: "Nuovo ordine", level: 1 }, { i: 1, parent: null, role: "combobox", name: "Divisa" }] };
  const v2 = { ...v1, elements: [{ i: 0, parent: null, role: "heading", name: "Nuovo ordine", level: 1 }, { i: 1, parent: null, role: "combobox", name: "Divisa", required: true }, { i: 2, parent: 1, role: "option", name: "EUR" }, { i: 3, parent: 1, role: "option", name: "USD" }] };
  const f = buildDrafts([v1, v2]).fields.find((x) => x.label === "Divisa");
  assert.deepEqual([f.mandatory, f.options], ["always", ["EUR", "USD"]]);
});

// Important 7 — un click su un pulsante con effetto non diventa un passo di percorso
test("I7: nessun percorso attraverso 'Conferma'", () => {
  const a = { kind: "page", page_sig: "a#a", title: "A", url_path: "/a", elements: [{ i: 0, parent: null, role: "button", name: "Conferma" }] };
  const b = { kind: "page", page_sig: "b#b", title: "B", url_path: "/b", elements: [] };
  assert.equal(buildDrafts([a, { kind: "click", from_sig: "a#a", target: { name: "Conferma" } }, b]).routes.length, 0);
});

// Important 8 — procedura memorizzata con invio e richiesta "solo bozza": niente SUBMIT
test("I8: --fino-a bozza su una procedura con SUBMIT ⇒ si ferma al salvataggio", () => {
  const ws = ws0();
  const sel = form(ws, ["Salva bozza", "Invia"]);
  writeDraft({ ws, customer: "ACME", scope: "P2P", draft: { items: [{ type: "FLW", title: "Crea ordine", steps: [
    { verb: "NAVIGATE", action_class: "ACT-OBS", target: { url_pattern: "/p2p/po/new" }, expect: { page_sig: "p2p/po/new" } },
    { verb: "FILL", action_class: "ACT-CREATE", target: sel("Descrizione"), data: "v", expect: { elements: [{ sel: sel("Descrizione") }] } },
    { verb: "SAVE", action_class: "ACT-CREATE", target: sel("Salva bozza"), expect: { page_sig: "p2p/po" } },
    { verb: "SUBMIT", action_class: "ACT-SUBMIT", target: sel("Invia"), expect: { page_sig: "p2p/po" } }] }] } });
  const r = composePlan({ ws, customer: "ACME", scope: "P2P", env: ENV, goal: "crea ordine", data: { Descrizione: "n" }, until: "bozza", planId: "PLAN.ACME.I8.1" });
  assert.ok(r.plan, JSON.stringify(r.gaps));
  assert.ok(!r.plan.steps.some((s) => s.verb === "SUBMIT"));
});

// Important 9 — la stessa etichetta su pagine diverse non è un doppione; l'abbinamento preferisce la pagina corrente
test("I9: 'Salva' su due pagine ⇒ due SEL; atlasMatch con la pagina sceglie quello della pagina", () => {
  const ws = ws0();
  const a = writeDraft({ ws, customer: "ACME", scope: "P2P", draft: { page: { signature: "a#a" }, items: [{ type: "SEL", label: "Salva", role: "button" }] } });
  const b = writeDraft({ ws, customer: "ACME", scope: "P2P", draft: { page: { signature: "b#b" }, items: [{ type: "SEL", label: "Salva", role: "button" }] } });
  assert.equal(b.written.length, 1, JSON.stringify(b));
  const atlas = atlasIndex(ws, "ACME", "P2P");
  assert.equal(atlasMatch(atlas, { role: "button", name: "Salva" }, { page: "b#b" })?.code, b.written[0].code);
  assert.equal(atlasMatch(atlas, { role: "button", name: "Salva" }, { page: "a#a" })?.code, a.written[0].code);
});
