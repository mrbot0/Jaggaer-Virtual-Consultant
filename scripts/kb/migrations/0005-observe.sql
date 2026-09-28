-- K6.2: errori della piattaforma riconosciuti da observe-append (§20.6, §29.6). Il testo grezzo subito,
-- la digestione entro la sessione: una riga per messaggio (hash del testo redatto + codice + categoria),
-- count incrementato a ogni ripetizione; file = customers/<C>/kb/scopes/<S>/errors/_raw/<ts>.yaml.
-- status: grezzo → digerito (il digester dello scope completa l'ERR e ne assegna il codice).
CREATE TABLE IF NOT EXISTS errors_raw (hash TEXT PRIMARY KEY, raw_id TEXT NOT NULL, customer TEXT NOT NULL, scope TEXT NOT NULL,
  message TEXT NOT NULL, code TEXT, category TEXT NOT NULL, kind TEXT, blocking INTEGER, lang TEXT, page_sig TEXT, file TEXT NOT NULL,
  first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 1, sessions TEXT NOT NULL, last_obs TEXT,
  status TEXT NOT NULL DEFAULT 'grezzo', err_code TEXT);
CREATE INDEX IF NOT EXISTS idx_errors_raw_status ON errors_raw(customer, scope, status);
CREATE INDEX IF NOT EXISTS idx_observations_page ON observations(page_sig);
