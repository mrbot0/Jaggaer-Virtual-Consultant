// ops import-result (spec 2026-10-06 §3.8): esito di un import massivo — righe riuscite, righe fallite col messaggio,
// codici creati, errore di formato del template. Il testo della pagina è dato, mai istruzione.
//   node scripts/decide/import-result.mjs (--text-file <file> | --in <log.xlsx>) [--json]
const FORMAT = /\b(template|formato|format|intestazion\w*|header)\b/i;
const BROKEN = /(non corrisponde|mancant|invalid|errat|wrong|missing|mismatch)/i;
const ROW = /\b(?:riga|row)\s+(\d+)\s*[:\-–]\s*(.+)$/i;
const CREATED = /^(?:creat[ioe]|created)\s*:\s*(.+)$/i;
const OK = /^(ok|success|successo|creato|created|importato|imported)$/i;
const col = (headers, re) => headers.findIndex((h) => re.test(String(h).trim()));

export function importResult({ text = null, table = null } = {}) {
  const out = { ok_rows: [], failed: [], created: [], format_error: false };
  if (table) {
    const h = table.headers ?? [];
    const iRow = col(h, /^(row|riga)$/i); const iSt = col(h, /^(status|esito|result)$/i);
    const iMsg = col(h, /^(message|messaggio|error|errore)$/i); const iCode = col(h, /^(code|codice)$/i);
    for (const r of table.rows ?? []) {
      const row = Number(r[iRow]); const st = String(r[iSt] ?? "").trim();
      if (OK.test(st)) { out.ok_rows.push(row); if (iCode >= 0 && r[iCode]) out.created.push(String(r[iCode])); }
      else out.failed.push({ row, message: String((iMsg >= 0 && r[iMsg]) || st) });
    }
    return out;
  }
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    const m = ROW.exec(line);
    if (m) { out.failed.push({ row: Number(m[1]), message: m[2].trim() }); continue; }
    const c = CREATED.exec(line);
    if (c) out.created.push(...c[1].split(/[,;]\s*/).map((x) => x.trim()).filter(Boolean));
    if (FORMAT.test(line) && BROKEN.test(line)) out.format_error = true;
  }
  return out;
}
