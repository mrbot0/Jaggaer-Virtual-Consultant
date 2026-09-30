// Lettore ZIP minimo (WP09a, §19.8): directory centrale, voci `stored` (0) e `deflate` (8) con
// zlib.inflateRawSync. Condiviso da DOCX, XLSX e PPTX. Nessuna dipendenza esterna.
//
//   openZip(buffer, limits?) → { names[], has(name), read(name) → Buffer, text(name) → string (utf8, senza BOM) }
//   ZipError: archivio non leggibile o rifiutato.
//   LIMITS: difese contro archivi ostili (revisione di sicurezza di WP09a-A: le dimensioni dell'intestazione
//     sono dichiarate da chi scrive il file, non ci si fida):
//     maxEntryBytes  64 MB   una voce dichiarata o decompressa oltre il tetto ⇒ rifiutata
//     maxTotalBytes  256 MB  somma dei byte decompressi letti da un archivio ⇒ oltre, rifiuto
//     maxEntries     10.000  voci nella directory centrale
//     maxRatio       200     rapporto dichiarato non compresso/compresso, sulle voci oltre ratioFloorBytes (1 MB)
//     inflateRawSync riceve maxOutputLength = min(dimensione dichiarata, tetto): una dichiarazione falsa per
//     difetto tronca l'uscita e la lunghezza effettiva ≠ dichiarata ⇒ ZipError; nomi con "..", assoluti o con
//     unità (C:) ⇒ ZipError all'apertura (il lettore non estrae su disco, ma non accetta archivi così).
// Limiti dichiarati: niente ZIP64 (archivi > 4 GB o > 65535 voci), niente voci cifrate, solo i metodi 0 e 8.
import { inflateRawSync } from "node:zlib";

export class ZipError extends Error { constructor(m) { super(m); this.name = "ZipError"; } }

export const LIMITS = Object.freeze({
  maxEntryBytes: 64 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
  maxEntries: 10000,
  maxRatio: 200,
  ratioFloorBytes: 1024 * 1024,
});

const BOM_RE = new RegExp("^" + String.fromCharCode(0xfeff));
const EOCD = 0x06054b50;
const CDH = 0x02014b50;
const LFH = 0x04034b50;

function findEocd(buf) {
  const min = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= min; i--) if (buf.readUInt32LE(i) === EOCD) return i;
  return -1;
}

export function isZip(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 4 && buf.readUInt32LE(0) === LFH;
}

const unsafeName = (name) => /(^|\/)\.\.(\/|$)/.test(name) || name.startsWith("/") || /^[A-Za-z]:/.test(name);

export function openZip(buf, limits = {}) {
  const L = { ...LIMITS, ...limits };
  if (!Buffer.isBuffer(buf)) throw new ZipError("atteso un Buffer");
  const e = findEocd(buf);
  if (e < 0) throw new ZipError("firma di fine directory centrale assente: non è un archivio ZIP");
  const count = buf.readUInt16LE(e + 10);
  const cdSize = buf.readUInt32LE(e + 12);
  const cdOff = buf.readUInt32LE(e + 16);
  if (count === 0xffff || cdOff === 0xffffffff || cdSize === 0xffffffff) throw new ZipError("ZIP64 non supportato");
  if (count > L.maxEntries) throw new ZipError(`troppe voci nell'archivio (${count} > ${L.maxEntries})`);
  if (cdOff + cdSize > buf.length) throw new ZipError("directory centrale oltre la fine del file");
  const entries = new Map();
  let p = cdOff;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CDH) throw new ZipError(`voce ${i} della directory centrale non valida`);
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const xlen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const rawName = buf.subarray(p + 46, p + 46 + nlen);
    const name = (flags & 0x800 ? rawName.toString("utf8") : rawName.toString("latin1")).replace(/\\/g, "/");
    if (unsafeName(name)) throw new ZipError(`nome di voce con attraversamento di percorso o assoluto: ${name}`);
    entries.set(name, { name, flags, method, csize, usize, lho });
    p += 46 + nlen + xlen + clen;
  }
  let total = 0;
  const read = (name) => {
    const en = entries.get(name);
    if (!en) throw new ZipError(`voce assente: ${name}`);
    if (en.flags & 1) throw new ZipError(`voce cifrata: ${name}`);
    if (en.usize > L.maxEntryBytes) throw new ZipError(`voce troppo grande: ${name} (${en.usize} byte dichiarati > ${L.maxEntryBytes})`);
    if (total + en.usize > L.maxTotalBytes) throw new ZipError(`archivio oltre il tetto di ${L.maxTotalBytes} byte decompressi`);
    if (en.usize > L.ratioFloorBytes && en.usize / Math.max(1, en.csize) > L.maxRatio) {
      throw new ZipError(`rapporto di compressione sospetto per ${name} (${Math.round(en.usize / Math.max(1, en.csize))}:1 > ${L.maxRatio}:1)`);
    }
    const h = en.lho;
    if (h + 30 > buf.length || buf.readUInt32LE(h) !== LFH) throw new ZipError(`intestazione locale non valida: ${name}`);
    const start = h + 30 + buf.readUInt16LE(h + 26) + buf.readUInt16LE(h + 28);
    if (start + en.csize > buf.length) throw new ZipError(`dati della voce oltre la fine del file: ${name}`);
    const data = buf.subarray(start, start + en.csize);
    let out;
    if (en.method === 0) out = Buffer.from(data);
    else if (en.method === 8) {
      try { out = inflateRawSync(data, { maxOutputLength: Math.max(1, Math.min(en.usize, L.maxEntryBytes)) }); }
      catch (err) { throw new ZipError(`decompressione rifiutata per ${name}: ${err.code === "ERR_BUFFER_TOO_LARGE" ? "uscita oltre la dimensione dichiarata" : err.message}`); }
    } else throw new ZipError(`metodo di compressione ${en.method} non supportato (${name})`);
    if (out.length !== en.usize) throw new ZipError(`dimensione di ${name} diversa da quella dichiarata (${out.length} ≠ ${en.usize})`);
    total += out.length;
    return out;
  };
  return {
    names: [...entries.keys()],
    has: (name) => entries.has(name),
    read,
    text: (name) => read(name).toString("utf8").replace(BOM_RE, ""),
  };
}
