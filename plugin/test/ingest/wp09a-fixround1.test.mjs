// WP09a giro di correzione 1 (.superpowers/sdd/wp09a-review.md): C1 back-check esatto, I2 sidecar OCR dei PDF, I3
// obbligatorietà tecnica XSD (choice, gruppi facoltativi, nillable), I4 errori del parser distinti dal residuo, I5 limiti
// di risorse fuori dallo ZIP (una bomba sintetica per formato, in memoria), M7 parole chiave it/en delle domande, M9 data
// dell'export, M10 affidabilità del DOC anche dalle unità citate, M14 nessuna uscita dentro il repository del plugin.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deflateSync } from "node:zlib";
import { spawnSync } from "node:child_process";
import YAML from "yaml";
import { supportOf } from "../../scripts/kb/backcheck.mjs";
import { parsePdf, LIMITS as PDF_LIMITS, lzwDecode } from "../../scripts/ingest/parse-pdf.mjs";
import { parseXsd, LIMITS as XSD_LIMITS } from "../../scripts/ingest/parse-xsd.mjs";
import { parseXlsx, LIMITS as XLSX_LIMITS } from "../../scripts/ingest/parse-xlsx.mjs";
import { readCfb, LIMITS as XLS_LIMITS } from "../../scripts/ingest/parse-xls.mjs";
import { parseConfigExport } from "../../scripts/ingest/parse-config-export.mjs";
import { ParseError } from "../../scripts/ingest/lib/parsed.mjs";
import { harvest, PARSERS } from "../../scripts/ingest/harvest.mjs";
import { ingestFolder, PolicyError } from "../../scripts/ingest/ingest.mjs";
import { segmentUnits } from "../../scripts/ingest/segment.mjs";
import { extractDocument } from "../../scripts/ingest/extract.mjs";
import { openDb } from "../../scripts/kb/db.mjs";
import { upsertUnits } from "../../scripts/kb/units.mjs";
import { planSubject } from "../../scripts/kb/digest-plan.mjs";
import { reindex } from "../../scripts/kb/reindex.mjs";
import { pdfFile, buildScannedPdf, buildXls } from "../fixtures/docs/build-fixtures.mjs";
import { makeZip } from "../helpers/zip-write.mjs";

const ROOT = new URL("../../", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const tmp = (p) => mkdtempSync(join(tmpdir(), p));

// ---------------------------------------------------------------- C1
test("C1 back-check: numeri e codici come TOKEN esatti, non sottostringhe (10 ≠ 100, 5000 ≠ 50000, REQ_CC_1 ≠ REQ_CC_12)", () => {
  assert.equal(supportOf("lunghezza massima 10", ["La lunghezza massima del campo è 100 caratteri."]).verdict, "non-supportata");
  assert.equal(supportOf("soglia di approvazione 5000", ["La soglia di approvazione è 50000 EUR."]).verdict, "non-supportata");
  assert.equal(supportOf("codice REQ_CC_1 obbligatorio", ["Il codice REQ_CC_12 è obbligatorio."]).verdict, "non-supportata");
  assert.equal(supportOf("codice REQ_CC_1 obbligatorio", ["Il codice REQ_CC_1 è obbligatorio."]).verdict, "supportata");
  assert.equal(supportOf("lunghezza massima 100", ["La lunghezza massima del campo è 100 caratteri."]).verdict, "supportata");
  assert.equal(supportOf("soglia 50000", ["Soglia: 50.000 EUR"]).verdict, "supportata", "separatori delle migliaia normalizzati");
});

// ---------------------------------------------------------------- I2
test("I2 PDF scansionato: il sidecar <file>.ocr.txt (marcatori di pagina) riempie le pagine di sole immagini; senza sidecar ogni pagina di sole immagini va al residuo deferred", () => {
  const dir = tmp("ocr-");
  const file = join(dir, "scan.pdf");
  writeFileSync(file, buildScannedPdf());
  const no = parsePdf(readFileSync(file), { id: "s", path: file });
  assert.equal(no.scanned, true);
  assert.deepEqual(no.meta.image_only_pages, [1]);
  writeFileSync(`${file}.ocr.txt`, "--- pagina 1 ---\nRichiesta di acquisto\nIl centro di costo deve essere compilato.\n");
  const ok = parsePdf(readFileSync(file), { id: "s", path: file });
  assert.equal(ok.meta.ocr, "sidecar");
  assert.deepEqual(ok.meta.image_only_pages, []);
  assert.ok(ok.sections[0].paragraphs.some((p) => /centro di costo deve essere compilato/.test(p)));
  // PDF misto (una pagina di testo, una di sole immagini) senza sidecar: residuo per pagina nella pipeline
  const mixed = pdfFile([
    { dict: "<< /Type /Catalog /Pages 2 0 R >>" },
    { dict: "<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>" },
    { dict: "<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << /F1 7 0 R >> >> >>" },
    { dict: "<< /Filter /FlateDecode >>", stream: deflateSync(Buffer.from("BT /F1 11 Tf 72 700 Td (Pagina di testo con contenuto sufficiente.) Tj ET", "latin1")) },
    { dict: "<< /Type /Page /Parent 2 0 R /Contents 6 0 R /Resources << /XObject << /Im1 8 0 R >> >> >>" },
    { dict: "<< >>", stream: Buffer.from("q 100 0 0 100 0 0 cm /Im1 Do Q", "latin1") },
    { dict: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>" },
    { dict: "<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /Filter /DCTDecode >>", stream: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) },
  ]);
  const src = tmp("mixed-");
  writeFileSync(join(src, "misto.pdf"), mixed);
  const ws = tmp("mixed-ws-");
  const r = ingestFolder(src, { root: ws, scope: "P2P" });
  const res = YAML.parse(readFileSync(join(ws, "_inbox", "P2P", "residue", readdirSync(join(ws, "_inbox", "P2P", "residue")).find((f) => f.startsWith("S."))), "utf8"));
  assert.ok(res.entries.some((e) => e.class === "deferred" && /pagina 2/.test(e.reason) && /ocr\.txt/.test(e.reason)), JSON.stringify(res.entries));
  assert.equal(r.documents.errors, 0);
});

// ---------------------------------------------------------------- I3
test("I3 XSD: i rami di xs:choice sono uno-fra (non obbligatori da soli), una sequenza minOccurs=0 rende facoltativi i suoi elementi, nillable non nega required", () => {
  const xsd = `<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"><xs:element name="Order"><xs:complexType><xs:sequence>
    <xs:choice><xs:element name="SupplierId" type="xs:string"/><xs:element name="SupplierCode" type="xs:string"/></xs:choice>
    <xs:sequence minOccurs="0"><xs:element name="Note" type="xs:string"/></xs:sequence>
    <xs:element name="Buyer" type="xs:string" nillable="true"/>
    <xs:element name="Extra" minOccurs="0"><xs:complexType><xs:sequence><xs:element name="Inner" type="xs:string"/></xs:sequence></xs:complexType></xs:element>
  </xs:sequence></xs:complexType></xs:element></xs:schema>`;
  const recs = Object.fromEntries(parseXsd(Buffer.from(xsd), { id: "x" }).sections.flatMap((s) => s.records).map((r) => [r.path, r]));
  for (const p of ["/Order/SupplierId", "/Order/SupplierCode"]) {
    assert.equal(recs[p].required, false, p);
    assert.ok(recs[p].choice_group, p);
    assert.equal(recs[p].one_of_required, true, p);
  }
  assert.equal(recs["/Order/SupplierId"].choice_group, recs["/Order/SupplierCode"].choice_group);
  assert.equal(recs["/Order/Note"].required, false);
  assert.equal(recs["/Order/Buyer"].required, true);
  assert.equal(recs["/Order/Buyer"].nillable, true);
  assert.equal(recs["/Order/Extra/Inner"].required, false, "figlio di un elemento facoltativo: non obbligatorio in assoluto");
  assert.equal(recs["/Order/Extra/Inner"].required_in_parent, true);
});

// ---------------------------------------------------------------- I4
test("I4 harvest: un'eccezione inattesa del parser (TypeError) è marcata parser_error, distinta dal residuo di formato", () => {
  const dir = tmp("perr-");
  writeFileSync(join(dir, "a.txt"), "Testo qualunque del documento.");
  const orig = PARSERS.text;
  try {
    PARSERS.text = () => { throw new TypeError("boom"); };
    const r = harvest(dir, { write: false });
    assert.equal(r.manifest[0].status, "residue");
    assert.equal(r.manifest[0].parser_error, true);
    assert.match(r.manifest[0].residue.reason, /errore del parser/);
  } finally { PARSERS.text = orig; }
  const ok = harvest(dir, { write: false });
  assert.equal(ok.manifest[0].parser_error, undefined);
});

// ---------------------------------------------------------------- I5
test("I5 limiti di default documentati per formato", () => {
  assert.equal(PDF_LIMITS.maxStreamBytes, 64 * 1024 * 1024);
  assert.equal(PDF_LIMITS.maxDocBytes, 256 * 1024 * 1024);
  assert.ok(PDF_LIMITS.maxFormCalls > 0 && PDF_LIMITS.maxOpsPerPage > 0);
  assert.equal(XSD_LIMITS.maxRecords, 20000);
  assert.ok(XLSX_LIMITS.maxCells > 0 && XLSX_LIMITS.maxColumns === 16384);
  assert.ok(XLS_LIMITS.maxStreamBytes > 0);
});

test("I5 PDF: flusso Flate oltre il tetto ⇒ ParseError (residuo), niente memoria illimitata; LZW limitato", () => {
  const big = pdfFile([
    { dict: "<< /Type /Catalog /Pages 2 0 R >>" },
    { dict: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>" },
    { dict: "<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>" },
    { dict: "<< /Filter /FlateDecode >>", stream: deflateSync(Buffer.alloc(2 * 1024 * 1024, 0x20)) },
  ]);
  assert.throws(() => parsePdf(big, { id: "b", limits: { maxStreamBytes: 1024 * 1024 } }), (e) => e instanceof ParseError && /flusso/.test(e.message));
  assert.throws(() => parsePdf(big, { id: "b", limits: { maxDocBytes: 1024 * 1024 } }), (e) => e instanceof ParseError);
  // LZW: codici che crescono (A, AA, AAA, …) oltre il tetto
  const codes = [256, 65];
  for (let c = 258; c < 400; c++) codes.push(c);
  let bits = 0, acc = 0, width = 9, next = 258;
  const out = [];
  for (const c of codes) { acc = (acc << width) | c; bits += width; while (bits >= 8) { out.push((acc >>> (bits - 8)) & 255); bits -= 8; } if (c !== 256) { next++; if (next + 1 >= 1 << width && width < 12) width++; } acc &= (1 << bits) - 1; }
  if (bits) out.push((acc << (8 - bits)) & 255);
  assert.throws(() => lzwDecode(Buffer.from(out), 1000), (e) => e instanceof ParseError);
});

test("I5 PDF: XObject Form in ventaglio (10 × 5 livelli) ⇒ ParseError oltre il tetto di invocazioni, senza ridecodificare", () => {
  const objs = [{ dict: "<< /Type /Catalog /Pages 2 0 R >>" }, { dict: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>" },
    { dict: "<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /XObject << /X 5 0 R >> >> >>" },
    { dict: "<< >>", stream: Buffer.from("/X Do ".repeat(10), "latin1") }];
  for (let i = 0; i < 5; i++) {
    const self = 5 + i;
    objs.push({ dict: `<< /Type /XObject /Subtype /Form /Resources << /XObject << /X ${self + 1} 0 R >> >> >>`, stream: Buffer.from(i < 4 ? "/X Do ".repeat(10) : "BT (x) Tj ET", "latin1") });
  }
  assert.throws(() => parsePdf(pdfFile(objs), { id: "f", limits: { maxFormCalls: 500 } }), (e) => e instanceof ParseError && /Form/.test(e.message));
});

test("I5 XSD: tipi riusati in modo esponenziale ⇒ ParseError oltre il tetto di record", () => {
  let types = "";
  for (let i = 0; i < 16; i++) types += `<xs:complexType name="T${i}"><xs:sequence><xs:element name="A" type="T${i + 1}"/><xs:element name="B" type="T${i + 1}"/></xs:sequence></xs:complexType>`;
  types += `<xs:complexType name="T16"><xs:sequence><xs:element name="Leaf" type="xs:string"/></xs:sequence></xs:complexType>`;
  const xsd = `<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"><xs:element name="Root" type="T0"/>${types}</xs:schema>`;
  assert.throws(() => parseXsd(Buffer.from(xsd), { id: "x", limits: { maxRecords: 1000 } }), (e) => e instanceof ParseError && /record/.test(e.message));
});

function xlsxWith(sheetXml) {
  return makeZip([
    { name: "xl/workbook.xml", data: `<workbook xmlns:r="r"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>` },
    { name: "xl/_rels/workbook.xml.rels", data: `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>` },
    { name: "xl/worksheets/sheet1.xml", data: sheetXml },
  ]);
}
test("I5 XLSX: area unita A1:XFD1048576 ridotta all'area usata (niente esplosione), celle oltre il tetto ⇒ ParseError", () => {
  const merged = xlsxWith(`<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Campo</t></is></c><c r="B1" t="inlineStr"><is><t>Valore</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>x</t></is></c><c r="B2"><v>1</v></c></row></sheetData><mergeCells count="1"><mergeCell ref="A1:XFD1048576"/></mergeCells></worksheet>`);
  const t0 = Date.now();
  const d = parseXlsx(merged, { id: "m" });
  assert.ok(Date.now() - t0 < 2000);
  assert.ok(d.sections[0].tables[0].headers.length <= 2);
  const far = xlsxWith(`<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>a</t></is></c></row><row r="1048576"><c r="XFD1048576"><v>1</v></c></row></sheetData></worksheet>`);
  assert.throws(() => parseXlsx(far, { id: "f", limits: { maxCells: 100000 } }), (e) => e instanceof ParseError && /celle/.test(e.message));
});

test("I5 XLS: catena FAT con un ciclo ⇒ ParseError (niente concatenazione fino al limite di iterazioni)", () => {
  const buf = Buffer.from(buildXls());
  const nWb = (buf.length - 1536) / 512;
  const last = 2 + nWb - 1;
  buf.writeUInt32LE(2, 512 + last * 4);   // l'ultimo settore del Workbook punta al primo: ciclo
  assert.throws(() => readCfb(buf), (e) => e instanceof ParseError && /ciclo/.test(e.message));
});

// ---------------------------------------------------------------- M7
test("M7 banche: parole chiave di ricerca it+en per domanda; digest-plan le usa (la domanda italiana trova unità inglesi)", () => {
  for (const f of readdirSync(join(ROOT, "product", "question-banks")).filter((x) => x !== "profile.yaml")) {
    for (const q of YAML.parse(readFileSync(join(ROOT, "product", "question-banks", f), "utf8")).questions) {
      assert.ok(q.keywords?.it?.length && q.keywords?.en?.length, `${f} ${q.attribute}`);
    }
  }
  const db = openDb(":memory:");
  const doc = { id: "d", title: "D", format: "docx", sections: [{ path: "1", title: "Approval workflow", level: 1, page: null, paragraphs: ["The approval workflow is triggered when the buyer submits the requisition.", "The requisition approval workflow routes documents to folders."], tables: [], figures: [] }] };
  upsertUnits(db, segmentUnits(doc, { docCode: "S.STD.XSC.DOC.0001" }).units);
  const p = planSubject(db, { subject: "S.STD.P2P.FLW.0001", type: "FLW", label: "approval workflow" });
  const trig = p.questions.find((q) => q.attribute === "trigger");
  assert.ok(trig.units.length && /triggered/.test(trig.units[0].text), JSON.stringify(trig.units));
});

// ---------------------------------------------------------------- M9
test("M9 data dell'export: dall'XML se presente, altrimenti dalla data del file (dichiarata); arriva a current_state.observed_at", () => {
  const xml = Buffer.from("<ReqConfig><VersionDescription>x</VersionDescription><ExportDate>2026-01-15T10:00:00</ExportDate><AllowedCartViews>Simple</AllowedCartViews></ReqConfig>");
  const a = parseConfigExport(xml, { id: "a" });
  assert.deepEqual([a.meta.exported_at, a.meta.dated, a.meta.date_source], ["2026-01-15", "2026-01-15", "xml"]);
  const b = parseConfigExport(Buffer.from("<ReqConfig><AllowedCartViews>Simple</AllowedCartViews></ReqConfig>"), { id: "b", mtime: new Date("2026-03-02T08:00:00Z") });
  assert.deepEqual([b.meta.exported_at, b.meta.date_source], ["2026-03-02", "mtime"]);
  const r = extractDocument(b, segmentUnits(b).units, { profile: { id: "S.STD.XSC.DOC.0009", kind: "config-export", genre: "tecnica", facets: { F1: "esecuzione-config" } } });
  assert.equal(r.items.find((x) => x.candidates[0] === "CFG").extraction.current_state.observed_at, "2026-03-02");
  const dir = tmp("mt-");
  writeFileSync(join(dir, "document_config_x.xml"), "<ReqConfig><AllowedCartViews>Simple</AllowedCartViews></ReqConfig>");
  assert.match(harvest(dir, { write: false }).docs[0].meta.exported_at, /^\d{4}-\d{2}-\d{2}$/);
});

// ---------------------------------------------------------------- M10
test("M10 reindex: un item che cita solo UNITÀ prende il peso di base dal DOC di quelle unità", () => {
  const root = tmp("kb-u-");
  const dir = join(root, "kb", "scopes", "P2P", "flows");
  mkdirSync(dir, { recursive: true });
  const base = YAML.parse(readFileSync(join(ROOT, "test", "fixtures", "items", "valid.flw.yaml"), "utf8"));
  writeFileSync(join(dir, "C.ACME.P2P.FLW.0001.yaml"), YAML.stringify({ ...base, id: "C.ACME.P2P.FLW.0001", facets: { ...base.facets, F1: "doc-cliente-utente", F8: "universale", F12: "promosso" }, sources: [{ unit: "U.DOC0007.0001" }] }));
  const dbPath = join(root, "k.db");
  const db = openDb(dbPath);
  db.prepare("insert into doc_profiles(code, doc_key, doc_id, reliability) values ('C.ACME.XSC.DOC.0007', 'k', 'd', 0.42)").run();
  db.prepare("insert into units(code, doc, type, text, hash) values ('U.DOC0007.0001', 'C.ACME.XSC.DOC.0007', 'testo', 't', 'h')").run();
  reindex(root, dbPath, { clustersDir: null });
  assert.equal(db.prepare("select confidence from items where code='C.ACME.P2P.FLW.0001'").get().confidence, 0.42);
});

// ---------------------------------------------------------------- M14
test("M14 ingest e harvest rifiutano un'uscita dentro il repository del plugin (exit 3)", () => {
  const src = tmp("src-");
  writeFileSync(join(src, "a.txt"), "Testo.");
  assert.throws(() => ingestFolder(src, { root: join(ROOT, "tmp-ws-rifiutato") }), PolicyError);
  assert.throws(() => harvest(src, { root: join(ROOT, "tmp-ws-rifiutato") }), PolicyError);
  const r = spawnSync(process.execPath, [join(ROOT, "scripts", "ingest", "ingest.mjs"), "--input", src, "--root", join(ROOT, "tmp-ws-rifiutato")], { encoding: "utf8" });
  assert.equal(r.status, 3, r.stdout + r.stderr);
  const h = spawnSync(process.execPath, [join(ROOT, "scripts", "ingest", "harvest.mjs"), "--input", src, "--root", ROOT], { encoding: "utf8" });
  assert.equal(h.status, 3);
});
