-- K4.5: modello dei campi (§19.6.5, §19.20). Una riga per FLD, popolata da reindex
-- (scripts/kb/reindex.mjs) dal file dell'item, che resta la verità del contenuto.
-- in_states e by_role sono array JSON; clusters è l'array cluster[] del file;
-- identity e identity_quality sono i blocchi della carta d'identità (JSON).
CREATE TABLE IF NOT EXISTS fields (code TEXT PRIMARY KEY, document TEXT, section TEXT, technical_name TEXT, label_it TEXT, label_en TEXT,
  field_type TEXT, mandatory_kind TEXT, in_states TEXT, when_cond TEXT, by_role TEXT, unless_cond TEXT, reason_kind TEXT, reason_ref TEXT,
  custom INTEGER NOT NULL DEFAULT 0, key_ref TEXT, clusters TEXT, integration_relevance TEXT, identity TEXT, identity_quality TEXT);
CREATE INDEX IF NOT EXISTS idx_fields_doc ON fields(document, mandatory_kind);
CREATE INDEX IF NOT EXISTS idx_fields_mandatory ON fields(mandatory_kind);
CREATE INDEX IF NOT EXISTS idx_fields_section ON fields(document, section);
CREATE INDEX IF NOT EXISTS idx_fields_technical ON fields(technical_name);
CREATE INDEX IF NOT EXISTS idx_fields_reason ON fields(reason_kind, custom);
-- Dettaglio degli archi lineage (relations porta solo from/to/kind): la fonte che li
-- dichiara (FLD, INT o LCY), trasformazione, mapping e obbligatorietà a valle.
-- reindex sostituisce gli archi di una fonte quando il suo file cambia.
CREATE TABLE IF NOT EXISTS field_lineage (source_code TEXT NOT NULL, from_code TEXT NOT NULL, to_code TEXT NOT NULL, kind TEXT NOT NULL,
  document TEXT, transform TEXT, mapping TEXT, mandatory_there INTEGER, note TEXT, reason_kind TEXT,
  PRIMARY KEY (source_code, from_code, to_code, kind));
CREATE INDEX IF NOT EXISTS idx_field_lineage_from ON field_lineage(from_code, kind);
CREATE INDEX IF NOT EXISTS idx_field_lineage_to ON field_lineage(to_code, kind);
CREATE INDEX IF NOT EXISTS idx_relations_to ON relations(to_code, kind);
