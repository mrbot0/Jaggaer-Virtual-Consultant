export function formatCode({ level, customer, scope, type, seq, version = 1 }) {
  return `${level}.${customer}.${scope}.${type}.${String(seq).padStart(4, "0")}${version > 1 ? `.v${version}` : ""}`;
}
export function assignSeq(db, { level, customer, scope, type }) {
  return db.transaction(() => {
    const prefix = `${level}.${customer}.${scope}.${type}.`;
    const row = db.prepare("select max(cast(substr(code, length(?)+1, 4) as integer)) as m from items where code like ? || '%'").get(prefix, prefix);
    return (row?.m ?? 0) + 1;
  })();
}
