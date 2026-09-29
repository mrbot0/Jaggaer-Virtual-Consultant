-- WP09d (F8): indice degli item del dominio analitico (PAT, PBK, BRF, RUL). I file in customers/<C>/analysis/ e
-- product/analysis/ restano la verità; la tabella dà il SEQ (assign-seq) e non entra nelle ricerche di kb (dominio separato, §1.1).
CREATE TABLE IF NOT EXISTS analysis_items (code TEXT PRIMARY KEY, type TEXT NOT NULL, scope TEXT NOT NULL, path TEXT NOT NULL, hash TEXT NOT NULL, created_at TEXT NOT NULL);
