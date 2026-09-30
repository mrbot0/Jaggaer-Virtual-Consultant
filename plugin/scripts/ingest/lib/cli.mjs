// CLI comune dei parser: node scripts/ingest/parse-<x>.mjs --in <file> [--id <id>] [--title <t>] [--out <file.json>] [--json] [--help]
// Exit code: 0 ok · 1 errore utente (argomenti, file assente, formato non leggibile) · 2 errore di sistema.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { basename } from "node:path";
import { isMain } from "../../lib/is-main.mjs";
import { parseArgs, fail } from "../../lib/args.mjs";
import { ParseError, docIdFor } from "./parsed.mjs";

export function runParserCli(url, { name, ext, parse, errors = [] }) {
  if (!isMain(url)) return;
  const HELP = `uso: node scripts/ingest/${name}.mjs --in <file${ext}> [--id <id>] [--title <titolo>] [--out <file.json>] [--json] [--help]

Produce il documento normalizzato (schemas/parsed-doc.schema.json) su stdout o in --out.
Exit code: 0 ok · 1 errore utente (argomenti, file assente o non leggibile nel formato) · 2 errore di sistema.`;
  const { opts } = parseArgs(process.argv.slice(2));
  const asJson = !!opts.json;
  if (opts.help) { console.log(HELP); process.exit(0); }
  if (!opts.in) process.exit(fail(asJson, 1, "richiesto --in <file>"));
  if (!existsSync(opts.in)) process.exit(fail(asJson, 1, `file assente: ${opts.in}`));
  try {
    const doc = parse(readFileSync(opts.in), { id: opts.id ?? docIdFor(basename(opts.in)), title: opts.title, source: basename(opts.in), path: opts.in });
    if (opts.out) { writeFileSync(opts.out, JSON.stringify(doc, null, 2)); console.log(JSON.stringify({ ok: true, id: doc.id, sections: doc.sections.length, out: opts.out })); }
    else console.log(JSON.stringify(asJson ? { ok: true, doc } : doc, null, asJson ? 0 : 2));
    process.exit(0);
  } catch (e) {
    if (e instanceof ParseError || errors.some((E) => e instanceof E)) process.exit(fail(asJson, 1, e.message, { residue: e.residue ?? "unsupported" }));
    process.exit(fail(asJson, 2, `errore di sistema: ${e?.message ?? e}`));
  }
}
