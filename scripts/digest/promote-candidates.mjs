// Digestione settimanale, passo 6 PROMOZIONE (§22, DT-010) — WP09d. Gruppi universali/condizionati con P ≥ 0.8 →
// candidati S IN ATTESA di approvazione umana. Questo script non promuove mai: la promozione la fa `kb promote <codice>
// --to product --approval <token>` dopo la frase dell'utente `APPROVO PROMOZIONE <codice>` (nella sessione del cliente).
// Un gruppo con un item contraddetto (CTR aperto o affermazione divergente) non è mai candidato.
import { evaluate, loadTable } from "../decide/dt-eval.mjs";

export const qualityClass = (q) => (q == null ? null : q >= 0.85 ? "operativa" : q >= 0.7 ? "affidabile" : q >= 0.5 ? "indicativa" : "da-riverificare");

let DT010 = null;
// groups: gruppi di align con la portabilità calcolata (portability.mjs) in g.portability.
export function promoteCandidates(groups, { openCtr = new Set(), week = "W" } = {}) {
  DT010 ??= loadTable("DT-010");
  const candidates = [];
  const excluded = [];
  let n = 0;
  for (const g of groups) {
    const pt = g.portability;
    if (!pt || pt.observed < 2) continue;
    const contradicted = g.members.filter((m) => openCtr.has(m.code)).map((m) => m.code);
    if (contradicted.length) { excluded.push({ key: g.key, reason: `item contraddetti (CTR aperto): ${contradicted.join(", ")}` }); continue; }
    let p;
    let members = g.members;
    if (pt.class === "universale") p = pt.p;
    else if (pt.class === "condizionata") {
      if (!pt.condition || pt.condition.customers.length < 2) { excluded.push({ key: g.key, reason: "condizionata con meno di 2 clienti nella partizione" }); continue; }
      p = pt.condition.p;
      members = g.members.filter((m) => pt.condition.customers.includes(m.customer));
    } else {
      if (pt.contradicting.length) excluded.push({ key: g.key, reason: `affermazioni divergenti fra clienti (${pt.class}): CTR di prodotto, mai promosso` });
      continue;
    }
    const qs = members.map((m) => m.quality).filter((q) => typeof q === "number");
    const q = qs.length ? Math.min(...qs) : null;
    const dt = evaluate(DT010, { portability_class: pt.class, p_value: Math.max(-2, Math.min(1, p)), quality_class: qualityClass(q), p_ge_08: p >= 0.8, open_product_ctr: false });
    if (dt.outcome !== "candidato") { excluded.push({ key: g.key, reason: `DT-010: ${dt.outcome} (${dt.rule}, P=${p})` }); continue; }
    n++;
    candidates.push({ id: `CAND-${week}-${String(n).padStart(3, "0")}`, key: g.key, type: g.type, scope: g.scope, class: pt.class, condition: pt.condition ?? null, p,
      quality_class: qualityClass(q), dt: { table: "DT-010", outcome: dt.outcome, score: dt.score, rule: dt.rule },
      members: members.map((m) => ({ customer: m.customer, code: m.code })), status: "in-attesa-di-approvazione" });
  }
  return { candidates, excluded };
}
