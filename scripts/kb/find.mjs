// Le chiavi di faccetta sono interpolate (non parametrizzabili) dentro
// json_extract('$.<chiave>'): senza allowlist un facet key come
// "F10') OR ('1'='1" iniettarebbe SQL arbitrario nella query. Solo F1..F15
// sono faccette valide (§6.1).
const FACET_KEY_RE = /^F(1[0-5]|[1-9])$/;

// Errore utente distinto (input invalido, non un'eccezione di sistema): la
// CLI lo mappa a exit 1 anziché al 2 generico (§44.5).
export class InvalidFacetError extends Error {}

// WP10a giro 1 (minore 1, §56.3): --cluster <CL> — solo i membri ammessi del cluster (cluster_members)
export function find(db, { scope, type, status, level, customer, cluster, facet = {}, top = 10 } = {}) {
  const where = ["status <> 'deprecato'"]; const args = [];
  if (scope) { where.push("scope=?"); args.push(scope); }
  if (type) { where.push("type=?"); args.push(type); }
  if (status) { where.push("status=?"); args.push(status); }
  if (level) { where.push("level=?"); args.push(level); }
  if (customer) { where.push("customer in (?, 'STD')"); args.push(customer); }
  if (cluster) { where.push("code in (select item_code from cluster_members where cluster_code=?)"); args.push(cluster); }
  for (const [k, v] of Object.entries(facet)) {
    if (!FACET_KEY_RE.test(k)) throw new InvalidFacetError(`faccetta non valida: ${k}`);
    where.push(`json_extract(facets, '$.${k}') = ?`); args.push(v);
  }
  return db.prepare(`select code,title,summary,weight,quality,status from items where ${where.join(" and ")} order by weight desc, code limit ?`).all(...args, top);
}
