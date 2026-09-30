// Parser PPTX (training deck) → documento normalizzato (§19.8): una sezione per diapositiva, titolo dal
// segnaposto title/ctrTitle, paragrafi dai blocchi di testo (a:p), tabelle (a:tbl), immagini come figure,
// note del relatore (ppt/notesSlides) come paragrafi "Nota del relatore: …".
//   parsePptx(buffer, { id, title?, source? }) → parsed-doc
// CLI: node scripts/ingest/parse-pptx.mjs --in <file.pptx> [--id <id>] [--out <file.json>] [--json]
import { posix } from "node:path";
import { openZip, ZipError } from "./lib/zip.mjs";
import { parseXml, kids, kid, find, textOf, attr } from "./lib/xml.mjs";
import { newDoc, newSection, finishDoc, oneLine, ParseError, sha256 } from "./lib/parsed.mjs";
import { runParserCli } from "./lib/cli.mjs";
import { officeMeta } from "./lib/office.mjs";

const paraText = (p) => oneLine(find(p, "t").map((t) => textOf(t)).join(""));

// ZipError in qualunque lettura (archivio ostile, voce troncata) ⇒ ParseError: il file va al residuo con il motivo.
export function parsePptx(buffer, opts = {}) {
  try { return parsePptxInner(buffer, opts); } catch (e) {
    if (e instanceof ZipError) throw new ParseError(`archivio ZIP rifiutato: ${e.message}`, { residue: "unsupported" });
    throw e;
  }
}

function parsePptxInner(buffer, { id, title, source = null } = {}) {
  let zip;
  try { zip = openZip(buffer); } catch (e) { throw new ParseError(`archivio ZIP rifiutato: ${e.message}`, { residue: "unsupported" }); }
  if (!zip.has("ppt/presentation.xml")) throw new ParseError("PPTX senza ppt/presentation.xml", { residue: "unsupported" });
  const rels = new Map();
  if (zip.has("ppt/_rels/presentation.xml.rels")) for (const r of kids(parseXml(zip.text("ppt/_rels/presentation.xml.rels")), "Relationship")) rels.set(attr(r, "Id"), posix.normalize(posix.join("ppt", attr(r, "Target"))));
  const order = find(parseXml(zip.text("ppt/presentation.xml")), "sldId").map((s) => rels.get(attr(s, "id"))).filter(Boolean);
  const slides = order.length ? order : zip.names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => Number(/(\d+)\.xml$/.exec(a)[1]) - Number(/(\d+)\.xml$/.exec(b)[1]));
  const doc = newDoc({ id, title, format: "pptx", source, parser: "parse-pptx" });
  doc.meta.sha256 = sha256(buffer);
  doc.meta.size = buffer.length;
  doc.meta.dated = officeMeta(zip).dated;
  doc.meta.kind_hint = "training-deck";
  slides.forEach((path, i) => {
    if (!zip.has(path)) return;
    const root = parseXml(zip.text(path));
    let stitle = null;
    const sec = newSection({ path: `s${i + 1}`, title: "", level: 1, page: i + 1 });
    for (const sp of find(root, "sp")) {
      const ph = find(sp, "ph")[0];
      const type = attr(ph, "type");
      const paras = find(sp, "p").map(paraText).filter(Boolean);
      if (!paras.length) continue;
      if (!stitle && (type === "title" || type === "ctrTitle")) { stitle = paras.join(" "); continue; }
      sec.paragraphs.push(...paras);
    }
    for (const tbl of find(root, "tbl")) {
      const rows = kids(tbl, "tr").map((tr) => kids(tr, "tc").map((tc) => oneLine(find(tc, "p").map(paraText).join(" "))));
      if (rows.length) { const w = Math.max(...rows.map((r) => r.length)); const pad = (r) => [...r, ...Array(w - r.length).fill("")]; sec.tables.push({ headers: pad(rows[0]), rows: rows.slice(1).map(pad) }); }
    }
    for (let k = 0; k < find(root, "pic").length; k++) sec.figures.push({ ref: `s${i + 1}-img${k + 1}`, page: i + 1 });
    const relsPath = path.replace(/slides\/(slide\d+\.xml)$/, "slides/_rels/$1.rels");
    if (zip.has(relsPath)) {
      for (const r of kids(parseXml(zip.text(relsPath)), "Relationship")) {
        if (!/notesSlide/.test(attr(r, "Type") ?? "")) continue;
        const np = posix.normalize(posix.join(posix.dirname(path), attr(r, "Target")));
        if (!zip.has(np)) continue;
        const notes = find(parseXml(zip.text(np)), "sp").filter((sp) => attr(find(sp, "ph")[0], "type") === "body").flatMap((sp) => find(sp, "p").map(paraText)).filter(Boolean);
        if (notes.length) sec.paragraphs.push(`Nota del relatore: ${notes.join(" ")}`);
      }
    }
    sec.title = stitle ?? sec.paragraphs[0]?.slice(0, 120) ?? `Diapositiva ${i + 1}`;
    doc.sections.push(sec);
  });
  doc.page_count = slides.length;
  if (!title && doc.sections[0]?.title) doc.title = doc.sections[0].title;
  return finishDoc(doc);
}

export const parse = parsePptx;
runParserCli(import.meta.url, { name: "parse-pptx", ext: ".pptx", parse: parsePptx, errors: [ZipError] });
