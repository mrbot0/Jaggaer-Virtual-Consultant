// Digestione settimanale, passi 4-5 PORTABILITÀ e CONTRADDIZIONI (§6.3, §22) — WP09d.
//   P = (clienti_confermanti − 2 × clienti_contraddicenti) / clienti_osservati
//   DT-006: universale (P ≥ 0.80, ≥ 2 clienti, 0 contraddizioni) · condizionata (una faccetta spiega la partizione)
//           · specifica (nessuna faccetta spiega) · ignota (< 2 clienti)
// Confermante = cliente con l'affermazione modale del gruppo; contraddicente = cliente con un'affermazione diversa o
// con un CTR aperto sul suo item. Gruppo divergente ⇒ proposta di CTR di prodotto ⇒ proposta di cluster CL-PRT.
import { evaluate, loadTable } from "../decide/dt-eval.mjs";

// Faccette che possono spiegare una partizione fra clienti, con il cluster di portabilità che la registra.
export const PARTITION_FACETS = Object.freeze([
  { facet: "F7", cluster: "CL-PRT-002", label: "ERP" },
  { facet: "F6", cluster: "CL-PRT-003", label: "modello di procurement" },
  { facet: "F5", cluster: "CL-PRT-004", label: "componente" },
]);
const facetValue = (facets, f) => { const v = facets?.[f]; return Array.isArray(v) ? [...v].sort().join("+") : v ?? null; };

// Per ogni cliente la sua affermazione (la più frequente fra i suoi item del gruppo; a parità la prima in ordine).
function perCustomer(members) {
  const by = new Map();
  for (const m of members) {
    if (!by.has(m.customer)) by.set(m.customer, []);
    by.get(m.customer).push(m);
  }
  return [...by.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([customer, ms]) => {
    const counts = new Map();
    for (const m of ms) counts.set(m.claim, (counts.get(m.claim) ?? 0) + 1);
    const claim = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
    return { customer, claim, facets: ms[0].facets ?? {}, codes: ms.map((m) => m.code) };
  });
}

// La faccetta spiega la partizione se ogni affermazione ha un solo valore della faccetta e i valori sono diversi.
export function explainingFacet(rows) {
  const claims = new Set(rows.map((r) => r.claim));
  if (claims.size < 2) return null;
  for (const pf of PARTITION_FACETS) {
    const valueOf = new Map();
    let ok = true;
    for (const r of rows) {
      const v = facetValue(r.facets, pf.facet);
      if (v == null) { ok = false; break; }
      if (valueOf.has(r.claim) && valueOf.get(r.claim) !== v) { ok = false; break; }
      valueOf.set(r.claim, v);
    }
    if (ok && new Set(valueOf.values()).size === claims.size) return { ...pf, values: Object.fromEntries([...valueOf.entries()]) };
  }
  return null;
}

let DT006 = null;
// openCtr: Set dei codici di item con un CTR aperto (registro contradictions dei clienti).
export function portability(group, { openCtr = new Set() } = {}) {
  DT006 ??= loadTable("DT-006");
  const rows = perCustomer(group.members);
  const observed = rows.length;
  const counts = new Map();
  for (const r of rows) counts.set(r.claim, (counts.get(r.claim) ?? 0) + 1);
  const modal = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
  const flagged = new Set(rows.filter((r) => r.codes.some((c) => openCtr.has(c))).map((r) => r.customer));
  const confirming = rows.filter((r) => r.claim === modal && !flagged.has(r.customer)).map((r) => r.customer);
  const contradicting = rows.filter((r) => r.claim !== modal || flagged.has(r.customer)).map((r) => r.customer);
  const p = observed ? Math.round(((confirming.length - 2 * contradicting.length) / observed) * 1e4) / 1e4 : 0;
  const facet = contradicting.length ? explainingFacet(rows) : null;
  const dt = evaluate(DT006, { p_value: Math.max(-2, Math.min(1, p)), enough_customers: observed >= 2, contradictions: contradicting.length > 0, facet_explains: !!facet });
  const cls = dt.outcome;
  const prt = cls === "universale" ? "CL-PRT-001" : cls === "condizionata" ? facet?.cluster ?? "CL-PRT-004" : cls === "specifica" ? "CL-PRT-005" : "CL-PRT-006";
  const out = { key: group.key, type: group.type, scope: group.scope, observed, confirming, contradicting, p, class: cls, facet: facet ? { facet: facet.facet, label: facet.label, values: facet.values } : null,
    cluster_proposal: prt, dt: { table: "DT-006", outcome: cls, score: dt.score, rule: dt.rule } };
  // condizionata: la P che conta per la promozione è quella DENTRO la partizione dell'affermazione modale (§22 passo 6:
  // "condizionati P ≥ 0.8"): i clienti con lo stesso valore della faccetta condizionante.
  if (cls === "condizionata" && facet) {
    const value = facet.values[modal];
    const part = rows.filter((r) => facetValue(r.facets, facet.facet) === value);
    const conf = part.filter((r) => r.claim === modal && !flagged.has(r.customer)).length;
    const contr = part.length - conf;
    out.condition = { facet: facet.facet, value, customers: part.map((r) => r.customer), p: part.length ? Math.round(((conf - 2 * contr) / part.length) * 1e4) / 1e4 : 0 };
  }
  // §22 passo 5: gruppo divergente fra clienti ⇒ CTR di prodotto ⇒ cluster CL-PRT (condizionata o specifica)
  if (contradicting.length && observed >= 2) out.ctr_proposal = { kind: "CTR-prodotto", key: group.key, customers: rows.map((r) => r.customer), confirming, contradicting,
    facet: out.facet, cluster: prt, note: facet ? `la faccetta ${facet.facet} (${facet.label}) spiega la partizione` : "nessuna faccetta spiega la divergenza: specifica" };
  return out;
}
