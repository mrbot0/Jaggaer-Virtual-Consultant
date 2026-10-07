import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { learnTemplate } from "../../scripts/kb/template-learn.mjs";
import { fillTemplate, main } from "../../scripts/decide/template-fill.mjs";
import { openZip } from "../../scripts/ingest/lib/zip.mjs";
import { parseXlsx } from "../../scripts/ingest/parse-xlsx.mjs";
import { demoTemplate } from "../kb/template-learn.test.mjs";
import { makeZip as makeZipLocal } from "../../scripts/ingest/lib/zip-write.mjs";

const OUT = "runs/RUN.ACME.20261007.1000.ADM/import/de.xlsx";
function setup() {
  const ws = mkdtempSync(join(tmpdir(), "tf-")); mkdirSync(join(ws, "customers/ACME/runs/RUN.ACME.20261007.1000.ADM"), { recursive: true });
  const f = join(ws, "de.xlsx"); writeFileSync(f, demoTemplate());
  learnTemplate({ ws, customer: "ACME", scope: "ADM", file: f, object: "data element" });
  return ws;
}

test("template-fill: righe valide ⇒ xlsx rileggibile con convalide intatte; righe invalide ⇒ errori, nessun file", () => {
  const ws = setup();
  const ok = fillTemplate({ ws, customer: "ACME", scope: "ADM", tpl: "C.ACME.ADM.TPL.0001", out: OUT, rows: [{ Codice: "DE_001", Descrizione: "Centro & costo", Tipo: "Testo" }, { Codice: "DE_002", Tipo: "Numero" }] });
  assert.equal(ok.ok, true); assert.equal(ok.rows, 2); assert.match(ok.sha256, /^[0-9a-f]{64}$/);
  const doc = parseXlsx(readFileSync(join(ws, "customers/ACME", OUT)), { id: "x" });
  assert.deepEqual(doc.sections[0].tables[0].rows.map((r) => r.slice(0, 3)), [["DE_001", "Centro & costo", "Testo"], ["DE_002", null, "Numero"]]);
  assert.deepEqual(doc.sections[0].validations[0].values, ["Testo", "Numero", "Data"]);
  const bad = fillTemplate({ ws, customer: "ACME", scope: "ADM", tpl: "C.ACME.ADM.TPL.0001", out: OUT.replace("de.xlsx", "de2.xlsx"), rows: [{ Descrizione: "x", Tipo: "Booleano" }, { Codice: "A", Colore: "rosso" }] });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.errors.map((e) => [e.row, e.column]), [[1, "Codice"], [1, "Tipo"], [2, "Tipo"], [2, "Colore"]]);
});

test("template-fill: uscita fuori da runs/<RUN>/import/ o file già esistente ⇒ errore", () => {
  const ws = setup();
  assert.throws(() => fillTemplate({ ws, customer: "ACME", scope: "ADM", tpl: "C.ACME.ADM.TPL.0001", out: "config/x.xlsx", rows: [{ Codice: "A", Tipo: "Testo" }] }), /runs\/<RUN>\/import/);
  fillTemplate({ ws, customer: "ACME", scope: "ADM", tpl: "C.ACME.ADM.TPL.0001", out: OUT, rows: [{ Codice: "A", Tipo: "Testo" }] });
  assert.throws(() => fillTemplate({ ws, customer: "ACME", scope: "ADM", tpl: "C.ACME.ADM.TPL.0001", out: OUT, rows: [{ Codice: "B", Tipo: "Testo" }] }), /esiste già/);
});

test("template-fill: sha256 = impronta dei byte scritti; codice TPL, cliente e scope validati prima di toccare i percorsi", () => {
  const ws = setup();
  const r = fillTemplate({ ws, customer: "ACME", scope: "ADM", tpl: "C.ACME.ADM.TPL.0001", out: OUT, rows: [{ Codice: "A", Tipo: "Testo" }] });
  assert.equal(r.sha256, createHash("sha256").update(readFileSync(join(ws, "customers/ACME", OUT))).digest("hex"));
  const base = { ws, customer: "ACME", scope: "ADM", out: OUT.replace("de.xlsx", "x.xlsx"), rows: [{ Codice: "A", Tipo: "Testo" }] };
  assert.throws(() => fillTemplate({ ...base, tpl: "../../../../x" }), /codice TPL non valido/);
  assert.throws(() => fillTemplate({ ...base, tpl: "C.ACME.ADM.TPL.0001/../../x" }), /codice TPL non valido/);
  assert.throws(() => fillTemplate({ ...base, tpl: "C.ACME.ADM.TPL.0001", customer: "../x" }), /cliente non valido/);
  assert.throws(() => fillTemplate({ ...base, tpl: "C.ACME.ADM.TPL.0001", scope: "ZZZ" }), /scope non valido/);
  assert.throws(() => fillTemplate({ ...base, tpl: "C.ACME.ADM.TPL.0009" }), /template .* non trovato/);
});

test("template-fill: le righe d'esempio sotto l'intestazione si tolgono; intestazione e convalide restano; numeri come numeri", () => {
  const ws = mkdtempSync(join(tmpdir(), "tf-")); mkdirSync(join(ws, "customers/ACME/runs/RUN.ACME.20261007.1000.ADM"), { recursive: true });
  const sheet = `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A3:B5"/><sheetData><row r="3"><c r="A3" t="inlineStr"><is><t>Nome *</t></is></c><c r="B3" t="inlineStr"><is><t>Quantità</t></is></c></row><row r="4"><c r="A4" t="inlineStr"><is><t>esempio</t></is></c><c r="B4"><v>5</v></c></row><row r="5"><c r="A5" t="inlineStr"><is><t>altro</t></is></c><c r="B5"><v>7</v></c></row></sheetData><mergeCells count="1"><mergeCell ref="A1:B1"/></mergeCells></worksheet>`;
  const wb = `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Dati" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const rels = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`;
  const f = join(ws, "w.xlsx");
  writeFileSync(f, makeZipLocal([{ name: "xl/workbook.xml", data: wb }, { name: "xl/_rels/workbook.xml.rels", data: rels }, { name: "xl/worksheets/sheet1.xml", data: sheet }]));
  learnTemplate({ ws, customer: "ACME", scope: "ADM", file: f, object: "workflow" });
  const r = fillTemplate({ ws, customer: "ACME", scope: "ADM", tpl: "C.ACME.ADM.TPL.0001", out: OUT, rows: [{ Nome: "uno", Quantità: 3 }] });
  assert.equal(r.ok, true);
  const doc = parseXlsx(readFileSync(join(ws, "customers/ACME", OUT)), { id: "x" });
  assert.deepEqual(doc.sections[0].tables[0].headers.slice(0, 2), ["Nome *", "Quantità"]);
  assert.deepEqual(doc.sections[0].tables[0].rows.map((x) => x.slice(0, 2)), [["uno", 3]]);
  const sx = openZip(readFileSync(join(ws, "customers/ACME", OUT))).text("xl/worksheets/sheet1.xml");
  assert.ok(sx.includes('<mergeCells count="1"><mergeCell ref="A1:B1"/></mergeCells>'), "celle unite intatte");
  assert.ok(sx.includes('<dimension ref="A3:B4"/>'), "dimensione aggiornata");
  assert.doesNotMatch(sx, /esempio|altro/);
});

test("template-fill CLI: 0 ok · 3 righe invalide · 1 uso (uscita fuori da runs/<RUN>/import/)", async () => {
  const ws = setup();
  writeFileSync(join(ws, "righe.json"), JSON.stringify([{ Codice: "A", Tipo: "Testo" }]));
  writeFileSync(join(ws, "male.yaml"), "- Descrizione: x\n");
  const env = { JVC_WORKSPACE: ws, CLAUDE_PROJECT_DIR: ws };
  const a = ["--tpl", "C.ACME.ADM.TPL.0001", "--scope", "ADM", "--customer", "ACME", "--workspace", ws, "--json"];
  assert.equal(await main([...a, "--data", join(ws, "righe.json"), "--out", OUT], env), 0);
  assert.equal(await main([...a, "--data", join(ws, "male.yaml"), "--out", OUT.replace("de.xlsx", "m.xlsx")], env), 3);
  assert.equal(await main([...a, "--data", join(ws, "righe.json"), "--out", "config/x.xlsx"], env), 1);
  assert.equal(await main([...a, "--data", join(ws, "righe.json"), "--out", OUT], env), 1, "già esistente ⇒ uso");
  assert.equal(await main([...a, "--data", join(ws, "..", "fuori.json"), "--out", OUT.replace("de.xlsx", "n.xlsx")], env), 1, "--data fuori dal workspace");
});


// foglio xlsx minimo per i test: sheetXml dentro un workbook con un solo foglio "Dati"
function mini(sheetXml, { rels = null, sheetName = "Dati" } = {}) {
  const wb = `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${sheetName}" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const r = rels ?? `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`;
  return makeZipLocal([{ name: "xl/workbook.xml", data: wb }, { name: "xl/_rels/workbook.xml.rels", data: r }, { name: "xl/worksheets/sheet1.xml", data: sheetXml }]);
}
function setupWith(buf, object = "oggetto") {
  const ws = mkdtempSync(join(tmpdir(), "tf-")); mkdirSync(join(ws, "customers/ACME/runs/RUN.ACME.20261007.1000.ADM"), { recursive: true });
  const f = join(ws, "t.xlsx"); writeFileSync(f, buf);
  const r = learnTemplate({ ws, customer: "ACME", scope: "ADM", file: f, object });
  return { ws, tpl: r.code, item: r.item };
}
const inl = (ref, t) => `<c r="${ref}" t="inlineStr"><is><t>${t}</t></is></c>`;
const readBack = (ws) => parseXlsx(readFileSync(join(ws, "customers/ACME", OUT)), { id: "x" }).sections[0].tables[0];

test("template-fill: '$&', \"$'\", '$`', '$$' nei valori tornano identici (nessun pattern di sostituzione)", () => {
  const ws = setup();
  const vals = ["Costo $& totale", "a $' b", "x $` y", "US$$", "$1 e $<n>"];
  const r = fillTemplate({ ws, customer: "ACME", scope: "ADM", tpl: "C.ACME.ADM.TPL.0001", out: OUT, rows: vals.map((v, i) => ({ Codice: `C${i}`, Descrizione: v, Tipo: "Testo" })) });
  assert.equal(r.ok, true);
  assert.deepEqual(readBack(ws).rows.map((x) => x[1]), vals);
});

test("template-fill: ']]>', NUL e '<&>' nei valori: i caratteri illegali in XML si tolgono, il resto torna identico", () => {
  const ws = setup();
  const r = fillTemplate({ ws, customer: "ACME", scope: "ADM", tpl: "C.ACME.ADM.TPL.0001", out: OUT, rows: [
    { Codice: "A", Descrizione: "uno ]]> due", Tipo: "Testo" }, { Codice: "B", Descrizione: "nu\u0000ll\uFFFEo\uFFFF", Tipo: "Testo" }, { Codice: "C", Descrizione: "<a href=\"x\">&amp; 'q'</a>", Tipo: "Testo" }] });
  assert.equal(r.ok, true);
  assert.deepEqual(readBack(ws).rows.map((x) => x[1]), ["uno ]]> due", "nullo", "<a href=\"x\">&amp; 'q'</a>"]);
});

test("template-fill: foglio con prefisso di namespace (x:sheetData, x:row) ⇒ i dati ci sono davvero", () => {
  const sheet = `<x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><x:dimension ref="A1:B2"/><x:sheetData><x:row r="1"><x:c r="A1" t="inlineStr"><x:is><x:t>Nome *</x:t></x:is></x:c><x:c r="B1" t="inlineStr"><x:is><x:t>Nota</x:t></x:is></x:c></x:row><x:row r="2"><x:c r="A2" t="inlineStr"><x:is><x:t>vecchio</x:t></x:is></x:c></x:row></x:sheetData></x:worksheet>`;
  const { ws, tpl } = setupWith(mini(sheet));
  const r = fillTemplate({ ws, customer: "ACME", scope: "ADM", tpl, out: OUT, rows: [{ Nome: "uno", Nota: "a$&b" }, { Nome: "due" }] });
  assert.equal(r.ok, true);
  assert.deepEqual(readBack(ws).rows.map((x) => x.slice(0, 2)), [["uno", "a$&b"], ["due", null]]);
  const sx = openZip(readFileSync(join(ws, "customers/ACME", OUT))).text("xl/worksheets/sheet1.xml");
  assert.ok(sx.includes("<x:row r=\"2\">") && !sx.includes("vecchio"));
});

test("template-fill: intestazione vuota in mezzo ⇒ ogni valore nella sua colonna (col dell'item)", () => {
  const sheet = `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1">${inl("A1", "Codice *")}${inl("C1", "Descrizione")}${inl("D1", "Note")}</row></sheetData></worksheet>`;
  const { ws, tpl, item } = setupWith(mini(sheet));
  assert.deepEqual(item.columns.map((c) => [c.name, c.col]), [["Codice", 0], ["Descrizione", 2], ["Note", 3]]);
  const r = fillTemplate({ ws, customer: "ACME", scope: "ADM", tpl, out: OUT, rows: [{ Codice: "K1", Descrizione: "desc", Note: "n1" }, { Codice: "K2", Note: "n2" }] });
  assert.equal(r.ok, true);
  // (parseXlsx scambierebbe la riga 2 per una seconda intestazione: si guardano i riferimenti di cella)
  const sx = openZip(readFileSync(join(ws, "customers/ACME", OUT))).text("xl/worksheets/sheet1.xml");
  const cells = [...sx.matchAll(/<c r="([A-Z]+\d+)"[^>]*>(?:<is><t[^>]*>([^<]*)<\/t><\/is>)?/g)].map((m) => m[1] + "=" + (m[2] ?? ""));
  assert.deepEqual(cells, ["A1=Codice *", "C1=Descrizione", "D1=Note", "A2=K1", "C2=desc", "D2=n1", "A3=K2", "D3=n2"]);
});

test("template-fill: voce senza col (vecchia) ⇒ posizione nell'elenco", async () => {
  const { ws, tpl } = setupWith(demoTemplate(), "vecchio");
  const YAML = (await import("yaml")).default;
  const p = join(ws, "customers/ACME/kb/scopes/ADM/templates", `${tpl}.yaml`);
  const it = YAML.parse(readFileSync(p, "utf8")); it.columns.forEach((c) => delete c.col); writeFileSync(p, YAML.stringify(it));
  assert.equal(fillTemplate({ ws, customer: "ACME", scope: "ADM", tpl, out: OUT, rows: [{ Codice: "A", Descrizione: "d", Tipo: "Testo" }] }).ok, true);
  assert.deepEqual(readBack(ws).rows.map((x) => x.slice(0, 3)), [["A", "d", "Testo"]]);
});

test("template-fill: foglio o relazione non risolti ⇒ errore chiaro, nessun ripiego su sheet1.xml, nessun file", () => {
  const sheet = `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1">${inl("A1", "Nome")}</row></sheetData></worksheet>`;
  const { ws, tpl } = setupWith(mini(sheet));
  const dirf = join(ws, "customers/ACME/kb/scopes/ADM/templates/files", `${tpl}.xlsx`);
  const args = { ws, customer: "ACME", scope: "ADM", tpl, out: OUT, rows: [{ Nome: "x" }] };
  // relazione assente
  writeFileSync(dirf, mini(sheet, { rels: `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>` }));
  assert.throws(() => fillTemplate(args), /foglio "Dati" non risolto/);
  // nome diverso da quello dell'item
  writeFileSync(dirf, mini(sheet, { sheetName: "Altro" }));
  assert.throws(() => fillTemplate(args), /foglio "Dati" non risolto/);
  assert.equal(existsSync(join(ws, "customers/ACME", OUT)), false);
});
