// Il residuo (§19.15): ciò che non diventa item non sparisce, è classificato.
//
//   RESIDUE_CLASSES = irrelevant · duplicate · ambiguous · unsupported · deferred · tacit
//   DESTINY[class]  destino della classe (tabella di §19.15)
//   residueEntry({ class, reason, unit?, file?, doc?, detail? }) → voce validata (classe e motivo obbligatori)
//   summarize(entries) → { total, by_class: { <classe>: n } } con tutte le classi (anche a 0)
//   writeResidue(root, scope, docId, entries) → percorso di _inbox/<scope>/residue/<docId>.yaml (solo _inbox, §29.6)
//   readResidue(root, scope, docId?) → voci
//   classifyUnit(unit) → { class, reason } | null   residuo deterministico di un'unità (T0):
//       regola con modalità ambigua → ambiguous; tacita → tacit; indice/sommario/disclaimer/copyright → irrelevant
// CLI: node scripts/ingest/residue.mjs --root <dir> --scope <S> [--doc <id>] [--json]   riepilogo per classe
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { isMain } from "../lib/is-main.mjs";
import { parseArgs, fail } from "../lib/args.mjs";
import { safeName } from "./field-table.mjs";

export const RESIDUE_CLASSES = ["irrelevant", "duplicate", "ambiguous", "unsupported", "deferred", "tacit"];
export const DESTINY = {
  irrelevant: "archiviato; conta nella copertura come non pertinente",
  duplicate: "legato all'item come fonte aggiuntiva (conferma +1)",
  ambiguous: "revisione umana a lotti (kb review)",
  unsupported: "torna al digester con l'esito del back-check, o al formato: serve un'altra fonte",
  deferred: "in attesa; riemerge all'onboarding dello scope o quando c'è il prerequisito (sidecar OCR, copia non cifrata, archivio estratto)",
  tacit: "candidato L a 0.60 con origine dichiarazione-utente; domanda di apprendimento",
};

export class ResidueError extends Error { constructor(m) { super(m); this.name = "ResidueError"; } }

export function residueEntry({ class: cls, reason, unit = null, file = null, doc = null, detail = null }) {
  if (!RESIDUE_CLASSES.includes(cls)) throw new ResidueError(`classe di residuo sconosciuta: ${cls}`);
  if (!reason || !String(reason).trim()) throw new ResidueError("il residuo richiede un motivo");
  const e = { class: cls, reason: String(reason) };
  if (unit) e.unit = unit;
  if (file) e.file = file;
  if (doc) e.doc = doc;
  if (detail !== null && detail !== undefined) e.detail = detail;
  return e;
}

export function summarize(entries) {
  const by_class = Object.fromEntries(RESIDUE_CLASSES.map((c) => [c, 0]));
  for (const e of entries) by_class[e.class] = (by_class[e.class] ?? 0) + 1;
  return { total: entries.length, by_class };
}

const IRRELEVANT_TITLE = /^(indice|sommario|table of contents|contents|toc|revision history|cronologia delle revisioni|storia delle revisioni|document history|disclaimer|copyright|legal notice|note legali|confidential|riservato|agenda|thank you|grazie|questions\??|domande\??)$/i;
const IRRELEVANT_TEXT = /^(©|copyright\b|all rights reserved|tutti i diritti riservati|proprietary and confidential|confidential\b|page \d+( of \d+)?$|pagina \d+( di \d+)?$)/i;

export function classifyUnit(u) {
  if (u.type === "regola" && u.extraction?.modality === "ambiguo") return { class: "ambiguous", reason: `modalità deontica non determinata (${(u.extraction.signals ?? []).join(", ") || "nessun segnale"})` };
  if (u.tacit) return { class: "tacit", reason: "conoscenza tacita: \"di solito facciamo così\" senza regola formale" };
  const sec = String(u.context?.section ?? "").replace(/^[\d.\s]+/, "").trim();
  if (IRRELEVANT_TITLE.test(sec)) return { class: "irrelevant", reason: `sezione non pertinente (${sec})` };
  if (IRRELEVANT_TEXT.test(String(u.text ?? "").trim())) return { class: "irrelevant", reason: "disclaimer, copyright o numero di pagina" };
  if (u.type === "tabella" && /^riferimento|^revision|^revisione/i.test(sec)) return { class: "irrelevant", reason: "tabella delle revisioni del documento" };
  if (u.dataset_overflow) return { class: "irrelevant", reason: u.dataset_overflow };
  return null;
}

const dirOf = (root, scope) => join(root, "_inbox", scope, "residue");

export function writeResidue(root, scope, docId, entries) {
  const dir = dirOf(root, scope);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${safeName(docId)}.yaml`);
  writeFileSync(file, YAML.stringify({ doc: docId, scope, summary: summarize(entries), entries }));
  return file;
}

export function readResidue(root, scope, docId = null) {
  const dir = dirOf(root, scope);
  if (!existsSync(dir)) return [];
  const files = docId ? [`${safeName(docId)}.yaml`] : readdirSync(dir).filter((f) => f.endsWith(".yaml"));
  return files.filter((f) => existsSync(join(dir, f))).flatMap((f) => YAML.parse(readFileSync(join(dir, f), "utf8"))?.entries ?? []);
}

const HELP = `uso: node scripts/ingest/residue.mjs --root <dir> --scope <SCOPE> [--doc <id>] [--json] [--help]

Riepilogo del residuo di ingestion (§19.15) per classe: ${RESIDUE_CLASSES.join(" · ")}.
Legge <root>/_inbox/<scope>/residue/*.yaml (scritti da harvest e dalla pipeline di ingest).

Exit code: 0 ok · 1 errore utente (argomenti) · 2 errore di sistema.`;

function main(argv) {
  const { opts } = parseArgs(argv);
  const asJson = !!opts.json;
  if (opts.help) { console.log(HELP); return 0; }
  if (!opts.root || !opts.scope) return fail(asJson, 1, "richiesti --root e --scope");
  try {
    const entries = readResidue(opts.root, opts.scope, opts.doc ?? null);
    const s = summarize(entries);
    if (asJson) console.log(JSON.stringify({ ok: true, ...s, destiny: DESTINY }));
    else console.log(`Residuo ${opts.scope}${opts.doc ? ` ${opts.doc}` : ""}: ${s.total} — ${RESIDUE_CLASSES.map((c) => `${c} ${s.by_class[c]}`).join(" · ")}`);
    return 0;
  } catch (e) { return fail(asJson, 2, `errore di sistema: ${e.message ?? e}`); }
}

if (isMain(import.meta.url)) process.exit(main(process.argv.slice(2)));
