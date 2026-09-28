// Parser DOCX → documento normalizzato (schemas/parsed-doc.schema.json), §19.8.
//
//   parseDocx(buffer, { id, title?, source? }) → parsed-doc
//     - paragrafi con livelli di titolo dagli stili (Heading1..n, Titolo1..n, "heading 1", outlineLvl);
//       ogni titolo apre una sezione (path "1", "1.2", … dalla numerazione dei livelli);
//     - tabelle w:tbl con la prima riga come intestazione; tabelle annidate appiattite nel testo della cella
//       (avviso); testo nelle caselle (w:txbxContent) come paragrafi in coda al paragrafo (avviso);
//     - revisioni tracciate w:ins / w:del (autore, data, testo) → sections[].revisions[]; il testo del paragrafo
//       è lo stato corrente (inserimenti sì, cancellazioni no);
//     - commenti (word/comments.xml) ancorati alla sezione dove compare il riferimento → sections[].comments[];
//     - figure (w:drawing, w:pict) con la didascalia vicina ("Figura n", "Figure n", stile Caption/Didascalia);
//     - pagina approssimata dai salti renderizzati (w:lastRenderedPageBreak, w:br type=page).
// CLI: node scripts/ingest/parse-docx.mjs --in <file.docx> [--id <id>] [--out <file.json>] [--json]
import { openZip, ZipError } from "./lib/zip.mjs";
import { parseXml, local, kids, kid, attr } from "./lib/xml.mjs";

// Come find di lib/xml.mjs, ma salta i rami mc:Fallback (duplicati di mc:Choice).
function find(node, name, out = []) {
  for (const c of node?.children ?? []) {
    if (typeof c !== "object") continue;
    const n = local(c.name);
    if (n === "Fallback") continue;
    if (n === name) out.push(c);
    find(c, name, out);
  }
  return out;
}
import { newDoc, newSection, finishDoc, oneLine, ParseError, sha256 } from "./lib/parsed.mjs";
import { runParserCli } from "./lib/cli.mjs";
import { officeMeta } from "./lib/office.mjs";

const HEADING_NAME = /^(?:heading|titolo|berschrift|titre|t[ií]tulo)\s*([1-9])$/i;

function styleMap(zip) {
  const map = new Map();
  if (!zip.has("word/styles.xml")) return map;
  const root = parseXml(zip.text("word/styles.xml"));
  for (const s of kids(root, "style")) {
    const id = attr(s, "styleId");
    const name = attr(kid(s, "name"), "val") ?? "";
    const outline = attr(kid(kid(s, "pPr"), "outlineLvl"), "val");
    let level = null;
    const m = HEADING_NAME.exec(name.replace(/\s+/g, " ").trim()) ?? HEADING_NAME.exec(String(id ?? ""));
    if (m) level = Number(m[1]);
    else if (outline !== undefined && /^[0-8]$/.test(outline) && /head|titol/i.test(`${name} ${id}`)) level = Number(outline) + 1;
    const caption = /^(caption|didascalia|beschriftung|l[ée]gende)$/i.test(name) || /^(caption|didascalia)$/i.test(String(id));
    const title = /^(title|titolo documento|titolo)$/i.test(name) && !level;
    map.set(id, { name, level, caption, title });
  }
  return map;
}

function comments(zip) {
  const out = new Map();
  if (!zip.has("word/comments.xml")) return out;
  const root = parseXml(zip.text("word/comments.xml"));
  for (const c of kids(root, "comment")) {
    const text = oneLine(kids(c, "p").map((p) => runText(p, { deleted: false })).join(" "));
    out.set(attr(c, "id"), { id: attr(c, "id") ?? null, author: attr(c, "author") ?? null, date: attr(c, "date") ?? null, text });
  }
  return out;
}

// Testo di un nodo di paragrafo: w:t, tabulazioni, a capo; salta w:delText (stato corrente), mc:Fallback
// (duplicato di mc:Choice) e le caselle di testo (raccolte a parte).
function runText(node, ctx) {
  let out = "";
  for (const c of node.children) {
    if (typeof c === "string") continue;
    const n = local(c.name);
    if (n === "t") out += c.children.filter((x) => typeof x === "string").join("");
    else if (n === "delText") { if (ctx.deleted) out += c.children.filter((x) => typeof x === "string").join(""); }
    else if (n === "tab") out += "\t";
    else if (n === "br" || n === "cr") out += attr(c, "type") === "page" ? " " : "\n";
    else if (n === "Fallback" || n === "txbxContent" || n === "instrText" || (n === "del" && !ctx.deleted)) continue;
    else out += runText(c, ctx);
  }
  return out;
}

// ZipError in qualunque lettura (archivio ostile, voce troncata) ⇒ ParseError: il file va al residuo con il motivo.
export function parseDocx(buffer, opts = {}) {
  try { return parseDocxInner(buffer, opts); } catch (e) {
    if (e instanceof ZipError) throw new ParseError(`archivio ZIP rifiutato: ${e.message}`, { residue: "unsupported" });
    throw e;
  }
}

function parseDocxInner(buffer, { id, title, source = null } = {}) {
  let zip;
  try { zip = openZip(buffer); } catch (e) { throw new ParseError(`archivio ZIP rifiutato: ${e.message}`, { residue: "unsupported" }); }
  if (!zip.has("word/document.xml")) throw new ParseError("DOCX senza word/document.xml", { residue: "unsupported" });
  const styles = styleMap(zip);
  const cmts = comments(zip);
  const body = kid(parseXml(zip.text("word/document.xml")), "body");
  const doc = newDoc({ id, title, format: "docx", source, parser: "parse-docx" });
  doc.meta.sha256 = sha256(buffer);
  doc.meta.size = buffer.length;
  doc.meta.dated = officeMeta(zip).dated;
  const counters = [];
  let page = 1;
  let docTitle = null;
  let sec = newSection({ path: "0", title: title ?? id, level: 1, page: 1 });
  doc.sections.push(sec);
  let lastFigure = null;
  const warn = (w) => { if (!doc.warnings.includes(w)) doc.warnings.push(w); };

  const paragraphInfo = (p) => {
    const pPr = kid(p, "pPr");
    const styleId = attr(kid(pPr, "pStyle"), "val");
    const st = styles.get(styleId) ?? { level: null };
    let level = st.level;
    const ol = attr(kid(pPr, "outlineLvl"), "val");
    if (!level && ol !== undefined && /^[0-8]$/.test(ol)) level = Number(ol) + 1;
    const numbered = !!kid(pPr, "numPr");
    return { level, caption: !!st.caption, title: !!st.title, numbered, style: st.name ?? styleId ?? null };
  };

  const collectRevisions = (p) => {
    for (const ins of find(p, "ins")) {
      const text = oneLine(runText(ins, { deleted: false }));
      if (text) (sec.revisions ??= []).push({ kind: "insert", author: attr(ins, "author") ?? null, date: attr(ins, "date") ?? null, text });
    }
    for (const del of find(p, "del")) {
      const text = oneLine(runText(del, { deleted: true }));
      if (text) (sec.revisions ??= []).push({ kind: "delete", author: attr(del, "author") ?? null, date: attr(del, "date") ?? null, text });
    }
    for (const ref of find(p, "commentReference")) {
      const c = cmts.get(attr(ref, "id"));
      if (c && !(sec.comments ?? []).some((x) => x.id === c.id)) (sec.comments ??= []).push(c);
    }
  };

  const pageBreaks = (node) => find(node, "lastRenderedPageBreak").length + find(node, "br").filter((b) => attr(b, "type") === "page").length;

  const handleParagraph = (p) => {
    page += pageBreaks(p);
    const info = paragraphInfo(p);
    const text = oneLine(runText(p, { deleted: false }));
    // figure: disegni che non sono caselle di testo
    const drawings = [...find(p, "drawing"), ...find(p, "pict")].filter((d) => !find(d, "txbxContent").length).length;
    const boxes = find(p, "txbxContent");
    if (info.level && text) {
      const lvl = Math.min(info.level, 9);
      counters.length = lvl;
      for (let i = 0; i < lvl; i++) counters[i] = counters[i] ?? 0;
      counters[lvl - 1] += 1;
      sec = newSection({ path: counters.join("."), title: text, level: lvl, page });
      doc.sections.push(sec);
      collectRevisions(p);
      return;
    }
    if (info.title && text) { if (!docTitle) docTitle = text; collectRevisions(p); return; }
    collectRevisions(p);
    for (let i = 0; i < drawings; i++) { lastFigure = { ref: `fig-${doc.sections.reduce((a, s) => a + s.figures.length, 0) + 1}`, page }; sec.figures.push(lastFigure); }
    if (text) {
      if (info.caption || /^(figura|figure|fig\.|abbildung|illustrazione)\s*\d+/i.test(text)) {
        const target = lastFigure && sec.figures.includes(lastFigure) && !lastFigure.caption ? lastFigure : null;
        if (target) target.caption = text; else sec.paragraphs.push(text);
      } else sec.paragraphs.push(info.numbered && !/^\s*(\d+[.)]|[a-z][.)]|[-•*])\s/.test(text) ? `${numberFor(p)} ${text}` : text);
    }
    if (boxes.length) {
      warn("testo in caselle di testo: estratto come paragrafi (ordine di lettura approssimato)");
      for (const b of boxes) for (const bp of kids(b, "p")) { const t = oneLine(runText(bp, { deleted: false })); if (t) sec.paragraphs.push(t); }
    }
  };

  // numerazione automatica: "n." per lista, azzerata a ogni titolo o paragrafo non numerato
  let listCounter = 0;
  let lastWasNumbered = false;
  const numberFor = () => { listCounter = lastWasNumbered ? listCounter + 1 : 1; return `${listCounter}.`; };

  const cellText = (tc) => {
    const parts = [];
    for (const c of kids(tc)) {
      const n = local(c.name);
      if (n === "p") { const t = oneLine(runText(c, { deleted: false })); if (t) parts.push(t); collectRevisions(c); }
      else if (n === "tbl") {
        warn("tabelle annidate appiattite nel testo della cella");
        for (const tr of kids(c, "tr")) parts.push(kids(tr, "tc").map((x) => cellText(x)).join(" | "));
      } else if (n === "sdt") { const t = oneLine(runText(c, { deleted: false })); if (t) parts.push(t); }
    }
    return parts.join("\n");
  };

  const handleTable = (tbl) => {
    page += pageBreaks(tbl);
    const rows = [];
    for (const tr of kids(tbl, "tr")) {
      const cells = [];
      for (const tc of kids(tr, "tc")) {
        const span = Number(attr(kid(kid(tc, "tcPr"), "gridSpan"), "val") ?? 1);
        const t = cellText(tc);
        cells.push(t);
        for (let i = 1; i < span; i++) cells.push(t);
      }
      rows.push(cells);
    }
    if (!rows.length) return;
    const width = Math.max(...rows.map((r) => r.length));
    const norm = rows.map((r) => [...r, ...Array(width - r.length).fill("")]);
    const [headers, ...body] = norm;
    sec.tables.push({ headers: headers.map((h) => oneLine(h)), rows: body });
  };

  const walkBody = (node) => {
    for (const c of kids(node)) {
      const n = local(c.name);
      if (n === "p") {
        const info = paragraphInfo(c);
        handleParagraph(c);
        lastWasNumbered = info.numbered && !info.level;
        if (!lastWasNumbered) listCounter = 0;
      } else if (n === "tbl") { lastWasNumbered = false; listCounter = 0; handleTable(c); }
      else if (n === "sdt") walkBody(kid(c, "sdtContent") ?? { children: [] });
      else if (n === "customXml" || n === "smartTag") walkBody(c);
    }
  };
  walkBody(body ?? { children: [] });
  if (docTitle && !title) doc.title = docTitle;
  if (doc.sections[0].path === "0" && !doc.sections[0].paragraphs.length && !doc.sections[0].tables.length && !doc.sections[0].figures.length) doc.sections.shift();
  doc.page_count = page;
  return finishDoc(doc);
}

export const parse = parseDocx;
runParserCli(import.meta.url, { name: "parse-docx", ext: ".docx", parse: parseDocx, errors: [ZipError] });
