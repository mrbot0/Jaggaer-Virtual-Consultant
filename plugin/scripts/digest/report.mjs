// Competence report (§22.1) — WP09d. Stesso impianto della spec: promozioni in attesa, contraddizioni fra clienti,
// nuovi cluster, decadimenti, copertura epistemica per scope, DECISIONI (esiti verificati, smentite, strategie con
// smentite, sorprese per compito, compiti fermati, proposte di calibrazione), check in memoria, economia.
// Tutto ciò che nomina un cliente arriva qui già pseudonimizzato (token): il report vive in product/.
import { REGISTRY } from "../kb/codes.mjs";

const SHAPES = ["consolidato", "libresco", "empirico", "ignoto", "contraddittorio"];
const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0);
const pad = (s, n) => String(s).padEnd(n);
const VERIFIED = new Set(["confermata", "smentita", "parziale"]);

export function decisionsBlock(decs) {
  const n = decs.length;
  const verified = decs.filter((d) => VERIFIED.has(d.result));
  const disproved = verified.reduce((a, d) => a + (d.result === "smentita" ? 1 : d.result === "parziale" ? 0.5 : 0), 0);
  const byStrategy = new Map();
  for (const d of decs) {
    if (!d.strategy) continue;
    const s = byStrategy.get(d.strategy) ?? { n: 0, verified: 0, disproved: 0 };
    s.n++;
    if (VERIFIED.has(d.result)) { s.verified++; s.disproved += d.result === "smentita" ? 1 : d.result === "parziale" ? 0.5 : 0; }
    byStrategy.set(d.strategy, s);
  }
  const strategies = [...byStrategy.entries()].sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0]))
    .map(([code, s]) => ({ code, share: pct(s.n, n), disproved: pct(s.disproved, s.verified) }));
  return { n, verified_pct: pct(verified.length, n), disproved_pct: pct(disproved, verified.length), strategies };
}

export function coverageBlock(epistemic) {
  const by = new Map();
  for (const e of epistemic) {
    const scope = String(e.subject_code ?? "").split(".")[2];
    if (!scope) continue;
    const s = by.get(scope) ?? Object.fromEntries(SHAPES.map((x) => [x, 0]));
    if (e.shape in s) s[e.shape]++;
    by.set(scope, s);
  }
  return [...by.entries()].sort(([a], [b]) => REGISTRY.scopes.indexOf(a) - REGISTRY.scopes.indexOf(b)).map(([scope, s]) => {
    const tot = SHAPES.reduce((a, k) => a + s[k], 0);
    return { scope, total: tot, ...Object.fromEntries(SHAPES.map((k) => [k, pct(s[k], tot)])), suggest_observations: s.ignoto, suggest_questions: s.contraddittorio };
  });
}

// input: { week, candidates, ctr, clusters_new, decay, epistemic, decisions, previous_disproved_pct, sessions, calibration, checks, economy, token }
export function buildReport(input) {
  const dec = decisionsBlock(input.decisions ?? []);
  const sessions = input.sessions ?? [];
  const tasks = sessions.reduce((a, s) => a + (s.tasks ?? 1), 0);
  const surprises = sessions.reduce((a, s) => a + (s.surprises ?? 0), 0);
  const stopped = sessions.reduce((a, s) => a + (s.stopped ?? 0), 0);
  const tokens = sessions.reduce((a, s) => a + (s.tokens ?? 0), 0);
  const byModel = {};
  for (const s of sessions) for (const [k, v] of Object.entries(s.by_model ?? {})) byModel[k] = (byModel[k] ?? 0) + (Number(v) || 0);
  return {
    week: input.week,
    promotions_pending: input.candidates ?? [],
    contradictions: input.ctr ?? [],
    new_clusters: input.clusters_new ?? [],
    decay: input.decay ?? { items: 0, clusters: [] },
    coverage: coverageBlock(input.epistemic ?? []),
    decisions: { ...dec, previous_disproved_pct: input.previous_disproved_pct ?? null, surprises_per_task: tasks ? Math.round((surprises / tasks) * 100) / 100 : 0,
      stopped_tasks: stopped, calibration: input.calibration ?? [] },
    checks: input.checks ?? { total: 0, new: 0 },
    economy: { tokens, by_model: byModel },
  };
}

export function renderReport(r) {
  const [y, w] = String(r.week).split("-W");
  const L = [];
  L.push(`COMPETENCE REPORT — settimana ${Number(w)}/${y}`, "");
  const ex = (list, f) => (list.length ? `   es. ${f(list[0])}` : "");
  L.push(`${pad("PROMOZIONI A S (in attesa)", 47)}${r.promotions_pending.length}${ex(r.promotions_pending, (c) => `${c.key} ${c.class} — ${c.customers.join(", ")}`)}`);
  L.push(`${pad("CONTRADDIZIONI FRA CLIENTI", 47)}${r.contradictions.length}${ex(r.contradictions, (c) => `${c.key}: ${c.facet ? `${c.facet.facet} ${c.facet.label}` : "nessuna faccetta"} → ${c.cluster}`)}`);
  L.push(`${pad("NUOVI CLUSTER (proposte)", 47)}${r.new_clusters.length}`);
  L.push(`${pad("DECADIMENTI", 47)}${r.decay.items} item, ${r.decay.clusters.length} cluster`, "");
  L.push("COPERTURA EPISTEMICA (tutti i clienti, per scope)");
  if (!r.coverage.length) L.push("  (nessun profilo epistemico)");
  for (const c of r.coverage) {
    const hint = [c.suggest_observations ? `${c.suggest_observations} osservazioni R0 suggerite` : null, c.suggest_questions ? `${c.suggest_questions} domande di apprendimento suggerite` : null].filter(Boolean).join(" · ");
    L.push(`  ${pad(c.scope, 4)} consolidato ${c.consolidato}%  libresco ${c.libresco}%  empirico ${c.empirico}%  ignoto ${c.ignoto}%  contradd. ${c.contraddittorio}%${hint ? `   → ${hint}` : ""}`);
  }
  L.push("", "DECISIONI");
  const d = r.decisions;
  L.push(`  DEC con esito verificato: ${d.verified_pct}% · smentite: ${d.disproved_pct}%${d.previous_disproved_pct != null ? ` (settimana precedente ${d.previous_disproved_pct}%)` : ""} · DEC della settimana: ${d.n}`);
  L.push(`  strategie: ${d.strategies.length ? d.strategies.map((s) => `${s.code} ${s.share}% (smentite ${s.disproved}%)`).join(" · ") : "—"}`);
  L.push(`  sorprese per compito: ${d.surprises_per_task} · compiti fermati per 3 sorprese: ${d.stopped_tasks}`);
  for (const c of d.calibration) L.push(`  proposta di calibrazione: ${c.table} bordo ${c.change.from} → ${c.change.to} (${c.supporting_decs.length} DEC a supporto${c.customer ? `, ${c.customer}` : ""})`);
  if (!d.calibration.length) L.push("  proposta di calibrazione: nessuna (servono ≥ 10 DEC con esito verificato per tabella)");
  L.push("", `${pad("CHECK IN MEMORIA", 47)}${r.checks.total} (+${r.checks.new})`, "");
  L.push("ECONOMIA");
  const models = Object.entries(r.economy.by_model).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(" · ");
  L.push(`  token: ${r.economy.tokens}${models ? ` · per modello: ${models}` : ""}`);
  return L.join("\n") + "\n";
}
