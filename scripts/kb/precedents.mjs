// Precedenti (§12.3): le decisioni passate con esito, ordinate per distanza di contesto.
//
//   distanza = 0.35 × [stesso soggetto 0 : stesso cluster 0.5 : 1]
//            + 0.25 × Hamming(F5, F6, F7, F10) / 4
//            + 0.20 × [stesso cliente 0 : 1 − portabilità del soggetto]
//            + 0.10 × min(1, età in release / 3)
//            + 0.10 × [stessa forma epistemica al momento 0 : 1]
//
// La portabilità numerica è il moltiplicatore di §6.3 per un altro cliente: universale 1.00 ·
// condizionata soddisfatta 1.00 / non soddisfatta 0.20 · specifica 0.10 · ignota 0.60.
// "condizionata(Fn)" è soddisfatta se la faccetta Fn ha lo stesso valore sui due soggetti (§11.6).
// Valori ignoti pesano come diversi (età ignota = 3 release, forma ignota = diversa): stessa
// prudenza della null_policy `worst` di DT-018.
//
// Ordinamento: distanza crescente; a parità (Δd ≤ 0.05 dal primo del gruppo) le smentite prima,
// perché "l'agente legge le note delle smentite per prime" (§12.3). Esclusi i DEC senza esito e
// quelli `non-verificabile` (§12.1: esclusi dai tassi, non dicono nulla).
import { parseCode } from "./codes.mjs";

export const WEIGHTS = { subject: 0.35, facets: 0.25, customer: 0.20, age: 0.10, shape: 0.10 };
export const HAMMING_FACETS = ["F5", "F6", "F7", "F10"];
export const TIE_DELTA = 0.05;
const round6 = (x) => Math.round(x * 1e6) / 1e6;

const canon = (v) => (Array.isArray(v) ? JSON.stringify([...v].map(String).sort()) : v === undefined || v === null ? null : JSON.stringify(String(v)));

export function portabilityValue(p, facetsA = {}, facetsB = {}) {
  if (typeof p !== "string" || !p) return 0.6;
  if (p === "universale") return 1;
  if (p === "specifica") return 0.1;
  if (p === "ignota") return 0.6;
  const m = /^condizionata(?:\((F(?:1[0-5]|[1-9]))\))?/.exec(p);
  if (m) {
    const f = m[1];
    if (!f) return 0.2;                                     // condizione non verificabile → non soddisfatta
    const a = canon(facetsA?.[f]);
    return a !== null && a === canon(facetsB?.[f]) ? 1 : 0.2;
  }
  return 0.6;
}

function hamming(fa = {}, fb = {}) {
  let diff = 0;
  for (const f of HAMMING_FACETS) {
    const a = canon(fa?.[f]);
    const b = canon(fb?.[f]);
    if (a !== b) diff++;                                     // un valore presente e uno assente contano come diversi
  }
  return diff / HAMMING_FACETS.length;
}

// Componenti della distanza fra il contesto attuale `a` e il contesto di un precedente `b`.
// a, b: { subject, clusters[], facets{}, customer, shape }; b porta anche age_releases e portability.
export function distanceComponents(a, b) {
  const clustersA = new Set(a.clusters ?? []);
  const sameSubject = !!a.subject && a.subject === b.subject;
  const sameCluster = (b.clusters ?? []).some((c) => clustersA.has(c));
  const subject = sameSubject ? 0 : sameCluster ? 0.5 : 1;
  const facets = hamming(a.facets, b.facets);
  const sameCustomer = !!a.customer && a.customer === b.customer;
  const customer = sameCustomer ? 0 : 1 - portabilityValue(b.portability, a.facets, b.facets);
  const age = typeof b.age_releases === "number" && Number.isFinite(b.age_releases) ? Math.min(1, Math.max(0, b.age_releases) / 3) : 1;
  const shape = a.shape && b.shape && a.shape === b.shape ? 0 : 1;
  return { subject, facets, customer, age, shape, same_subject: sameSubject, same_cluster: sameCluster };
}

export function distance(a, b) {
  const c = distanceComponents(a, b);
  return round6(WEIGHTS.subject * c.subject + WEIGHTS.facets * c.facets + WEIGHTS.customer * c.customer + WEIGHTS.age * c.age + WEIGHTS.shape * c.shape);
}

const parseJson = (s, dflt) => { try { const v = JSON.parse(s); return v ?? dflt; } catch { return dflt; } };
const customerOf = (code) => { const p = code ? parseCode(code) : null; return p && p.customer !== "STD" ? p.customer : null; };

// Release ordinate (dalla più vecchia): context.releases, altrimenti meta 'releases' (JSON).
// Una voce è un nome o { name, date }. La release attuale è context.release o l'ultima.
function releaseIndex(db, context) {
  let list = context.releases;
  if (!Array.isArray(list)) {
    const row = db.prepare("select value from meta where key='releases'").get();
    list = row ? parseJson(row.value, []) : [];
  }
  const entries = list.map((r) => (typeof r === "string" ? { name: r } : r)).filter((r) => r && r.name);
  const idx = new Map(entries.map((r, i) => [r.name, i]));
  const current = context.release ?? entries.at(-1)?.name ?? null;
  const cur = current !== null && idx.has(current) ? idx.get(current) : null;
  const byDate = (at) => {
    if (!at) return null;
    let found = null;
    entries.forEach((r, i) => { if (r.date && String(r.date) <= String(at)) found = i; });
    return found;
  };
  return (releaseRef, at) => {
    if (cur === null) return null;
    const i = releaseRef && idx.has(releaseRef) ? idx.get(releaseRef) : byDate(at);
    return i === null || i === undefined ? null : Math.max(0, cur - i);
  };
}

export function precedents(db, subject, { top = 5, customer, context = {} } = {}) {
  const itemStmt = db.prepare("select facets from items where code=?");
  const clusterStmt = db.prepare("select cluster_code from cluster_members where item_code=?");
  const itemCache = new Map();
  const facetsOf = (code) => {
    if (!code) return {};
    if (!itemCache.has(code)) itemCache.set(code, parseJson(itemStmt.get(code)?.facets, {}));
    return itemCache.get(code);
  };
  const clustersOf = (code) => (code ? clusterStmt.all(code).map((r) => r.cluster_code) : []);

  const subjFacets = { ...facetsOf(subject), ...(context.facets ?? {}) };
  const ctxClusters = [context.cluster, ...(context.clusters ?? [])].filter(Boolean);
  const shapeRow = db.prepare("select shape from epistemic where subject_code=?").get(subject);
  const a = {
    subject,
    clusters: [...new Set([...clustersOf(subject), ...ctxClusters])],
    facets: subjFacets,
    customer: customer ?? context.customer ?? customerOf(subject),
    shape: context.shape ?? shapeRow?.shape ?? null,
  };
  const ageOf = releaseIndex(db, context);

  const rows = db.prepare(`select d.code, d.table_code, d.subject_code, d.subject_cluster, d.inputs, d.outcome, d.at,
      o.result, o.note, c.release_ref, c.shape as ctx_shape, c.facets as ctx_facets
    from decisions d join outcomes o on o.decision_code = d.code
    left join decision_context c on c.decision_code = d.code
    where o.result in ('confermata','smentita','parziale')`).all();

  const scored = rows.map((r) => {
    const pFacets = r.ctx_facets ? parseJson(r.ctx_facets, {}) : facetsOf(r.subject_code);
    const b = {
      subject: r.subject_code,
      clusters: [...new Set([...clustersOf(r.subject_code), r.subject_cluster].filter(Boolean))],
      facets: pFacets,
      customer: customerOf(r.code),
      shape: r.ctx_shape ?? parseJson(r.inputs, {}).shape ?? null,
      age_releases: ageOf(r.release_ref, r.at),
      portability: facetsOf(r.subject_code).F8 ?? subjFacets.F8,
    };
    const comp = distanceComponents(a, b);
    return {
      dec: r.code, d: distance(a, b), table: r.table_code, outcome: r.outcome, result: r.result, at: r.at,
      note: r.note ?? null, same_subject: comp.same_subject, same_cluster: comp.same_cluster, customer: b.customer,
    };
  });
  return orderWithTies(scored).slice(0, Math.max(0, Number(top) || 0));
}

// Gruppi di distanza (ogni elemento entro TIE_DELTA dal primo del gruppo); dentro il gruppo le
// smentite prima, poi distanza e codice. Deterministico: nessun confronto non transitivo.
export function orderWithTies(rows) {
  const sorted = [...rows].sort((x, y) => x.d - y.d || x.dec.localeCompare(y.dec));
  const out = [];
  let group = [];
  const flush = () => {
    group.sort((x, y) => (x.result === "smentita" ? 0 : 1) - (y.result === "smentita" ? 0 : 1) || x.d - y.d || x.dec.localeCompare(y.dec));
    out.push(...group);
    group = [];
  };
  for (const r of sorted) {
    if (group.length && r.d - group[0].d > TIE_DELTA + 1e-9) flush();
    group.push(r);
  }
  flush();
  return out;
}
