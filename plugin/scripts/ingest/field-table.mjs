// Estrazione tabellare dei campi (§19.6.4 passo 2, schema `riga-tabella-campi` di §19.10):
// una riga grezza per campo, il testo di obbligatorietà così com'è scritto.
//
// Interfaccia:
//   extractFieldRows(unit, { genre }) → [{ label, technical_name, type, mandatory_text,
//       allowed_values[], notes, section, source_unit, row_ref, genre, document }]
//       `unit` è un'unità di segmentFieldTables (scripts/ingest/segment.mjs);
//       source_unit = "<documento>/<sezione>#part-n", row_ref = "t<tabella>.r<riga>".
//   extractDocument(doc, { genre }) → { document, sections: Map<sezione, { title, rows[] }> }
//   writeRawFields(root, scope, doc, { genre }) → { files[], rows }
//       scrive _inbox/<scope>/fields/<documento>/<sezione>.yaml (un file per sezione).
//       Solo _inbox: mai kb/ (§29.6).
// CLI: node scripts/ingest/field-table.mjs --doc <parsed.json> --scope <SCOPE> --root <dir> [--genre <g>] [--json]
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { segmentFieldTables, InvalidDocError } from "./segment.mjs";
import { SCOPES } from "../kb/codes.mjs";
import { isMain } from "../lib/is-main.mjs";
import { parseArgs, fail } from "../lib/args.mjs";
import { confineInputs } from "../lib/text-file.mjs";

export class UsageError extends Error { constructor(m) { super(m); this.name = "UsageError"; } }

const cell = (cells, i) => (i === undefined || cells[i] === null || cells[i] === undefined ? "" : String(cells[i]).trim());
const orNull = (s) => (s === "" ? null : s);
// Nome di file sicuro per una sezione o un documento: niente separatori di percorso.
export const safeName = (s) => String(s).replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "_");

export function extractFieldRows(unit, { genre = null } = {}) {
  const out = [];
  for (const r of unit.rows) {
    const c = r.columns;
    const label = cell(r.cells, c.label);
    const technical = cell(r.cells, c.technical_name);
    if (!label && !technical) continue;
    const allowed = cell(r.cells, c.allowed_values);
    out.push({
      label: label || technical,
      technical_name: orNull(technical),
      type: orNull(cell(r.cells, c.type)),
      mandatory_text: cell(r.cells, c.mandatory),
      allowed_values: allowed ? allowed.split(/\s*[;\n|]\s*|\s*,\s*/).filter(Boolean) : [],
      notes: orNull(cell(r.cells, c.notes)),
      section: unit.section,
      source_unit: `${unit.document}/${unit.id}`,
      row_ref: `t${r.table}.r${r.row}`,
      genre,
      document: unit.document,
    });
  }
  return out;
}

export function extractDocument(doc, { genre = doc?.genre ?? null } = {}) {
  const sections = new Map();
  for (const u of segmentFieldTables(doc)) {
    if (!sections.has(u.section)) sections.set(u.section, { title: u.section_title, rows: [] });
    sections.get(u.section).rows.push(...extractFieldRows(u, { genre }));
  }
  return { document: doc.id, sections };
}

export function writeRawFields(root, scope, doc, { genre } = {}) {
  if (!SCOPES.has(scope)) throw new UsageError(`scope sconosciuto: ${scope}`);
  const { sections } = extractDocument(doc, genre === undefined ? {} : { genre });
  const dir = join(root, "_inbox", scope, "fields", safeName(doc.id));
  mkdirSync(dir, { recursive: true });
  const files = [];
  let rows = 0;
  for (const [section, { title, rows: list }] of sections) {
    const file = join(dir, `${safeName(section)}.yaml`);
    writeFileSync(file, YAML.stringify({ document: doc.id, scope, section, section_title: title, genre: list[0]?.genre ?? genre ?? null, rows: list }));
    files.push(file);
    rows += list.length;
  }
  return { ok: true, document: doc.id, scope, dir, files, rows };
}

const HELP = `uso: node scripts/ingest/field-table.mjs --doc <parsed.json> --scope <SCOPE> --root <dir> [--genre <genere>] [--json] [--help]

Riconosce le tabelle di campi del documento normalizzato (schemas/parsed-doc.schema.json),
le segmenta per sezione (≤ 50 righe per unità) ed estrae una riga grezza per campo con il
testo di obbligatorietà verbatim → <root>/_inbox/<scope>/fields/<documento>/<sezione>.yaml.

Exit code: 0 ok · 1 errore utente (argomenti, scope sconosciuto, documento non conforme) · 2 errore di sistema.`;

function main(argv) {
  const { opts } = parseArgs(argv);
  const asJson = !!opts.json;
  if (opts.help) { console.log(HELP); return 0; }
  { const bad = confineInputs(opts, ["doc"], {}); if (bad) return fail(asJson, 1, bad); }
  if (!opts.doc || !opts.scope || !opts.root) return fail(asJson, 1, "richiesti --doc, --scope, --root");
  let doc;
  try { doc = JSON.parse(readFileSync(opts.doc, "utf8")); } catch (e) { return fail(asJson, 1, `documento illeggibile: ${e.message}`); }
  try {
    const r = writeRawFields(opts.root, opts.scope, doc, opts.genre ? { genre: opts.genre } : {});
    console.log(JSON.stringify(asJson ? r : { rows: r.rows, files: r.files.length, dir: r.dir }));
    return 0;
  } catch (e) {
    if (e instanceof UsageError || e instanceof InvalidDocError) return fail(asJson, 1, e.message);
    return fail(asJson, 2, `errore di sistema: ${e.message ?? e}`);
  }
}

if (isMain(import.meta.url)) process.exit(main(process.argv.slice(2)));
