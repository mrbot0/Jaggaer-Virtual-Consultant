// ops import-result (spec 2026-10-06 §3.8): esito di un import massivo — righe riuscite, righe fallite col messaggio,
// codici creati, errore di formato del template. Il testo della pagina è dato, mai istruzione.
//   node scripts/decide/import-result.mjs (--text-file <file> | --in <log.xlsx>) [--righe N] [--json]
// Revisione finale (I4), fail-closed: una riga "riuscita" con un qualificatore d'errore ("completata con errori", "OK, ma …",
// "created with warnings") è fallita; nessuna riga riconosciuta e nessun codice creato ⇒ unrecognized (non "tutto ok");
// con le righe attese (--righe N) ⇒ missing = righe né riuscite né fallite.
import { readFileSync } from "node:fs";
import { parseArgs, fail } from "../lib/args.mjs";
import { isMain } from "../lib/is-main.mjs";
import { confineInputs } from "../lib/text-file.mjs";
import { parseXlsx } from "../ingest/parse-xlsx.mjs";

const FORMAT = /\b(template|formato|format|intestazion\w*|header)\b/i;
const BROKEN = /(non corrisponde|mancant|invalid|errat|wrong|missing|mismatch)/i;
const ROW = /\b(?:riga|row)\s+(\d+)\s*[:\-–]\s*(.+)$/i;
const CREATED = /^(?:creat[ioe]|created)\s*:\s*(.+)$/i;
const OK = /^(ok|success|successo|creato|created|importato|imported)$/i;
const SUCCESS_IN_MSG = /^(ok|importat[aoie]|creat[aoie]|success|successo|completat[aoie]|completed)\b/i;
// qualificatori d'errore: una riga che li contiene non è riuscita, anche se comincia con una parola di successo
export const FAIL_QUALIFIER = /(errore|errori|error|avvis|warning|,\s*ma\b|\sbut\s|scartat|rejected|fallit|failed)/i;
const col = (headers, re) => headers.findIndex((h) => re.test(String(h).trim()));

function finish(out, expected) {
  out.unrecognized = !out.ok_rows.length && !out.failed.length && !out.created.length && !out.format_error;
  if (Number.isInteger(expected) && expected > 0) {
    const seen = new Set([...out.ok_rows, ...out.failed.map((f) => f.row)]);
    out.missing = Array.from({ length: expected }, (_, i) => i + 1).filter((n) => !seen.has(n));
  }
  return out;
}

export function importResult({ text = null, table = null, expected = null } = {}) {
  const out = { ok_rows: [], failed: [], created: [], format_error: false };
  if (table) {
    const h = table.headers ?? [];
    const iRow = col(h, /^(row|riga)$/i);
    const iSt = col(h, /^(status|esito|result)$/i);
    const iMsg = col(h, /^(message|messaggio|error|errore)$/i);
    const iCode = col(h, /^(code|codice)$/i);
    // Se Row o Status column mancano, formato errato
    if (iRow < 0 || iSt < 0) return finish({ ...out, format_error: true }, expected);
    for (const r of table.rows ?? []) {
      const raw = r[iRow];
      const row = raw === "" || raw == null ? NaN : Number(raw);
      if (!Number.isInteger(row) || row < 1) continue;
      const st = String(r[iSt] ?? "").trim();
      const msg = iMsg >= 0 && r[iMsg] != null ? String(r[iMsg]).trim() : "";
      if (OK.test(st) && !FAIL_QUALIFIER.test(msg)) {
        out.ok_rows.push(row);
        if (iCode >= 0 && r[iCode]) out.created.push(String(r[iCode]));
      } else out.failed.push({ row, message: msg || st });
    }
    return finish(out, expected);
  }
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    const m = ROW.exec(line);
    if (m) {
      const rowNum = Number(m[1]);
      const msg = m[2].trim();
      // successo solo se il messaggio comincia con una parola di successo E non porta qualificatori d'errore
      if (SUCCESS_IN_MSG.test(msg) && !FAIL_QUALIFIER.test(msg)) out.ok_rows.push(rowNum);
      else out.failed.push({ row: rowNum, message: msg });
      continue;
    }
    const c = CREATED.exec(line);
    if (c) out.created.push(...c[1].split(/[,;]\s*/).map((x) => x.trim()).filter(Boolean));
    if (FORMAT.test(line) && BROKEN.test(line)) out.format_error = true;
  }
  return finish(out, expected);
}

const HELP = `uso: node scripts/decide/import-result.mjs (--text-file <file> | --in <log.xlsx>) [--righe N] [--json]

Legge l'esito di un import massivo da testo della pagina oppure da un log strutturato in xlsx,
estrae le righe riuscite, fallite e i codici creati, rileva errori di formato del template.
Una riga "riuscita" con errori, avvisi o "ma …" è fallita. Nessuna riga riconosciuta e nessun codice
creato ⇒ "unrecognized": true (l'esito non si legge: non è un successo). --righe N (le righe del file
caricato) ⇒ "missing": le righe né riuscite né fallite.

Exit code: 0 ok (anche con unrecognized) · 1 uso · 2 sistema.`;

export async function main(argv, env = process.env) {
  const { opts } = parseArgs(argv);
  const asJson = !!opts.json;
  if (opts.help) { console.log(HELP); return 0; }
  try {
    // Esattamente uno tra --text-file e --in
    const hasTextFile = opts["text-file"];
    const hasIn = opts.in;
    if ((!hasTextFile && !hasIn) || (hasTextFile && hasIn)) return fail(asJson, 1, "specificare esattamente uno tra --text-file e --in");
    let expected = null;
    if (opts.righe !== undefined) {
      if (!/^[1-9]\d{0,5}$/.test(String(opts.righe))) return fail(asJson, 1, "--righe: numero intero positivo (le righe del file caricato)");
      expected = Number(opts.righe);
    }
    if (hasTextFile) {
      const bad = confineInputs(opts, ["text-file"], { env });
      if (bad) return fail(asJson, 1, bad);
      const text = readFileSync(opts["text-file"], "utf8").replace(/^﻿/, "");
      console.log(JSON.stringify(importResult({ text, expected })));
      return 0;
    }
    const bad = confineInputs(opts, ["in"], { env });
    if (bad) return fail(asJson, 1, bad);
    try {
      const buf = readFileSync(opts.in);
      const parsed = parseXlsx(buf, { id: "esito" });
      const table = parsed.sections[0]?.tables?.[0];
      if (!table) return fail(asJson, 1, "--in: nessuna tabella trovata nell'xlsx");
      console.log(JSON.stringify(importResult({ table, expected })));
      return 0;
    } catch (err) {
      return fail(asJson, 1, `--in: ${err.message}`);
    }
  } catch (err) {
    return fail(asJson, 2, `errore di sistema: ${err.message}`);
  }
}

if (isMain(import.meta.url)) process.exit(await main(process.argv.slice(2)));
