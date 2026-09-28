// Genera i campioni SINTETICI dei test di ingest (WP09a). Contenuti inventati (cliente dimostrativo ACME):
// nessun testo della documentazione JAGGAER reale è copiato o derivato qui.
// Uso: node test/fixtures/docs/build-fixtures.mjs   (riscrive i file binari di questa cartella)
import { writeFileSync, mkdirSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { makeZip } from "../../helpers/zip-write.mjs";
import { makeXls } from "../../helpers/xls-write.mjs";

const DIR = dirname(fileURLToPath(import.meta.url));
const out = (name, data) => writeFileSync(join(DIR, name), data);
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ---------------------------------------------------------------- DOCX
export function buildDocx() {
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"';
  const p = (text, style) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ""}<w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;
  const cell = (inner) => `<w:tc>${inner}</w:tc>`;
  const row = (cells) => `<w:tr>${cells.map((c) => cell(p(c))).join("")}</w:tr>`;
  const table = (rows) => `<w:tbl>${rows.map(row).join("")}</w:tbl>`;
  const nested = `<w:tbl><w:tr>${cell(p("Parametro"))}${cell(p("Valore"))}</w:tr><w:tr>${cell(p("strict_import"))}${cell(`<w:tbl><w:tr>${cell(p("false"))}${cell(p("dal go-live"))}</w:tr></w:tbl>`)}</w:tr></w:tbl>`;
  const body = [
    p("Manuale di configurazione ACME", "Title"),
    p("1 Richieste di acquisto", "Heading1"),
    p("Il centro di costo è il codice contabile che identifica chi sostiene la spesa."),
    p("1.1 Campi della testata", "Heading2"),
    table([["Campo", "Nome tecnico", "Tipo", "Obbligatorio", "Note"],
      ["Centro di costo", "REQ_HDR_COST_CENTER", "lookup", "Sì", "Deve esistere in SAP"],
      ["Codice progetto", "REQ_HDR_PROJECT", "testo", "No", ""],
      ["Data di consegna", "REQ_HDR_DELIVERY_DATE", "data", "Se la categoria è servizi è obbligatorio", ""]]),
    `<w:p><w:r><w:t xml:space="preserve">Il campo Fornitore </w:t></w:r><w:ins w:id="1" w:author="Mario Rossi" w:date="2026-03-02T10:00:00Z"><w:r><w:t>deve essere compilato prima dell'invio.</w:t></w:r></w:ins><w:del w:id="2" w:author="Mario Rossi" w:date="2026-03-02T10:00:00Z"><w:r><w:delText>è facoltativo.</w:delText></w:r></w:del><w:commentRangeStart w:id="0"/><w:r><w:commentReference w:id="0"/></w:r></w:p>`,
    p("Nota: in ACME il parametro strict_import è impostato a false dal go-live."),
    p("1.2 Creare una richiesta", "Heading2"),
    `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Aprire il menu Acquisti.</w:t></w:r></w:p>`,
    `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Selezionare Nuova richiesta.</w:t></w:r></w:p>`,
    `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Inserire il centro di costo e salvare.</w:t></w:r></w:p>`,
    `<w:p><w:r><w:lastRenderedPageBreak/><w:drawing/></w:r></w:p>`,
    p("Figura 1 - Nuova richiesta", "Caption"),
    p("Ad esempio, il centro di costo CC-1000 identifica la sede di Milano."),
    p("Per i dettagli vedi §2.1."),
    nested,
    `<w:p><w:r><mc:AlternateContent><mc:Choice><w:drawing><wps:txbx><w:txbxContent><w:p><w:r><w:t>Attenzione: il budget è verificato all'invio.</w:t></w:r></w:p></w:txbxContent></wps:txbx></w:drawing></mc:Choice><mc:Fallback><w:pict><w:txbxContent><w:p><w:r><w:t>Attenzione: il budget è verificato all'invio.</w:t></w:r></w:p></w:txbxContent></w:pict></mc:Fallback></mc:AlternateContent></w:r></w:p>`,
    p("2 Approvazioni", "Titolo1"),
    p("2.1 Livelli", "Titolo2"),
    p("Se l'importo supera 50.000 EUR la richiesta deve essere approvata dal direttore acquisti."),
  ].join("");
  const styles = `<w:styles ${W}><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style><w:style w:type="paragraph" w:styleId="Titolo1"><w:name w:val="Titolo 1"/></w:style><w:style w:type="paragraph" w:styleId="Titolo2"><w:name w:val="Titolo 2"/></w:style><w:style w:type="paragraph" w:styleId="Caption"><w:name w:val="caption"/></w:style></w:styles>`;
  const comments = `<w:comments ${W}><w:comment w:id="0" w:author="Laura Bianchi" w:date="2026-03-03T09:00:00Z"><w:p><w:r><w:t>Verificare con il referente se vale anche per IT02.</w:t></w:r></w:p></w:comment></w:comments>`;
  return makeZip([
    { name: "[Content_Types].xml", data: '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>' },
    { name: "word/document.xml", data: `<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body>${body}</w:body></w:document>` },
    { name: "word/styles.xml", data: styles },
    { name: "word/comments.xml", data: comments },
  ]);
}

// ---------------------------------------------------------------- XLSX
export function buildXlsx() {
  const strings = ["Campo", "Tipo", "Obbligatorio", "Valori ammessi", "Centro di costo", "lookup", "Sì", "Categoria", "lista", "No", "beni;servizi", "Liste", "Stato", "bozza", "inviata", "Test", "Esito", "Dati di prova", "Passo", "Atteso", "Salvare la richiesta", "OK"];
  const s = (t) => strings.indexOf(t);
  const sst = `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">${strings.map((x) => `<si><t>${esc(x)}</t></si>`).join("")}</sst>`;
  const c = (ref, v) => (typeof v === "number" ? `<c r="${ref}"><v>${v}</v></c>` : `<c r="${ref}" t="s"><v>${s(v)}</v></c>`);
  const sheet = (rows, extra = "") => `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.map((r, i) => `<row r="${i + 1}">${r.map(([ref, v]) => c(ref, v)).join("")}</row>`).join("")}</sheetData>${extra}</worksheet>`;
  const s1 = sheet([[["A1", "Campo"], ["B1", "Tipo"], ["C1", "Obbligatorio"], ["D1", "Valori ammessi"]], [["A2", "Centro di costo"], ["B2", "lookup"], ["C2", "Sì"]], [["A3", "Categoria"], ["B3", "lista"], ["C3", "No"], ["D3", "beni;servizi"]], [["A4", "Stato"], ["B4", "lista"]]],
    `<mergeCells count="1"><mergeCell ref="B4:C4"/></mergeCells><dataValidations count="2"><dataValidation type="list" sqref="C2:C4"><formula1>"Sì,No"</formula1></dataValidation><dataValidation type="list" sqref="D2:D4"><formula1>Liste!$A$1:$A$2</formula1></dataValidation></dataValidations>`);
  const s2 = sheet([[["A1", "bozza"]], [["A2", "inviata"]]]);
  const s3 = sheet([[["A1", "Test"], ["B1", "Test"], ["C1", "Esito"]], [["A2", "Passo"], ["B2", "Atteso"], ["C2", "Esito"]], [["A3", "Salvare la richiesta"], ["B3", "OK"], ["C3", 1]]], `<mergeCells count="1"><mergeCell ref="A1:B1"/></mergeCells>`);
  const wb = `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Campi" sheetId="1" r:id="rId1"/><sheet name="Liste" sheetId="2" state="hidden" r:id="rId2"/><sheet name="Dati di prova" sheetId="3" r:id="rId3"/></sheets></workbook>`;
  const rels = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Target="worksheets/sheet3.xml"/></Relationships>`;
  return makeZip([
    { name: "xl/workbook.xml", data: wb }, { name: "xl/_rels/workbook.xml.rels", data: rels }, { name: "xl/sharedStrings.xml", data: sst },
    { name: "xl/worksheets/sheet1.xml", data: s1 }, { name: "xl/worksheets/sheet2.xml", data: s2 }, { name: "xl/worksheets/sheet3.xml", data: s3 },
  ]);
}

// ---------------------------------------------------------------- PPTX
export function buildPptx() {
  const A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  const sp = (type, paras) => `<p:sp><p:nvSpPr><p:nvPr>${type ? `<p:ph type="${type}"/>` : ""}</p:nvPr></p:nvSpPr><p:txBody>${paras.map((t) => `<a:p><a:r><a:t>${esc(t)}</a:t></a:r></a:p>`).join("")}</p:txBody></p:sp>`;
  const slide = (title, paras) => `<p:sld ${A}><p:cSld><p:spTree>${sp("title", [title])}${sp(null, paras)}</p:spTree></p:cSld></p:sld>`;
  return makeZip([
    { name: "ppt/presentation.xml", data: `<p:presentation ${A}><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId3"/></p:sldIdLst></p:presentation>` },
    { name: "ppt/_rels/presentation.xml.rels", data: `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Target="slides/slide1.xml"/><Relationship Id="rId3" Target="slides/slide2.xml"/></Relationships>` },
    { name: "ppt/slides/slide1.xml", data: slide("Workflow delle richieste", ["Le richieste passano per due livelli di approvazione.", "Il secondo livello scatta sopra 50.000 EUR."]) },
    { name: "ppt/slides/slide2.xml", data: slide("Cartelle", ["Ogni attività deposita il documento in una cartella."]) },
    { name: "ppt/slides/_rels/slide1.xml.rels", data: `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide1.xml"/></Relationships>` },
    { name: "ppt/notesSlides/notesSlide1.xml", data: `<p:notes ${A}><p:cSld><p:spTree>${sp("body", ["Di solito il secondo livello lo approva il CFO."])}</p:spTree></p:cSld></p:notes>` },
  ]);
}

// ---------------------------------------------------------------- PDF
export function pdfFile(objects) {
  let body = "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n";
  const offsets = [];
  const chunks = [Buffer.from(body, "latin1")];
  let pos = chunks[0].length;
  objects.forEach((o, i) => {
    offsets.push(pos);
    const head = Buffer.from(`${i + 1} 0 obj\n`, "latin1");
    const parts = [head];
    if (o.stream) {
      parts.push(Buffer.from(`${o.dict.replace(/>>\s*$/, "")} /Length ${o.stream.length} >>\nstream\n`, "latin1"), o.stream, Buffer.from("\nendstream\nendobj\n", "latin1"));
    } else parts.push(Buffer.from(`${o.dict}\nendobj\n`, "latin1"));
    const b = Buffer.concat(parts);
    chunks.push(b);
    pos += b.length;
  });
  const xref = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`, ...offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`)].join("");
  chunks.push(Buffer.from(`${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${pos}\n%%EOF\n`, "latin1"));
  return Buffer.concat(chunks);
}

export function buildPdf() {
  const page1 = "BT /F1 18 Tf 72 760 Td (Guida alla richiesta di acquisto) Tj ET\n" +
    "BT /F1 11 Tf 72 720 Td (Il centro di costo \\350 obbligatorio per tutte le richieste.) Tj 0 -14 Td [(La richiesta ) -250 (viene inviata ) -300 (al primo approvatore.)] TJ ET\n" +
    "BT /F1 11 Tf 72 670 Td 14 TL (Nota: dopo l'approvazione non \\350 pi\\371 modificabile.) Tj T* (Seconda riga del paragrafo.) ' ET";
  const toUnicode = "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n2 beginbfrange\n<0001> <001A> <0061>\n<0020> <0020> <0020>\nendbfrange\n1 beginbfchar\n<0030> <00E8>\nendbfchar\nendcmap\nend end";
  // "Approvazione" in CID: A→a (0x01), p=0x10, r=0x12, o=0x0f, v=0x16, a=0x01, z=0x1a, i=0x09, n=0x0e, e=0x05
  const hex = (word) => word.split("").map((ch) => (ch === " " ? "0020" : ch === "è" ? "0030" : (ch.toLowerCase().charCodeAt(0) - 96).toString(16).padStart(4, "0"))).join("");
  const page2 = `BT /F2 16 Tf 72 760 Td <${hex("approvazione")}> Tj ET\nBT /F2 11 Tf 72 720 Td <${hex("la richiesta passa al direttore")}> Tj ET`;
  return pdfFile([
    { dict: "<< /Type /Catalog /Pages 2 0 R >>" },
    { dict: "<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 /Resources << /Font << /F1 7 0 R /F2 8 0 R >> >> >>" },
    { dict: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>" },
    { dict: "<< /Filter /FlateDecode >>", stream: deflateSync(Buffer.from(page1, "latin1")) },
    { dict: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 6 0 R >>" },
    { dict: "<< /Filter /FlateDecode >>", stream: deflateSync(Buffer.from(page2, "latin1")) },
    { dict: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding << /Type /Encoding /BaseEncoding /WinAnsiEncoding /Differences [232 /egrave 249 /ugrave] >> >>" },
    { dict: "<< /Type /Font /Subtype /Type0 /BaseFont /Demo /Encoding /Identity-H /ToUnicode 9 0 R >>" },
    { dict: "<< >>", stream: Buffer.from(toUnicode, "latin1") },
  ]);
}

export function buildScannedPdf() {
  const content = "q 500 0 0 700 50 50 cm /Im1 Do Q";
  return pdfFile([
    { dict: "<< /Type /Catalog /Pages 2 0 R >>" },
    { dict: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>" },
    { dict: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /XObject << /Im1 5 0 R >> >> >>" },
    { dict: "<< >>", stream: Buffer.from(content, "latin1") },
    { dict: "<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /DCTDecode >>", stream: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) },
  ]);
}

// ---------------------------------------------------------------- PNG minimo (1×1)
export function buildPng(w = 4, h = 3) {
  const b = Buffer.alloc(33);
  Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").copy(b, 0);
  b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); b[24] = 8; b[25] = 2;
  return b;
}

// ---------------------------------------------------------------- XLS (BIFF8)
export function buildXls() {
  return makeXls([
    { name: "Articoli", cells: [[0, 0, "Codice"], [0, 1, "Descrizione"], [0, 2, "Prezzo"], [1, 0, "A-100"], [1, 1, "Sedia ergonomica"], [1, 2, 129.5], [2, 0, "A-200"], [2, 1, "Scrivania"], [2, 2, 310]], merges: [] },
    { name: "Nascosto", hidden: true, cells: [[0, 0, "Valuta"], [1, 0, "EUR"]] },
  ]);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  mkdirSync(DIR, { recursive: true });
  out("sample.docx", buildDocx());
  out("sample.xlsx", buildXlsx());
  out("sample.pptx", buildPptx());
  out("sample.pdf", buildPdf());
  out("scanned.pdf", buildScannedPdf());
  out("screen.png", buildPng());
  out("orphan.png", buildPng(2, 2));
  out("sample.xls", buildXls());
  console.log("fixture rigenerati in", DIR);
}
