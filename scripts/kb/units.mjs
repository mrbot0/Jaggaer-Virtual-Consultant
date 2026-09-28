// Le unità di significato nel DB (§19.9, §19.11): indice e ricerca per la digestione guidata.
//
// Posizione canonica dei file (la verità del contenuto): customers/<C>/sources/units/<DOCID>/<codice>.yaml
// (livello S: product/sources/units/<DOCID>/<codice>.yaml), scritti dalla pipeline di ingest; reindex li indicizza
// nella tabella `units` e in `units_fts` (FTS5, unicode61 senza diacritici). Nessun agente scrive lì (§29.6).
//
//   writeUnits(unitsDir, units) → { dir, files }             un file YAML per unità, cartella <DOCID>
//   upsertUnits(db, units, { root?, unitsDir? }) → n           indice diretto (pipeline), hash invariato ⇒ nessuna scrittura
//   indexUnits(db, unitsDir, { root }) → { scanned, upserted, unchanged }   (reindex)
//   linkSubjectUnits(db, subject, unitCodes)                   unità sorgente di un soggetto (prossimità per --near)
//   ftsQuery(text) → espressione FTS5 (parole ≥ 3 lettere, senza parole vuote, prefisso per le parole lunghe, OR)
//   units(db, { doc?, near?, query?, top = 5, type?, within? })   within: insieme di codici ammessi → [{ code, doc, type, section, section_path, page, text, score, near }]
//     FTS (bm25) + prossimità di sezione: stessa sezione di un'unità sorgente del soggetto ×2, stesso capitolo ×1.3.
//     Senza query: le unità del documento (o della sezione del soggetto) in ordine.
//   questionFor("CFG.impacts") → { type, attribute, question, genre, critical_for_r2 } dalla banca di domande
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import YAML from "yaml";
import { docIdToken } from "../ingest/segment.mjs";

export class UnitsInputError extends Error { constructor(m) { super(m); this.name = "UnitsInputError"; } }

const BANKS = new URL("../../product/question-banks/", import.meta.url);
export function questionFor(ref) {
  const m = /^([A-Z]{2,3})\.([a-z_]+)$/.exec(String(ref ?? ""));
  if (!m) throw new UnitsInputError(`riferimento di domanda non valido: ${ref} (atteso TIPO.attributo, es. CFG.impacts)`);
  const file = new URL(`${m[1]}.yaml`, BANKS);
  if (!existsSync(file)) throw new UnitsInputError(`nessuna banca di domande per il tipo ${m[1]}`);
  const bank = YAML.parse(readFileSync(file, "utf8"));
  const q = bank.questions.find((x) => x.attribute === m[2]);
  if (!q) throw new UnitsInputError(`il tipo ${m[1]} non ha l'attributo atteso ${m[2]}`);
  return { type: m[1], ...q };
}

export function writeUnits(unitsDir, units) {
  if (!units.length) return { dir: null, files: 0 };
  const dir = join(unitsDir, docIdToken(units[0].doc));
  mkdirSync(dir, { recursive: true });
  for (const u of units) writeFileSync(join(dir, `${u.id}.yaml`), YAML.stringify(u, { lineWidth: 0 }));
  return { dir, files: units.length };
}

function stmts(db) {
  return {
    get: db.prepare("select hash, doc from units where code=?"),
    up: db.prepare(`insert into units(code, doc, doc_id, type, section, section_path, chapter, page, lang, text, hash, prev, next, path, updated_at)
      values (@code,@doc,@doc_id,@type,@section,@section_path,@chapter,@page,@lang,@text,@hash,@prev,@next,@path,@updated_at)
      on conflict(code) do update set doc=excluded.doc, doc_id=excluded.doc_id, type=excluded.type, section=excluded.section, section_path=excluded.section_path,
      chapter=excluded.chapter, page=excluded.page, lang=excluded.lang, text=excluded.text, hash=excluded.hash, prev=excluded.prev, next=excluded.next,
      path=excluded.path, updated_at=excluded.updated_at`),
    ftsDel: db.prepare("delete from units_fts where code=?"),
    ftsIns: db.prepare("insert into units_fts(code, text, section) values (?,?,?)"),
  };
}

function upsertOne(s, u, path) {
  const prev = s.get.get(u.id);
  // hash e documento invariati ⇒ nessuna scrittura; una nuova versione del DOC riprende le unità invariate (§19.16)
  if (prev?.hash === u.hash && prev?.doc === u.doc) return false;
  s.up.run({ code: u.id, doc: u.doc, doc_id: u.doc_id ?? null, type: u.type, section: u.context?.section ?? null, section_path: u.context?.section_path ?? null,
    chapter: u.context?.chapter ?? null, page: u.context?.page ?? null, lang: u.lang ?? u.context?.lang ?? null, text: u.text, hash: u.hash,
    prev: u.context?.prev ?? null, next: u.context?.next ?? null, path, updated_at: new Date().toISOString() });
  s.ftsDel.run(u.id);
  s.ftsIns.run(u.id, u.text, `${u.context?.chapter ?? ""} ${u.context?.section ?? ""}`.trim());
  return true;
}

export function upsertUnits(db, list, { root = null, unitsDir = null } = {}) {
  const s = stmts(db);
  let n = 0;
  db.transaction(() => {
    for (const u of list) {
      const path = unitsDir ? join(unitsDir, docIdToken(u.doc), `${u.id}.yaml`) : null;
      if (upsertOne(s, u, path && root ? relative(root, path) : path)) n++;
    }
  })();
  return n;
}

export function indexUnits(db, unitsDir, { root = null } = {}) {
  const stats = { units_scanned: 0, units_upserted: 0, units_unchanged: 0 };
  if (!unitsDir || !existsSync(unitsDir)) return stats;
  const s = stmts(db);
  db.transaction(() => {
    for (const d of readdirSync(unitsDir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const dir = join(unitsDir, d.name);
      for (const f of readdirSync(dir)) {
        if (!/^U\..+\.ya?ml$/.test(f)) continue;
        stats.units_scanned++;
        const file = join(dir, f);
        let u;
        try { u = YAML.parse(readFileSync(file, "utf8")); } catch { continue; }
        if (!u?.id || !u?.hash || !u?.text) continue;
        if (upsertOne(s, u, root ? relative(root, file) : file)) stats.units_upserted++; else stats.units_unchanged++;
      }
    }
  })();
  return stats;
}

export function linkSubjectUnits(db, subject, unitCodes) {
  const ins = db.prepare("insert or ignore into subject_units(subject_code, unit_code) values (?,?)");
  db.transaction(() => { for (const u of unitCodes) ins.run(subject, u); })();
}

const STOP = new Set(["che", "chi", "cosa", "come", "dove", "quando", "quale", "quali", "quanto", "perché", "perche", "del", "della", "dei", "delle", "degli", "nel", "nella", "per",
  "con", "una", "uno", "gli", "le", "il", "lo", "la", "da", "di", "si", "se", "non", "sono", "questo", "questa", "prima", "dopo", "deve", "può", "puo", "the", "and", "for", "what", "which",
  "how", "who", "where", "when", "does", "this", "that", "with", "from", "are", "is", "its", "it", "can", "has", "have", "been", "any", "all", "esiste", "esistono", "vale", "viene", "cui", "suo", "sua"]);
export function ftsQuery(text) {
  const words = String(text ?? "").toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").match(/[\p{L}\p{N}_]{3,}/gu) ?? [];
  const terms = [...new Set(words.filter((w) => !STOP.has(w)))].slice(0, 16).map((w) => (w.length > 6 ? `${w.slice(0, 6)}*` : `"${w}"`));
  return terms.join(" OR ");
}

export function units(db, { doc = null, near = null, query = null, top = 5, type = null, within = null } = {}) {
  if (!Number.isInteger(top) || top < 1 || top > 50) throw new UnitsInputError("--top fra 1 e 50");
  const docCodes = doc ? db.prepare("select code from doc_profiles where code=? or doc_id=? or code like ? || '.v%'").all(doc, doc, doc).map((r) => r.code) : [];
  const docSet = doc ? new Set([doc, ...docCodes]) : null;
  const nearUnits = near ? db.prepare("select u.code, u.doc, u.section_path, u.chapter from subject_units s join units u on u.code = s.unit_code where s.subject_code=?").all(near) : [];
  const nearSections = new Set(nearUnits.map((u) => `${u.doc}|${u.section_path}`));
  const nearChapters = new Set(nearUnits.map((u) => `${u.doc}|${u.chapter}`));
  const filter = (r) => (!docSet || docSet.has(r.doc) || docSet.has(r.doc_id)) && (!type || r.type === type) && (!within || within.has(r.code));
  const proximity = (r) => (nearSections.has(`${r.doc}|${r.section_path}`) ? "sezione" : nearChapters.has(`${r.doc}|${r.chapter}`) ? "capitolo" : null);
  const q = ftsQuery(query);
  let rows;
  if (q) {
    rows = db.prepare(`select u.*, bm25(units_fts) as rank from units_fts f join units u on u.code = f.code where units_fts match ? order by rank limit 2000`).all(q)
      .filter(filter).map((r) => {
        const p = proximity(r);
        return { ...r, near: p, score: Math.round(-r.rank * (p === "sezione" ? 2 : p === "capitolo" ? 1.3 : 1) * 1e4) / 1e4 };
      });
  } else {
    const base = docSet ? db.prepare("select * from units where doc in (select value from json_each(?)) or doc_id in (select value from json_each(?))").all(JSON.stringify([...docSet]), JSON.stringify([...docSet]))
      : nearUnits.length ? db.prepare("select * from units where doc in (select value from json_each(?))").all(JSON.stringify([...new Set(nearUnits.map((u) => u.doc))])) : [];
    rows = base.filter(filter).map((r) => { const p = proximity(r); return { ...r, near: p, score: p === "sezione" ? 2 : p === "capitolo" ? 1.3 : 1 }; });
  }
  rows.sort((a, b) => b.score - a.score || String(a.code).localeCompare(String(b.code), "en", { numeric: true }));
  return rows.slice(0, top).map((r) => ({ code: r.code, doc: r.doc, type: r.type, section: r.section, section_path: r.section_path, page: r.page, text: r.text, score: r.score, near: r.near }));
}

export const unitFileCount = (unitsDir) => (existsSync(unitsDir) ? readdirSync(unitsDir).filter((d) => statSync(join(unitsDir, d)).isDirectory()).reduce((a, d) => a + readdirSync(join(unitsDir, d)).length, 0) : 0);
