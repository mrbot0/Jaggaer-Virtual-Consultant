// Revisione finale (I5 + Ruling F3, I6 + Ruling F4, Ruling F1): il file salvato come template non ha righe di dati
// (nemmeno nelle shared strings) e l'impronta è quella del file ripulito; la voce non salva valori di celle (example null);
// le intestazioni su più righe sono rifiutate; la voce dichiara kind config|data (--tipo config|dati, predefinito config).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import YAML from "yaml";
import { makeZip } from "../../scripts/ingest/lib/zip-write.mjs";
import { openZip } from "../../scripts/ingest/lib/zip.mjs";
import { parseXlsx } from "../../scripts/ingest/parse-xlsx.mjs";
import { learnTemplate, main } from "../../scripts/kb/template-learn.mjs";
import { fillTemplate } from "../../scripts/decide/template-fill.mjs";

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
const WB = (name) => `<workbook ${NS} xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${name}" sheetId="1" r:id="rId1"/></sheets></workbook>`;
const RELS = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`;
const xlsx = (sheet, extra = []) => makeZip([{ name: "xl/workbook.xml", data: WB("Fornitori") }, { name: "xl/_rels/workbook.xml.rels", data: RELS }, { name: "xl/worksheets/sheet1.xml", data: sheet }, ...extra]);

// Template già compilato con dati del cliente: shared strings (Mario Rossi, IT0123) e un numero (4242)
function populated() {
  const sst = `<sst ${NS} count="5" uniqueCount="5"><si><t>Ragione sociale *</t></si><si><t>Partita IVA</t></si><si><t>Fido</t></si><si><t>Mario Rossi SpA</t></si><si><t>IT0123456789</t></si></sst>`;
  const sheet = `<worksheet ${NS}><dimension ref="A1:C3"/><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row><row r="2"><c r="A2" t="s"><v>3</v></c><c r="B2" t="s"><v>4</v></c><c r="C2"><v>4242</v></c></row><row r="3"><c r="A3" t="inlineStr"><is><t>Bianchi Srl</t></is></c><c r="C3"><v>17</v></c></row></sheetData></worksheet>`;
  return xlsx(sheet, [{ name: "xl/sharedStrings.xml", data: sst }]);
}
const wsWith = () => { const ws = mkdtempSync(join(tmpdir(), "tplf-")); mkdirSync(join(ws, "customers/ACME"), { recursive: true }); return ws; };
const DATA = ["Mario Rossi", "IT0123456789", "4242", "Bianchi", "17"];

test("template-learn: un template compilato si salva SENZA righe di dati (anche nelle shared strings), impronta del file ripulito, example null", () => {
  const ws = wsWith();
  const f = join(ws, "fornitori.xlsx"); writeFileSync(f, populated());
  const r = learnTemplate({ ws, customer: "ACME", scope: "VEN", file: f, object: "fornitore", page: "/vendors/import" });
  const stored = readFileSync(r.blank);
  const t = parseXlsx(stored, { id: "x" }).sections[0].tables[0];
  assert.deepEqual(t.headers, ["Ragione sociale *", "Partita IVA", "Fido"]);
  assert.deepEqual(t.rows, [], "nessuna riga di dati sotto l'intestazione");
  const z = openZip(stored);
  const all = z.names.map((n) => z.text(n)).join("\n");
  for (const v of DATA) assert.ok(!all.includes(v), `il file salvato contiene ancora "${v}"`);
  assert.equal(r.item.sha256, createHash("sha256").update(stored).digest("hex"), "impronta = file ripulito salvato");
  assert.ok(r.item.columns.every((c) => c.example === null), "example sempre null");
  assert.equal(r.item.columns.find((c) => c.name === "Fido").type, "number", "il tipo si deduce ancora (senza salvare il valore)");
  const yamlText = readFileSync(join(ws, "customers/ACME/kb/scopes/VEN/templates", `${r.code}.yaml`), "utf8");
  for (const v of DATA) assert.ok(!yamlText.includes(v), `la voce TPL contiene "${v}"`);
  // il file ripulito resta un template valido per template-fill
  const out = fillTemplate({ ws, customer: "ACME", scope: "VEN", tpl: r.code, rows: [{ "Ragione sociale": "Prova Srl", Fido: 5 }], out: "runs/RUN.ACME.20261007.1000.VEN/import/f.xlsx" });
  assert.equal(out.ok, true, JSON.stringify(out));
});

test("template-learn: intestazione su più righe ⇒ rifiuto chiaro (CLI exit 1)", async () => {
  const ws = wsWith();
  // riga 1 con celle unite sopra una riga 2 tutta testo: parseXlsx la legge come intestazione su due righe
  const sheet = `<worksheet ${NS}><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Anagrafica</t></is></c><c r="C1" t="inlineStr"><is><t>Banca</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Nome</t></is></c><c r="B2" t="inlineStr"><is><t>Città</t></is></c><c r="C2" t="inlineStr"><is><t>IBAN</t></is></c></row></sheetData><mergeCells count="1"><mergeCell ref="A1:B1"/></mergeCells></worksheet>`;
  const f = join(ws, "due-righe.xlsx"); writeFileSync(f, xlsx(sheet));
  assert.throws(() => learnTemplate({ ws, customer: "ACME", scope: "VEN", file: f, object: "fornitore" }), /intestazione su più righe/);
  const err = [];
  const e0 = console.error; const l0 = console.log;
  try {
    console.error = (x) => err.push(String(x)); console.log = (x) => err.push(String(x));
    assert.equal(await main(["--file", f, "--object", "fornitore", "--scope", "VEN", "--customer", "ACME", "--workspace", ws, "--page", "/p"], { JVC_WORKSPACE: ws, JVC_INPUT_BASE: ws }), 1);
  } finally { console.error = e0; console.log = l0; }
  assert.match(err.join("\n"), /intestazione su più righe/);
});

test("template-learn: kind config (predefinito, fail-closed) o data con --tipo dati; --tipo sbagliato ⇒ exit 1", async () => {
  const ws = wsWith();
  const f = join(ws, "fornitori.xlsx"); writeFileSync(f, populated());
  assert.equal(learnTemplate({ ws, customer: "ACME", scope: "VEN", file: f, object: "fornitore" }).item.kind, "config");
  assert.equal(learnTemplate({ ws, customer: "ACME", scope: "VEN", file: f, object: "articolo", kind: "data" }).item.kind, "data");
  assert.throws(() => learnTemplate({ ws, customer: "ACME", scope: "VEN", file: f, object: "x", kind: "altro" }), /--tipo/);
  const out = [];
  const e0 = console.error; const l0 = console.log;
  let a; let b;
  try {
    console.error = (x) => out.push(String(x)); console.log = (x) => out.push(String(x));
    a = await main(["--file", f, "--object", "contratto quadro", "--scope", "VEN", "--customer", "ACME", "--workspace", ws, "--page", "/p", "--tipo", "dati"], { JVC_WORKSPACE: ws, JVC_INPUT_BASE: ws });
    b = await main(["--file", f, "--object", "y", "--scope", "VEN", "--customer", "ACME", "--workspace", ws, "--page", "/p", "--tipo", "boh"], { JVC_WORKSPACE: ws, JVC_INPUT_BASE: ws });
  } finally { console.error = e0; console.log = l0; }
  assert.equal(a, 0, out.join("\n"));
  assert.equal(JSON.parse(out.find((l) => l.startsWith("{"))).kind, "data");
  assert.equal(b, 1);
});

test("template-learn: lo schema TPL accetta kind config|data (assente nelle voci vecchie) e rifiuta altri valori", async () => {
  const { validateItem } = await import("../../scripts/kb/validate-schema.mjs");
  const ws = wsWith();
  const f = join(ws, "fornitori.xlsx"); writeFileSync(f, populated());
  const { item } = learnTemplate({ ws, customer: "ACME", scope: "VEN", file: f, object: "fornitore" });
  assert.ok(validateItem(item).ok);
  const { kind, ...old } = item;
  assert.equal(kind, "config");
  assert.ok(validateItem(old).ok, "voce vecchia senza kind ancora valida");
  assert.equal(validateItem({ ...item, kind: "altro" }).ok, false);
  assert.ok(YAML.stringify(item).includes("kind: config"));
});
