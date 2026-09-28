// Esiti dei piani nei run (scritti da step-check a piano completato o fermato): runs/<RUN>/result.yaml (K6.8, l'ultimo
// piano del run) e runs/<RUN>/results/<plan_id>.yaml (WP09b, uno per piano: un run di select-suite esegue più casi).
//   runResults(ws, customer, { planIds? }) → [{ run, plan_id, plan_hash, fingerprint, status, completed_at }] (per run e piano, senza doppioni)
//   fingerprint: impronta del caso indipendente dal run (WP09b giro 1), scritta da step-check; null negli esiti precedenti
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";

export function runResults(ws, customer, { planIds = null } = {}) {
  const base = join(ws, "customers", customer, "runs");
  let runs = [];
  try { runs = readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return []; }
  const out = new Map();
  const add = (run, f) => {
    let y;
    try { y = YAML.parse(readFileSync(f, "utf8")); } catch { return; }
    if (!y?.plan_id || (planIds && !planIds.includes(y.plan_id))) return;
    const k = `${run}\u0000${y.plan_id}`;
    if (!out.has(k)) out.set(k, { run, plan_id: y.plan_id, plan_hash: y.plan_hash ?? null, fingerprint: y.fingerprint ?? null, status: String(y.status ?? "").toLowerCase(), completed_at: y.completed_at ?? null });
  };
  for (const r of runs) {
    const rd = join(base, r, "results");
    if (existsSync(rd)) for (const f of readdirSync(rd).filter((x) => x.endsWith(".yaml"))) add(r, join(rd, f));
    const f = join(base, r, "result.yaml");
    if (existsSync(f)) add(r, f);
  }
  return [...out.values()].sort((a, b) => Date.parse(a.completed_at ?? 0) - Date.parse(b.completed_at ?? 0) || a.run.localeCompare(b.run));
}
