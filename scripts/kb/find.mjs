export function find(db, { scope, type, status, level, customer, facet = {}, top = 10 } = {}) {
  const where = ["status <> 'deprecato'"]; const args = [];
  if (scope) { where.push("scope=?"); args.push(scope); }
  if (type) { where.push("type=?"); args.push(type); }
  if (status) { where.push("status=?"); args.push(status); }
  if (level) { where.push("level=?"); args.push(level); }
  if (customer) { where.push("customer in (?, 'STD')"); args.push(customer); }
  for (const [k, v] of Object.entries(facet)) { where.push(`json_extract(facets, '$.${k}') = ?`); args.push(v); }
  return db.prepare(`select code,title,summary,weight,quality,status from items where ${where.join(" and ")} order by weight desc, code limit ?`).all(...args, top);
}
