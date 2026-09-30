// Il report di ingestion per documento (§19.15), sul modello templates/ingestion-report.md.
//
//   accountUnits(units, rawItems) → { buckets: Map<unit, extracted|context|residue>, extracted, context, residue: [{ unit, class, reason }] }
//     ogni unità sta in UN solo secchio: residuo (dall'estrazione — regola ambigua, tacita — o da classifyUnit —
//     indice, disclaimer…), estratta (ha prodotto un item grezzo) o contesto (resta fonte per la digestione guidata).
//     Invariante: unità = fonti (estratte + contesto) + residuo.
//   buildReport({ profile, units, extraction, backcheck?, dt021?, epistemic?, contradictions?, date, overflow? })
//     overflow: righe di tabelle-dataset fuori campione (non sono unità: riportate a parte, fuori dall'invariante) → dati del report
//   renderReport(data, template?) → testo con il layout di §19.15
//   writeReport(inboxScopeDir, data) → _inbox/<scope>/reports/<DOCID>.md (+ .yaml con i dati)
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { classifyUnit, RESIDUE_CLASSES } from "./residue.mjs";
import { docIdToken } from "./segment.mjs";

const TEMPLATE = readFileSync(new URL("../../templates/ingestion-report.md", import.meta.url), "utf8");
const TOKENS_PER_MINUTE = 2500;   // stima del ritmo di lettura + scrittura di un agente T1 (solo per l'ordine di grandezza)

export function accountUnits(units, rawItems = []) {
  const byUnit = new Map();
  for (const r of rawItems) if (r.source_unit && r.unit_type) byUnit.set(r.source_unit, r);
  const buckets = new Map();
  const residue = [];
  let extracted = 0, context = 0;
  for (const u of units) {
    const r = byUnit.get(u.id);
    const cls = r?.residue ?? classifyUnit({ ...u, extraction: r?.extraction });
    if (cls) { buckets.set(u.id, "residue"); residue.push({ unit: u.id, class: cls.class, reason: cls.reason }); continue; }
    if (r) { buckets.set(u.id, "extracted"); extracted++; } else { buckets.set(u.id, "context"); context++; }
  }
  return { buckets, extracted, context, residue };
}

const byClass = (list) => Object.fromEntries(RESIDUE_CLASSES.map((c) => [c, list.filter((x) => x.class === c).length]));

export function buildReport({ profile, units, extraction, backcheck = null, dt021 = null, epistemic = null, contradictions = 0, date = new Date().toISOString().slice(0, 10), overflow = [] }) {
  const items = (extraction?.items ?? []).filter((r) => !r.residue);
  const acc = accountUnits(units, extraction?.items ?? []);
  const residue = acc.residue;
  const byCand = {};
  for (const r of items) { const k = r.candidates?.[0] ?? "?"; byCand[k] = (byCand[k] ?? 0) + 1; }
  const plan = extraction?.llm_plan ?? { estimated_tokens: 0, sessions: [] };
  const t1 = items.filter((r) => r.needs_llm).length;
  const handled = units.length || 1;
  const t0 = Math.max(0, handled - t1);
  const pct = (x) => Math.round((x / handled) * 100);
  const ambiguous = residue.filter((r) => r.class === "ambiguous").length;
  const gapsFreq = {};
  for (const r of items) for (const m of r.missing ?? []) if (!m.startsWith("schema:")) gapsFreq[m] = (gapsFreq[m] ?? 0) + 1;
  const topGaps = Object.entries(gapsFreq).sort((a, b) => b[1] - a[1]).slice(0, 4);
  return {
    doc: profile?.id ?? units[0]?.doc ?? "?", title: profile?.title ?? profile?.source?.path ?? "", date,
    units: units.length, items: items.length, items_by_candidate: byCand, extracted_units: acc.extracted, context: acc.context,
    residue: byClass(residue), residue_total: residue.length, residue_detail: residue,
    sourced: acc.extracted + acc.context,
    overflow_rows: overflow.reduce((a, o) => a + ((o.rows_total ?? 0) - (o.rows_sampled ?? 0)), 0),
    backcheck, dt021, epistemic, contradictions,
    gaps: topGaps.map(([g, n]) => ({ attribute: g, items: n, of: items.length })),
    cost: { t0: pct(t0), t1: pct(t1), t2: 0, tokens: plan.estimated_tokens, minutes: Math.ceil(plan.estimated_tokens / TOKENS_PER_MINUTE), sessions: plan.sessions.length },
    todo: { ambiguous_units: ambiguous, review_minutes: Math.ceil(ambiguous * 1.4), llm_items: t1, questions: dt021?.ambiguo ?? 0, ctr: contradictions },
  };
}

const fmtMap = (m) => Object.entries(m).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(" · ") || "nessuno";
export function renderReport(d, template = TEMPLATE) {
  const v = {
    doc: d.doc, title: d.title, date: d.date, units: d.units, items: d.items, items_by_candidate: fmtMap(d.items_by_candidate), context: d.context,
    residue_total: d.residue_total, overflow_rows: d.overflow_rows ?? 0, backcheck: d.backcheck ? `${d.backcheck.first_pass}/${d.backcheck.total} al primo passaggio; ${d.backcheck.derived ?? 0} rifatti come \`derived\`` : "non ancora eseguito (dopo la digestione)",
    dt021: d.dt021 ? `${d.dt021.C ?? 0} C · ${d.dt021.S ?? 0} S (conferme) · ${d.dt021.ambiguo ?? 0} ambigui → ${d.dt021.ambiguo ?? 0} domande all'utente` : "non ancora valutata (digestione)",
    epistemic: d.epistemic ? fmtMap(d.epistemic) : "non ancora prodotta (reindex dopo la digestione)",
    gaps: d.gaps.length ? d.gaps.map((g) => `${g.attribute} (${g.items}/${g.of})`).join(", ") : "nessuno",
    contradictions: d.contradictions,
    todo: `${d.todo.ambiguous_units} unità ambigue in revisione (stimati ${d.todo.review_minutes} min umani) · ${d.todo.llm_items} item grezzi allo scope-extractor · ${d.todo.questions} domande · ${d.todo.ctr} CTR`,
  };
  for (const c of RESIDUE_CLASSES) v[`residue.${c}`] = d.residue[c];
  for (const [k, x] of Object.entries(d.cost)) v[`cost.${k}`] = x;
  return template.replace(/\{\{([\w.]+)\}\}/g, (_, k) => (v[k] === undefined ? "" : String(v[k])));
}

export function writeReport(inboxScopeDir, d) {
  const dir = join(inboxScopeDir, "reports");
  mkdirSync(dir, { recursive: true });
  const base = join(dir, docIdToken(d.doc));
  writeFileSync(`${base}.md`, renderReport(d));
  const { residue_detail, ...rest } = d;
  writeFileSync(`${base}.yaml`, YAML.stringify({ ...rest, residue_units: residue_detail.length }, { lineWidth: 0 }));
  return `${base}.md`;
}
