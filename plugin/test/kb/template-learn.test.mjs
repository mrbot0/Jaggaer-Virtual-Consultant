import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import YAML from "yaml";
import { makeZip } from "../../scripts/ingest/lib/zip-write.mjs";
import { learnTemplate } from "../../scripts/kb/template-learn.mjs";

export function demoTemplate() {
  const sheet = `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Codice *</t></is></c><c r="B1" t="inlineStr"><is><t>Descrizione</t></is></c><c r="C1" t="inlineStr"><is><t>Tipo (obbligatorio)</t></is></c></row></sheetData><dataValidations count="1"><dataValidation type="list" sqref="C2:C1000"><formula1>"Testo,Numero,Data"</formula1></dataValidation></dataValidations></worksheet>`;
  const wb = `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Data Elements" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const rels = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`;
  return makeZip([{ name: "xl/workbook.xml", data: wb }, { name: "xl/_rels/workbook.xml.rels", data: rels }, { name: "xl/worksheets/sheet1.xml", data: sheet }]);
}

test("template-learn: colonne, obbligatori da '*' e '(obbligatorio)', liste dalle convalide; item TPL e file vuoto", () => {
  const ws = mkdtempSync(join(tmpdir(), "tpl-")); mkdirSync(join(ws, "customers/ACME"), { recursive: true });
  const f = join(ws, "de.xlsx"); writeFileSync(f, demoTemplate());
  const r = learnTemplate({ ws, customer: "ACME", scope: "ADM", file: f, object: "data element" });
  assert.equal(r.code, "C.ACME.ADM.TPL.0001");
  const it = YAML.parse(readFileSync(join(ws, "customers/ACME/kb/scopes/ADM/templates/C.ACME.ADM.TPL.0001.yaml"), "utf8"));
  assert.deepEqual(it.columns.map((c) => [c.name, c.required, c.type, c.values]), [["Codice", true, "text", null], ["Descrizione", false, "text", null], ["Tipo", true, "list", ["Testo", "Numero", "Data"]]]);
  assert.equal(it.sheet, "Data Elements"); assert.equal(it.header_row, 1); assert.equal(it.source, "utente");
  assert.ok(existsSync(join(ws, "customers/ACME/kb/scopes/ADM/templates/files/C.ACME.ADM.TPL.0001.xlsx")));
  assert.equal(learnTemplate({ ws, customer: "ACME", scope: "ADM", file: f, object: "data element", source: "tenant" }).code, "C.ACME.ADM.TPL.0001", "stesso oggetto ⇒ stessa voce aggiornata");
});

test("template-learn: intestazione non in riga 1 ⇒ header_row; la voce valida per lo schema TPL e il reindex la lascia stare", async () => {
  const { reindex } = await import("../../scripts/kb/reindex.mjs");
  const { validateItem } = await import("../../scripts/kb/validate-schema.mjs");
  const ws = mkdtempSync(join(tmpdir(), "tpl-")); mkdirSync(join(ws, "customers/ACME"), { recursive: true });
  const sheet = `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="3"><c r="A3" t="inlineStr"><is><t>Nome *</t></is></c><c r="B3" t="inlineStr"><is><t>Quantità</t></is></c></row><row r="4"><c r="A4" t="inlineStr"><is><t>x</t></is></c><c r="B4"><v>5</v></c></row></sheetData></worksheet>`;
  const wb = `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Dati" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const rels = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`;
  const f = join(ws, "w.xlsx"); writeFileSync(f, makeZip([{ name: "xl/workbook.xml", data: wb }, { name: "xl/_rels/workbook.xml.rels", data: rels }, { name: "xl/worksheets/sheet1.xml", data: sheet }]));
  const a = learnTemplate({ ws, customer: "ACME", scope: "ADM", file: f, object: "workflow", module: "Admin", page: "sig-1" });
  assert.equal(a.item.header_row, 3);
  // revisione finale (Ruling F3): example non salva valori di celle; il tipo si deduce ancora dal primo valore
  assert.deepEqual(a.item.columns.map((c) => [c.name, c.required, c.type, c.example]), [["Nome", true, "text", null], ["Quantità", false, "number", null]]);
  assert.ok(validateItem(a.item).ok, validateItem(a.item).errors.join("; "));
  assert.equal(validateItem({ ...a.item, header_row: 0 }).ok, false);
  assert.equal(validateItem({ ...a.item, columns: [{ name: "x", required: true, type: "date" }] }).ok, false);
  // un secondo oggetto prende il numero successivo
  assert.equal(learnTemplate({ ws, customer: "ACME", scope: "ADM", file: f, object: "altro" }).code, "C.ACME.ADM.TPL.0002");
  // la cartella templates/ non rompe l'indice: voce non indicizzata, non contata come invalida
  const st = reindex(join(ws, "customers/ACME"), join(ws, "k.db"));
  assert.equal(st.invalid, 0); assert.equal(st.upserted, 0);
});

test("template-learn: errori d'uso (scope, cliente, oggetto, foglio senza intestazione)", () => {
  const ws = mkdtempSync(join(tmpdir(), "tpl-")); const f = join(ws, "de.xlsx"); writeFileSync(f, demoTemplate());
  assert.throws(() => learnTemplate({ ws, customer: "ACME", scope: "ZZZ", file: f, object: "x" }), /scope non valido/);
  assert.throws(() => learnTemplate({ ws, customer: "acme", scope: "ADM", file: f, object: "x" }), /cliente non valido/);
  assert.throws(() => learnTemplate({ ws, customer: "ACME", scope: "ADM", file: f, object: " " }), /--object/);
  assert.throws(() => learnTemplate({ ws, customer: "ACME", scope: "ADM", file: f, object: "x", source: "web" }), /--fonte/);
});
