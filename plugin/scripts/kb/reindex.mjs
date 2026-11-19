import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";
import YAML from "yaml";
import { openDb } from "./db.mjs";
import { validateItem } from "./validate-schema.mjs";
import { parseCode } from "./codes.mjs";
import { validateCluster } from "./cluster-rules.mjs";
import { fileURLToPath } from "node:url";
import { confidence, weight } from "./weights.mjs";
import { quality } from "./quality.mjs";
import { isMain } from "../lib/is-main.mjs";
import { indexFieldModel, needsFieldIndex } from "./fields.mjs";
import { indexUnits, linkSubjectUnits } from "./units.mjs";

// WP09a: le unità citate come fonte di un item (sources[].unit o stringa "U.<DOCID>.<nnnn>") → subject_units,
// la sezione nota del soggetto per la prossimità di `kb units --near`.
const UNIT_CODE_RE = /^U\.[A-Z0-9]+\.\d{4,}$/;
export const sourceUnits = (obj) => (obj?.sources ?? []).flatMap((s) => (typeof s === "string" ? [s] : [s?.unit, ...(Array.isArray(s?.units) ? s.units : [])])).filter((u) => UNIT_CODE_RE.test(String(u ?? "")));

// Tipi che alimentano il modello dei campi (K4.5): FLD → fields; FLD, INT, LCY → archi lineage.
const FIELD_MODEL_TYPES = new Set(["FLD", "INT", "LCY"]);

const SOURCE_WEIGHTS = YAML.parse(readFileSync(new URL("../../schemas/source-weights.yaml", import.meta.url), "utf8"));

// WP09a (§19.7): se una fonte dell'item è un DOC profilato, il suo reliability.score è il peso di base
// (il minimo fra i DOC profilati citati), in luogo del peso generico per origine.
const DOC_CODE_RE = /^[SC]\.[A-Z0-9]{3,4}\.[A-Z0-9]{3}\.DOC\.\d{4}(?:\.v\d+)?$/;
// Giro 1 (M10): la digestione guidata cita UNITÀ (sources[].unit): unitDoc(codice) → DOC dell'unità (units.doc).
export function profiledSourceScore(obj, docReliability, unitDoc = null) {
  if (!docReliability?.size) return null;
  const scores = [];
  for (const s of obj?.sources ?? []) {
    const refs = typeof s === "string" ? [s] : [s?.doc, s?.ref, s?.code, s?.document].filter(Boolean);
    if (unitDoc) for (const u of sourceUnits({ sources: [s] })) { const d = unitDoc(u); if (d) refs.push(d); }
    for (const r of refs) if (DOC_CODE_RE.test(String(r)) && docReliability.has(String(r))) scores.push(docReliability.get(String(r)));
  }
  return scores.length ? Math.min(...scores) : null;
}

// Peso della fonte da F1 (§6.2); promozione-digest usa il minimo dei
// contributori scritto dalla digestione (source_weight), altrimenti il fallback.
export function sourceWeight(obj, { docReliability = null, unitDoc = null } = {}) {
  const profiled = profiledSourceScore(obj, docReliability, unitDoc);
  if (profiled !== null) return profiled;
  const w = SOURCE_WEIGHTS[obj?.facets?.F1];
  if (typeof w === "number") return w;
  if (w && typeof w === "object") return typeof obj.source_weight === "number" ? obj.source_weight : w.fallback;
  return 0;
}

// Parametri neutri della qualità a reindex: nessuna età, release corrente,
// nessuna corroborazione né contraddizione; i parametri che richiedono la
// provenienza completa (specificità, completezza, verificabilità, metodo,
// stabilità) valgono 0.5 finché la digestione non li fornisce.
const NEUTRAL_Q = { ageDays: 0, releaseDistance: 0, docStatus: 1, corroboration: 0, openContradictions: 0, specificity: 0.5, completeness: 0.5,
  verifiability: 0.5, verificationMethod: 0.5, lastVerifiedDays: 0, applicability: 1, stability: 0.5 };

// Confidenza, peso W e qualità Q di un item al reindex (§6.3, §6.5), senza
// contesto di sessione: freschezza 1.0, 0 conferme, 0 contraddizioni; una
// portabilità condizionata vale "condizione non soddisfatta" (0.20) finché il
// contesto del cliente non la verifica.
export function scoreItem(obj, { docReliability = null, unitDoc = null } = {}) {
  const sw = sourceWeight(obj, { docReliability, unitDoc });
  const conf = Math.round(confidence({ sourceWeight: sw, freshness: 1.0, confirmations: 0, openContradictions: 0 }) * 1e4) / 1e4;
  const w = weight({ confidence: conf, portability: obj.facets.F8, status: obj.facets.F12, condition_met: false, same_customer: true });
  const q = quality({ ...NEUTRAL_Q, authority: sw }, "generic", obj.type).Q;
  return { confidence: conf, weight: w, quality: q };
}

function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (!e.name.startsWith(".") && e.name !== "_inbox") yield* walk(p); }
    else if (/\.ya?ml$/.test(e.name) && /^[SCL]\./.test(e.name)) yield p;
  }
}

export const DEFAULT_CLUSTERS_DIR = fileURLToPath(new URL("../../clusters", import.meta.url));

function* walkClusters(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walkClusters(p);
    else if (/^CL-.+\.ya?ml$/.test(e.name)) yield p;
  }
}

// Upsert dei file CLS nella tabella `clusters` (+ cluster_details). Lo stato
// gestito dalle operazioni del validatore (fuso, deprecato) non viene
// sovrascritto dal file: il ciclo di vita è nel DB, il contenuto nel file.
export function upsertClusters(db, dir) {
  const stats = { clusters_upserted: 0, clusters_invalid: 0 };
  if (!dir || !existsSync(dir)) return stats;
  const up = db.prepare(`insert into clusters(code,family,name,definition,inclusion,exclusion,facet_signature,owner,portability,status,item_code)
    values (@code,@family,@name,@definition,@inclusion,@exclusion,@facet_signature,@owner,@portability,@status,null)
    on conflict(code) do update set family=excluded.family, name=excluded.name, definition=excluded.definition, inclusion=excluded.inclusion,
    exclusion=excluded.exclusion, facet_signature=excluded.facet_signature, owner=excluded.owner, portability=excluded.portability,
    status=case when clusters.status in ('fuso','deprecato') then clusters.status else excluded.status end`);
  const det = db.prepare(`insert into cluster_details(code,domain,depth,parent,base_risk,path,hash) values (@code,@domain,@depth,@parent,@base_risk,@path,@hash)
    on conflict(code) do update set domain=excluded.domain, depth=excluded.depth, parent=excluded.parent, base_risk=excluded.base_risk,
    path=excluded.path, hash=excluded.hash`);
  for (const file of walkClusters(dir)) {
    const text = readFileSync(file, "utf8");
    const c = YAML.parse(text);
    if (!validateCluster(c).ok) { stats.clusters_invalid++; continue; }
    up.run({ code: c.code, family: c.family, name: c.name, definition: c.definition, inclusion: JSON.stringify(c.inclusion),
      exclusion: JSON.stringify(c.exclusion), facet_signature: JSON.stringify(c.facet_signature), owner: c.owner,
      portability: JSON.stringify(c.portability), status: c.status });
    det.run({ code: c.code, domain: c.domain, depth: c.depth, parent: c.parent ?? null, base_risk: c.base_risk ?? null,
      path: relative(dir, file), hash: createHash("sha256").update(text).digest("hex") });
    stats.clusters_upserted++;
  }
  return stats;
}

// 18/11/2026 (ciclo di bug fixing): il catalogo dei cluster del plugin entrava nel DB solo con reindex. Sui DB reali mai
// reindicizzati (ENEL, AVVA, prodotto: clusters 0) `kb clusters` era vuoto e `cluster.mjs admit` rispondeva «cluster
// inesistente» per ogni CL del catalogo, cioè il cluster-validator non poteva ammettere nulla. ensureClusters carica (o
// riallinea) il catalogo quando la tabella è vuota o quando manca il codice cercato; lo stato fuso/deprecato del DB resta.
export function ensureClusters(db, { code = null, dir = DEFAULT_CLUSTERS_DIR } = {}) {
  const missing = code ? !db.prepare("select 1 from clusters where code = ?").get(code) : !db.prepare("select 1 from clusters limit 1").get();
  if (!missing || !dir || !existsSync(dir)) return { clusters_upserted: 0, clusters_invalid: 0 };
  return db.transaction(() => upsertClusters(db, dir))();
}

// recompute: ricalcola confidenza/peso/qualità anche degli item invariati. Senza,
// si ricalcolano solo gli invariati ancora senza punteggio (confidenza 0: DB scritti da K0).
// 18/11/2026 (ciclo di bug fixing, decisione dell'utente: «quando va in errore non si deve bloccare subito ma deve fare
// quello che può e tracciare l'errore»): un file YAML illeggibile non ferma più l'indice (prima YAML.parse lanciava e la
// transazione annullava TUTTO il reindex) e un item non valido non resta senza motivo: entrambi finiscono in `errors`
// (file, codice, motivo; al più MAX_ERRORS voci) e il loro item già indicizzato NON si depreca (il file c'è ancora: va
// corretto, non è sparito). Ogni file nel suo savepoint: un errore del DB su un file non annulla gli altri. Il DB si chiude.
const MAX_ERRORS = 50;
const codeOfFile = (file) => { const m = /([SCL]\.[A-Z0-9]{3,4}\.[A-Z0-9]{3}\.[A-Z]{3}\.\d{4}(?:\.v\d+)?)\.ya?ml$/.exec(file); return m ? m[1] : null; };
export function reindex(root, dbPath, { clustersDir = DEFAULT_CLUSTERS_DIR, recompute = false } = {}) {
  const db = openDb(dbPath);
  try { return reindexDb(db, root, { clustersDir, recompute }); } finally { db.close(); }
}

function reindexDb(db, root, { clustersDir, recompute }) {
  const stats = { scanned: 0, upserted: 0, unchanged: 0, rescored: 0, deprecated: 0, invalid: 0, errors: [] };
  const trace = (file, code, error) => { if (stats.errors.length < MAX_ERRORS) stats.errors.push({ file: relative(root, file), code, error: String(error).slice(0, 300) }); };
  const seen = new Set();
  const get = db.prepare("select hash, confidence, updated_at from items where code=?");
  const touchItem = db.prepare("update items set updated_at=? where code=?");
  const rescore = db.prepare("update items set confidence=@confidence, weight=@weight, quality=@quality where code=@code");
  const upsert = db.prepare(`insert into items(code,level,customer,scope,type,version,title,summary,facets,confidence,quality,weight,status,path,hash,updated_at,verified_at,release_ref)
    values (@code,@level,@customer,@scope,@type,@version,@title,@summary,@facets,@confidence,@quality,@weight,@status,@path,@hash,@updated_at,@verified_at,@release_ref)
    on conflict(code) do update set title=excluded.title, summary=excluded.summary, facets=excluded.facets, status=excluded.status,
    confidence=excluded.confidence, quality=excluded.quality, weight=excluded.weight,
    path=excluded.path, hash=excluded.hash, updated_at=excluded.updated_at, verified_at=excluded.verified_at, release_ref=excluded.release_ref, version=excluded.version`);
  const ftsDel = db.prepare("delete from items_fts where code=?");
  const ftsIns = db.prepare("insert into items_fts(code,title,summary) values (?,?,?)");
  const kbDir = existsSync(join(root, "kb")) ? join(root, "kb") : root;
  // WP09a: affidabilità dei DOC profilati (doc_profiles, più i DOC in kb/ di questa scansione)
  const docReliability = new Map(db.prepare("select code, reliability from doc_profiles where reliability is not null").all().map((r) => [r.code, r.reliability]));
  for (const file of walk(kbDir)) {
    if (!/\.DOC\.\d{4}(?:\.v\d+)?\.ya?ml$/.test(file)) continue;
    try { const d = YAML.parse(readFileSync(file, "utf8")); if (d?.type === "DOC" && typeof d.reliability?.score === "number") docReliability.set(d.id, d.reliability.score); } catch { /* validato sotto */ }
  }
  // giro 1 (M10): le unità si indicizzano PRIMA degli item, così una fonte U.* risolve il suo DOC
  const unitStats = indexUnits(db, join(root, "sources", "units"), { root });
  const unitDocSt = db.prepare("select doc from units where code=?");
  const unitDoc = (code) => unitDocSt.get(code)?.doc ?? null;
  // 18/11/2026: i file si leggono e si validano FUORI dalla transazione, a lotti; ogni lotto si scrive in una transazione
  // breve (prima: una sola transazione per tutta la scansione ⇒ blocco di scrittura tenuto per minuti sui kb grandi, AVVA
  // 12759 item, e hook e agenti fermi su «database is locked»). La deprecazione degli spariti resta alla fine, dopo tutto.
  const BATCH = 500;
  const files = [...walk(kbDir)];
  // 19/11/2026 (ciclo 5, segnalazione del coordinatore: reindex di AVVA, 12759 item invariati, ~140 s; learn digest-weekly
  // oltre i 2 minuti del timeout di Bash): reindex incrementale. Un file con lo stesso percorso e la stessa data della sua
  // riga (updated_at = mtime del file, come lo scrive l'upsert), con punteggio e modello dei campi già indicizzati e non
  // deprecato, è invariato e NON si rilegge né si rianalizza. Un file con la data cambiata si rilegge: contenuto uguale ⇒
  // la riga prende la data del file (la volta dopo si salta), contenuto diverso ⇒ upsert. --recompute rilegge tutto.
  const iso = (ms) => new Date(ms).toISOString();
  const slash = (p) => String(p ?? "").split("\\").join("/");
  const indexed = new Map(db.prepare("select code, type, path, confidence, status, updated_at from items").all().map((r) => [slash(r.path), r]));
  const fieldRow = db.prepare("select 1 from fields where code=?");
  const lineageRow = db.prepare("select 1 from field_lineage where source_code=? limit 1");
  const fieldModelReady = (r) => !FIELD_MODEL_TYPES.has(r.type) || !!(r.type === "FLD" ? fieldRow.get(r.code) : lineageRow.get(r.code));
  for (let b = 0; b < files.length; b += BATCH) {
    const entries = [];
    for (const file of files.slice(b, b + BATCH)) {
      stats.scanned++;
      const row = recompute ? null : indexed.get(slash(relative(root, file)));
      if (row && row.confidence && row.status !== "deprecato" && row.code === codeOfFile(file)) {
        let mt = null;
        try { mt = statSync(file).mtimeMs; } catch { /* letto sotto */ }
        if (mt !== null && row.updated_at === iso(mt) && fieldModelReady(row)) { seen.add(row.code); stats.unchanged++; continue; }
      }
      const fileCode = codeOfFile(file);
      let text, obj;
      try { text = readFileSync(file, "utf8"); obj = YAML.parse(text); } catch (err) {
        stats.invalid++;
        if (fileCode) seen.add(fileCode);
        trace(file, fileCode, `file illeggibile: ${err?.message ?? err}`);
        continue;
      }
      const hash = createHash("sha256").update(text).digest("hex");
      if (obj?.type === "TPL") continue;   // template di caricamento (§3.8): voce di kb/ non indicizzata, validata da template-learn
      const v = validateItem(obj);
      if (!v.ok) {
        stats.invalid++;
        if (fileCode) seen.add(fileCode);
        if (typeof obj?.id === "string") seen.add(obj.id);
        trace(file, obj?.id ?? fileCode, `item non valido: ${v.errors.slice(0, 3).join("; ")}`);
        continue;
      }
      let mtimeMs = Date.now();
      try { mtimeMs = statSync(file).mtimeMs; } catch { /* sparito durante la scansione: l'ora corrente */ }
      entries.push({ file, obj, hash, mtimeMs });
    }
    db.transaction(() => { for (const { file, obj, hash, mtimeMs } of entries) {
      try {
        db.transaction(() => {
          const c = parseCode(obj.id); seen.add(obj.id);
          const prev = get.get(obj.id);
          if (prev?.hash === hash) {
            stats.unchanged++;
            if (prev.updated_at !== iso(mtimeMs)) touchItem.run(iso(mtimeMs), obj.id);
            if (recompute || !prev.confidence) { rescore.run({ code: obj.id, ...scoreItem(obj, { docReliability, unitDoc }) }); stats.rescored++; }
            if (FIELD_MODEL_TYPES.has(obj.type) && needsFieldIndex(db, obj)) indexFieldModel(db, obj);   // DB precedente a 0004-fld
            return;
          }
          upsert.run({ code: obj.id, level: c.level, customer: c.customer, scope: c.scope, type: c.type, version: c.version, title: obj.title,
            summary: obj.summary, facets: JSON.stringify(obj.facets), ...scoreItem(obj, { docReliability, unitDoc }), status: obj.facets.F12, path: relative(root, file), hash,
            updated_at: new Date(mtimeMs).toISOString(), verified_at: obj.facets.F13?.verified_at ?? null, release_ref: obj.facets.F13?.release ?? null });
          ftsDel.run(obj.id); ftsIns.run(obj.id, obj.title, obj.summary);
          if (FIELD_MODEL_TYPES.has(obj.type)) indexFieldModel(db, obj);
          const su = sourceUnits(obj);
          if (su.length) linkSubjectUnits(db, obj.id, su);
          stats.upserted++;
        })();
      } catch (err) { stats.invalid++; trace(file, obj.id, `errore di indicizzazione: ${err?.message ?? err}`); }
    } })();
  }
  db.transaction(() => {
    const dep = db.prepare("update items set status='deprecato' where code=?");
    for (const { code } of db.prepare("select code from items where status<>'deprecato'").all()) if (!seen.has(code)) { dep.run(code); stats.deprecated++; }
    Object.assign(stats, upsertClusters(db, clustersDir));
    // WP09a: unità di significato (<root>/sources/units/<DOCID>/<codice>.yaml) → units + units_fts
    Object.assign(stats, unitStats);
  })();
  return stats;
}

// WP09d: indicizza UN file di item (promote, deprecate): stessa validazione e stesso punteggio di reindex, riga
// items + FTS aggiornate. Lancia se il file non valida (lo script chiamante lo ha già validato prima di scriverlo).
// text: il contenuto che si sta per scrivere (promote/deprecate indicizzano PRIMA di scrivere il file, nella stessa
// transazione: se la scrittura fallisce la riga si annulla e non resta nulla da togliere).
export function indexItemFile(db, root, file, text = readFileSync(file, "utf8")) {
  const obj = YAML.parse(text);
  const v = validateItem(obj);
  if (!v.ok) throw new Error(`item non valido ${obj?.id ?? file}: ${v.errors.join("; ")}`);
  const c = parseCode(obj.id);
  db.prepare(`insert into items(code,level,customer,scope,type,version,title,summary,facets,confidence,quality,weight,status,path,hash,updated_at,verified_at,release_ref)
    values (@code,@level,@customer,@scope,@type,@version,@title,@summary,@facets,@confidence,@quality,@weight,@status,@path,@hash,@updated_at,@verified_at,@release_ref)
    on conflict(code) do update set title=excluded.title, summary=excluded.summary, facets=excluded.facets, status=excluded.status,
    confidence=excluded.confidence, quality=excluded.quality, weight=excluded.weight, path=excluded.path, hash=excluded.hash,
    updated_at=excluded.updated_at, verified_at=excluded.verified_at, release_ref=excluded.release_ref, version=excluded.version`).run({
    code: obj.id, level: c.level, customer: c.customer, scope: c.scope, type: c.type, version: c.version, title: obj.title, summary: obj.summary,
    facets: JSON.stringify(obj.facets), ...scoreItem(obj), status: obj.facets.F12, path: relative(root, file),
    hash: createHash("sha256").update(text).digest("hex"), updated_at: (existsSync(file) ? new Date(statSync(file).mtimeMs) : new Date()).toISOString(),
    verified_at: obj.facets.F13?.verified_at ?? null, release_ref: obj.facets.F13?.release ?? null });
  db.prepare("delete from items_fts where code=?").run(obj.id);
  db.prepare("insert into items_fts(code,title,summary) values (?,?,?)").run(obj.id, obj.title, obj.summary);
  // 18/11/2026 (ciclo di bug fixing): come reindex, anche il modello dei campi (fields, archi lineage) e le unità sorgente.
  // Prima un FLD scritto da atlas-write (o promosso) entrava solo in items: su AVVA 820 FLD e `kb fields` vuoto (fields 0)
  // fino a un reindex completo; identity e impact non li trovavano.
  if (FIELD_MODEL_TYPES.has(obj.type)) indexFieldModel(db, obj);
  const su = sourceUnits(obj);
  if (su.length) linkSubjectUnits(db, obj.id, su);
  return obj;
}

function printHelp() {
  console.log(`uso: node scripts/kb/reindex.mjs --root <dir> --db <file> [--clusters <dir>] [--recompute] [--json] [--help]

Scansiona <dir>/kb, calcola l'hash di ogni item YAML, aggiorna items e
items_fts nel DB SQLite; deprecato per gli item spariti dal filesystem.
--clusters: cartella dei file CLS da caricare in clusters (default: clusters/ del plugin).
--recompute: ricalcola confidenza, peso e qualità anche degli item invariati.

Exit code: 0 ok · 1 errore utente (argomenti mancanti) · 2 errore di sistema.`);
}

if (isMain(import.meta.url)) {
  const a = process.argv;
  if (a.includes("--help")) { printHelp(); process.exit(0); }
  const asJson = a.includes("--json");
  const root = a[a.indexOf("--root") + 1];
  const db = a[a.indexOf("--db") + 1];
  if (!root || !db || a.indexOf("--root") < 0 || a.indexOf("--db") < 0) {
    if (asJson) console.log(JSON.stringify({ ok: false, error: "richiesti --root <dir> e --db <file>" }));
    else { console.error("errore: richiesti --root <dir> e --db <file>"); printHelp(); }
    process.exit(1);
  }
  try {
    const ci = a.indexOf("--clusters");
    const stats = reindex(root, db, { ...(ci >= 0 && a[ci + 1] ? { clustersDir: a[ci + 1] } : {}), recompute: a.includes("--recompute") });
    console.log(JSON.stringify(asJson ? { ok: true, ...stats } : stats));
    process.exit(0);
  } catch (err) {
    if (asJson) console.log(JSON.stringify({ ok: false, error: String(err?.message ?? err) }));
    else console.error(`errore di sistema: ${err?.message ?? err}`);
    process.exit(2);
  }
}
