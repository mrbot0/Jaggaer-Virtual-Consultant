-- WP09d: registro delle migrazioni applicate (kb migrate, §49.4: file → DB, mai il contrario) e
-- esecuzioni delle query Analytics (§20.3, DT-015: una query si consegna solo se eseguita con LIMIT e giudicata
-- coerente; su tabelle ignote diventa QRY solo dopo due esecuzioni coerenti).
CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, sha256 TEXT NOT NULL, applied_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS query_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, query_hash TEXT NOT NULL, customer TEXT, executed_at TEXT NOT NULL,
  row_limit INTEGER NOT NULL, row_count INTEGER, coherence TEXT NOT NULL, tables TEXT, tables_knowledge TEXT, session TEXT, note TEXT);
CREATE INDEX IF NOT EXISTS idx_query_runs_hash ON query_runs(query_hash);
