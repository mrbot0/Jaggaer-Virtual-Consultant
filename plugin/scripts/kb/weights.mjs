export const freshness = (r) => (r <= 0 ? 1.0 : r === 1 ? 0.9 : r === 2 ? 0.75 : 0.5);
export function confidence({ sourceWeight, freshness: f, confirmations = 0, openContradictions = 0 }) {
  return Math.max(0, Math.min(1, sourceWeight * f * (1 + 0.05 * Math.min(confirmations, 3)) * (1 - 0.3 * openContradictions)));
}
const PORT = { universale: () => 1, condizionata: (o) => (o.condition_met ? 1 : 0.2), specifica: (o) => (o.same_customer ? 1 : 0.1), ignota: () => 0.6 };
const STATUS = { promosso: 1, clusterizzato: 0.95, validato: 0.85, digerito: 0.6, grezzo: 0, quarantena: 0, deprecato: 0 };
export function weight(o) { return +(o.confidence * PORT[o.portability](o) * (STATUS[o.status] ?? 0)).toFixed(4); }
