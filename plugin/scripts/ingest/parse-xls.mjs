// Parser XLS binario (BIFF8 dentro un Compound File, Excel 97-2003) senza dipendenze → documento normalizzato.
// Formato vecchio non nel brief: decisione del controllore — si legge se fattibile, altrimenti residuo
// `deferred` con motivo. Qui è fattibile per il caso comune: fogli di celle (SST, LABELSST, LABEL, NUMBER,
// RK, MULRK, FORMULA con risultato in cache, STRING, BOOLERR) e celle unite (MERGEDCELLS).
//
//   readCfb(buffer) → { streams: Map<nome, Buffer> }       Compound File Binary (FAT, mini FAT, DIFAT)
//   parseXls(buffer, { id, title?, source? }) → parsed-doc (una sezione per foglio, come parse-xlsx)
// Non supportati (→ ParseError residuo `deferred` con il motivo): file cifrati (FILEPASS), BIFF5/BIFF7
// (Excel 95), grafici e fogli macro (saltati con avviso).
// CLI: node scripts/ingest/parse-xls.mjs --in <file.xls> [--id <id>] [--out <file.json>] [--json]
import { newDoc, newSection, finishDoc, oneLine, ParseError, sha256 } from "./lib/parsed.mjs";
import { runParserCli } from "./lib/cli.mjs";

const SIG = "d0cf11e0a1b11ae1";
const END = 0xfffffffe, FREE = 0xffffffff;

export function isCfb(buf) { return Buffer.isBuffer(buf) && buf.length >= 512 && buf.subarray(0, 8).toString("hex") === SIG; }

// Giro 1 (I5): catene FAT e mini-FAT con rilevamento dei cicli (settori già visitati) e tetto dei byte per stream.
export const LIMITS = Object.freeze({ maxStreamBytes: 64 * 1024 * 1024 });

export function readCfb(buf, limits = LIMITS) {
  if (!isCfb(buf)) throw new ParseError("non è un Compound File (OLE2)", { residue: "unsupported" });
  const ss = 1 << buf.readUInt16LE(0x1e);
  const mss = 1 << buf.readUInt16LE(0x20);
  const nFat = buf.readUInt32LE(0x2c);
  const dirStart = buf.readUInt32LE(0x30);
  const cutoff = buf.readUInt32LE(0x38);
  const miniFatStart = buf.readUInt32LE(0x3c);
  let difatNext = buf.readUInt32LE(0x44);
  const sector = (n) => buf.subarray((n + 1) * ss, (n + 2) * ss);
  const fatSectors = [];
  for (let i = 0; i < 109 && fatSectors.length < nFat; i++) { const s = buf.readUInt32LE(0x4c + i * 4); if (s !== FREE) fatSectors.push(s); }
  let guard = 0;
  while (difatNext !== END && difatNext !== FREE && fatSectors.length < nFat && guard++ < 10000) {
    const d = sector(difatNext);
    for (let i = 0; i < ss / 4 - 1 && fatSectors.length < nFat; i++) { const s = d.readUInt32LE(i * 4); if (s !== FREE) fatSectors.push(s); }
    difatNext = d.readUInt32LE(ss - 4);
  }
  const fat = [];
  for (const s of fatSectors) { const d = sector(s); for (let i = 0; i < ss / 4; i++) fat.push(d.readUInt32LE(i * 4)); }
  const chain = (start, table, unit = ss) => {
    const out = [];
    const seen = new Set();
    let s = start;
    while (s !== END && s !== FREE && s < table.length) {
      if (seen.has(s)) throw new ParseError(`Compound File non valido: ciclo nella catena dei settori (${s})`, { residue: "unsupported" });
      seen.add(s);
      out.push(s);
      if (out.length * unit > limits.maxStreamBytes) throw new ParseError(`stream oltre ${limits.maxStreamBytes} byte`, { residue: "unsupported" });
      s = table[s];
    }
    return out;
  };
  const readChain = (start) => Buffer.concat(chain(start, fat).map(sector));
  const dir = readChain(dirStart);
  const entries = [];
  for (let off = 0; off + 128 <= dir.length; off += 128) {
    const nlen = dir.readUInt16LE(off + 64);
    const type = dir[off + 66];
    if (!type) continue;
    entries.push({ name: dir.subarray(off, off + Math.max(0, nlen - 2)).toString("utf16le"), type, start: dir.readUInt32LE(off + 116), size: dir.readUInt32LE(off + 120) });
  }
  const root = entries.find((e) => e.type === 5);
  const miniStream = root ? readChain(root.start) : Buffer.alloc(0);
  const miniFat = [];
  if (miniFatStart !== END && miniFatStart !== FREE) { const m = readChain(miniFatStart); for (let i = 0; i + 4 <= m.length; i += 4) miniFat.push(m.readUInt32LE(i)); }
  const streams = new Map();
  for (const e of entries.filter((x) => x.type === 2)) {
    let data;
    if (e.size < cutoff) data = Buffer.concat(chain(e.start, miniFat, mss).map((s) => miniStream.subarray(s * mss, (s + 1) * mss)));
    else data = readChain(e.start);
    streams.set(e.name, data.subarray(0, e.size));
  }
  return { streams };
}

function* records(buf, from = 0) {
  let p = from;
  while (p + 4 <= buf.length) {
    const type = buf.readUInt16LE(p), len = buf.readUInt16LE(p + 2);
    yield { type, data: buf.subarray(p + 4, p + 4 + len), pos: p };
    p += 4 + len;
  }
}

function rk(v) {
  let n;
  if (v & 2) n = v >> 2;
  else { const b = Buffer.alloc(8); b.writeUInt32LE(v & 0xfffffffc, 4); n = b.readDoubleLE(0); }
  return v & 1 ? n / 100 : n;
}

// Lettore di stringhe che attraversa i record CONTINUE (SST): al confine, i caratteri riprendono con un nuovo byte di opzioni.
class Chunks {
  constructor(parts) { this.parts = parts; this.i = 0; this.p = 0; }
  ensure() { while (this.i < this.parts.length && this.p >= this.parts[this.i].length) { this.i++; this.p = 0; } }
  u8() { this.ensure(); return this.parts[this.i][this.p++]; }
  u16() { const a = this.u8(), b = this.u8(); return a | (b << 8); }
  u32() { return (this.u16() | (this.u16() << 16)) >>> 0; }
  skip(n) { for (let k = 0; k < n; k++) this.u8(); }
  chars(cch, wide) {
    let out = "", w = wide;
    for (let k = 0; k < cch; k++) {
      if (this.i < this.parts.length && this.p >= this.parts[this.i].length) { this.i++; this.p = 0; w = !!(this.u8() & 1); }
      out += w ? String.fromCharCode(this.u16()) : String.fromCharCode(this.u8());
    }
    return out;
  }
}

function xlString(c, cch) {
  const flags = c.u8();
  const rich = flags & 8 ? c.u16() : 0;
  const ext = flags & 4 ? c.u32() : 0;
  const s = c.chars(cch, !!(flags & 1));
  c.skip(rich * 4 + ext);
  return s;
}

const shortString = (d, off) => { const cch = d[off], wide = d[off + 1] & 1; return wide ? d.subarray(off + 2, off + 2 + cch * 2).toString("utf16le") : d.subarray(off + 2, off + 2 + cch).toString("latin1"); };

export function parseXls(buffer, { id, title, source = null } = {}) {
  const { streams } = readCfb(buffer);
  const wb = streams.get("Workbook") ?? streams.get("Book");
  if (!wb) throw new ParseError("stream Workbook assente: non è una cartella di lavoro Excel", { residue: "unsupported" });
  const doc = newDoc({ id, title, format: "xls", source, parser: "parse-xls" });
  doc.meta.sha256 = sha256(buffer);
  doc.meta.size = buffer.length;
  const sheets = [];
  let sst = [];
  const it = records(wb);
  let first = it.next();
  if (first.done || first.value.type !== 0x0809) throw new ParseError("record BOF assente", { residue: "unsupported" });
  if (first.value.data.readUInt16LE(0) !== 0x0600) throw new ParseError("versione BIFF anteriore a BIFF8 (Excel 95 o precedente): esportare in .xlsx", { residue: "deferred" });
  const all = [...records(wb)];
  for (let i = 0; i < all.length; i++) {
    const r = all[i];
    if (r.type === 0x002f) throw new ParseError("cartella di lavoro XLS cifrata (FILEPASS): serve una copia senza protezione", { residue: "deferred" });
    if (r.type === 0x0085) sheets.push({ offset: r.data.readUInt32LE(0), hidden: (r.data[4] & 3) !== 0, kind: r.data[5], name: shortString(r.data, 6) });
    if (r.type === 0x00fc) {
      const parts = [r.data.subarray(8)];
      while (all[i + 1]?.type === 0x003c) parts.push(all[++i].data);
      const total = r.data.readUInt32LE(4);
      const c = new Chunks(parts);
      sst = [];
      try { for (let k = 0; k < total; k++) { const cch = c.u16(); sst.push(xlString(c, cch)); } } catch { doc.warnings.push("SST troncata: alcune stringhe condivise mancano"); }
    }
    if (r.type === 0x000a) break;   // EOF dei globali
  }
  sheets.forEach((sh, n) => {
    const sec = newSection({ path: `sheet-${n + 1}`, title: sh.name, level: 1 });
    if (sh.hidden) sec.hidden = true;
    doc.sections.push(sec);
    if (sh.kind !== 0) { doc.warnings.push(`foglio ${sh.name}: grafico o macro, saltato`); return; }
    const grid = [];
    const merges = [];
    const set = (r, c, v) => { if (v === null || v === undefined || v === "") return; (grid[r] ??= [])[c] = typeof v === "string" ? oneLine(v) : v; };
    let pendingFormula = null;
    for (const r of records(wb, sh.offset)) {
      const d = r.data;
      if (r.type === 0x000a) break;
      if (r.type === 0x00fd) set(d.readUInt16LE(0), d.readUInt16LE(2), sst[d.readUInt32LE(6)] ?? "");
      else if (r.type === 0x0204) { const c = new Chunks([d.subarray(8)]); set(d.readUInt16LE(0), d.readUInt16LE(2), xlString(c, d.readUInt16LE(6))); }
      else if (r.type === 0x0203) set(d.readUInt16LE(0), d.readUInt16LE(2), d.readDoubleLE(6));
      else if (r.type === 0x027e) set(d.readUInt16LE(0), d.readUInt16LE(2), rk(d.readUInt32LE(6)));
      else if (r.type === 0x00bd) {
        const row = d.readUInt16LE(0), c1 = d.readUInt16LE(2), c2 = d.readUInt16LE(d.length - 2);
        for (let c = c1, off = 4; c <= c2 && off + 6 <= d.length - 2; c++, off += 6) set(row, c, rk(d.readUInt32LE(off + 2)));
      } else if (r.type === 0x0006) {
        const row = d.readUInt16LE(0), col = d.readUInt16LE(2);
        if (d.readUInt16LE(12) === 0xffff) { const kind = d[6]; if (kind === 0) pendingFormula = { row, col }; else if (kind === 1) set(row, col, d[8] === 1); }
        else set(row, col, d.readDoubleLE(6));
      } else if (r.type === 0x0207 && pendingFormula) { const c = new Chunks([d.subarray(2)]); set(pendingFormula.row, pendingFormula.col, xlString(c, d.readUInt16LE(0))); pendingFormula = null; }
      else if (r.type === 0x0205 && d[7] === 0) set(d.readUInt16LE(0), d.readUInt16LE(2), d[6] === 1);
      else if (r.type === 0x00e5) { const n2 = d.readUInt16LE(0); for (let k = 0; k < n2; k++) merges.push({ r1: d.readUInt16LE(2 + k * 8), r2: d.readUInt16LE(4 + k * 8), c1: d.readUInt16LE(6 + k * 8), c2: d.readUInt16LE(8 + k * 8) }); }
    }
    for (const m of merges) { const v = grid[m.r1]?.[m.c1]; if (v === undefined) continue; for (let r = m.r1; r <= m.r2; r++) for (let c = m.c1; c <= m.c2; c++) if (r !== m.r1 || c !== m.c1) (grid[r] ??= [])[c] = v; }
    const rows = [];
    for (let r = 0; r < grid.length; r++) rows.push(grid[r] ?? []);
    const firstRow = rows.findIndex((r) => r.some((v) => v !== undefined && v !== ""));
    if (firstRow < 0) return;
    let last = rows.length - 1;
    while (last > firstRow && !rows[last].some((v) => v !== undefined)) last--;
    const width = Math.max(...rows.slice(firstRow, last + 1).map((r) => r.length));
    const cell = (r, c) => (rows[r]?.[c] === undefined ? null : rows[r][c]);
    sec.tables.push({ headers: Array.from({ length: width }, (_, c) => String(cell(firstRow, c) ?? "")),
      rows: Array.from({ length: last - firstRow }, (_, k) => Array.from({ length: width }, (_, c) => cell(firstRow + 1 + k, c))) });
  });
  return finishDoc(doc);
}

export const parse = parseXls;
runParserCli(import.meta.url, { name: "parse-xls", ext: ".xls", parse: parseXls });
