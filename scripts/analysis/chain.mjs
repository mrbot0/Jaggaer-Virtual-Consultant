// Catena causale a 4 livelli (§1.1, F8) — WP09d: sintomo → causa immediata → causa radice → risoluzione, dai campi
// dei ticket di un gruppo. Per ogni livello il valore più frequente (normalizzato) con la quota di ticket che lo
// porta; un livello senza valori resta null (ignoto) con il numero di ticket mancanti. Confidenza = la quota minima fra
// i livelli noti (una catena è forte quanto il suo anello più debole).
const LEVELS = [["symptom", (t) => t.summary ?? t.description], ["immediate_cause", (t) => t.immediate_cause], ["root_cause", (t) => t.root_cause], ["resolution", (t) => t.resolution]];
const key = (s) => String(s).normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").replace(/[.;:!]+$/, "").trim();
const r2 = (x) => Math.round(x * 100) / 100;

export function chain(tickets) {
  const n = tickets.length;
  const out = {};
  const shares = [];
  for (const [level, get] of LEVELS) {
    const counts = new Map();
    const first = new Map();
    let missing = 0;
    for (const t of tickets) {
      const v = get(t);
      if (v == null || String(v).trim() === "") { missing++; continue; }
      const k = key(v);
      counts.set(k, (counts.get(k) ?? 0) + 1);
      if (!first.has(k)) first.set(k, String(v).trim());
    }
    const best = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    if (!best) { out[level] = { value: null, share: 0, missing }; continue; }
    const share = n ? r2(best[1] / n) : 0;
    out[level] = { value: first.get(best[0]), share, missing };
    shares.push(share);
  }
  out.confidence = shares.length ? Math.min(...shares) : 0;
  return out;
}
