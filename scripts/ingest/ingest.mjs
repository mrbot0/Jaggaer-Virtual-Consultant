// La pipeline di ingestion (§19.1 passi 3-6 per la parte deterministica, §34.2 "/kb ingest <cartella>"):
// harvest → per documento: codice DOC (con versione) → unità (codici stabili fra versioni) → profilo DOC → pre-estrazione
// T0 → residuo → unità su disco e nel DB → campi grezzi e lotti ≤ 50 (digest-fields) → report di ingestion → diff di
// versione se il documento sostituisce una versione precedente; alla fine proposte di alias, backlog DT-025 e il
// riepilogo del corpus. Tutto nel workspace di conoscenza (mai nel repository del plugin); solo _inbox/ e
// sources/units/: la promozione in kb/ passa dalla validazione (§29.6).
//
//   ingestFolder(input, { root, scope = "XSC", customer?, origin?, genre?, currentRelease?, onDoc? }) → summary
//   ingestDoc(ctx, doc, entry) → per-documento { code, units, items, residue, llm, fields, batches, report }
// CLI: node scripts/ingest/ingest.mjs --input <cartella> --root <workspace> [--scope XSC] [--customer ACME]
//        [--origin vendor|cliente|partner|interno] [--genre tecnica|d'uso|empirica|testimoniale] [--current-release R] [--json]
import { writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { harvest } from "./harvest.mjs";
import { segmentUnits, docIdToken } from "./segment.mjs";
import { profileDoc, assignDocCode, recordProfile, writeProfile, validateProfile, ORIGINS, KINDS } from "./profile-doc.mjs";
import { extractDocument, writeRaw, DOC_BUDGET } from "./extract.mjs";
import { residueEntry, writeResidue, summarize, RESIDUE_CLASSES } from "./residue.mjs";
import { buildReport, writeReport, accountUnits } from "./ingestion-report.mjs";
import { writeRawFields } from "./field-table.mjs";
import { diffUnits, impact } from "./doc-diff.mjs";
import { learn, loadRegistry, emptyRegistry } from "./aliases.mjs";
import { workspacePaths, ensureWorkspace, assertOutsidePlugin, PolicyError } from "./lib/paths.mjs";
export { PolicyError };
import { openDb } from "../kb/db.mjs";
import { writeUnits, upsertUnits } from "../kb/units.mjs";
import { plan as digestPlan, BudgetPolicyError, MAX_BATCH } from "../kb/digest-fields.mjs";
import { backlog } from "../kb/ingest-backlog.mjs";
import { SCOPES } from "../kb/codes.mjs";
import { isMain } from "../lib/is-main.mjs";
import { parseArgs, fail } from "../lib/args.mjs";

export class UsageError extends Error { constructor(m) { super(m); this.name = "UsageError"; } }
const GENRES = ["tecnica", "d'uso", "empirica", "testimoniale"];

function previousUnits(db, code) {
  return db.prepare("select code as id, hash, type, text, section_path, section from units where doc=? order by code").all(code)
    .map((r) => ({ id: r.id, hash: r.hash, type: r.type, text: r.text, context: { section_path: r.section_path, section: r.section } }));
}

export function ingestDoc(ctx, doc, entry) {
  const { db, paths, scope, origin, genre, kind, currentRelease, today } = ctx;
  const inbox = paths.inbox(scope);
  const assigned = assignDocCode(db, { level: paths.level, customer: paths.customer, source: entry.path, sha256: entry.sha256 });
  const code = assigned.code;
  // nuova versione dello stesso documento: le unità con hash invariato conservano il codice (§19.16)
  const prevCode = assigned.previous ?? (assigned.existing ? code : null);
  const prev = prevCode ? previousUnits(db, prevCode) : [];
  const { units, overflow } = segmentUnits(doc, { docCode: code, previous: prev });
  const profile = profileDoc(doc, units, { code, origin, currentRelease, overflow, today, ...(genre ? { genre } : {}), ...(kind ? { kind } : {}) });
  const extraction = extractDocument(doc, units, { profile });
  const acc = accountUnits(units, extraction.items);
  const residueEntries = acc.residue.map((r) => residueEntry({ class: r.class, reason: r.reason, unit: r.unit, doc: code }));
  for (const o of overflow) residueEntries.push(residueEntry({ class: "irrelevant", reason: o.reason, doc: code, detail: { section: o.section, rows: o.rows_total - o.rows_sampled, kind: "righe-dataset" } }));
  // giro 1 (I2): ogni pagina di sole immagini ancora senza testo (nessun sidecar OCR per quella pagina) è un residuo deferred
  for (const p of doc.meta?.image_only_pages ?? []) {
    residueEntries.push(residueEntry({ class: "deferred", reason: `pagina ${p} di sole immagini: serve il sidecar OCR ${entry.path}.ocr.txt (marcatore "--- pagina ${p} ---")`, doc: code, detail: { page: p } }));
  }
  writeUnits(paths.units, units);
  upsertUnits(db, units, { root: paths.root, unitsDir: paths.units });
  writeRaw(inbox, code, extraction, { scope });
  // campi: righe grezze e lotti ≤ 50 per la digestione (digest-fields, budget per documento §29.10)
  let fields = { rows: 0, batches: [], cursor: null, tokens: 0, status: "nessuna tabella di campi" };
  if (units.some((u) => u.type === "riga-tabella-campi")) {
    const w = writeRawFields(paths.inboxRoot, scope, doc, { genre: profile.genre });
    fields.rows = w.rows;
    if (w.rows) {
      try {
        const p = digestPlan(doc.id, { root: paths.inboxRoot, scope });
        fields = { rows: w.rows, batches: p.batches.map((b) => ({ batch: b.batch, rows: b.rows, tokens: b.tokens })), cursor: p.cursor, tokens: p.tokens_used, total_batches: p.total_batches, status: p.status };
      } catch (e) {
        if (!(e instanceof BudgetPolicyError)) throw e;
        fields = { rows: w.rows, batches: [], cursor: /cursore (\S+)/.exec(e.message)?.[1] ?? null, tokens: 0, status: "piano interrotto: riprendere con --resume" };
      }
    }
  }
  const llm = extraction.llm_plan;
  profile.ingestion = {
    status: "extracted", units_processed: units.length, items_produced: extraction.items.filter((r) => !r.residue).length,
    residue: summarize(residueEntries).by_class, coverage_ratio: units.length ? Math.round((acc.extracted / units.length) * 100) / 100 : null, last_run: today,
    estimated_tokens: llm.estimated_tokens + fields.tokens, sessions_planned: Math.max(llm.sessions.length, fields.cursor ? 2 : fields.batches.length ? 1 : 0),
  };
  const v = validateProfile(profile);
  if (!v.ok) throw new Error(`profilo ${code} non valido: ${v.errors.slice(0, 3).join("; ")}`);
  const pfile = writeProfile(inbox, profile);
  recordProfile(db, profile, { path: pfile });
  writeResidue(paths.inboxRoot, scope, code, residueEntries);
  const report = buildReport({ profile, units, extraction, date: today, overflow });
  writeReport(inbox, report);
  let diff = null;
  if (assigned.previous && prev.length) {
    const d = diffUnits(prev, units);
    diff = impact(d, []).counts;
    mkdirSync(join(inbox, "doc-diff"), { recursive: true });
    writeFileSync(join(inbox, "doc-diff", `${docIdToken(code)}.yaml`), YAML.stringify({ doc: code, previous: assigned.previous, ...impact(d, []) }, { lineWidth: 0 }));
  }
  return {
    code, doc_id: doc.id, source: entry.path, format: entry.format, kind: profile.kind, genre: profile.genre, reliability: profile.reliability.score,
    units: units.length, units_by_type: profile.units.by_type, items: profile.ingestion.items_produced, residue: profile.ingestion.residue,
    llm: { estimated_tokens: llm.estimated_tokens, sessions: llm.sessions.map((s) => s.tokens), over_unit_budget: llm.over_unit_budget.length },
    fields, overflow_rows: report.overflow_rows, diff, consistent: report.units === report.sourced + report.residue_total,
    text_tokens: units.reduce((a, u) => a + Math.ceil(u.text.length / 4), 0), candidates: extraction.stats.by_candidate,
  };
}

export function ingestFolder(input, { root, scope = "XSC", customer = null, origin = null, genre = null, kind = null, currentRelease = null, onDoc = null, today = new Date().toISOString().slice(0, 10) } = {}) {
  if (!root) throw new UsageError("richiesta la radice del workspace di conoscenza (--root)");
  assertOutsidePlugin(root);   // giro 1 (M14): mai nel repository del plugin
  if (!SCOPES.has(scope)) throw new UsageError(`scope sconosciuto: ${scope}`);
  if (origin && !ORIGINS.includes(origin)) throw new UsageError(`origine non valida: ${origin}`);
  if (genre && !GENRES.includes(genre)) throw new UsageError(`genere non valido: ${genre}`);
  // WP10a giro 1 (minore 1, §56.3 --kind): il tipo di documento forzato per tutta la cartella, nel vocabolario di §19.7
  if (kind && !KINDS.includes(kind)) throw new UsageError(`tipo di documento non valido: ${kind} (ammessi: ${KINDS.join(", ")})`);
  const t0 = Date.now();
  const paths = ensureWorkspace(workspacePaths({ root, customer }));
  const h = harvest(input, { root, scope, customer });
  const db = openDb(paths.db);
  const docs = [];
  const errors = [];
  try {
    const ctx = { db, paths, scope, origin: origin ?? (paths.level === "S" ? "vendor" : "cliente"), genre, kind, currentRelease, today };
    const byId = new Map(h.manifest.filter((m) => m.status === "parsed").map((m) => [m.doc_id, m]));
    for (const doc of h.docs) {
      try {
        const r = ingestDoc(ctx, doc, byId.get(doc.id));
        docs.push(r);
        if (onDoc) onDoc(r);
      } catch (e) { errors.push({ doc: doc.id, source: doc.meta?.source, error: String(e?.message ?? e) }); }
    }
    // proposte di alias dai campi grezzi (mai scritte in kb/ dalla pipeline: la promozione le valida)
    const rawRows = [];
    const fieldsDir = join(paths.inbox(scope), "fields");
    if (existsSync(fieldsDir)) {
      for (const d of docs.filter((x) => x.fields.rows)) {
        const dir = join(fieldsDir, d.doc_id.replace(/[^A-Za-z0-9._-]+/g, "_"));
        if (!existsSync(dir)) continue;
        for (const f of readdirSafe(dir).filter((x) => /\.yaml$/.test(x) && !/^(batch-|_)/.test(x))) rawRows.push(...(YAML.parse(readFileSync(join(dir, f), "utf8"))?.rows ?? []));
      }
    }
    const reg = existsSync(paths.aliases) ? loadRegistry(paths.aliases) : emptyRegistry();
    const aliasStats = learn(reg, rawRows);
    mkdirSync(paths.inbox(scope), { recursive: true });
    writeFileSync(join(paths.inbox(scope), "aliases.proposed.yaml"), YAML.stringify(reg, { lineWidth: 0 }));
    const bl = backlog(db);
    writeFileSync(join(paths.inbox(scope), "backlog.yaml"), YAML.stringify({ generated: today, backlog: bl }, { lineWidth: 0 }));
    const summary = corpusSummary(h, docs, errors, { aliasStats, ms: Date.now() - t0, scope, root: paths.root });
    writeFileSync(join(paths.inbox(scope), "ingest-summary.yaml"), YAML.stringify(summary, { lineWidth: 0 }));
    return { ...summary, docs };
  } finally { db.close(); }
}

function readdirSafe(dir) { try { return readdirSync(dir); } catch { return []; } }

export function corpusSummary(h, docs, errors, { aliasStats = null, ms = 0, scope = null, root = null } = {}) {
  const unitsByType = {};
  for (const d of docs) for (const [t, n] of Object.entries(d.units_by_type)) unitsByType[t] = (unitsByType[t] ?? 0) + n;
  const residueUnits = Object.fromEntries(RESIDUE_CLASSES.map((c) => [c, docs.reduce((a, d) => a + (d.residue[c] ?? 0), 0)]));
  const fileResidue = {};
  for (const m of h.manifest.filter((x) => x.status === "residue")) {
    const k = `${m.residue.class}: ${m.residue.reason.replace(/\(.*?\.ocr\.txt\)/, "(<immagine>.ocr.txt)").replace(/stesso contenuto di .*/, "stesso contenuto di un altro file")}`;
    fileResidue[k] = (fileResidue[k] ?? 0) + 1;
  }
  const byClassFiles = Object.fromEntries(RESIDUE_CLASSES.map((c) => [c, h.manifest.filter((x) => x.residue?.class === c).length]));
  const fields = docs.reduce((a, d) => a + (d.units_by_type["riga-tabella-campi"] ?? 0), 0);
  const tracciati = docs.reduce((a, d) => a + (d.units_by_type.tracciato ?? 0), 0);
  const llmTokens = docs.reduce((a, d) => a + d.llm.estimated_tokens, 0);
  const fieldTokens = docs.reduce((a, d) => a + (d.fields.tokens ?? 0), 0);
  const maxBatch = Math.max(0, ...docs.flatMap((d) => d.fields.batches.map((b) => b.rows)));
  const maxSession = Math.max(0, ...docs.flatMap((d) => d.llm.sessions), ...docs.map((d) => d.fields.tokens ?? 0));
  return {
    scope, root, ms,
    files: { total: h.stats.files, parsed: h.stats.parsed, residue: h.stats.residue, sidecars: h.stats.sidecars, parser_errors: h.manifest.filter((m) => m.parser_error).length, by_format: h.stats.by_format },
    documents: { profiled: docs.length, errors: errors.length, by_kind: docs.reduce((a, d) => { a[d.kind] = (a[d.kind] ?? 0) + 1; return a; }, {}), inconsistent: docs.filter((d) => !d.consistent).map((d) => d.code) },
    units: { total: docs.reduce((a, d) => a + d.units, 0), by_type: unitsByType },
    fields: { field_rows: fields, tracciato_elements: tracciati, max_batch_rows: maxBatch, batch_limit: MAX_BATCH },
    items_raw: docs.reduce((a, d) => a + d.items, 0),
    residue: { units_by_class: residueUnits, files_by_class: byClassFiles, files_by_reason: fileResidue, dataset_rows_outside_sample: docs.reduce((a, d) => a + (d.overflow_rows ?? 0), 0) },
    budget: { per_document: DOC_BUDGET, max_session_tokens: maxSession, respected: maxSession <= DOC_BUDGET, over_unit_budget: docs.reduce((a, d) => a + d.llm.over_unit_budget, 0) },
    tokens: { corpus_text: docs.reduce((a, d) => a + (d.text_tokens ?? 0), 0), t1_extraction: llmTokens, field_digestion: fieldTokens, total_llm_estimate: llmTokens + fieldTokens },
    candidates: docs.reduce((a, d) => { for (const [k, n] of Object.entries(d.candidates ?? {})) a[k] = (a[k] ?? 0) + n; return a; }, {}),
    aliases: aliasStats, errors,
  };
}

const HELP = `uso: node scripts/ingest/ingest.mjs --input <cartella> --root <workspace di conoscenza> [--scope XSC] [--customer ACME]
       [--origin vendor|cliente|partner|interno] [--genre tecnica|d'uso|empirica|testimoniale] [--kind <tipo di documento>] [--current-release R] [--json] [--help]

/kb ingest (§34.2): harvest della cartella, poi per ogni documento codice DOC (versioni comprese), unità con codici
stabili, profilo DOC con affidabilità, pre-estrazione T0 con il piano per lo scope-extractor (≤ 80k token per sessione),
residuo classificato, unità in <ws>/product|customers/<C>/sources/units/ e nel DB, campi grezzi e lotti ≤ 50, report
di ingestion (_inbox/<scope>/reports/), diff di versione; proposte di alias, backlog DT-025 e riepilogo del corpus
(_inbox/<scope>/ingest-summary.yaml). Il workspace nasce se assente. Mai scritture in kb/ (§29.6).

Exit code: 0 ok · 1 errore utente (argomenti, cartella assente, scope/origine/genere non validi) · 2 errore di sistema ·
3 uscita dentro il repository del plugin (rifiutata).`;

function main(argv) {
  const { opts } = parseArgs(argv);
  const asJson = !!opts.json;
  if (opts.help) { console.log(HELP); return 0; }
  if (!opts.input || !opts.root) return fail(asJson, 1, "richiesti --input <cartella> e --root <workspace>");
  try {
    const r = ingestFolder(opts.input, { root: opts.root, scope: opts.scope ?? "XSC", customer: opts.customer ?? null, origin: opts.origin ?? null, genre: opts.genre ?? null, kind: opts.kind ?? null, currentRelease: opts["current-release"] ?? null });
    const { docs, ...summary } = r;
    console.log(JSON.stringify(asJson ? { ok: true, ...summary, docs } : { ok: true, ...summary }, null, asJson ? 0 : 1));
    return 0;
  } catch (e) {
    if (e instanceof PolicyError) return fail(asJson, 3, e.message);
    if (e instanceof UsageError || /cartella di input assente|scope sconosciuto|cliente non valido/.test(e.message)) return fail(asJson, 1, e.message);
    return fail(asJson, 2, `errore di sistema: ${e.message ?? e}`);
  }
}

if (isMain(import.meta.url)) process.exit(main(process.argv.slice(2)));
