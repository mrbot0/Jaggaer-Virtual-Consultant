export function formatCode({ level, customer, scope, type, seq, version = 1 }) {
  return `${level}.${customer}.${scope}.${type}.${String(seq).padStart(4, "0")}${version > 1 ? `.v${version}` : ""}`;
}
// Tabelle i cui codici seguono il formato item (§5): `items` per la
// conoscenza, `decisions` per i DEC scritti da dt-eval (§29.6). Allow-list:
// il nome della tabella non arriva mai in SQL da input esterno. K6.2: `observations` per le OBS di observe-append.
const SEQ_TABLES = new Set(["items", "decisions", "observations"]);
export function assignSeq(db, { level, customer, scope, type }, { table = "items" } = {}) {
  if (!SEQ_TABLES.has(table)) throw new Error(`tabella non ammessa per assign-seq: ${table}`);
  return db.transaction(() => {
    const prefix = `${level}.${customer}.${scope}.${type}.`;
    const row = db.prepare(`select max(cast(substr(code, length(?)+1, 4) as integer)) as m from ${table} where code like ? || '%'`).get(prefix, prefix);
    return (row?.m ?? 0) + 1;
  })();
}
