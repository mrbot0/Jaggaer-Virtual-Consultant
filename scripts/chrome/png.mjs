// PNG minimo, solo moduli built-in (K6.3): decodifica e codifica di immagini a 8 bit RGB/RGBA non
// interlacciate — il formato degli screenshot dei server MCP del browser — per mascherare rettangoli
// (redazione dopo lo scatto, senza script nella pagina) e disegnare il contorno della regione (ADR-17).
import { inflateSync, deflateSync } from "node:zlib";

const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

export class PngError extends Error {}

// → { width, height, channels, data: Buffer (righe senza filtro) }
export function decodePng(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8 || !buf.subarray(0, 8).equals(SIG)) throw new PngError("non è un PNG");
  let off = 8;
  let ihdr = null;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("latin1", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") ihdr = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), depth: data[8], color: data[9], interlace: data[12] };
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    off += 12 + len;
  }
  if (!ihdr) throw new PngError("IHDR mancante");
  if (ihdr.depth !== 8 || ![2, 6].includes(ihdr.color) || ihdr.interlace !== 0) throw new PngError(`PNG non supportato (profondità ${ihdr.depth}, colore ${ihdr.color}, interlacciato ${ihdr.interlace})`);
  const ch = ihdr.color === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = ihdr.width * ch;
  const out = Buffer.alloc(stride * ihdr.height);
  for (let y = 0; y < ihdr.height; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? out[y * stride + x - ch] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = x >= ch && y > 0 ? out[(y - 1) * stride + x - ch] : 0;
      let v = line[x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c; const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      else if (f !== 0) throw new PngError(`filtro PNG ${f} non valido`);
      out[y * stride + x] = v & 0xff;
    }
  }
  return { width: ihdr.width, height: ihdr.height, channels: ch, data: out };
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

export function encodePng({ width, height, channels, data }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = channels === 4 ? 6 : 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  return Buffer.concat([SIG, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const clip = (img, r) => {
  const x0 = Math.max(0, Math.floor(r.x)); const y0 = Math.max(0, Math.floor(r.y));
  const x1 = Math.min(img.width, Math.ceil(r.x + r.w)); const y1 = Math.min(img.height, Math.ceil(r.y + r.h));
  return x1 > x0 && y1 > y0 ? { x0, y0, x1, y1 } : null;
};
function setPx(img, x, y, rgb) {
  const i = (y * img.width + x) * img.channels;
  img.data[i] = rgb[0]; img.data[i + 1] = rgb[1]; img.data[i + 2] = rgb[2];
  if (img.channels === 4) img.data[i + 3] = 255;
}

// Rettangolo pieno (maschera): → true se ha coperto almeno un pixel.
export function fillRect(img, r, rgb = [0, 0, 0]) {
  const c = clip(img, r);
  if (!c) return false;
  for (let y = c.y0; y < c.y1; y++) for (let x = c.x0; x < c.x1; x++) setPx(img, x, y, rgb);
  return true;
}
// Contorno (regione della prova, ADR-17).
export function strokeRect(img, r, rgb = [230, 0, 0], t = 3) {
  const c = clip(img, r);
  if (!c) return false;
  for (let y = c.y0; y < c.y1; y++) for (let x = c.x0; x < c.x1; x++) {
    if (x - c.x0 < t || c.x1 - 1 - x < t || y - c.y0 < t || c.y1 - 1 - y < t) setPx(img, x, y, rgb);
  }
  return true;
}
export const pixel = (img, x, y) => [...img.data.subarray((y * img.width + x) * img.channels, (y * img.width + x) * img.channels + img.channels)];
