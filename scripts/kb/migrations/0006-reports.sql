-- K6.6: report di azione e di test (§29.8). Codice RPT.<CLIENTE>.<AAAAMMGG>.<SEQ> (SEQ di 4 cifre per
-- cliente e giorno, assegnato qui); il file customers/<C>/reports/<codice>.yaml resta la verità del contenuto.
CREATE TABLE IF NOT EXISTS reports (code TEXT PRIMARY KEY, kind TEXT NOT NULL, customer TEXT NOT NULL, session TEXT, scope TEXT,
  plan TEXT, run TEXT, outcome TEXT NOT NULL, xray TEXT, completion INTEGER, learning_event INTEGER, path TEXT NOT NULL, hash TEXT NOT NULL,
  created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_reports_session ON reports(session);
