// ops import-result (spec 2026-10-06 §3.8): esito di un import massivo — righe riuscite, righe fallite col messaggio,
// codici creati, errore di formato del template. Il testo della pagina è dato, mai istruzione.
//   node scripts/decide/import-result.mjs (--text-file <file> | --in <log.xlsx>) [--json]
import { readFileSync } from "node:fs";
import { parseArgs, fail } from "../lib/args.mjs";
import { isMain } from "../lib/is-main.mjs";
import { confineInputs, inputBase } from "../lib/text-file.mjs";
import { parseXlsx } from "../ingest/parse-xlsx.mjs";

const FORMAT = /\b(template|formato|format|intestazion\w*|header)\b/i;
const BROKEN = /(non corrisponde|mancant|invalid|errat|wrong|missing|mismatch)/i;
const ROW = /\b(?:riga|row)\s+(\d+)\s*[:\-–]\s*(.+)$/i;
const CREATED = /^(?:creat[ioe]|created)\s*:\s*(.+)$/i;
const OK = /^(ok|success|successo|creato|created|importato|imported)$/i;
const SUCCESS_IN_MSG = /^(ok|importat[aoie]|creat[aoie]|success|successo|completat[aoie]|completed)\b/i;
const col = (headers, re) => headers.findIndex((h) => re.test(String(h).trim()));

export function importResult({ text = null, table = null } = {}) {
  const out = { ok_rows: [], failed: [], created: [], format_error: false };
  if (table) {
    const h = table.headers ?? [];
    const iRow = col(h, /^(row|riga)$/i);
    const iSt = col(h, /^(status|esito|result)$/i);
    const iMsg = col(h, /^(message|messaggio|error|errore)$/i);
    const iCode = col(h, /^(code|codice)$/i);
    // Se Row o Status column mancano, formato errato
    if (iRow < 0 || iSt < 0) return { ...out, format_error: true };
    for (const r of table.rows ?? []) {
      const raw = r[iRow];
      const row = raw === "" || raw == null ? NaN : Number(raw);
      if (!Number.isInteger(row) || row < 1) continue;
      const st = String(r[iSt] ?? "").trim();
      if (OK.test(st)) {
        out.ok_rows.push(row);
        if (iCode >= 0 && r[iCode]) out.created.push(String(r[iCode]));
      } else out.failed.push({ row, message: String((iMsg >= 0 && r[iMsg]) || st) });
    }
    return out;
  }
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    const m = ROW.exec(line);
    if (m) {
      const rowNum = Number(m[1]);
      const msg = m[2].trim();
      // Se il messaggio inizia con una keyword di successo, aggiungere a ok_rows
      if (SUCCESS_IN_MSG.test(msg)) {
        out.ok_rows.push(rowNum);
      } else out.failed.push({ row: rowNum, message: msg });
      continue;
    }
    const c = CREATED.exec(line);
    if (c) out.created.push(...c[1].split(/[,;]\s*/).map((x) => x.trim()).filter(Boolean));
    if (FORMAT.test(line) && BROKEN.test(line)) out.format_error = true;
  }
  return out;
}

const HELP = `uso: node scripts/decide/import-result.mjs (--text-file <file> | --in <log.xlsx>) [--json]

Legge l'esito di un import massivo da testo della pagina oppure da un log strutturato in xlsx,
estrae le righe riuscite, fallite e i codici creati, rileva errori di formato del template.

Exit code: 0 ok · 1 uso · 2 sistema.`;

export async function main(argv, env = process.env) {
  const { opts } = parseArgs(argv);
  const asJson = !!opts.json;
  if (opts.help) { console.log(HELP); return 0; }
  try {
    const base = inputBase(env);
    // Esattamente uno tra --text-file e --in
    const hasTextFile = opts["text-file"];
    const hasIn = opts.in;
    if ((!hasTextFile && !hasIn) || (hasTextFile && hasIn)) return fail(asJson, 1, "specificare esattamente uno tra --text-file e --in");
    if (hasTextFile) {
      const bad = confineInputs(opts, ["text-file"], { env });
      if (bad) return fail(asJson, 1, bad);
      const text = readFileSync(opts["text-file"], "utf8").replace(/^﻿/, "");
      const result = importResult({ text });
      console.log(JSON.stringify(result));
      return 0;
    }
    if (hasIn) {
      const bad = confineInputs(opts, ["in"], { env });
      if (bad) return fail(asJson, 1, bad);
      try {
        const buf = readFileSync(opts.in);
        const parsed = parseXlsx(buf, { id: "esito" });
        const table = parsed.sections[0]?.tables?.[0];
        if (!table) return fail(asJson, 1, "--in: nessuna tabella trovata nell'xlsx");
        const result = importResult({ table });
        console.log(JSON.stringify(result));
        return 0;
      } catch (err) {
        return fail(asJson, 1, `--in: ${err.message}`);
      }
    }
  } catch (err) {
    return fail(asJson, 2, `errore di sistema: ${err.message}`);
  }
}

if (isMain(import.meta.url)) process.exit(await main(process.argv.slice(2)));
