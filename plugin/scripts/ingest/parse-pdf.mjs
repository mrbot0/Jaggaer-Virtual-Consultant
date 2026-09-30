// Parser PDF testuale "best effort" senza dipendenze → documento normalizzato, §19.8.
//
//   parsePdf(buffer, { id, title?, source? }) → parsed-doc
//     - oggetti "n g obj … endobj" e flussi di oggetti (/ObjStm); filtri FlateDecode (zlib), ASCII85,
//       ASCIIHex, LZW; albero delle pagine dal catalogo (risorse ereditate), con ripiego sugli oggetti /Page;
//     - operatori di testo Tj, TJ, ', " dentro BT…ET, posizionamento Td/TD/Tm/T* per righe e spazi,
//       XObject di tipo Form ricorsivi; decodifica con /ToUnicode (bfchar/bfrange) o con la codifica
//       semplice (WinAnsi/Standard + /Differences);
//     - una sezione per pagina (path "p<n>", page = n); titolo = la riga di corpo più grande della pagina;
//       paragrafi dalle righe, separati dagli stacchi verticali;
//     - pagine con immagini e senza testo → avviso; `scanned: true` quando nessuna pagina ha testo e
//       almeno una ha immagini: serve il sidecar OCR (<file>.ocr.txt), come per le schermate.
// Limiti dichiarati (report di fase): niente PDF cifrati (→ residuo deferred), niente font CID senza
// /ToUnicode (testo non decodificabile → avviso), tabelle non ricostruite (le colonne restano righe di
// testo), ordine di lettura = ordine del flusso, intestazioni riconosciute solo dalla dimensione del font.
// CLI: node scripts/ingest/parse-pdf.mjs --in <file.pdf> [--id <id>] [--out <file.json>] [--json]
import { inflateSync, inflateRawSync, constants as Z } from "node:zlib";
import { existsSync, readFileSync } from "node:fs";
import { newDoc, newSection, finishDoc, oneLine, ParseError, sha256 } from "./lib/parsed.mjs";
import { runParserCli } from "./lib/cli.mjs";

// ---------------------------------------------------------------- valori PDF
const WS = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIM = new Set("()<>[]{}/%".split("").map((c) => c.charCodeAt(0)));
class Ref { constructor(n, g) { this.n = n; this.g = g; } }
class Name { constructor(v) { this.v = v; } toString() { return this.v; } }
class Op { constructor(v) { this.v = v; } }

// Lettore di token su una stringa latin1 (1 carattere = 1 byte).
class Lexer {
  constructor(s, pos = 0) { this.s = s; this.i = pos; }
  skipWs() {
    const s = this.s;
    for (;;) {
      while (this.i < s.length && WS.has(s.charCodeAt(this.i))) this.i++;
      if (s[this.i] === "%") { while (this.i < s.length && s[this.i] !== "\n" && s[this.i] !== "\r") this.i++; continue; }
      return;
    }
  }
  next() {
    this.skipWs();
    const s = this.s;
    if (this.i >= s.length) return undefined;
    const c = s[this.i];
    if (c === "/") {
      let j = this.i + 1;
      while (j < s.length && !WS.has(s.charCodeAt(j)) && !DELIM.has(s.charCodeAt(j))) j++;
      const raw = s.slice(this.i + 1, j).replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
      this.i = j; return new Name(raw);
    }
    if (c === "(") return this.literal();
    if (c === "<" && s[this.i + 1] === "<") { this.i += 2; return "<<"; }
    if (c === ">" && s[this.i + 1] === ">") { this.i += 2; return ">>"; }
    if (c === "<") {
      const e = s.indexOf(">", this.i);
      const hex = s.slice(this.i + 1, e < 0 ? s.length : e).replace(/[^0-9a-fA-F]/g, "");
      this.i = e < 0 ? s.length : e + 1;
      const h = hex.length % 2 ? `${hex}0` : hex;
      let out = "";
      for (let k = 0; k < h.length; k += 2) out += String.fromCharCode(parseInt(h.slice(k, k + 2), 16));
      return { str: out };
    }
    if (c === "[" || c === "]" || c === "{" || c === "}") { this.i++; return c; }
    let j = this.i;
    while (j < s.length && !WS.has(s.charCodeAt(j)) && !DELIM.has(s.charCodeAt(j))) j++;
    if (j === this.i) { this.i++; return this.next(); }
    const tok = s.slice(this.i, j);
    this.i = j;
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(tok)) return Number(tok);
    if (tok === "true") return true;
    if (tok === "false") return false;
    if (tok === "null") return null;
    return new Op(tok);
  }
  literal() {
    const s = this.s;
    let depth = 1, out = "";
    this.i++;
    while (this.i < s.length && depth > 0) {
      const c = s[this.i++];
      if (c === "\\") {
        const d = s[this.i++];
        if (d === "n") out += "\n"; else if (d === "r") out += "\r"; else if (d === "t") out += "\t";
        else if (d === "b") out += "\b"; else if (d === "f") out += "\f";
        else if (d === "\r") { if (s[this.i] === "\n") this.i++; }
        else if (d === "\n") { /* continuazione */ }
        else if (d >= "0" && d <= "7") {
          let oct = d;
          while (oct.length < 3 && s[this.i] >= "0" && s[this.i] <= "7") oct += s[this.i++];
          out += String.fromCharCode(parseInt(oct, 8) & 0xff);
        } else out += d ?? "";
      } else if (c === "(") { depth++; out += c; }
      else if (c === ")") { depth--; if (depth) out += c; }
      else out += c;
    }
    return { str: out };
  }
}

// Valore completo (dizionari, array, riferimenti "n g R") dal lexer.
function readValue(lx, tok = lx.next()) {
  if (tok === "<<") {
    const d = {};
    for (;;) {
      const k = lx.next();
      if (k === ">>" || k === undefined) return d;
      if (k instanceof Name) d[k.v] = readValue(lx);
    }
  }
  if (tok === "[") {
    const a = [];
    for (;;) {
      const save = lx.i;
      const t = lx.next();
      if (t === "]" || t === undefined) return a;
      lx.i = save;
      a.push(readValue(lx));
    }
  }
  if (typeof tok === "number" && Number.isInteger(tok)) {
    const save = lx.i;
    const g = lx.next();
    if (typeof g === "number" && Number.isInteger(g)) {
      const r = lx.next();
      if (r instanceof Op && r.v === "R") return new Ref(tok, g);
    }
    lx.i = save;
  }
  return tok;
}

// ---------------------------------------------------------------- filtri
function ascii85(data) {
  const s = data.toString("latin1").replace(/\s/g, "").replace(/^<~/, "").replace(/~>.*$/, "");
  const out = [];
  let group = [];
  for (const ch of s) {
    if (ch === "z" && !group.length) { out.push(0, 0, 0, 0); continue; }
    group.push(ch.charCodeAt(0) - 33);
    if (group.length === 5) {
      let v = 0; for (const g of group) v = v * 85 + g;
      out.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
      group = [];
    }
  }
  if (group.length) {
    const n = group.length;
    while (group.length < 5) group.push(84);
    let v = 0; for (const g of group) v = v * 85 + g;
    const bytes = [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
    out.push(...bytes.slice(0, n - 1));
  }
  return Buffer.from(out);
}
function asciiHex(data) {
  const h = data.toString("latin1").replace(/>.*$/s, "").replace(/[^0-9a-fA-F]/g, "");
  return Buffer.from(h.length % 2 ? `${h}0` : h, "hex");
}
// Giro 1 (I5): limiti di risorse. Un PDF di 300 KB può decomprimersi in un GB: ogni flusso è limitato (come le voci
// ZIP), il documento ha un tetto complessivo, gli XObject Form sono memorizzati e contati, gli operatori per pagina
// contati. Oltre un limite ⇒ ParseError (residuo unsupported con motivo), mai un'eccezione non gestita.
export const LIMITS = Object.freeze({
  maxStreamBytes: 64 * 1024 * 1024,   // un flusso decompresso
  maxDocBytes: 256 * 1024 * 1024,     // somma dei flussi decompressi del documento
  maxFormCalls: 2000,                 // invocazioni di XObject Form per pagina (ventaglio × profondità)
  maxOpsPerPage: 2000000,             // operatori di contenuto per pagina, Form comprese
});
const limitError = (m) => new ParseError(m, { residue: "unsupported" });

export function lzwDecode(data, cap = LIMITS.maxStreamBytes) {
  const out = [];
  let dict = [];
  const reset = () => { dict = []; for (let i = 0; i < 256; i++) dict.push([i]); dict.push(null, null); };
  reset();
  let bits = 9, buf = 0, nbits = 0, prev = null;
  for (const byte of data) {
    buf = ((buf << 8) | byte) & 0xffffff; nbits += 8;
    while (nbits >= bits) {
      const code = (buf >>> (nbits - bits)) & ((1 << bits) - 1);
      nbits -= bits;
      if (code === 256) { reset(); bits = 9; prev = null; continue; }
      if (code === 257) return Buffer.from(out);
      let entry;
      if (code < dict.length && dict[code]) entry = dict[code];
      else if (prev) entry = [...prev, prev[0]];
      else return Buffer.from(out);
      if (out.length + entry.length > cap) throw limitError(`flusso LZW oltre ${cap} byte decompressi`);
      for (const x of entry) out.push(x);
      if (prev && dict.length < 4096) dict.push([...prev, entry[0]]);
      prev = entry;
      if (dict.length + 1 >= 1 << bits && bits < 12) bits++;
    }
  }
  return Buffer.from(out);
}
function flate(data, cap) {
  const tooBig = (e) => e?.code === "ERR_BUFFER_TOO_LARGE" || /maxOutputLength|larger than/i.test(e?.message ?? "");
  const tries = [(d) => inflateSync(d, { maxOutputLength: cap }), (d) => inflateSync(d, { finishFlush: Z.Z_SYNC_FLUSH, maxOutputLength: cap }), (d) => inflateRawSync(d, { finishFlush: Z.Z_SYNC_FLUSH, maxOutputLength: cap })];
  for (const t of tries) {
    try { return t(data); } catch (e) { if (tooBig(e)) throw limitError(`flusso Flate oltre ${cap} byte decompressi`); }
  }
  return null;
}
const IMAGE_FILTERS = new Set(["DCTDecode", "JPXDecode", "CCITTFaxDecode", "JBIG2Decode", "RunLengthDecode"]);

// ---------------------------------------------------------------- documento
class PdfFile {
  constructor(buf, limits = LIMITS) {
    this.limits = limits;
    this.inflated = 0;
    this.decoded = new Map();   // flussi decodificati per oggetto (memo: un Form usato 1000 volte si decodifica una volta)
    this.buf = buf;
    this.s = buf.toString("latin1");
    this.objects = new Map();
    this.warnings = [];
    this.scan();
  }
  scan() {
    const s = this.s;
    const re = /(\d+)\s+(\d+)\s+obj\b/g;
    let m;
    while ((m = re.exec(s))) {
      const num = Number(m[1]);
      const start = m.index + m[0].length;
      const lx = new Lexer(s, start);
      let value;
      try { value = readValue(lx); } catch { continue; }
      let stream = null;
      lx.skipWs();
      if (value && typeof value === "object" && !Array.isArray(value) && s.startsWith("stream", lx.i)) {
        let p = lx.i + 6;
        if (s[p] === "\r") p++;
        if (s[p] === "\n") p++;
        let end = -1;
        if (typeof value.Length === "number" && p + value.Length <= s.length && /^\s*endstream/.test(s.slice(p + value.Length, p + value.Length + 20))) end = p + value.Length;
        if (end < 0) { end = s.indexOf("endstream", p); if (end < 0) end = s.length; while (end > p && (s[end - 1] === "\n" || s[end - 1] === "\r")) end--; }
        stream = { start: p, end };
        re.lastIndex = end;
      } else re.lastIndex = lx.i;
      this.objects.set(num, { value, stream });
    }
    // flussi di oggetti (PDF 1.5)
    for (const [, o] of [...this.objects]) {
      if (!o.stream || o.value?.Type?.v !== "ObjStm") continue;
      const data = this.streamData(o);
      if (!data) continue;
      const txt = data.toString("latin1");
      const n = Number(o.value.N) || 0;
      const first = Number(o.value.First) || 0;
      const head = new Lexer(txt.slice(0, first));
      const pairs = [];
      for (let k = 0; k < n; k++) { const a = head.next(); const b = head.next(); if (typeof a !== "number" || typeof b !== "number") break; pairs.push([a, b]); }
      for (const [num, off] of pairs) {
        if (this.objects.has(num)) continue;
        try { this.objects.set(num, { value: readValue(new Lexer(txt, first + off)), stream: null }); } catch { /* ignora */ }
      }
    }
  }
  get(v) {
    let x = v, guard = 0;
    while (x instanceof Ref && guard++ < 32) x = this.objects.get(x.n)?.value;
    return x;
  }
  obj(v) { return v instanceof Ref ? this.objects.get(v.n) : null; }
  streamData(o) {
    if (!o?.stream) return null;
    if (this.decoded.has(o)) return this.decoded.get(o);
    const data = this.decodeStream(o);
    this.decoded.set(o, data);
    if (data) {
      this.inflated += data.length;
      if (this.inflated > this.limits.maxDocBytes) throw limitError(`documento oltre ${this.limits.maxDocBytes} byte di flussi decompressi`);
    }
    return data;
  }
  decodeStream(o) {
    let data = this.buf.subarray(o.stream.start, o.stream.end);
    const cap = Math.max(1, Math.min(this.limits.maxStreamBytes, this.limits.maxDocBytes - this.inflated));
    const f = this.get(o.value.Filter);
    const filters = (Array.isArray(f) ? f : f ? [f] : []).map((x) => (this.get(x) ?? "").toString());
    for (const name of filters) {
      if (name === "FlateDecode" || name === "Fl") data = flate(data, cap);
      else if (name === "ASCII85Decode" || name === "A85") data = ascii85(data);
      else if (name === "ASCIIHexDecode" || name === "AHx") data = asciiHex(data);
      else if (name === "LZWDecode" || name === "LZW") data = lzwDecode(data, cap);
      else if (IMAGE_FILTERS.has(name)) return null;
      else return null;
      if (!data) return null;
    }
    return data;
  }
  pages() {
    const out = [];
    const root = [...this.objects.values()].find((o) => this.get(o.value?.Type)?.v === "Catalog");
    const visit = (ref, inherited, depth) => {
      if (depth > 64 || out.length > 5000) return;
      const node = this.get(ref);
      if (!node || typeof node !== "object") return;
      const res = node.Resources ?? inherited;
      const type = this.get(node.Type)?.v;
      if (type === "Pages" || Array.isArray(this.get(node.Kids))) { for (const k of this.get(node.Kids) ?? []) visit(k, res, depth + 1); }
      else out.push({ node, resources: res });
    };
    if (root) visit(root.value.Pages, null, 0);
    if (!out.length) for (const o of this.objects.values()) if (this.get(o.value?.Type)?.v === "Page") out.push({ node: o.value, resources: o.value.Resources ?? null });
    return out;
  }
}

// ---------------------------------------------------------------- font
const GLYPHS = {
  space: " ", exclam: "!", quotedbl: '"', numbersign: "#", dollar: "$", percent: "%", ampersand: "&", quotesingle: "'", quoteright: "’",
  quoteleft: "‘", parenleft: "(", parenright: ")", asterisk: "*", plus: "+", comma: ",", hyphen: "-", minus: "-", period: ".", slash: "/",
  zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", colon: ":", semicolon: ";",
  less: "<", equal: "=", greater: ">", question: "?", at: "@", bracketleft: "[", backslash: "\\", bracketright: "]", underscore: "_",
  braceleft: "{", bar: "|", braceright: "}", asciitilde: "~", bullet: "•", endash: "–", emdash: "—", quotedblleft: "“",
  quotedblright: "”", ellipsis: "…", Euro: "€", degree: "°", copyright: "©", registered: "®", trademark: "™",
  agrave: "à", egrave: "è", eacute: "é", igrave: "ì", ograve: "ò", ugrave: "ù", Agrave: "À", Egrave: "È",
  Eacute: "É", ccedilla: "ç", udieresis: "ü", odieresis: "ö", adieresis: "ä", fi: "fi", fl: "fl", nbspace: " ",
};
const PUA = new RegExp("[\uE000-\uF8FF]", "g");
const WIN = { 0x80: "€", 0x82: "‚", 0x84: "„", 0x85: "…", 0x91: "‘", 0x92: "’", 0x93: "“", 0x94: "”", 0x95: "•", 0x96: "–", 0x97: "—", 0x99: "™", 0xa0: " " };

function parseCMap(txt) {
  const map = new Map();
  let width = 1;
  const cs = /begincodespacerange([\s\S]*?)endcodespacerange/.exec(txt);
  if (cs) { const m = /<([0-9a-fA-F]+)>/.exec(cs[1]); if (m) width = Math.max(1, m[1].length / 2); }
  const hexToStr = (h) => { let o = ""; for (let i = 0; i + 4 <= h.length; i += 4) o += String.fromCharCode(parseInt(h.slice(i, i + 4), 16)); if (h.length === 2) o = String.fromCharCode(parseInt(h, 16)); return o; };
  for (const block of txt.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) map.set(parseInt(m[1], 16), hexToStr(m[2]));
  }
  for (const block of txt.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const m of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<([0-9a-fA-F]+)>|\[([^\]]*)\])/g)) {
      const lo = parseInt(m[1], 16), hi = parseInt(m[2], 16);
      if (hi - lo > 65535) continue;
      if (m[4] !== undefined) {
        const base = m[4];
        const last = parseInt(base.slice(-4) || base, 16);
        const prefix = base.length > 4 ? hexToStr(base.slice(0, -4)) : "";
        for (let c = lo; c <= hi; c++) map.set(c, prefix + String.fromCharCode(last + (c - lo)));
      } else {
        const list = [...m[5].matchAll(/<([0-9a-fA-F]*)>/g)].map((x) => hexToStr(x[1]));
        for (let c = lo; c <= hi && c - lo < list.length; c++) map.set(c, list[c - lo]);
      }
    }
  }
  return { map, width };
}

function makeFont(pdf, fontRef) {
  const f = pdf.get(fontRef);
  if (!f || typeof f !== "object") return { decode: (s) => s, bad: false };
  const subtype = pdf.get(f.Subtype)?.v;
  let cmap = null;
  const tu = pdf.obj(f.ToUnicode);
  if (tu) { const d = pdf.streamData(tu); if (d) cmap = parseCMap(d.toString("latin1")); }
  const type0 = subtype === "Type0";
  // i font semplici hanno sempre codici di 1 byte, qualunque sia il codespace della ToUnicode
  const width = type0 ? (cmap?.width ?? 2) : 1;
  const diffs = new Map();
  const enc = pdf.get(f.Encoding);
  if (enc && typeof enc === "object" && !(enc instanceof Name)) {
    let code = 0;
    for (const d of pdf.get(enc.Differences) ?? []) {
      if (typeof d === "number") code = d;
      else if (d instanceof Name) { const g = d.v; diffs.set(code++, GLYPHS[g] ?? (g.length === 1 ? g : /^uni([0-9A-F]{4})$/.exec(g) ? String.fromCharCode(parseInt(g.slice(3), 16)) : "")); }
    }
  }
  const font = { bad: false, decode: null };
  font.decode = (raw) => {
    let out = "";
    for (let i = 0; i + width <= raw.length; i += width) {
      let code = 0;
      for (let k = 0; k < width; k++) code = code * 256 + raw.charCodeAt(i + k);
      if (cmap?.map.has(code)) { out += cmap.map.get(code); continue; }
      if (type0) { font.bad = true; continue; }
      if (diffs.has(code)) { out += diffs.get(code); continue; }
      out += WIN[code] ?? (code >= 32 ? String.fromCharCode(code) : code === 9 ? " " : "");
    }
    // simboli nell area d uso privato (Symbol/Wingdings: elenchi puntati) → punto elenco
    return out.replace(PUA, "• ");
  };
  return font;
}

// ---------------------------------------------------------------- contenuto
function pageText(pdf, content, resources, state, depth = 0) {
  const res = pdf.get(resources) ?? {};
  const fonts = pdf.get(res.Font) ?? {};
  const xobjs = pdf.get(res.XObject) ?? {};
  const fontCache = state.fontCache;
  const lx = new Lexer(content);
  const ops = [];
  let font = null, size = 12, tm = [1, 0, 0, 1, 0, 0], lm = [1, 0, 0, 1, 0, 0], leading = 0;
  const newline = () => { if (state.cur.text.trim()) state.lines.push(state.cur); state.cur = { text: "", size: 0, y: null }; };
  const moveTo = (x, y) => {
    const prevY = state.cur.y;
    if (prevY !== null && Math.abs(y - prevY) > 1) { newline(); }
    else if (state.lastX !== null && x - state.lastX > size * 0.3 && state.cur.text && !state.cur.text.endsWith(" ")) state.cur.text += " ";
    state.cur.y = y; state.lastX = x;
  };
  const show = (str) => {
    if (!font) font = { decode: (s) => s, bad: false };
    const t = font.decode(str);
    if (font.bad) state.badFont = true;
    const eff = Math.abs(size * (tm[3] || tm[0] || 1));
    if (state.cur.y === null) state.cur.y = tm[5];
    state.cur.text += t;
    state.cur.size = Math.max(state.cur.size, eff);
    state.lastX = tm[4] + t.length * eff * 0.5;
    if (t.trim()) state.hasText = true;
  };
  for (;;) {
    const t = lx.next();
    if (t === undefined) break;
    if (!(t instanceof Op)) {
      if (t === "[") { lx.i--; ops.push(readValue(lx)); }
      else if (t === "<<") { lx.i -= 2; ops.push(readValue(lx)); }
      else ops.push(t);
      continue;
    }
    const op = t.v;
    if (++state.ops > pdf.limits.maxOpsPerPage) throw limitError(`pagina oltre ${pdf.limits.maxOpsPerPage} operatori di contenuto`);
    const a = ops.splice(0);
    switch (op) {
      case "BT": tm = [1, 0, 0, 1, 0, 0]; lm = [...tm]; break;
      case "ET": break;
      case "Tf": {
        const key = a[0] instanceof Name ? a[0].v : null;
        size = typeof a[1] === "number" ? a[1] : size;
        const ref = key ? fonts[key] : null;
        const cacheKey = ref instanceof Ref ? `r${ref.n}` : `k${key}`;
        if (!fontCache.has(cacheKey)) fontCache.set(cacheKey, makeFont(pdf, ref));
        font = fontCache.get(cacheKey);
        break;
      }
      case "TL": leading = a[0] ?? leading; break;
      case "Td": case "TD": {
        const [tx = 0, ty = 0] = a;
        if (op === "TD") leading = -ty;
        lm = [lm[0], lm[1], lm[2], lm[3], lm[4] + tx * lm[0] + ty * lm[2], lm[5] + tx * lm[1] + ty * lm[3]];
        tm = [...lm];
        moveTo(tm[4], tm[5]);
        break;
      }
      case "Tm": if (a.length >= 6) { lm = a.slice(0, 6); tm = [...lm]; moveTo(tm[4], tm[5]); } break;
      case "T*": lm = [lm[0], lm[1], lm[2], lm[3], lm[4] - leading * lm[2], lm[5] - leading * lm[3]]; tm = [...lm]; newline(); state.cur.y = tm[5]; break;
      case "Tj": if (a[0]?.str !== undefined) show(a[0].str); break;
      case "'": newline(); if (a[0]?.str !== undefined) show(a[0].str); break;
      case '"': newline(); if (a[2]?.str !== undefined) show(a[2].str); break;
      case "TJ": for (const x of Array.isArray(a[0]) ? a[0] : []) { if (x?.str !== undefined) show(x.str); else if (typeof x === "number" && x < -180 && state.cur.text && !state.cur.text.endsWith(" ")) state.cur.text += " "; } break;
      case "Do": {
        const key = a[0] instanceof Name ? a[0].v : null;
        const xo = key ? pdf.obj(xobjs[key]) : null;
        const st = pdf.get(xo?.value?.Subtype)?.v;
        if (st === "Image") state.images++;
        else if (st === "Form" && depth < 8) {
          if (++state.formCalls > pdf.limits.maxFormCalls) throw limitError(`XObject Form: oltre ${pdf.limits.maxFormCalls} invocazioni per pagina`);
          const d = pdf.streamData(xo);
          if (d) pageText(pdf, d.toString("latin1"), xo.value.Resources ?? resources, state, depth + 1);
        }
        break;
      }
      case "BI": {
        const e = content.indexOf("EI", lx.i);
        const id = content.indexOf("ID", lx.i);
        state.images++;
        lx.i = e < 0 ? content.length : e + 2;
        if (id < 0) break;
        break;
      }
      default: break;
    }
  }
}

function contentsOf(pdf, page) {
  const c = page.node.Contents;
  const list = Array.isArray(pdf.get(c)) ? pdf.get(c) : [c];
  const parts = [];
  for (const r of list) { const o = pdf.obj(r); const d = o ? pdf.streamData(o) : null; if (d) parts.push(d.toString("latin1")); }
  return parts.join("\n");
}

function paragraphs(lines) {
  if (!lines.length) return [];
  const gaps = [];
  for (let i = 1; i < lines.length; i++) if (lines[i].y !== null && lines[i - 1].y !== null) gaps.push(Math.abs(lines[i - 1].y - lines[i].y));
  const sorted = gaps.filter((g) => g > 0).sort((a, b) => a - b);
  const typical = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
  const out = [];
  let cur = [];
  lines.forEach((l, i) => {
    const gap = i && l.y !== null && lines[i - 1].y !== null ? Math.abs(lines[i - 1].y - l.y) : 0;
    const bullet = /^\s*([•\-–*]|\d+[.)]|[a-z][.)])\s/.test(l.text);
    if (cur.length && (gap > typical * 1.45 || bullet || l.y > (lines[i - 1].y ?? l.y) + 2)) { out.push(cur.join(" ")); cur = []; }
    cur.push(oneLine(l.text));
  });
  if (cur.length) out.push(cur.join(" "));
  return out.map(oneLine).filter(Boolean);
}

// Sidecar OCR (<file>.ocr.txt, come per le schermate): marcatori "--- pagina N ---" / "--- page N ---" o salti pagina
// (form feed); senza marcatori il testo va alla prima pagina di sole immagini. → Map<pagina, testo>
const FORM_FEED = String.fromCharCode(12);
const OCR_MARKER = /^\s*-{2,}\s*(?:pagina|page)\s+(\d+)\s*-{2,}\s*$/gim;
export function readOcrSidecar(path, imagePages) {
  const file = path ? `${path}.ocr.txt` : null;
  if (!file || !existsSync(file)) return null;
  const text = readFileSync(file, "utf8");
  const out = new Map();
  const marks = [...text.matchAll(OCR_MARKER)];
  if (marks.length) marks.forEach((m, i) => out.set(Number(m[1]), text.slice(m.index + m[0].length, i + 1 < marks.length ? marks[i + 1].index : text.length)));
  else if (text.includes(FORM_FEED)) text.split(FORM_FEED).forEach((t, i) => out.set(i + 1, t));
  else out.set(imagePages[0] ?? 1, text);
  return out;
}
const ocrParagraphs = (t) => t.split(/\r?\n\s*\r?\n/).flatMap((b) => b.split(/\r?\n/)).map(oneLine).filter(Boolean);

export function parsePdf(buffer, { id, title, source = null, path = null, limits = {} } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.subarray(0, 1024).toString("latin1").indexOf("%PDF-") < 0) throw new ParseError("non è un PDF (manca %PDF-)", { residue: "unsupported" });
  const pdf = new PdfFile(buffer, { ...LIMITS, ...limits });
  if (/\/Encrypt\s+(\d+\s+\d+\s+R|<<)/.test(pdf.s.slice(-4096)) || /\/Encrypt\s+\d+\s+\d+\s+R/.test(pdf.s.slice(0, 4096))) {
    throw new ParseError("PDF cifrato: serve una copia senza protezione o il testo esportato", { residue: "deferred" });
  }
  const doc = newDoc({ id, title, format: "pdf", source, parser: "parse-pdf" });
  doc.meta.sha256 = sha256(buffer);
  doc.meta.size = buffer.length;
  const dm = /\/(?:ModDate|CreationDate)\s*\(D:(\d{4})(\d{2})(\d{2})/.exec(pdf.s);
  doc.meta.dated = dm ? `${dm[1]}-${dm[2]}-${dm[3]}` : null;
  const pages = pdf.pages();
  const fontCache = new Map();
  const perPage = [];
  let imageOnly = 0, withText = 0, badFont = false;
  pages.forEach((p, i) => {
    const state = { lines: [], cur: { text: "", size: 0, y: null }, lastX: null, images: 0, hasText: false, badFont: false, fontCache, ops: 0, formCalls: 0 };
    try { pageText(pdf, contentsOf(pdf, p), p.resources, state); } catch (e) {
      if (e instanceof ParseError) throw e;   // limiti di risorse: il documento va al residuo con il motivo
      doc.warnings.push(`pagina ${i + 1}: contenuto non interpretabile (${e.message})`);
    }
    if (state.cur.text.trim()) state.lines.push(state.cur);
    if (state.badFont) badFont = true;
    const hasText = state.lines.some((l) => l.text.trim());
    if (hasText) withText++; else if (state.images) imageOnly++;
    perPage.push({ n: i + 1, lines: state.lines, images: state.images, hasText });
  });
  const ocr = readOcrSidecar(path, perPage.filter((p) => !p.hasText && p.images).map((p) => p.n));
  const sizes = perPage.flatMap((p) => p.lines.map((l) => l.size)).filter((x) => x > 0).sort((a, b) => a - b);
  const body = sizes.length ? sizes[Math.floor(sizes.length / 2)] : 0;
  for (const p of perPage) {
    const heading = p.lines.find((l) => l.size >= body * 1.2 && l.text.trim().split(/\s+/).length <= 14) ?? null;
    const sec = newSection({ path: `p${p.n}`, title: heading ? heading.text : (p.lines[0]?.text ?? `Pagina ${p.n}`).slice(0, 120), level: 1, page: p.n });
    const rest = heading ? p.lines.filter((l) => l !== heading) : p.lines;
    sec.paragraphs = paragraphs(rest);
    for (let k = 0; k < p.images; k++) sec.figures.push({ ref: `p${p.n}-img${k + 1}`, page: p.n });
    if (!p.hasText && p.images) {
      sec.meta = { image_only: true };
      const t = ocr?.get(p.n);
      if (t && t.trim()) {
        const paras = ocrParagraphs(t);
        sec.title = paras[0].slice(0, 120);
        sec.paragraphs = paras.slice(1);
        sec.meta.ocr = "sidecar";
      }
    }
    doc.sections.push(sec);
  }
  doc.page_count = pages.length;
  if (!pages.length) doc.warnings.push("albero delle pagine non trovato: nessuna pagina");
  if (imageOnly) doc.warnings.push(`${imageOnly} pagine con sole immagini (testo da OCR)`);
  if (badFont) doc.warnings.push("font CID senza /ToUnicode: parte del testo non decodificabile");
  doc.scanned = withText === 0 && imageOnly > 0;
  if (ocr) doc.meta.ocr = "sidecar";
  // pagine di sole immagini ancora senza testo (nessun sidecar o sidecar senza quella pagina): residuo deferred per pagina
  doc.meta.image_only_pages = doc.sections.filter((s) => s.meta?.image_only && !s.meta?.ocr).map((s) => s.page);
  const t = title ?? perPage.flatMap((p) => p.lines).find((l) => l.size >= body * 1.2)?.text;
  if (t) doc.title = oneLine(t).slice(0, 140);
  return finishDoc(doc);
}

export const parse = parsePdf;
runParserCli(import.meta.url, { name: "parse-pdf", ext: ".pdf", parse: parsePdf });
