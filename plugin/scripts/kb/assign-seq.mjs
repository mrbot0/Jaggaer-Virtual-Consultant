import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

export function formatCode({ level, customer, scope, type, seq, version = 1 }) {
  return `${level}.${customer}.${scope}.${type}.${String(seq).padStart(4, "0")}${version > 1 ? `.v${version}` : ""}`;
}
// Tabelle i cui codici seguono il formato item (§5): `items` per la
// conoscenza, `decisions` per i DEC scritti da dt-eval (§29.6). Allow-list:
// il nome della tabella non arriva mai in SQL da input esterno. K6.2: `observations` per le OBS di observe-append.
// WP09a: `doc_profiles` per i DOC profilati prima della promozione (profile-doc prende il massimo con `items`).
// WP09d: `analysis_items` per PAT, PBK, BRF, RUL del dominio analitico (fuori dall'indice di kb).
const SEQ_TABLES = new Set(["items", "decisions", "observations", "doc_profiles", "analysis_items"]);
export function assignSeq(db, { level, customer, scope, type }, { table = "items" } = {}) {
  if (!SEQ_TABLES.has(table)) throw new Error(`tabella non ammessa per assign-seq: ${table}`);
  return db.transaction(() => {
    const prefix = `${level}.${customer}.${scope}.${type}.`;
    const row = db.prepare(`select max(cast(substr(code, length(?)+1, 4) as integer)) as m from ${table} where code like ? || '%'`).get(prefix, prefix);
    return (row?.m ?? 0) + 1;
  })();
}

// 18/11/2026 (ciclo di bug fixing): `kb next-code`. Lo scope-digester deve dare un codice a ogni bozza («il SEQ lo assegna
// il DB, mai inventato») ma nessun comando glielo dava (MANUAL citava un assign-seq di kb.mjs che non esisteva): i codici
// si inventavano, con il rischio di collidere con un item di kb/ o con un'altra bozza. I prossimi `count` codici liberi:
// oltre il massimo SEQ di items (e di doc_profiles per i DOC), dei file di kb/ non ancora indicizzati (kbDir) e delle
// bozze in <inbox>/<S>/digested/. Non prenota nulla: il codice è occupato quando la bozza è scritta (subito dopo).
const fileSeqs = (dir, prefix) => {
  if (!dir || !existsSync(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir)) if (f.startsWith(prefix)) { const m = /^(\d{4})(?:\.v\d+)?\.ya?ml$/.exec(f.slice(prefix.length)); if (m) out.push(Number(m[1])); }
  return out;
};
export function nextCodes(db, { level, customer, scope, type }, { inbox = null, kbDir = null, count = 1 } = {}) {
  const key = { level, customer, scope, type };
  const prefix = `${level}.${customer}.${scope}.${type}.`;
  const seqs = [assignSeq(db, key) - 1];
  if (type === "DOC") seqs.push(assignSeq(db, key, { table: "doc_profiles" }) - 1);
  if (inbox) seqs.push(...fileSeqs(join(inbox, scope, "digested"), prefix));
  if (kbDir) seqs.push(...fileSeqs(kbDir, prefix));
  const start = Math.max(0, ...seqs) + 1;
  const n = Math.max(1, Math.min(50, Math.trunc(Number(count) || 1)));
  return Array.from({ length: n }, (_, i) => formatCode({ ...key, seq: start + i })).filter((c) => /\.\d{4}$/.test(c));
}
