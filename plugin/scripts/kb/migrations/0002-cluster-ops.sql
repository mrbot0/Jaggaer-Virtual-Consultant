-- K1.4: stato operativo dei cluster (il file CLS resta la verità del contenuto).
-- domain/depth/parent/base_risk dal file; empty_digests e merged_into sono
-- gestiti dalle operazioni del validatore (scripts/kb/cluster.mjs).
CREATE TABLE IF NOT EXISTS cluster_details (code TEXT PRIMARY KEY, domain TEXT, depth INTEGER, parent TEXT, base_risk TEXT,
  empty_digests INTEGER NOT NULL DEFAULT 0, merged_into TEXT, path TEXT, hash TEXT);
-- Registro append-only delle operazioni: ammissioni, rifiuti motivati, dubbi, fusioni, quarantene, deprecazioni.
CREATE TABLE IF NOT EXISTS cluster_events (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, op TEXT NOT NULL,
  cluster_code TEXT, item_code TEXT, reason TEXT, decision_code TEXT, payload TEXT);
CREATE INDEX IF NOT EXISTS idx_cluster_events_item ON cluster_events(item_code);
