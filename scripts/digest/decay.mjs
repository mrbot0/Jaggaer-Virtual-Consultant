// Digestione settimanale, passo 11 DECADIMENTO (§22, §6.3 freschezza) — WP09d. Item non verificati da 3 release
// (F13.release di 3 o più release prima della corrente, nell'elenco meta 'releases' del DB, dalla più vecchia) e
// cluster vuoti per 2 digestioni (cluster_details.empty_digests, contato da cluster.mjs recordDigest). Solo proposte:
// il decadimento abbassa la freschezza e mette l'item in coda di riverifica, non cancella nulla.
export const DECAY_RELEASES = 3;
export const EMPTY_DIGESTS = 2;

export function releaseAge(release, releases) {
  if (!release || !Array.isArray(releases) || !releases.length) return null;
  const i = releases.indexOf(release);
  if (i < 0) return null;
  return releases.length - 1 - i;
}

// data: output di collectCustomer (all_items, releases, cluster_decay).
export function decayCustomer(data, { releases = data.releases } = {}) {
  const items = [];
  const unknown = [];
  for (const it of data.all_items ?? []) {
    if (!it.release_ref) continue;
    const age = releaseAge(it.release_ref, releases);
    if (age == null) { if (releases?.length) unknown.push(it.code); continue; }
    if (age >= DECAY_RELEASES) items.push({ code: it.code, release: it.release_ref, age_releases: age, verified_at: it.verified_at ?? null });
  }
  const clusters = (data.cluster_decay ?? []).filter((c) => c.empty_digests >= EMPTY_DIGESTS).map((c) => ({ code: c.code, empty_digests: c.empty_digests }));
  return { items, clusters, unknown_release: unknown.length };
}

export function decay(collected) {
  const by = {};
  let items = 0;
  const clusters = new Set();
  for (const [c, d] of Object.entries(collected.customers)) {
    by[c] = decayCustomer(d);
    items += by[c].items.length;
    for (const x of by[c].clusters) clusters.add(x.code);
  }
  return { items, clusters: [...clusters].sort(), by_customer: by };
}
