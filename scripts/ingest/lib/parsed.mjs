// Costruzione del documento normalizzato (schemas/parsed-doc.schema.json) comune a tutti i parser.
//
//   docIdFor(relPath)          identificativo stabile dal percorso relativo: slug + 8 cifre esadecimali dello sha256
//   sha256(buf)                "sha256:<hex>"
//   newDoc({ id, title, format, source }) → documento vuoto con meta { source, parser }
//   newSection({ path, title, level, page }) → sezione vuota
//   finishDoc(doc)             toglie le sezioni vuote (salvo l'unica), valida contro lo schema
//   estimateTokens(x)          ≈ caratteri / 4 (stessa stima di digest-fields)
//   cleanText(s)               spazi compressi, senza caratteri di controllo
import { createHash } from "node:crypto";
import { basename } from "node:path";
import { validateWith } from "../../lib/schemas.mjs";

export const PARSER_VERSION = "1";

export class ParseError extends Error {
  constructor(m, { residue = "unsupported", reason = m } = {}) { super(m); this.name = "ParseError"; this.residue = residue; this.reason = reason; }
}

export const sha256 = (buf) => `sha256:${createHash("sha256").update(buf).digest("hex")}`;

export function slugify(s, max = 48) {
  return String(s ?? "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max).replace(/-+$/g, "") || "doc";
}

export function docIdFor(relPath) {
  const p = String(relPath).replace(/\\/g, "/");
  const h = createHash("sha256").update(p.toLowerCase()).digest("hex").slice(0, 8);
  return `${slugify(basename(p))}-${h}`;
}

// eslint-disable-next-line no-control-regex
const CTRL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
export const cleanText = (s) => String(s ?? "").replace(CTRL, " ").replace(/[ \t ]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
export const oneLine = (s) => cleanText(s).replace(/\s+/g, " ");
export const estimateTokens = (x) => Math.ceil((typeof x === "string" ? x : JSON.stringify(x ?? "")).length / 4);

export function newDoc({ id, title, format, source = null, parser }) {
  return { id, title: title || id, format, sections: [], warnings: [], meta: { source, parser, parser_version: PARSER_VERSION } };
}

export function newSection({ path, title = "", level = 1, page = null }) {
  return { path: String(path), title: oneLine(title), level: Math.max(1, level | 0), page: page ?? null, paragraphs: [], tables: [], figures: [] };
}

const isEmpty = (s) => !s.paragraphs.length && !s.tables.length && !s.figures.length && !(s.revisions?.length) && !(s.comments?.length) && !(s.records?.length);

export function finishDoc(input) {
  let doc = input;
  // le sezioni vuote con un titolo restano (capitoli: danno il contesto alle unità), le altre no
  const kept = doc.sections.filter((s) => !isEmpty(s) || (s.title && s.path !== "0"));
  doc.sections = kept.length ? kept : doc.sections.slice(0, 1);
  if (!doc.sections.length) doc.sections.push(newSection({ path: "1", title: doc.title }));
  // path unici nel documento
  const seen = new Map();
  for (const s of doc.sections) {
    const n = seen.get(s.path) ?? 0;
    seen.set(s.path, n + 1);
    if (n) s.path = `${s.path}~${n + 1}`;
  }
  if (!doc.warnings.length) delete doc.warnings;
  doc = JSON.parse(JSON.stringify(doc));   // solo JSON: niente chiavi undefined
  const v = validateWith("parsed-doc.schema.json", doc);
  if (!v.ok) throw new ParseError(`uscita del parser non conforme a parsed-doc.schema.json: ${v.errors.slice(0, 3).join("; ")}`, { residue: "unsupported" });
  return doc;
}
