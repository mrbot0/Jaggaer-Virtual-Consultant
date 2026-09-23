CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS items (code TEXT PRIMARY KEY, level TEXT NOT NULL, customer TEXT NOT NULL, scope TEXT NOT NULL,
  type TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, title TEXT NOT NULL, summary TEXT NOT NULL, facets TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0, quality REAL NOT NULL DEFAULT 0, weight REAL NOT NULL DEFAULT 0, status TEXT NOT NULL,
  path TEXT NOT NULL, hash TEXT NOT NULL, updated_at TEXT NOT NULL, verified_at TEXT, release_ref TEXT);
CREATE TABLE IF NOT EXISTS relations (from_code TEXT, to_code TEXT, kind TEXT, PRIMARY KEY (from_code, to_code, kind));
CREATE TABLE IF NOT EXISTS clusters (code TEXT PRIMARY KEY, family TEXT, name TEXT, definition TEXT, inclusion TEXT, exclusion TEXT,
  facet_signature TEXT, owner TEXT, portability TEXT, status TEXT, item_code TEXT);
CREATE TABLE IF NOT EXISTS cluster_members (cluster_code TEXT, item_code TEXT, admitted_at TEXT, decision_code TEXT, PRIMARY KEY (cluster_code, item_code));
CREATE TABLE IF NOT EXISTS observations (code TEXT PRIMARY KEY, session TEXT, scope TEXT, page_sig TEXT, payload TEXT, confirmed_count INTEGER DEFAULT 1, promoted_to TEXT);
CREATE TABLE IF NOT EXISTS lessons (code TEXT PRIMARY KEY, agent TEXT, session TEXT, scope TEXT, status TEXT, payload TEXT, validated_by TEXT, promoted_to TEXT);
CREATE TABLE IF NOT EXISTS decisions (code TEXT PRIMARY KEY, table_code TEXT, agent TEXT, session TEXT, subject_code TEXT, subject_cluster TEXT,
  inputs TEXT, priors TEXT, score REAL, outcome TEXT, strategy TEXT, at TEXT);
CREATE TABLE IF NOT EXISTS outcomes (decision_code TEXT PRIMARY KEY, verified_at TEXT, verified_by TEXT, result TEXT, evidence_code TEXT, note TEXT);
CREATE TABLE IF NOT EXISTS epistemic (subject_code TEXT PRIMARY KEY, k_tech REAL, k_use REAL, k_obs REAL, k_exec REAL, k_user REAL, k_level REAL,
  shape TEXT, open_contradictions INTEGER DEFAULT 0, computed_at TEXT);
CREATE TABLE IF NOT EXISTS contradictions (code TEXT PRIMARY KEY, a_code TEXT, b_code TEXT, facet TEXT, resolution TEXT, status TEXT);
CREATE TABLE IF NOT EXISTS sessions (code TEXT PRIMARY KEY, customer TEXT, scope TEXT, mode TEXT, started_at TEXT, tokens_in INTEGER, tokens_out INTEGER,
  cost_estimate REAL, model_mix TEXT, surprises INTEGER DEFAULT 0);
CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(code, title, summary);
CREATE INDEX IF NOT EXISTS idx_items_facets ON items(level, scope, type, status);
INSERT OR IGNORE INTO meta(key, value) VALUES ('knowledge_version', '1');
