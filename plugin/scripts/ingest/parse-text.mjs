// Testo semplice, Markdown, CSV/TSV e HTML → documento normalizzato (§19.8).
//
//   parseText(buffer, { id, title?, source? })  paragrafi separati da righe vuote; titoli Markdown (#) o righe
//       in MAIUSCOLO brevi seguite da testo aprono sezioni; un file tabellare (TAB o ; , costanti su ≥ 3 righe)
//       diventa una tabella (import/export di dati: catalogo, utenti, prezzi).
//   parseCsv(buffer, { id, title?, source?, delimiter? })  una tabella: intestazione = prima riga; virgolette RFC 4180.
//   parseHtml(buffer, { id, title?, source? })  h1..h6 → sezioni, <p>/<li> → paragrafi, <table> → tabelle;
//       script, style e commenti ignorati.
//   decodeText(buffer)  UTF-8 (BOM compreso) o, se non valido, Windows-1252/latin1; UTF-16 con BOM.
// CLI: node scripts/ingest/parse-text.mjs --in <file.txt|csv|htm> [--id <id>] [--out <file.json>] [--json]
import { newDoc, newSection, finishDoc, oneLine, ParseError, sha256 } from "./lib/parsed.mjs";
import { decodeEntities } from "./lib/xml.mjs";
import { runParserCli } from "./lib/cli.mjs";

export function decodeText(buf) {
  if (!Buffer.isBuffer(buf)) return String(buf);
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString("utf16le");
  if (buf[0] === 0xfe && buf[1] === 0xff) { const b = Buffer.from(buf.subarray(2)); b.swap16(); return b.toString("utf16le"); }
  const s = buf.toString("utf8");
  const start = s.charCodeAt(0) === 0xfeff ? 1 : 0;
  if (!s.includes(String.fromCharCode(0xfffd))) return s.slice(start);
  return buf.toString("latin1");
}

export function splitDelimited(text, delimiter) {
  const rows = [];
  let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"' && cell === "") q = true;
    else if (c === delimiter) { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); if (row.length > 1 || row[0] !== "") rows.push(row); }
  return rows;
}

export function detectDelimiter(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 20);
  if (lines.length < 2) return null;
  for (const d of ["\t", ";", ",", "|"]) {
    const counts = lines.map((l) => l.split(d).length - 1);
    const first = counts[0];
    if (first >= 1 && counts.filter((c) => c === first).length >= Math.max(2, Math.ceil(lines.length * 0.8))) return d;
  }
  return null;
}

const cellValue = (v) => { const t = v.trim(); if (t === "") return null; return t; };

function tableSection(rows, title) {
  const width = Math.max(...rows.map((r) => r.length));
  const pad = (r) => [...r, ...Array(width - r.length).fill("")];
  const [h, ...body] = rows.map(pad);
  const sec = newSection({ path: "dati", title, level: 1 });
  sec.tables.push({ headers: h.map((x) => oneLine(x)), rows: body.map((r) => r.map(cellValue)), rows_total: body.length });
  return sec;
}

export function parseCsv(buffer, { id, title, source = null, delimiter = null } = {}) {
  const text = decodeText(buffer);
  const d = delimiter ?? detectDelimiter(text) ?? ",";
  const rows = splitDelimited(text, d);
  if (!rows.length) throw new ParseError("file tabellare vuoto", { residue: "irrelevant" });
  const doc = newDoc({ id, title: title ?? source ?? id, format: "csv", source, parser: "parse-text" });
  doc.meta.sha256 = sha256(Buffer.isBuffer(buffer) ? buffer : Buffer.from(text));
  doc.meta.size = Buffer.isBuffer(buffer) ? buffer.length : text.length;
  doc.sections.push(tableSection(rows, title ?? source ?? "Dati"));
  return finishDoc(doc);
}

const HEADING_MD = /^(#{1,6})\s+(.+)$/;
const isCapsHeading = (l, next) => l.length <= 80 && /[A-Z]/.test(l) && l === l.toUpperCase() && !/[.;,]$/.test(l) && l.split(/\s+/).length <= 10 && !!next;

export function parseText(buffer, { id, title, source = null } = {}) {
  const text = decodeText(buffer);
  if (!text.trim()) throw new ParseError("file di testo vuoto", { residue: "irrelevant" });
  const d = detectDelimiter(text);
  if (d && d !== ",") { const doc = parseCsv(buffer, { id, title, source, delimiter: d }); doc.format = "txt"; doc.meta.kind_hint = "dati-tabellari"; return doc; }
  const doc = newDoc({ id, title: title ?? source ?? id, format: /\.md$/i.test(source ?? "") ? "md" : "txt", source, parser: "parse-text" });
  doc.meta.sha256 = sha256(Buffer.isBuffer(buffer) ? buffer : Buffer.from(text));
  doc.meta.size = Buffer.isBuffer(buffer) ? buffer.length : text.length;
  let sec = newSection({ path: "0", title: title ?? source ?? id, level: 1 });
  doc.sections.push(sec);
  let n = 0;
  const lines = text.split(/\r?\n/);
  let para = [];
  const flush = () => { const t = oneLine(para.join(" ")); if (t) sec.paragraphs.push(t); para = []; };
  lines.forEach((raw, i) => {
    const l = raw.trim();
    const md = HEADING_MD.exec(l);
    const next = lines.slice(i + 1).find((x) => x.trim());
    if (md || (isCapsHeading(l, next) && !para.length)) {
      flush();
      sec = newSection({ path: String(++n), title: md ? md[2] : l, level: md ? md[1].length : 1 });
      doc.sections.push(sec);
      return;
    }
    if (!l) { flush(); return; }
    if (/^([-*•]|\d+[.)])\s/.test(l)) { flush(); para.push(l); flush(); return; }
    para.push(l);
  });
  flush();
  return finishDoc(doc);
}

const stripTags = (s) => oneLine(decodeEntities(s.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, " ")));

export function parseHtml(buffer, { id, title, source = null } = {}) {
  let html = decodeText(buffer).replace(/<!--[\s\S]*?-->/g, "").replace(/<(script|style|noscript|svg)\b[\s\S]*?<\/\1>/gi, "");
  const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const doc = newDoc({ id, title: title ?? (t ? stripTags(t[1]) : null) ?? source ?? id, format: "html", source, parser: "parse-text" });
  doc.meta.sha256 = sha256(Buffer.isBuffer(buffer) ? buffer : Buffer.from(html));
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html);
  if (body) html = body[1];
  let sec = newSection({ path: "0", title: doc.title, level: 1 });
  doc.sections.push(sec);
  const counters = [];
  const re = /<(h[1-6])\b[^>]*>([\s\S]*?)<\/\1>|<table\b[^>]*>([\s\S]*?)<\/table>|<(p|li|dd|dt|div|td|pre|blockquote)\b[^>]*>([\s\S]*?)(?=<\/?(?:p|li|dd|dt|div|h[1-6]|table|ul|ol|pre|blockquote)\b|$)|<img\b([^>]*)>/gi;
  let m;
  while ((m = re.exec(html))) {
    if (m[1]) {
      const lvl = Number(m[1][1]);
      counters.length = lvl;
      for (let i = 0; i < lvl; i++) counters[i] = counters[i] ?? 0;
      counters[lvl - 1]++;
      sec = newSection({ path: counters.join("."), title: stripTags(m[2]), level: lvl });
      doc.sections.push(sec);
    } else if (m[3] !== undefined) {
      const rows = [...m[3].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((r) => [...r[1].matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((c) => stripTags(c[1])));
      const good = rows.filter((r) => r.length);
      if (good.length >= 2) { const w = Math.max(...good.map((r) => r.length)); const pad = (r) => [...r, ...Array(w - r.length).fill("")]; sec.tables.push({ headers: pad(good[0]), rows: good.slice(1).map(pad) }); }
      else if (good.length) sec.paragraphs.push(good[0].join(" "));
    } else if (m[6] !== undefined) {
      const alt = /alt="([^"]*)"/i.exec(m[6])?.[1];
      const src = /src="([^"]*)"/i.exec(m[6])?.[1];
      if (src && !/^data:/i.test(src)) sec.figures.push({ ref: src.slice(0, 200), caption: alt ? oneLine(alt) : undefined });
    } else {
      const txt = stripTags(m[5] ?? "");
      if (txt && txt.length > 1) sec.paragraphs.push(txt);
    }
  }
  if (doc.sections.every((s) => !s.paragraphs.length && !s.tables.length)) {
    const all = stripTags(html);
    if (all) doc.sections[0].paragraphs.push(all);
  }
  return finishDoc(doc);
}

export function parse(buffer, opts = {}) {
  const src = opts.source ?? "";
  if (/\.(csv)$/i.test(src)) return parseCsv(buffer, opts);
  if (/\.(html?|xhtml)$/i.test(src)) return parseHtml(buffer, opts);
  return parseText(buffer, opts);
}
runParserCli(import.meta.url, { name: "parse-text", ext: ".txt", parse });
