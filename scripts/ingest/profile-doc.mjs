// Profilo del documento (§19.7): valutare la fonte prima di leggerla. DOC C.<C>.XSC.DOC.nnnn (S.STD per i
// documenti vendor), con kind, genere (F15), origine, versione, data, release coperta, lingue, scope, struttura,
// unità per tipo, affidabilità calcolata (schemas/doc-reliability.yaml), problemi noti, stato dell'ingestion.
//
//   detectKind(doc, { source }) → kind di §19.7 (+ tenant-survey, dati-import)
//   genreFor(kind) → F15
//   detectScopes(doc, units) → scope ordinati per punteggio lessicale
//   docKey(source) → identità del documento fra le versioni (nome senza marcatori di versione)
//   reliability({ kind, origin, title, coversRelease, currentRelease, releases, units, formal, corroboration }) → { …, score }
//   internalConsistency(units) → { value, contradictions, rules }
//   profileDoc(doc, units, { code, origin, level, currentRelease?, releases?, corroboration?, kind?, genre?, scope?, residue?, overflow? })
//       → item DOC (item.base + doc.schema.json); summary ≤ 60 parole; facets F1..F15 dal genere e dall'origine
//   assignDocCode(db, { level, customer, doc, source, sha256 }) → { code, version, existing }   (SEQ dal DB, §5):
//       stesso doc_key e stesso sha256 ⇒ stesso codice; stesso doc_key e contenuto diverso ⇒ nuova versione .vN
//   recordProfile(db, profile, { path }) → upsert in doc_profiles
// CLI: node scripts/ingest/profile-doc.mjs --parsed <doc.json> --root <workspace> [--customer C] [--origin vendor|cliente|partner|interno]
//        [--scope XSC] [--kind K] [--current-release R] [--json]
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, basename, extname } from "node:path";
import YAML from "yaml";
import { openDb } from "../kb/db.mjs";
import { assignSeq, formatCode } from "../kb/assign-seq.mjs";
import { parseCode, SCOPES } from "../kb/codes.mjs";
import { validateItem } from "../kb/validate-schema.mjs";
import { validateWith } from "../lib/schemas.mjs";
import { isMain } from "../lib/is-main.mjs";
import { parseArgs, fail } from "../lib/args.mjs";
import { segmentUnits, recognizeFieldTable } from "./segment.mjs";
import { parseMandatoryText } from "./deontic.mjs";
import { normalizeLabel } from "./dedupe.mjs";
import { workspacePaths, ensureWorkspace } from "./lib/paths.mjs";
import { safeName } from "./field-table.mjs";

export const RELIABILITY = YAML.parse(readFileSync(new URL("../../schemas/doc-reliability.yaml", import.meta.url), "utf8"));
export const KINDS = Object.keys(RELIABILITY.base_by_kind);
export const ORIGINS = ["vendor", "cliente", "partner", "interno"];
export class UsageError extends Error { constructor(m) { super(m); this.name = "UsageError"; } }

const GENRE = {
  "spec-integrazione": "tecnica", "config-export": "tecnica", "doc-configurazione-cliente": "tecnica", "doc-progetto": "tecnica", "guida-admin": "tecnica",
  "release-notes": "tecnica", "dati-import": "tecnica", "manuale-utente": "d'uso", "training-deck": "d'uso", "help-online": "d'uso", "set-screenshot": "d'uso",
  "tenant-survey": "empirica", "registrazione": "testimoniale", "thread-email": "testimoniale",
};
export const genreFor = (kind) => GENRE[kind] ?? "d'uso";

// F1 (§6.2) dal genere e dall'origine del documento: il peso generico per origine, sostituito dal reliability.score.
export function f1For(kind, origin, format = null) {
  // formale solo per le specifiche a schema (XSD, WSDL, OpenAPI/JSON Schema); i dev kit in prosa e tabelle sono prosa
  if (kind === "spec-integrazione") return ["xsd", "wsdl", "openapi", "json", "yaml"].includes(format) ? "spec-integrazione-formale" : "spec-integrazione-prosa";
  if (kind === "config-export") return "esecuzione-config";
  if (kind === "release-notes") return "release-notes";
  if (kind === "tenant-survey" || kind === "set-screenshot") return "osservazione-chrome";
  if (kind === "registrazione" || kind === "thread-email") return "dichiarazione-utente";
  if (origin === "vendor") return "doc-standard";
  return genreFor(kind) === "tecnica" ? "doc-cliente-tecnica" : "doc-cliente-utente";
}

const T = (s) => String(s ?? "").toLowerCase();
export function detectKind(doc, { source = doc?.meta?.source ?? "" } = {}) {
  const hint = doc?.meta?.kind_hint ?? "";
  const name = T(`${basename(String(source))} ${doc?.title ?? ""}`);
  if (["workflow-definition", "workflow-folders", "document-config", "form-config", "form-request-template", "config-export"].includes(hint)) return "config-export";
  if (hint === "spec-integrazione" || ["xsd", "wsdl", "openapi"].includes(doc?.format)) return "spec-integrazione";
  if (hint === "registrazione" || ["vtt", "srt"].includes(doc?.format)) return "registrazione";
  if (hint === "thread-email" || doc?.format === "eml") return "thread-email";
  if (hint === "set-screenshot" || doc?.format === "image") return "set-screenshot";
  if (hint === "tenant-survey") return "tenant-survey";
  if (/release notes|note di rilascio|what'?s new|novità della release/.test(name)) return "release-notes";
  if (/development.?kit|web.?service|\bws\b|\bapi\b|integrat|interfac|tracciat|\bjint\b|\bj1p\b|push services|ftp service/.test(name)) return "spec-integrazione";
  if (hint === "dati-tabellari" || ["csv", "xls"].includes(doc?.format) || /import|template|sample|export data|master report|commodity|catalog_item|price file|users_/.test(name) && ["xlsx", "txt", "csv", "xls"].includes(doc?.format)) return "dati-import";
  if (doc?.format === "pptx" || /slides?|slide notes|course|corso|training|workbook|blueprint|class file|curriculum|game board|handout|capstone/.test(name)) return "training-deck";
  if (/checklist|project plan|piano di progetto|burndown|implementation|go.?live|transition form|documento di progetto|ppq|considerations|methodology/.test(name)) return "doc-progetto";
  if (/configurazione|configuration|config\b/.test(name) && /cliente|customer|acme/.test(name)) return "doc-configurazione-cliente";
  if (/admin|administration|amministrazione|setup|set up|configur|sysadmin|workflow|guidelines|settings/.test(name)) return "guida-admin";
  if (doc?.format === "html") return "help-online";
  return "manuale-utente";
}

const SCOPE_LEX = {
  CAT: /\b(catalog\w*|punch-?out|item master|articol\w+|listin\w+|hosted catalog|virtual item)\b/gi,
  SRC: /\b(sourcing|rfx|rfq|rfp|gar[ae]|tender|auction|bid\w*|quot(?:e|ation)s?)\b/gi,
  VEN: /\b(suppliers?|fornitor\w+|vendors?|registration|onboarding|supplier portal|tsm)\b/gi,
  CON: /\b(contracts?|contratt\w+|agreements?|call-?off)\b/gi,
  P2P: /\b(requisitions?|richiest[ae] di acquisto|purchase orders?|\bpo\b|ordin[ei]|receipts?|ricevimento|carts?|carrello|checkout|approvals?|approvazion\w+)\b/gi,
  INV: /\b(invoices?|fattur\w+|credit memos?|note di credito|matching|abbinamento|payment\w*)\b/gi,
  QLT: /\b(quality|qualità|non-?conformit\w+|audit)\b/gi,
  ANL: /\b(analytics|reports?|reporting|dashboards?|spend analysis|kpi)\b/gi,
  ADM: /\b(admin\w*|users?|utent[ei]|roles?|ruol[io]|permissions?|permess[io]|setup|site settings|organi[sz]ation|custom fields?|workflows?|departments?|budget manager)\b/gi,
  XSC: /\b(integration\w*|integrazion\w+|web services?|api|erp|sap|ftp|xml|interfac\w+|jint|push|middleware|endpoint)\b/gi,
};
export function detectScopes(doc, units = [], { max = 4 } = {}) {
  const text = [doc?.title ?? "", ...(doc?.sections ?? []).map((s) => s.title), ...units.slice(0, 2000).map((u) => u.text)].join(" \n ");
  const score = Object.fromEntries(Object.entries(SCOPE_LEX).map(([k, re]) => [k, (text.match(re) ?? []).length]));
  const sorted = Object.entries(score).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  if (!sorted.length) return ["XSC"];
  const top = sorted[0][1];
  return sorted.filter(([, v]) => v >= top * 0.15).slice(0, max).map(([k]) => k);
}

export function docKey(source) {
  const base = basename(String(source ?? "doc")).replace(extname(String(source ?? "")), "");
  return base.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "")
    .replace(/[\s_-]*(?:v(?:er(?:sion[e]?)?)?\.?\s*\d+(?:\.\d+)*|rev\.?\s*\d+|\(\d+\)|copy|copia)\s*$/i, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "doc";
}

export function detectVersion(doc, source) {
  if (doc?.version) return String(doc.version);
  const m = /(?:^|[\s_-])v(?:er(?:sion[e]?)?)?\.?\s*(\d+(?:\.\d+)*)(?![\d])/i.exec(`${basename(String(source ?? ""))} ${doc?.title ?? ""}`);
  return m ? m[1] : null;
}

const REL_RE = /\b(?:R\s?(\d{2})\.(\d{1,2})|release\s+(\d{2})\.(\d{1,2})|(?:release|versione|version)\s+(20\d{2}(?:\.\d+)?))\b/i;
export function detectRelease(doc, units = []) {
  const hay = [doc?.title ?? "", doc?.meta?.source ?? "", ...units.slice(0, 200).map((u) => u.text)].join(" ");
  const m = REL_RE.exec(hay);
  if (!m) return null;
  if (m[1]) return `R${m[1]}.${m[2]}`;
  if (m[3]) return `R${m[3]}.${m[4]}`;
  return m[5];
}

// Coerenza interna: righe-campo con lo stesso nome tecnico (o label) e obbligatorietà opposta (always vs never).
export function internalConsistency(units) {
  const seen = new Map();
  let contradictions = 0;
  let rules = units.filter((u) => u.type === "regola").length;
  for (const u of units.filter((x) => x.type === "riga-tabella-campi")) {
    const c = u.row?.columns ?? {};
    const cells = u.row?.cells ?? [];
    const key = normalizeLabel(cells[c.technical_name] ?? cells[c.label] ?? "");
    const mt = cells[c.mandatory];
    if (!key || mt === undefined || mt === null || String(mt).trim() === "") continue;
    rules++;
    const kind = parseMandatoryText(String(mt)).mandatory?.kind ?? null;
    if (!kind || kind === "conditional") continue;
    const k2 = `${u.context?.section_path}|${key}`;
    if (seen.has(k2) && seen.get(k2) !== kind) contradictions++;
    else seen.set(k2, kind);
  }
  const value = rules ? Math.max(RELIABILITY.internal_consistency_min, 1 - contradictions / rules) : 1;
  return { value: Math.round(value * 100) / 100, contradictions, rules };
}

const releaseNum = (r) => { const m = /R?(\d{2,4})\.?(\d{1,2})?/.exec(String(r ?? "")); return m ? Number(m[1]) * 10 + Number(m[2] ?? 0) : null; };
export function releaseDistance(covers, current, releases = null) {
  if (!covers || !current) return null;
  if (Array.isArray(releases) && releases.includes(covers) && releases.includes(current)) return Math.max(0, releases.indexOf(current) - releases.indexOf(covers));
  const a = releaseNum(covers), b = releaseNum(current);
  if (a === null || b === null) return null;
  return Math.max(0, Math.round((b - a) / 10 * 2) / 1);   // ~2 release l'anno (R24.1, R24.3…) quando non c'è elenco
}

export function reliability({ kind, origin, title = "", coversRelease = null, currentRelease = null, releases = null, units = [], formal = false, corroboration = null }) {
  const R = RELIABILITY;
  const notes = [];
  const base = formal ? R.formal_spec_base : R.base_by_kind[kind] ?? 0.7;
  const dist = releaseDistance(coversRelease, currentRelease, releases);
  let freshness;
  if (dist === null) { freshness = R.freshness_unknown_release; notes.push("release coperta o corrente ignota: freschezza neutra"); }
  else freshness = R.freshness_by_release_distance[Math.min(3, dist)];
  let authorship = R.authorship_by_origin[origin] ?? R.authorship_unknown;
  if (/unofficial|non ufficiale|draft|bozza/i.test(title)) { authorship *= R.unofficial_factor; notes.push("documento dichiarato non ufficiale o bozza"); }
  const ic = internalConsistency(units);
  if (ic.contradictions) notes.push(`${ic.contradictions} contraddizioni interne su ${ic.rules} regole`);
  const corr = corroboration ?? R.corroboration_default;
  if (corroboration === null) notes.push("corroborazione non ancora misurata (neutra)");
  const r2 = (x) => Math.round(x * 100) / 100;
  return { base_by_kind: r2(base), freshness: r2(freshness), authorship: r2(authorship), internal_consistency: ic.value, corroboration: r2(corr),
    score: r2(base * freshness * authorship * ic.value * corr), notes };
}

const count = (list, f) => list.reduce((a, x) => a + (f(x) ? 1 : 0), 0);
const words = (s) => String(s ?? "").split(/\s+/).filter(Boolean);
const clip = (s, n) => { const w = words(s); return w.length <= n ? w.join(" ") : `${w.slice(0, n - 1).join(" ")} …`; };

export function profileDoc(doc, units, opts = {}) {
  const { code, origin = "vendor", currentRelease = null, releases = null, corroboration = null, residue = null, overflow = [], today = new Date().toISOString().slice(0, 10) } = opts;
  if (!code || !parseCode(code) || parseCode(code).type !== "DOC") throw new UsageError(`codice DOC non valido: ${code}`);
  if (!ORIGINS.includes(origin)) throw new UsageError(`origine non valida: ${origin} (${ORIGINS.join(", ")})`);
  const source = doc.meta?.source ?? doc.id;
  const kind = opts.kind ?? detectKind(doc, { source });
  if (!KINDS.includes(kind)) throw new UsageError(`kind non valido: ${kind}`);
  const genre = opts.genre ?? genreFor(kind);
  const coversRelease = opts.coversRelease ?? detectRelease(doc, units);
  const formal = ["xsd", "wsdl", "openapi"].includes(doc.format) || doc.meta?.parser === "parse-spec" || doc.meta?.parser === "parse-xsd";
  const rel = reliability({ kind, origin, title: `${doc.title} ${source}`, coversRelease, currentRelease, releases, units, formal, corroboration });
  const byType = {};
  for (const u of units) byType[u.type] = (byType[u.type] ?? 0) + 1;
  const langs = Object.entries(units.reduce((a, u) => { a[u.lang] = (a[u.lang] ?? 0) + 1; return a; }, {})).filter(([, n]) => n >= Math.max(1, units.length * 0.1)).map(([l]) => l).sort();
  const sections = doc.sections ?? [];
  const tables = sections.flatMap((s) => s.tables ?? []);
  const structure = {
    pages: doc.page_count ?? null, chapters: count(sections, (s) => s.level === 1), sections: sections.length, tables: tables.length,
    figures: sections.reduce((a, s) => a + (s.figures?.length ?? 0), 0), field_tables: count(tables, (t) => !!recognizeFieldTable(t.headers)),
    hidden_sheets: count(sections, (s) => s.hidden), revisions: sections.reduce((a, s) => a + (s.revisions?.length ?? 0), 0),
    comments: sections.reduce((a, s) => a + (s.comments?.length ?? 0), 0), scanned: !!doc.scanned,
  };
  const scopes = opts.scopes ?? detectScopes(doc, units);
  const known = (doc.warnings ?? []).map((w) => ({ section: null, note: w, status: "parser" }));
  for (const o of overflow) known.push({ section: o.section, note: o.reason, status: "open" });
  const parsed = parseCode(code);
  const summary = clip(`Documento ${kind} (${genre}, origine ${origin}) "${doc.title}": ${units.length} unità, ${structure.tables} tabelle, ${structure.field_tables} tabelle di campi; scope ${scopes.join(", ")}; affidabilità ${rel.score}.`, 60);
  const profile = {
    id: code, type: "DOC", title: clip(String(doc.title || source), 20).slice(0, 140).padEnd(3, "."), summary,
    facets: {
      F1: f1For(kind, origin, doc.format), F4: "profilo", F5: "saas-core", F6: [], F7: "nessuno", F8: parsed.level === "S" ? "universale" : "specifica", F9: "una-tantum",
      F10: "R0", F11: "deterministico", F12: "grezzo", F13: { verified_at: doc.meta?.dated ?? today, release: coversRelease ?? "ignota" }, F15: genre,
    },
    sources: [{ file: source, sha256: doc.meta?.sha256 ?? null }],
    kind, genre, origin, version: detectVersion(doc, source), dated: doc.meta?.dated ?? null, covers_release: coversRelease,
    languages: langs.length ? langs : [doc.lang ?? "it"], scopes,
    source: { path: source, sha256: doc.meta?.sha256 ?? "", size: doc.meta?.size ?? 0, format: doc.format, doc_id: doc.id, doc_key: docKey(source) },
    structure, units: { total: units.length, by_type: byType }, reliability: rel, known_issues: known,
    ingestion: { status: "segmented", units_processed: units.length, items_produced: 0, residue: residue ?? {}, coverage_ratio: null, last_run: today },
  };
  return profile;
}

export function validateProfile(p) {
  const base = validateItem(p);
  const spec = validateWith("doc.schema.json", p);
  return { ok: base.ok && spec.ok, errors: [...base.errors, ...spec.errors] };
}

export function assignDocCode(db, { level = "S", customer = "STD", source, sha256 }) {
  const key = docKey(source);
  const rows = db.prepare("select code, sha256 from doc_profiles where doc_key=? order by profiled_at").all(key);
  const same = rows.find((r) => r.sha256 === sha256);
  if (same) return { code: same.code, existing: true, version: parseCode(same.code)?.version ?? 1 };
  if (rows.length) {
    const p = parseCode(rows[0].code);
    const version = Math.max(...rows.map((r) => parseCode(r.code)?.version ?? 1)) + 1;
    return { code: formatCode({ ...p, version }), existing: false, version, previous: rows.at(-1).code };
  }
  const k = { level, customer, scope: "XSC", type: "DOC" };
  const seq = Math.max(assignSeq(db, k, { table: "items" }), assignSeq(db, k, { table: "doc_profiles" }));
  return { code: formatCode({ ...k, seq }), existing: false, version: 1 };
}

export function recordProfile(db, p, { path = null } = {}) {
  db.prepare(`insert into doc_profiles(code, doc_key, doc_id, source, sha256, kind, genre, origin, version, dated, covers_release, reliability, status, units, path, profiled_at)
    values (@code,@doc_key,@doc_id,@source,@sha256,@kind,@genre,@origin,@version,@dated,@covers_release,@reliability,@status,@units,@path,@profiled_at)
    on conflict(code) do update set doc_id=excluded.doc_id, source=excluded.source, sha256=excluded.sha256, kind=excluded.kind, genre=excluded.genre,
    origin=excluded.origin, version=excluded.version, dated=excluded.dated, covers_release=excluded.covers_release, reliability=excluded.reliability,
    status=excluded.status, units=excluded.units, path=excluded.path, profiled_at=excluded.profiled_at`).run({
    code: p.id, doc_key: p.source.doc_key, doc_id: p.source.doc_id, source: p.source.path, sha256: p.source.sha256, kind: p.kind, genre: p.genre, origin: p.origin,
    version: p.version, dated: p.dated, covers_release: p.covers_release, reliability: p.reliability.score, status: p.ingestion.status, units: p.units.total, path,
    profiled_at: new Date().toISOString(),
  });
}

export function writeProfile(inboxScopeDir, p) {
  const dir = join(inboxScopeDir, "profiles");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${safeName(p.id)}.yaml`);
  writeFileSync(file, YAML.stringify(p));
  return file;
}

const HELP = `uso: node scripts/ingest/profile-doc.mjs --parsed <doc.json> --root <workspace> [--customer C] [--origin vendor|cliente|partner|interno]
       [--scope XSC] [--kind <kind>] [--current-release R] [--json] [--help]

Profilo DOC del documento normalizzato (§19.7): codice dal DB (S.STD.XSC.DOC.nnnn o C.<C>.XSC.DOC.nnnn; stessa
chiave e contenuto diverso ⇒ nuova versione .vN), kind, genere, origine, struttura, unità per tipo, affidabilità
(schemas/doc-reliability.yaml). Scrive _inbox/<scope>/profiles/<codice>.yaml e la riga doc_profiles del DB.
Kind ammessi: ${KINDS.join(", ")}.

Exit code: 0 ok · 1 errore utente (argomenti, documento o profilo non valido) · 2 errore di sistema.`;

function main(argv) {
  const { opts } = parseArgs(argv);
  const asJson = !!opts.json;
  if (opts.help) { console.log(HELP); return 0; }
  if (!opts.parsed || !opts.root) return fail(asJson, 1, "richiesti --parsed <doc.json> e --root <workspace>");
  const scope = opts.scope ?? "XSC";
  if (!SCOPES.has(scope)) return fail(asJson, 1, `scope sconosciuto: ${scope}`);
  let doc;
  try { doc = JSON.parse(readFileSync(opts.parsed, "utf8")); } catch (e) { return fail(asJson, 1, `documento illeggibile: ${e.message}`); }
  try {
    const paths = ensureWorkspace(workspacePaths({ root: opts.root, customer: opts.customer ?? null }));
    const db = openDb(paths.db);
    try {
      const { code } = assignDocCode(db, { level: paths.level, customer: paths.customer, source: doc.meta?.source ?? doc.id, sha256: doc.meta?.sha256 ?? "" });
      const { units, overflow } = segmentUnits(doc, { docCode: code });
      const p = profileDoc(doc, units, { code, origin: opts.origin ?? (paths.level === "S" ? "vendor" : "cliente"), kind: opts.kind, currentRelease: opts["current-release"] ?? null, overflow });
      const v = validateProfile(p);
      if (!v.ok) return fail(asJson, 1, `profilo non valido: ${v.errors.slice(0, 5).join("; ")}`);
      const file = writeProfile(paths.inbox(scope), p);
      recordProfile(db, p, { path: file });
      console.log(JSON.stringify(asJson ? { ok: true, profile: p, file } : { ok: true, code: p.id, kind: p.kind, genre: p.genre, reliability: p.reliability.score, units: p.units.total, file }));
      return 0;
    } finally { db.close(); }
  } catch (e) {
    if (e instanceof UsageError) return fail(asJson, 1, e.message);
    return fail(asJson, 2, `errore di sistema: ${e.message ?? e}`);
  }
}

if (isMain(import.meta.url)) process.exit(main(process.argv.slice(2)));
