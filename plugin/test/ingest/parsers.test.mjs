// WP09a-A — parser → documento normalizzato (schemas/parsed-doc.schema.json): golden per formato sui campioni
// SINTETICI di test/fixtures/docs (rigenerabili con node test/fixtures/docs/build-fixtures.mjs), più le
// proprietà che la spec chiede a ciascun formato (§19.8). UPDATE_GOLDEN=1 riscrive i golden.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateWith } from "../../scripts/lib/schemas.mjs";
import { parseDocx } from "../../scripts/ingest/parse-docx.mjs";
import { parseXlsx } from "../../scripts/ingest/parse-xlsx.mjs";
import { parsePdf } from "../../scripts/ingest/parse-pdf.mjs";
import { parsePptx } from "../../scripts/ingest/parse-pptx.mjs";
import { parseXls } from "../../scripts/ingest/parse-xls.mjs";
import { parseXsd } from "../../scripts/ingest/parse-xsd.mjs";
import { parseSpec } from "../../scripts/ingest/parse-spec.mjs";
import { parseConfigExport } from "../../scripts/ingest/parse-config-export.mjs";
import { parseScreenshot } from "../../scripts/ingest/parse-screenshots.mjs";
import { parseTranscript } from "../../scripts/ingest/parse-transcript.mjs";
import { parseEmail } from "../../scripts/ingest/parse-email.mjs";
import { parseText, parseCsv, parseHtml } from "../../scripts/ingest/parse-text.mjs";
import { openZip } from "../../scripts/ingest/lib/zip.mjs";
import { parseXml, textOf, kid } from "../../scripts/ingest/lib/xml.mjs";
import { ParseError } from "../../scripts/ingest/lib/parsed.mjs";
import { harvest, detectFormat } from "../../scripts/ingest/harvest.mjs";
import { makeZip } from "../helpers/zip-write.mjs";

const FIX = new URL("../fixtures/docs/", import.meta.url);
const GOLD = new URL("../golden/ingest/", import.meta.url);
const buf = (n) => readFileSync(new URL(n, FIX));
const path = (n) => new URL(n, FIX).pathname.replace(/^\/([A-Za-z]:)/, "$1");

function golden(name, doc) {
  const v = validateWith("parsed-doc.schema.json", doc);
  assert.ok(v.ok, `${name}: ${v.errors.join("; ")}`);
  const file = new URL(`${name}.json`, GOLD);
  const text = `${JSON.stringify(doc, null, 2)}\n`;
  if (process.env.UPDATE_GOLDEN === "1" || !existsSync(file)) { mkdirSync(GOLD, { recursive: true }); writeFileSync(file, text); }
  assert.deepEqual(doc, JSON.parse(readFileSync(file, "utf8")), `${name}: diverso dal golden`);
}

test("lib/zip: legge voci stored e deflate; lib/xml: entità, CDATA, DOCTYPE, tag non chiusi", () => {
  const z = openZip(makeZip([{ name: "a.txt", data: "ciao" }, { name: "b/c.xml", data: "<x>è</x>" }], { deflate: true }));
  assert.deepEqual(z.names, ["a.txt", "b/c.xml"]);
  assert.equal(z.text("a.txt"), "ciao");
  const s = openZip(makeZip([{ name: "s", data: "stored" }], { deflate: false }));
  assert.equal(s.text("s"), "stored");
  const x = parseXml('<?xml version="1.0"?><!DOCTYPE r SYSTEM "x.dtd" [<!ENTITY a "b">]><r a="1 &amp; 2"><![CDATA[<raw>]]><k>&lt;&#233;&#x41;</k><open></r>');
  assert.equal(x.attrs.a, "1 & 2");
  assert.equal(textOf(kid(x, "k")), "<éA");
  assert.ok(textOf(x).startsWith("<raw>"));
});

test("parse-docx: titoli dagli stili (Heading/Titolo), tabelle con intestazione, revisioni e commenti sulla sezione, figure con didascalia, avvisi", () => {
  const d = parseDocx(buf("sample.docx"), { id: "demo-docx", source: "sample.docx" });
  golden("docx", d);
  assert.equal(d.title, "Manuale di configurazione ACME");
  assert.deepEqual(d.sections.map((s) => [s.path, s.level]), [["1", 1], ["1.1", 2], ["1.2", 2], ["2", 1], ["2.1", 2]]);
  const s11 = d.sections.find((s) => s.path === "1.1");
  assert.deepEqual(s11.tables[0].headers, ["Campo", "Nome tecnico", "Tipo", "Obbligatorio", "Note"]);
  assert.deepEqual(s11.revisions.map((r) => [r.kind, r.author]), [["insert", "Mario Rossi"], ["delete", "Mario Rossi"]]);
  assert.ok(s11.paragraphs.includes("Il campo Fornitore deve essere compilato prima dell'invio."), "testo corrente: inserimenti sì, cancellazioni no");
  assert.equal(s11.comments[0].author, "Laura Bianchi");
  const s12 = d.sections.find((s) => s.path === "1.2");
  assert.deepEqual(s12.paragraphs.slice(0, 3), ["1. Aprire il menu Acquisti.", "2. Selezionare Nuova richiesta.", "3. Inserire il centro di costo e salvare."]);
  assert.equal(s12.figures[0].caption, "Figura 1 - Nuova richiesta");
  assert.equal(s12.figures[0].page, 2);
  assert.equal(s12.tables[0].rows[0][1], "false | dal go-live", "tabella annidata appiattita");
  assert.equal(s12.paragraphs.filter((p) => p.startsWith("Attenzione")).length, 1, "casella di testo una sola volta (mc:Fallback saltato)");
  assert.ok(d.warnings.some((w) => /annidate/.test(w)) && d.warnings.some((w) => /caselle/.test(w)));
});

test("parse-xlsx: una tabella per foglio, foglio nascosto, convalide a lista (anche da intervallo), celle unite espanse, intestazione su due righe", () => {
  const d = parseXlsx(buf("sample.xlsx"), { id: "demo-xlsx", source: "sample.xlsx" });
  golden("xlsx", d);
  const [campi, liste, prova] = d.sections;
  assert.equal(liste.hidden, true);
  assert.deepEqual(campi.validations.map((v) => v.values), [["Sì", "No"], ["bozza", "inviata"]]);
  assert.equal(campi.tables[0].rows[2][2], "lista", "B4:C4 unite: il valore è copiato");
  assert.deepEqual(prova.tables[0].headers, ["Test / Passo", "Test / Atteso", "Esito"]);
  assert.equal(prova.tables[0].header_rows, 2);
});

test("parse-pdf: testo da flussi Flate con Tj/TJ/'/T*, font semplice con /Differences e font CID con /ToUnicode, pagine; PDF scansionato ⇒ scanned", () => {
  const d = parsePdf(buf("sample.pdf"), { id: "demo-pdf", source: "sample.pdf" });
  golden("pdf", d);
  assert.equal(d.page_count, 2);
  assert.equal(d.sections[0].page, 1);
  assert.equal(d.sections[0].title, "Guida alla richiesta di acquisto");
  assert.match(d.sections[0].paragraphs[0], /Il centro di costo è obbligatorio per tutte le richieste\. La richiesta viene inviata al primo approvatore\./);
  assert.match(d.sections[0].paragraphs[1], /non è più modificabile/);
  assert.deepEqual(d.sections[1].paragraphs, ["la richiesta passa al direttore"]);
  assert.equal(d.scanned, false);
  const sc = parsePdf(buf("scanned.pdf"), { id: "scan", source: "scanned.pdf" });
  assert.equal(sc.scanned, true);
  assert.ok(sc.warnings.some((w) => /OCR/.test(w)));
  assert.throws(() => parsePdf(Buffer.from("non un pdf"), { id: "x" }), ParseError);
});

test("parse-pptx e parse-xls (BIFF8): diapositive con note del relatore; fogli di un .xls binario con foglio nascosto", () => {
  const p = parsePptx(buf("sample.pptx"), { id: "demo-pptx", source: "sample.pptx" });
  golden("pptx", p);
  assert.equal(p.sections[0].title, "Workflow delle richieste");
  assert.ok(p.sections[0].paragraphs.some((x) => x.startsWith("Nota del relatore:")));
  const x = parseXls(buf("sample.xls"), { id: "demo-xls", source: "sample.xls" });
  golden("xls", x);
  assert.deepEqual(x.sections[0].tables[0].rows, [["A-100", "Sedia ergonomica", 129.5], ["A-200", "Scrivania", 310]]);
  assert.equal(x.sections[1].hidden, true);
});

test("parse-xsd e parse-spec: tracciati con obbligatorietà TECNICA (minOccurs, use=required, required), tipi, lunghezze, pattern, enum", () => {
  const d = parseXsd(buf("sample.xsd"), { id: "demo-xsd", source: "sample.xsd" });
  golden("xsd", d);
  const recs = Object.fromEntries(d.sections.flatMap((s) => s.records).map((r) => [r.path, r]));
  assert.equal(d.sections[0].kind, "tracciato");
  assert.equal(recs["/OrderMessage/OrderNumber"].max_length, 20);
  assert.equal(recs["/OrderMessage/OrderNumber"].pattern, "PO-[0-9]+");
  assert.equal(recs["/OrderMessage/CostCenter"].required, true);
  assert.equal(recs["/OrderMessage/Currency"].required, false);
  assert.deepEqual(recs["/OrderMessage/Currency"].enumeration, ["EUR", "USD"]);
  assert.equal(recs["/OrderMessage/@version"].required, true);
  assert.equal(recs["/OrderMessage/Line/Quantity"].type, "decimal");
  const w = parseSpec(buf("sample.wsdl"), { id: "demo-wsdl", source: "sample.wsdl" });
  golden("wsdl", w);
  assert.ok(w.sections[0].records.some((r) => r.kind === "operation" && r.name === "UpsertSupplier" && r.input === "SupplierIn"));
  assert.ok(w.sections.flatMap((s) => s.records).some((r) => r.path === "/SupplierRequest/ErpCode" && r.required === false));
  const o = parseSpec(buf("sample-openapi.json"), { id: "demo-openapi", source: "sample-openapi.json" });
  golden("openapi", o);
  const props = Object.fromEntries(o.sections.flatMap((s) => s.records).map((r) => [r.path, r]));
  assert.equal(props["/Requisition/costCenter"].required, true);
  assert.equal(props["/Requisition/priority"].required, false);
  assert.equal(props["/Requisition/lines/quantity"].required, true);
});

test("parse-config-export: workflow_definition (passi, attività, transizioni), workflow_folders, document_config (impostazioni + campi con obbligatorietà dalle convalide), form, form request", () => {
  const wf = parseConfigExport(buf("workflow_definition_demo.xml"), { id: "wf", source: "workflow_definition_demo.xml" });
  golden("config-workflow-definition", wf);
  assert.equal(wf.meta.kind_hint, "workflow-definition");
  const act = wf.sections.find((s) => s.path === "attivita").records.find((r) => r.name === "Approve Manager");
  assert.deepEqual([act.type, act.step, act.folders, act.rule], ["Approval", "Manager Approval", ["Manager Folder"], "[Document.Total] > 50000"]);
  assert.equal(wf.sections.find((s) => s.path === "transizioni").records.length, 2);
  assert.ok(!wf.sections[0].tables[0].rows.some((r) => r[0] === "ActivityRelationship"), "le impostazioni non contengono gli elementi strutturali");
  const fo = parseConfigExport(buf("workflow_folders_demo.xml"), { id: "fo" });
  assert.equal(fo.meta.kind_hint, "workflow-folders");
  assert.equal(fo.sections[0].records[1].robot, "ApproveAll");
  const dc = parseConfigExport(buf("document_config_demo.xml"), { id: "dc", source: "document_config_demo.xml" });
  golden("config-document-config", dc);
  const campi = dc.sections.find((s) => s.path.startsWith("campi"));
  assert.deepEqual(campi.tables[0].rows.map((r) => [r[0], r[1], r[3]]), [["CostCenter", "Centro di costo", "Obbligatorio in Checkout"], ["ProjectCode", "ProjectCode", "No"]]);
  const fm = parseConfigExport(buf("form_demo.xml"), { id: "fm" });
  assert.equal(fm.meta.kind_hint, "form-config");
  assert.ok(fm.sections.find((s) => s.path === "liste").records[0].values.includes("Business"));
  const fr = parseConfigExport(buf("form_request_demo.xml"), { id: "fr" });
  assert.equal(fr.meta.kind_hint, "form-request-template");
  assert.deepEqual(fr.sections.find((s) => s.path.startsWith("domande")).records.map((r) => r.required), [true, false]);
});

test("parse-screenshots: metadati + sidecar OCR/layout; senza sidecar ⇒ residuo deferred con motivo", () => {
  const d = parseScreenshot(buf("screen.png"), { id: "screen", source: "screen.png", path: path("screen.png") });
  golden("screenshot", d);
  assert.equal(d.sections[0].kind, "schermata");
  assert.deepEqual(d.sections[0].meta.image, { format: "png", width: 4, height: 3, sha256: d.meta.sha256, size: 33 });
  assert.ok(d.sections[0].records.some((r) => r.kind === "field" && r.name === "Centro di costo" && r.required === true));
  assert.throws(() => parseScreenshot(buf("orphan.png"), { id: "o", path: path("orphan.png") }), (e) => e instanceof ParseError && e.residue === "deferred" && /sidecar OCR/.test(e.message));
});

test("parse-transcript (VTT/SRT) e parse-email: cambi di schermata, conoscenza tacita, un messaggio per sezione con data/autore, decisioni, citazioni tolte", () => {
  const v = parseTranscript(buf("training.vtt"), { id: "vtt", source: "training.vtt" });
  golden("vtt", v);
  assert.deepEqual(v.sections.map((s) => s.title), ["Inizio", "Nuova richiesta"]);
  assert.ok(v.sections[1].records.some((r) => r.kind === "tacit" && r.speaker === "Trainer"));
  const s = parseTranscript(buf("training.srt"), { id: "srt", source: "training.srt" });
  assert.equal(s.format, "srt");
  assert.ok(s.sections[0].records.some((r) => r.kind === "tacit" && /usually/.test(r.text)));
  const e = parseEmail(buf("thread.eml"), { id: "eml", source: "thread.eml" });
  golden("email", e);
  assert.equal(e.sections.length, 2);
  assert.equal(e.sections[0].meta.from, "Laura Bianchi <laura@example.invalid>");
  assert.ok(e.sections[0].records.some((r) => r.kind === "decision"));
  assert.ok(!e.sections[0].paragraphs.join(" ").includes("citato"), "le righe citate sono tolte");
});

test("parse-text: testo con titoli, TSV come tabella, CSV RFC 4180, HTML con titoli/tabelle/immagini", () => {
  const t = parseText(buf("notes.txt"), { id: "txt", source: "notes.txt" });
  golden("text", t);
  assert.deepEqual(t.sections.map((s) => s.title), ["PROCEDURA DI SETUP", "Parametri"]);
  const u = parseText(buf("users_import.txt"), { id: "tsv", source: "users_import.txt" });
  assert.deepEqual(u.sections[0].tables[0].headers, ["Username", "Email", "Role", "Company"]);
  const c = parseCsv(buf("data.csv"), { id: "csv", source: "data.csv" });
  assert.deepEqual(c.sections[0].tables[0].rows[0], ["10000000", "Materiali, generici", null]);
  const h = parseHtml(buf("page.htm"), { id: "htm", source: "page.htm" });
  golden("html", h);
  assert.equal(h.title, "Articolo demo");
  assert.deepEqual(h.sections[1].tables[0].headers, ["Attributo", "Valore"]);
  assert.equal(h.sections[1].figures[0].caption, "Foto della sedia");
});

test("harvest: riconosce il formato per estensione e magic, scrive parsed/<docId>.json + _manifest.json in _inbox/<scope>/; sconosciuti elencati con motivo, sidecar non come documenti, duplicati per sha256", () => {
  const ws = mkdtempSync(join(tmpdir(), "jvc-harvest-"));
  const r = harvest(path(""), { root: ws, scope: "P2P" });
  const byPath = Object.fromEntries(r.manifest.map((m) => [m.path, m]));
  assert.equal(byPath["build-fixtures.mjs"].status, "residue");
  assert.match(byPath["build-fixtures.mjs"].residue.reason, /non riconosciuto/);
  assert.equal(byPath["screen.png.ocr.txt"].status, "sidecar");
  assert.equal(byPath["orphan.png"].residue.class, "deferred");
  assert.equal(byPath["document_config_demo.xml"].parser, "config-export");
  assert.equal(byPath["sample.xsd"].parser, "xsd");
  assert.equal(byPath["sample-openapi.json"].parser, "spec");
  assert.equal(byPath["thread.eml"].parser, "email");
  const parsedDir = join(ws, "_inbox", "P2P", "parsed");
  const files = readdirSync(parsedDir);
  assert.ok(files.includes("_manifest.json"));
  assert.equal(files.filter((f) => f !== "_manifest.json").length, r.stats.parsed);
  for (const f of files.filter((x) => x !== "_manifest.json")) assert.ok(validateWith("parsed-doc.schema.json", JSON.parse(readFileSync(join(parsedDir, f), "utf8"))).ok, f);
  assert.ok(existsSync(join(ws, "_inbox", "P2P", "residue", "_harvest.yaml")));
  assert.ok(existsSync(join(ws, "product", "sources", "units")), "il workspace S nasce dallo script");
  // duplicati
  const dup = mkdtempSync(join(tmpdir(), "jvc-dup-"));
  writeFileSync(join(dup, "a.txt"), "Testo di prova\n\nSeconda riga.");
  writeFileSync(join(dup, "b.txt"), "Testo di prova\n\nSeconda riga.");
  const r2 = harvest(dup, { root: ws, scope: "P2P", write: false });
  assert.equal(r2.manifest[1].residue.class, "duplicate");
  assert.equal(r2.manifest[1].duplicate_of, "a.txt");
});

test("detectFormat: archivi, Office 97-2003 non Excel, Snagit, file di sistema → residuo con motivo, mai indovinati", () => {
  const empty = Buffer.alloc(16);
  assert.equal(detectFormat("x/a.zip", empty).residue.class, "deferred");
  assert.equal(detectFormat("x/a.doc", empty).residue.class, "deferred");
  assert.equal(detectFormat("x/a.snag", empty).residue.class, "unsupported");
  assert.equal(detectFormat("x/Thumbs.db", empty).residue.class, "irrelevant");
  assert.equal(detectFormat("x/blob.bin", Buffer.from([1, 0, 2, 0])).residue.class, "unsupported");
  assert.equal(detectFormat("x/creditcard", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0, 0, 0, 0, 0, 0, 0])).parser, "image", "immagine senza estensione dai byte iniziali");
});

test("parse-xlsx: celle inlineStr (<is><t> e <is><r><t>) lette; table.start_row = riga 1-based dell'intestazione, assente se è la 1", () => {
  const wbXml = `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const rels = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`;
  const mk = (rows) => parseXlsx(makeZip([{ name: "xl/workbook.xml", data: wbXml }, { name: "xl/_rels/workbook.xml.rels", data: rels },
    { name: "xl/worksheets/sheet1.xml", data: `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>` }]), { id: "t" });
  const top = mk(`<row r="1"><c r="A1" t="inlineStr"><is><t>Codice</t></is></c><c r="B1" t="inlineStr"><is><r><t>Nome</t></r><r><t> esteso</t></r></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>X1</t></is></c></row>`).sections[0].tables[0];
  assert.deepEqual(top.headers, ["Codice", "Nome esteso"]);
  assert.equal(top.rows[0][0], "X1");
  assert.equal("start_row" in top, false, "intestazione in riga 1: nessun start_row (golden invariati)");
  const low = mk(`<row r="3"><c r="A3" t="inlineStr"><is><t>Codice</t></is></c></row><row r="4"><c r="A4" t="inlineStr"><is><t>X1</t></is></c></row>`).sections[0].tables[0];
  assert.equal(low.start_row, 3);
});
