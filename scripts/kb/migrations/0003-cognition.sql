-- K3: contesto delle decisioni ed esiti attesi.
-- decision_context: ciò che la distanza di contesto di §12.3 e la calibrazione di §17.4
-- devono sapere di una DEC e che la riga `decisions` non porta: release in cui è stata presa
-- (età in release), forma epistemica al momento, faccette F5/F6/F7/F10 del soggetto allora,
-- confidenza dichiarata dall'agente (Brier), se la decisione ha effetti (§17.1 #4-#5).
CREATE TABLE IF NOT EXISTS decision_context (decision_code TEXT PRIMARY KEY, release_ref TEXT, shape TEXT, facets TEXT,
  confidence REAL, effects INTEGER);
-- expected_outcomes: l'esito atteso dichiarato nella lezione (§10.2 passo 6, §12.1) per ogni DEC con
-- effetti; `learn outcomes` verifica contro questo registro e `expire` chiude a non-verificabile
-- dopo 2 release senza verifica.
CREATE TABLE IF NOT EXISTS expected_outcomes (decision_code TEXT PRIMARY KEY, expect TEXT NOT NULL, lesson_code TEXT, session TEXT,
  release_ref TEXT, declared_at TEXT);
CREATE INDEX IF NOT EXISTS idx_expected_session ON expected_outcomes(session);
