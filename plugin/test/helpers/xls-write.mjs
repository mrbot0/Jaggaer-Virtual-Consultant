// Scrittore minimo di un .xls (BIFF8 in un Compound File) per il fixture sintetico di parse-xls.
// Un solo stream "Workbook" ≥ 4096 byte (niente mini stream), un settore FAT, un settore di directory.
const rec = (type, data) => { const h = Buffer.alloc(4); h.writeUInt16LE(type, 0); h.writeUInt16LE(data.length, 2); return Buffer.concat([h, data]); };
const u16 = (...v) => { const b = Buffer.alloc(v.length * 2); v.forEach((x, i) => b.writeUInt16LE(x, i * 2)); return b; };
const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v, 0); return b; };
const bof = (dt) => rec(0x0809, Buffer.concat([u16(0x0600, dt, 0x0dbb, 0x07cc), u32(0), u32(0x06)]));
const eof = () => rec(0x000a, Buffer.alloc(0));

// sheets: [{ name, hidden?, cells: [[row, col, value]], merges?: [[r1, r2, c1, c2]] }]
export function makeXls(sheets) {
  const strings = [];
  const idx = (s) => { let i = strings.indexOf(s); if (i < 0) { strings.push(s); i = strings.length - 1; } return i; };
  const sheetStreams = sheets.map((sh) => {
    const parts = [bof(0x0010)];
    for (const [r, c, v] of sh.cells) {
      if (typeof v === "number") { const d = Buffer.alloc(14); d.writeUInt16LE(r, 0); d.writeUInt16LE(c, 2); d.writeDoubleLE(v, 6); parts.push(rec(0x0203, d)); }
      else parts.push(rec(0x00fd, Buffer.concat([u16(r, c, 0), u32(idx(String(v)))])));
    }
    if (sh.merges?.length) parts.push(rec(0x00e5, Buffer.concat([u16(sh.merges.length), ...sh.merges.map((m) => u16(...m))])));
    parts.push(eof());
    return Buffer.concat(parts);
  });
  const sst = rec(0x00fc, Buffer.concat([u32(strings.length), u32(strings.length), ...strings.map((s) => Buffer.concat([u16(s.length), Buffer.from([0]), Buffer.from(s, "latin1")]))]));
  const boundLen = (sh) => 4 + 8 + sh.name.length;
  const globalsLen = (bof(5).length) + sheets.reduce((a, sh) => a + boundLen(sh), 0) + sst.length + 4;
  let offset = globalsLen;
  const bounds = sheets.map((sh, i) => {
    const d = Buffer.concat([u32(offset), Buffer.from([sh.hidden ? 1 : 0, 0, sh.name.length, 0]), Buffer.from(sh.name, "latin1")]);
    offset += sheetStreams[i].length;
    return rec(0x0085, d);
  });
  let wb = Buffer.concat([bof(0x0005), ...bounds, sst, eof(), ...sheetStreams]);
  if (wb.length < 4096) wb = Buffer.concat([wb, Buffer.alloc(4096 - wb.length)]);
  const size = wb.length;
  const nWb = Math.ceil(size / 512);
  wb = Buffer.concat([wb, Buffer.alloc(nWb * 512 - size)]);
  // settori: 0 = FAT, 1 = directory, 2.. = workbook
  const header = Buffer.alloc(512, 0);
  Buffer.from("d0cf11e0a1b11ae1", "hex").copy(header, 0);
  header.writeUInt16LE(0x3e, 0x18); header.writeUInt16LE(3, 0x1a); header.writeUInt16LE(0xfffe, 0x1c);
  header.writeUInt16LE(9, 0x1e); header.writeUInt16LE(6, 0x20); header.writeUInt32LE(1, 0x2c); header.writeUInt32LE(1, 0x30);
  header.writeUInt32LE(4096, 0x38); header.writeUInt32LE(0xfffffffe, 0x3c); header.writeUInt32LE(0xfffffffe, 0x44);
  for (let i = 0; i < 109; i++) header.writeUInt32LE(0xffffffff, 0x4c + i * 4);
  header.writeUInt32LE(0, 0x4c);
  const fat = Buffer.alloc(512, 0xff);
  fat.writeUInt32LE(0xfffffffd, 0); fat.writeUInt32LE(0xfffffffe, 4);
  for (let i = 0; i < nWb; i++) fat.writeUInt32LE(i === nWb - 1 ? 0xfffffffe : 3 + i, (2 + i) * 4);
  const dir = Buffer.alloc(512, 0);
  const entry = (off, name, type, start, sz) => {
    const n = Buffer.from(`${name}\0`, "utf16le"); n.copy(dir, off); dir.writeUInt16LE(n.length, off + 64); dir[off + 66] = type; dir[off + 67] = 1;
    dir.writeUInt32LE(0xffffffff, off + 68); dir.writeUInt32LE(0xffffffff, off + 72); dir.writeUInt32LE(type === 5 ? 1 : 0xffffffff, off + 76);
    dir.writeUInt32LE(start, off + 116); dir.writeUInt32LE(sz, off + 120);
  };
  entry(0, "Root Entry", 5, 0xfffffffe, 0);
  entry(128, "Workbook", 2, 2, size);
  return Buffer.concat([header, fat, dir, wb]);
}
