import { ftsQuery } from "./units.mjs";

// 18/11/2026 (ciclo di bug fixing): `kb resolve` riceve la domanda dell'utente in testo libero (--text-file), ma cercava
// TUTTE le parole insieme (AND FTS5, comprese "come", "un", "?"): su AVVA (12759 item) «come creo un contratto?» dava 0
// risultati. Prima la ricerca stretta (tutte le parole: stesso esito di prima quando trova qualcosa), poi, se vuota, le
// parole significative in OR (parole vuote tolte, prefisso per le lunghe, come `kb units`), ordinate per bm25 × peso.
const SQL = `select i.code, i.title, i.summary, i.weight, bm25(items_fts) as rank
    from items_fts join items i on i.code = items_fts.code
    where items_fts match ? and i.status <> 'deprecato'
    order by (-bm25(items_fts)) * (0.5 + i.weight) desc limit ?`;

export function resolve(db, text, { top = 5 } = {}) {
  const words = String(text ?? "").trim().split(/\s+/).map((w) => w.replace(/"/g, "")).filter((w) => /[\p{L}\p{N}]/u.test(w));
  if (!words.length) return [];
  const strict = db.prepare(SQL).all(words.map((w) => `"${w}"`).join(" "), top);
  if (strict.length) return strict;
  const loose = ftsQuery(text);
  return loose ? db.prepare(SQL).all(loose, top) : [];
}
