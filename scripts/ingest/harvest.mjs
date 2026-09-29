// Harvest (§19.8, §34.2 "/kb ingest <cartella>"): percorre una cartella, riconosce il formato di ogni file
// dall'estensione e dai byte iniziali (magic), lo passa al parser giusto e scrive il documento normalizzato in
// _inbox/<scope>/parsed/<docId>.json + il manifesto _inbox/<scope>/parsed/_manifest.json. I formati
// sconosciuti sono ELENCATI (residuo unsupported con motivo), mai indovinati.
//
//   detectFormat(path, head) → { parser, format } | { residue: { class, reason } } | { sidecar: true }
//   parseFile(path, { id, relPath }) → { doc } | { residue }
//   harvest(input, { root, scope = "XSC", customer?, write = true, onFile? }) → { manifest[], docs[], stats }
//     manifest[i]: { path, doc_id, format, parser, status: parsed|residue|sidecar, sha256, size, residue?, duplicate_of?, parser_error?, ms }
//     parser_error: eccezione inattesa del parser (difetto, non formato): il test sul corpus ne esige zero
//     i file con lo stesso sha256 di un file già visto → residuo duplicate (duplicate_of)
// CLI: node scripts/ingest/harvest.mjs --input <cartella> --root <workspace> [--scope XSC] [--customer ACME] [--dry-run] [--json]
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, relative, extname, basename } from "node:path";
import { createHash } from "node:crypto";
import { isMain } from "../lib/is-main.mjs";
import { parseArgs, fail } from "../lib/args.mjs";
import { SCOPES } from "../kb/codes.mjs";
import { docIdFor, ParseError } from "./lib/parsed.mjs";
import { workspacePaths, ensureWorkspace, assertOutsidePlugin, PolicyError } from "./lib/paths.mjs";
export { PolicyError };
import { residueEntry, writeResidue } from "./residue.mjs";
import { isZip, ZipError } from "./lib/zip.mjs";
import { parseDocx } from "./parse-docx.mjs";
import { parseXlsx } from "./parse-xlsx.mjs";
import { parsePptx } from "./parse-pptx.mjs";
import { parsePdf } from "./parse-pdf.mjs";
import { parseXls, isCfb } from "./parse-xls.mjs";
import { parseXsd } from "./parse-xsd.mjs";
import { parseSpec } from "./parse-spec.mjs";
import { parseConfigExport } from "./parse-config-export.mjs";
import { parseScreenshot, imageInfo } from "./parse-screenshots.mjs";
import { parseTranscript, looksLikeTranscript } from "./parse-transcript.mjs";
import { parseEmail, looksLikeEmail } from "./parse-email.mjs";
import { parseText, parseCsv, parseHtml, decodeText } from "./parse-text.mjs";
import { makeUnitRedactor, ingestionProfile, knownCustomers, redactDoc } from "./redact.mjs";

export class UsageError extends Error { constructor(m) { super(m); this.name = "UsageError"; } }

export const PARSERS = { docx: parseDocx, xlsx: parseXlsx, pptx: parsePptx, pdf: parsePdf, xls: parseXls, xsd: parseXsd, spec: parseSpec,
  "config-export": parseConfigExport, image: parseScreenshot, transcript: parseTranscript, email: parseEmail, text: parseText, csv: parseCsv, html: parseHtml };

const SYSTEM_FILES = /^(thumbs\.db|desktop\.ini|\.ds_store|ehthumbs\.db|~\$.*|\._.*)$/i;
const ARCHIVES = new Set([".zip", ".7z", ".rar", ".tar", ".gz", ".tgz"]);
const IMAGES = new Set([".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp"]);

function xmlRoot(text) {
  const m = /<([A-Za-z_][\w:.-]*)[\s>/]/.exec(text.replace(/<\?[\s\S]*?\?>/g, "").replace(/<!--[\s\S]*?-->/g, "").replace(/<!DOCTYPE[^>[]*(\[[\s\S]*?\])?>/i, ""));
  return m ? m[1].replace(/^[^:]*:/, "") : null;
}

export function detectFormat(path, head) {
  const name = basename(path);
  const ext = extname(name).toLowerCase();
  if (/\.(ocr\.txt|layout\.json)$/i.test(name)) return { sidecar: true };
  if (SYSTEM_FILES.test(name)) return { residue: { class: "irrelevant", reason: "file di sistema (miniature, impostazioni della cartella)" } };
  if (ARCHIVES.has(ext)) return { residue: { class: "deferred", reason: `archivio compresso (${ext}): estrarlo in una cartella e rilanciare harvest su quella` } };
  if (ext === ".snag") return { residue: { class: "unsupported", reason: "formato proprietario Snagit: esportare l'immagine in PNG (e produrne il sidecar OCR)" } };
  if ([".doc", ".ppt", ".dot", ".pps"].includes(ext)) return { residue: { class: "deferred", reason: `formato binario Office 97-2003 (${ext}) non leggibile senza dipendenze: salvarlo come ${ext === ".doc" || ext === ".dot" ? ".docx" : ".pptx"}` } };
  const zip = isZip(head);
  if ([".docx", ".docm", ".dotx"].includes(ext) && zip) return { parser: "docx", format: "docx" };
  if ([".xlsx", ".xlsm", ".xltx"].includes(ext) && zip) return { parser: "xlsx", format: "xlsx" };
  if ([".pptx", ".ppsx", ".potx"].includes(ext) && zip) return { parser: "pptx", format: "pptx" };
  if (ext === ".pdf" || head.subarray(0, 5).toString("latin1") === "%PDF-") return { parser: "pdf", format: "pdf" };
  if (isCfb(head)) {
    if (ext === ".xls" || ext === ".xlt") return { parser: "xls", format: "xls" };
    return { residue: { class: "deferred", reason: "Compound File (Office 97-2003) diverso da una cartella Excel: salvarlo in formato Office Open XML" } };
  }
  if (IMAGES.has(ext) || imageInfo(head)) return { parser: "image", format: "image" };
  if (ext === ".xsd") return { parser: "xsd", format: "xsd" };
  if (ext === ".wsdl") return { parser: "spec", format: "wsdl" };
  if (ext === ".vtt" || ext === ".srt") return { parser: "transcript", format: ext.slice(1) };
  if (ext === ".eml") return { parser: "email", format: "eml" };
  if (ext === ".csv" || ext === ".tsv") return { parser: "csv", format: "csv" };
  if (ext === ".htm" || ext === ".html" || ext === ".xhtml") return { parser: "html", format: "html" };
  if (zip) return { residue: { class: "unsupported", reason: "contenitore ZIP con estensione non riconosciuta" } };
  // testo: controlla che sia davvero testo (niente byte nulli nei primi 4 KB salvo UTF-16 con BOM)
  const bomU16 = (head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff);
  if (!bomU16 && head.subarray(0, 4096).includes(0)) return { residue: { class: "unsupported", reason: `formato binario non riconosciuto${ext ? ` (${ext})` : " (senza estensione)"}` } };
  const text = decodeText(head);
  const t = text.replace(/^\s+/, "");
  if (ext === ".json" || ext === ".yaml" || ext === ".yml") {
    if (/"openapi"|"swagger"|^openapi:|^swagger:|"\$schema"|"properties"\s*:/m.test(text)) return { parser: "spec", format: ext === ".json" ? "json" : "yaml" };
    return ext === ".json" ? { parser: "config-export", format: "json" } : { parser: "text", format: "yaml" };
  }
  if (t.startsWith("<")) {
    const root = xmlRoot(text);
    if (root === "schema") return { parser: "xsd", format: "xsd" };
    if (root === "definitions" || root === "description") return { parser: "spec", format: "wsdl" };
    if (root && /^html$/i.test(root)) return { parser: "html", format: "html" };
    if (root) return { parser: "config-export", format: "xml" };
  }
  if ([".txt", ".md", ".log", ".text", ""].includes(ext) || ext.length > 5 || /^\.[^.]*\s/.test(ext)) {
    if (looksLikeEmail(text)) return { parser: "email", format: "eml" };
    if (looksLikeTranscript(text)) return { parser: "transcript", format: "txt" };
    return { parser: "text", format: /\.md$/i.test(ext) ? "md" : "txt" };
  }
  return { residue: { class: "unsupported", reason: `formato non riconosciuto (${ext})` } };
}

export function parseFile(path, { id, relPath, buffer = null }) {
  const buf = buffer ?? readFileSync(path);
  const det = detectFormat(path, buf.subarray(0, 65536));
  if (det.sidecar) return { sidecar: true };
  if (det.residue) return { residue: det.residue, format: null };
  // giro 1 (M9): data del file come ripiego dichiarato per la data di un export (meta.date_source = "mtime")
  let mtime = null;
  try { mtime = statSync(path).mtime; } catch { /* buffer senza file */ }
  try {
    const doc = PARSERS[det.parser](buf, { id, source: relPath, path, mtime });
    doc.meta = { ...(doc.meta ?? {}), source: relPath, size: buf.length, sha256: doc.meta?.sha256 ?? `sha256:${createHash("sha256").update(buf).digest("hex")}` };
    return { doc, parser: det.parser, format: det.format };
  } catch (e) {
    if (e instanceof ParseError) return { residue: { class: e.residue ?? "unsupported", reason: e.reason ?? e.message }, parser: det.parser, format: det.format };
    if (e instanceof ZipError) return { residue: { class: "unsupported", reason: `archivio ZIP rifiutato: ${e.message}` }, parser: det.parser, format: det.format };
    // giro 1 (I4): un'eccezione inattesa è un DIFETTO del parser, non un formato illeggibile: marcata parser_error
    return { residue: { class: "unsupported", reason: `errore del parser ${det.parser}: ${e?.name ?? "Error"}: ${e?.message ?? e}` }, parser: det.parser, format: det.format, parser_error: true };
  }
}

export function* walkFiles(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (!e.name.startsWith(".") && e.name !== "_inbox" && e.name !== "node_modules") yield* walkFiles(p); }
    else if (e.isFile()) yield p;
  }
}

export function harvest(input, { root, scope = "XSC", customer = null, write = true, onFile = null } = {}) {
  if (!existsSync(input) || !statSync(input).isDirectory()) throw new UsageError(`cartella di input assente: ${input}`);
  if (!SCOPES.has(scope)) throw new UsageError(`scope sconosciuto: ${scope}`);
  if (root && write) assertOutsidePlugin(root);   // giro 1 (M14)
  const paths = root ? workspacePaths({ root, customer }) : null;
  const outDir = paths ? join(paths.inbox(scope), "parsed") : null;
  if (write && paths) { ensureWorkspace(paths); mkdirSync(outDir, { recursive: true }); }
  // correzione mirata finale (T3): il documento normalizzato su disco (ingresso di scope-extractor) solo redatto, con le
  // regole delle unità (strict per il livello S); il documento restituito resta intero (la pipeline lo redige da sé)
  const redactor = paths ? makeUnitRedactor({ profile: ingestionProfile({ level: paths.level, customer: paths.customer }), names: knownCustomers(paths.root).filter((c) => c !== paths.customer) }) : null;
  const manifest = [];
  const docs = [];
  const seen = new Map();
  const residue = [];
  for (const file of walkFiles(input)) {
    const rel = relative(input, file).replace(/\\/g, "/");
    const t0 = Date.now();
    const buf = readFileSync(file);
    const hash = `sha256:${createHash("sha256").update(buf).digest("hex")}`;
    const id = docIdFor(rel);
    const entry = { path: rel, doc_id: id, sha256: hash, size: buf.length };
    if (seen.has(hash) && !/\.(ocr\.txt|layout\.json)$/i.test(file)) {
      Object.assign(entry, { status: "residue", format: null, parser: null, duplicate_of: seen.get(hash), residue: residueEntry({ class: "duplicate", reason: `stesso contenuto di ${seen.get(hash)}`, file: rel }) });
    } else {
      const r = parseFile(file, { id, relPath: rel, buffer: buf });
      if (r.sidecar) Object.assign(entry, { status: "sidecar", format: null, parser: null });
      else if (r.residue) Object.assign(entry, { status: "residue", format: r.format ?? null, parser: r.parser ?? null, residue: residueEntry({ ...r.residue, file: rel }), ...(r.parser_error ? { parser_error: true } : {}) });
      else {
        seen.set(hash, rel);
        Object.assign(entry, { status: "parsed", format: r.format, parser: r.parser, sections: r.doc.sections.length, warnings: r.doc.warnings ?? [], scanned: r.doc.scanned ?? false });
        docs.push(r.doc);
        if (write && outDir) writeFileSync(join(outDir, `${id}.json`), JSON.stringify(redactDoc(r.doc, redactor)));
      }
      if (!seen.has(hash) && entry.status !== "sidecar") seen.set(hash, rel);
    }
    entry.ms = Date.now() - t0;
    if (entry.residue) residue.push(entry.residue);
    manifest.push(entry);
    if (onFile) onFile(entry);
  }
  const stats = {
    files: manifest.length,
    parsed: manifest.filter((m) => m.status === "parsed").length,
    residue: manifest.filter((m) => m.status === "residue").length,
    sidecars: manifest.filter((m) => m.status === "sidecar").length,
    by_format: manifest.reduce((a, m) => { const k = m.format ?? (extname(m.path).toLowerCase() || "(senza estensione)"); a[k] = (a[k] ?? 0) + 1; return a; }, {}),
  };
  if (write && outDir) {
    writeFileSync(join(outDir, "_manifest.json"), JSON.stringify({ input: basename(input), scope, customer: customer ?? "STD", harvested_at: new Date().toISOString(), stats, files: manifest }, null, 1));
    if (residue.length) writeResidue(paths.inboxRoot, scope, "_harvest", residue);
  }
  return { manifest, docs, stats, outDir };
}

const HELP = `uso: node scripts/ingest/harvest.mjs --input <cartella> --root <workspace> [--scope XSC] [--customer ACME] [--dry-run] [--json] [--help]

Percorre la cartella, riconosce il formato di ogni file (estensione + byte iniziali) e produce il documento
normalizzato in <workspace>/_inbox/<scope>/parsed/<docId>.json con il manifesto _manifest.json.
Formati: docx xlsx pptx pdf xls(BIFF8) xsd wsdl openapi/json-schema export XML/JSON di configurazione JAGGAER
(workflow_definition, workflow_folders, document_config, form) csv/tsv txt/md html vtt/srt eml immagini
(con sidecar <img>.ocr.txt). Sconosciuti, archivi, Office 97-2003 non Excel, Snagit, file di sistema: residuo
con motivo (_inbox/<scope>/residue/_harvest.yaml). File identici: residuo duplicate.
--customer: livello C (customers/<C>/_inbox); senza: livello S (product/, _inbox/ nella radice).

Exit code: 0 ok · 1 errore utente (cartella assente, scope sconosciuto) · 2 errore di sistema · 3 uscita dentro il
repository del plugin (rifiutata: il workspace di conoscenza è separato).`;

function main(argv) {
  const { opts } = parseArgs(argv, { flags: ["dry-run"] });
  const asJson = !!opts.json;
  if (opts.help) { console.log(HELP); return 0; }
  if (!opts.input || (!opts.root && !opts["dry-run"])) return fail(asJson, 1, "richiesti --input <cartella> e --root <workspace>");
  try {
    const r = harvest(opts.input, { root: opts.root, scope: opts.scope ?? "XSC", customer: opts.customer ?? null, write: !opts["dry-run"] });
    console.log(JSON.stringify(asJson ? { ok: true, stats: r.stats, out: r.outDir, files: r.manifest } : { ok: true, ...r.stats, out: r.outDir }));
    return 0;
  } catch (e) {
    if (e instanceof PolicyError) return fail(asJson, 3, e.message);
    if (e instanceof UsageError || /cliente non valido/.test(e.message)) return fail(asJson, 1, e.message);
    return fail(asJson, 2, `errore di sistema: ${e.message ?? e}`);
  }
}

if (isMain(import.meta.url)) process.exit(main(process.argv.slice(2)));
