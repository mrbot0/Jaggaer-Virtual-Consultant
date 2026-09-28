// Parser XLSX → documento normalizzato, §19.8 (matrici di campi, matrici di test, checklist).
//
//   parseXlsx(buffer, { id, title?, source? }) → parsed-doc
//     - una sezione per foglio (path "sheet-<n>", titolo = nome del foglio), una tabella per foglio:
//       intestazione = prima riga non vuota, righe = le successive (vuote finali tolte);
//     - fogli nascosti (state hidden/veryHidden) → sections[].hidden = true;
//     - convalide di cella di tipo lista → sections[].validations[] { sqref, type, values[] | source }
//       (vocabolari chiusi); le liste che puntano a un intervallo sono risolte se il foglio è nel file;
//     - celle unite: il valore è copiato in tutte le celle dell'area;
//     - intestazioni su due righe (riga 1 con celle unite orizzontali o vuote sopra una riga 2 di testo)
//       → avviso e intestazione composta "Gruppo / Colonna"; table.header_rows = 2.
// Limiti: le formule valgono il valore in cache (<v>); le date restano numeri seriali di Excel.
// CLI: node scripts/ingest/parse-xlsx.mjs --in <file.xlsx> [--id <id>] [--out <file.json>] [--json]
import { openZip, ZipError } from "./lib/zip.mjs";
import { parseXml, kids, kid, find, textOf, attr } from "./lib/xml.mjs";
import { newDoc, newSection, finishDoc, oneLine, ParseError, sha256 } from "./lib/parsed.mjs";
import { runParserCli } from "./lib/cli.mjs";
import { posix } from "node:path";

export function colIndex(letters) {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}
export function cellRef(ref) {
  const m = /^\$?([A-Z]+)\$?(\d+)$/i.exec(String(ref).trim());
  return m ? { c: colIndex(m[1]), r: Number(m[2]) - 1 } : null;
}
export function rangeRef(ref) {
  const [a, b] = String(ref).split(":");
  const s = cellRef(a);
  const e = b ? cellRef(b) : s;
  return s && e ? { r1: Math.min(s.r, e.r), c1: Math.min(s.c, e.c), r2: Math.max(s.r, e.r), c2: Math.max(s.c, e.c) } : null;
}

function sharedStrings(zip) {
  if (!zip.has("xl/sharedStrings.xml")) return [];
  const root = parseXml(zip.text("xl/sharedStrings.xml"));
  return kids(root, "si").map((si) => {
    const t = kid(si, "t");
    if (t) return textOf(t);
    return kids(si, "r").map((r) => textOf(kid(r, "t"))).join("");
  });
}

function sheetTargets(zip) {
  const wb = parseXml(zip.text("xl/workbook.xml"));
  const rels = new Map();
  if (zip.has("xl/_rels/workbook.xml.rels")) {
    for (const r of kids(parseXml(zip.text("xl/_rels/workbook.xml.rels")), "Relationship")) {
      const target = attr(r, "Target");
      rels.set(attr(r, "Id"), target.startsWith("/") ? target.slice(1) : posix.normalize(posix.join("xl", target)));
    }
  }
  return find(wb, "sheet").map((s, i) => ({
    name: attr(s, "name") ?? `Foglio${i + 1}`,
    state: attr(s, "state") ?? "visible",
    path: rels.get(attr(s, "id")) ?? `xl/worksheets/sheet${i + 1}.xml`,
  }));
}

function readSheet(zip, path, strings) {
  const root = parseXml(zip.text(path));
  const grid = [];
  for (const row of find(root, "row")) {
    const r = Number(attr(row, "r") ?? grid.length + 1) - 1;
    let nextC = 0;
    for (const c of kids(row, "c")) {
      const ref = attr(c, "r");
      const pos = ref ? cellRef(ref) : { r, c: nextC };
      nextC = pos.c + 1;
      const t = attr(c, "t");
      const v = kid(c, "v");
      let val = null;
      if (t === "s") val = strings[Number(textOf(v))] ?? "";
      else if (t === "inlineStr") val = textOf(kid(c, "is"));
      else if (t === "b") val = textOf(v) === "1";
      else if (t === "str" || t === "e") val = textOf(v);
      else if (v) { const s = textOf(v); const n = Number(s); val = s !== "" && Number.isFinite(n) ? n : s; }
      if (val === null || val === "") continue;
      (grid[pos.r] ??= [])[pos.c] = typeof val === "string" ? oneLine(val) : val;
    }
  }
  const merges = find(root, "mergeCell").map((m) => rangeRef(attr(m, "ref"))).filter(Boolean);
  for (const m of merges) {
    const v = grid[m.r1]?.[m.c1] ?? null;
    if (v === null || v === undefined) continue;
    for (let r = m.r1; r <= m.r2; r++) for (let c = m.c1; c <= m.c2; c++) if (!(r === m.r1 && c === m.c1)) (grid[r] ??= [])[c] = v;
  }
  const validations = find(root, "dataValidation").map((dv) => ({
    sqref: attr(dv, "sqref") ?? "",
    type: attr(dv, "type") ?? "any",
    formula: textOf(kid(dv, "formula1")).trim(),
  }));
  // x14:dataValidation (liste da altri fogli) con xm:sqref e xm:f
  for (const dv of find(root, "dataValidation").filter((d) => kid(d, "sqref"))) {
    const v = validations.find((x) => x.sqref === "" && x.formula === textOf(kid(dv, "formula1")).trim());
    if (v) v.sqref = textOf(kid(dv, "sqref")).trim();
  }
  return { grid, merges, validations };
}

const isBlank = (v) => v === null || v === undefined || (typeof v === "string" && !v.trim());

function listValues(formula, sheets) {
  if (!formula) return { values: [], source: null };
  const q = /^"(.*)"$/s.exec(formula);
  if (q) return { values: q[1].split(",").map((x) => x.trim()).filter(Boolean), source: null };
  const m = /^(?:'?([^'!]+)'?!)?(\$?[A-Z]+\$?\d+(?::\$?[A-Z]+\$?\d+)?)$/i.exec(formula.replace(/^=/, ""));
  if (m) {
    const sheet = m[1] ? sheets.find((s) => s.name === m[1]) : null;
    const rg = rangeRef(m[2]);
    if (sheet?.data && rg) {
      const values = [];
      for (let r = rg.r1; r <= rg.r2; r++) for (let c = rg.c1; c <= rg.c2; c++) { const v = sheet.data.grid[r]?.[c]; if (!isBlank(v)) values.push(String(v)); }
      return { values, source: formula };
    }
  }
  return { values: [], source: formula };
}

export function parseXlsx(buffer, { id, title, source = null } = {}) {
  let zip;
  try { zip = openZip(buffer); } catch (e) { throw new ParseError(`XLSX non leggibile: ${e.message}`, { residue: "unsupported" }); }
  if (!zip.has("xl/workbook.xml")) throw new ParseError("XLSX senza xl/workbook.xml", { residue: "unsupported" });
  const strings = sharedStrings(zip);
  const sheets = sheetTargets(zip);
  const doc = newDoc({ id, title, format: "xlsx", source, parser: "parse-xlsx" });
  doc.meta.sha256 = sha256(buffer);
  doc.meta.size = buffer.length;
  for (const s of sheets) if (zip.has(s.path)) s.data = readSheet(zip, s.path, strings);
  sheets.forEach((s, i) => {
    const sec = newSection({ path: `sheet-${i + 1}`, title: s.name, level: 1 });
    if (s.state !== "visible") sec.hidden = true;
    doc.sections.push(sec);
    if (!s.data) { doc.warnings.push(`foglio ${s.name}: parte del file assente`); return; }
    const { grid, merges, validations } = s.data;
    const lists = validations.filter((v) => v.type === "list").map((v) => ({ sqref: v.sqref, type: "list", ...listValues(v.formula, sheets) }));
    if (lists.length) sec.validations = lists;
    const rows = [];
    for (let r = 0; r < grid.length; r++) rows[r] = grid[r] ?? [];
    const first = rows.findIndex((r) => r && r.some((v) => !isBlank(v)));
    if (first < 0) return;
    let last = rows.length - 1;
    while (last > first && !rows[last].some((v) => !isBlank(v))) last--;
    const width = Math.max(...rows.slice(first, last + 1).map((r) => r.length));
    const cell = (r, c) => (isBlank(rows[r]?.[c]) ? "" : rows[r][c]);
    let headers = Array.from({ length: width }, (_, c) => String(cell(first, c)));
    let bodyStart = first + 1;
    let headerRows = 1;
    // Intestazione su due righe: la riga 1 ha celle unite orizzontali (o vuoti) e la riga 2 è tutta testo
    const next = first + 1 <= last ? Array.from({ length: width }, (_, c) => cell(first + 1, c)) : null;
    const hMerge = merges.some((m) => m.r1 === first && m.r2 === first && m.c2 > m.c1);
    const nextAllText = next && next.filter((v) => v !== "").length >= Math.max(2, Math.ceil(width / 2)) && next.every((v) => v === "" || typeof v === "string");
    const gaps = headers.filter((h) => h === "").length;
    if (next && nextAllText && (hMerge || (gaps > 0 && gaps < width))) {
      doc.warnings.push(`foglio ${s.name}: intestazione su due righe, composta come "gruppo / colonna"`);
      headers = headers.map((h, c) => { const lo = String(next[c] ?? ""); return h && lo && h !== lo ? `${h} / ${lo}` : h || lo; });
      bodyStart = first + 2;
      headerRows = 2;
    }
    const body = [];
    for (let r = bodyStart; r <= last; r++) {
      const row = Array.from({ length: width }, (_, c) => { const v = cell(r, c); return v === "" ? null : v; });
      body.push(row);
    }
    const table = { headers: headers.map((h) => oneLine(h)), rows: body };
    if (headerRows > 1) table.header_rows = headerRows;
    sec.tables.push(table);
  });
  return finishDoc(doc);
}

export const parse = parseXlsx;
runParserCli(import.meta.url, { name: "parse-xlsx", ext: ".xlsx", parse: parseXlsx, errors: [ZipError] });
