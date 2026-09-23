export function resolve(db, text, { top = 5 } = {}) {
  const q = text.trim().split(/\s+/).map((w) => `"${w.replace(/"/g, "")}"`).join(" ");
  return db.prepare(`select i.code, i.title, i.summary, i.weight, bm25(items_fts) as rank
    from items_fts join items i on i.code = items_fts.code
    where items_fts match ? and i.status <> 'deprecato'
    order by (-bm25(items_fts)) * (0.5 + i.weight) desc limit ?`).all(q, top);
}
