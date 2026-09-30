-- WP09a (F1'): unità di significato (§19.9), profili dei documenti (§19.7), copertura degli attributi dalla
-- digestione guidata (§19.11) e revisione umana (§19.19). I file restano la verità del contenuto:
--   unità   customers/<C>/sources/units/<DOCID>/<codice>.yaml  (livello S: product/sources/units/…)
--   DOC     _inbox/<scope>/profiles/<codice>.yaml → kb/ dopo la promozione
-- Il DB è l'indice (reindex, pipeline di ingest).
CREATE TABLE IF NOT EXISTS units (code TEXT PRIMARY KEY, doc TEXT NOT NULL, doc_id TEXT, type TEXT NOT NULL, section TEXT,
  section_path TEXT, chapter TEXT, page INTEGER, lang TEXT, text TEXT NOT NULL, hash TEXT NOT NULL, prev TEXT, next TEXT,
  path TEXT, updated_at TEXT);
CREATE INDEX IF NOT EXISTS idx_units_doc ON units(doc, section_path);
CREATE INDEX IF NOT EXISTS idx_units_hash ON units(hash);
CREATE VIRTUAL TABLE IF NOT EXISTS units_fts USING fts5(code UNINDEXED, text, section, tokenize = 'unicode61 remove_diacritics 2');
-- DOC: codice assegnato dal DB (assign-seq), doc_key = identità del documento fra le versioni (nome senza marcatori
-- di versione); reliability = reliability.score del profilo, peso di base delle affermazioni del documento.
CREATE TABLE IF NOT EXISTS doc_profiles (code TEXT PRIMARY KEY, doc_key TEXT NOT NULL, doc_id TEXT NOT NULL, source TEXT, sha256 TEXT,
  kind TEXT, genre TEXT, origin TEXT, scopes TEXT, version TEXT, dated TEXT, covers_release TEXT, reliability REAL, status TEXT, units INTEGER,
  path TEXT, profiled_at TEXT);
CREATE INDEX IF NOT EXISTS idx_doc_profiles_key ON doc_profiles(doc_key);
CREATE INDEX IF NOT EXISTS idx_doc_profiles_docid ON doc_profiles(doc_id);
-- Digestione guidata: per soggetto e attributo atteso, le unità che rispondono e il genere (i gap sono gratuiti).
CREATE TABLE IF NOT EXISTS attribute_coverage (subject_code TEXT NOT NULL, attribute TEXT NOT NULL, units TEXT NOT NULL, genre TEXT,
  answered INTEGER NOT NULL, contradiction INTEGER NOT NULL DEFAULT 0, recorded_at TEXT NOT NULL, PRIMARY KEY (subject_code, attribute));
-- Unità sorgente di un soggetto (sezione nota → prossimità per kb units --near).
CREATE TABLE IF NOT EXISTS subject_units (subject_code TEXT NOT NULL, unit_code TEXT NOT NULL, PRIMARY KEY (subject_code, unit_code));
