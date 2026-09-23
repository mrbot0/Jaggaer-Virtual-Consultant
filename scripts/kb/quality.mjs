import { readFileSync } from "node:fs";
import YAML from "yaml";
const DECAY = YAML.parse(readFileSync(new URL("../../schemas/decay.yaml", import.meta.url), "utf8"));
const WEIGHTS = YAML.parse(readFileSync(new URL("../../decision-tables/quality-weights.yaml", import.meta.url), "utf8"));

export function decayValue(ageDays, type) {
  const half = DECAY[type] ?? DECAY.default;
  return Math.max(0.2, Math.pow(0.5, ageDays / half));
}
const rel = (d) => (d <= 0 ? 1 : d === 1 ? 0.9 : d === 2 ? 0.75 : 0.5);
const corr = (n) => (n <= 0 ? 0.5 : n === 1 ? 0.8 : n === 2 ? 0.95 : 1);
const ctr = (n) => (n <= 0 ? 1 : n === 1 ? 0.6 : 0.3);

export function quality(p, decisionKind = "generic", type = "default") {
  const w = WEIGHTS[decisionKind] ?? WEIGHTS.generic;
  const v = { Q1: decayValue(p.ageDays, type), Q2: rel(p.releaseDistance), Q3: p.authority, Q4: 1, Q5: p.docStatus, Q6: corr(p.corroboration),
    Q7: ctr(p.openContradictions), Q8: p.specificity, Q9: p.completeness, Q10: p.verifiability, Q11: p.verificationMethod,
    Q12: decayValue(p.lastVerifiedDays, type), Q13: p.applicability, Q14: p.stability };
  const sum = Object.entries(w).reduce((a, [k, wk]) => a + wk * v[k], 0);
  const Q = Math.max(0, Math.min(1, sum * (p.unitQuality ?? 1) * (p.envFactor ?? 1)));
  const cls = Q >= 0.85 ? "operativa" : Q >= 0.7 ? "affidabile" : Q >= 0.5 ? "indicativa" : "da-riverificare";
  return { Q: +Q.toFixed(4), class: cls };
}
