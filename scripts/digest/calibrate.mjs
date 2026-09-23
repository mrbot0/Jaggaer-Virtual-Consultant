// Calibrazione delle tabelle (§12.5) e della confidenza dichiarata (§17.4). Le tabelle imparano dagli
// esiti, ma non da sole: questo script PROPONE, un umano approva. Mai una tabella sovrascritta.
//
// Soglie (§12.5): per ogni DT, le DEC con esito verificato (confermata · smentita · parziale = ½);
// sotto 10 DEC nessuna proposta (§31 rischi: "Calibrazione solo con ≥ 10 DEC"). Grid search sullo
// spostamento di ciascun bordo di banda interno (±0.10, passo 0.01): per ogni candidato si rivaluta
// ogni DEC con i suoi input e priori registrati e si conta
//   smentite_after   = smentite il cui esito non cambia + confermate spostate su un altro esito decisivo
//                      (una smentita il cui esito cambia è evitata; una confermata spostata è un rischio)
//   unnecessary_asks = confermate spostate su "chiedi" (domande in più all'utente senza bisogno)
// e si sceglie il minimo di smentite_after con unnecessary_asks ≤ tolleranza (default max(1, 10% di n)),
// a parità meno domande, poi lo spostamento più piccolo. Proposta solo se riduce le smentite.
// Scrive decision-tables/proposals/DT-0nn.v<N+1>.proposal.yaml; se esiste già non la tocca.
//
// Confidenza (§17.4): Brier e sovraconfidenza per (agente, DT, mese) dalle DEC con confidenza
// dichiarata (decision_context.confidence); gli effetti della tabella di §17.4 sono elencati, non applicati.
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { evaluate, loadTable, validateTable, TABLES_DIR } from "../decide/dt-eval.mjs";
import { openDb } from "../kb/db.mjs";
import { agentName } from "./outcomes.mjs";
import { isMain } from "../lib/is-main.mjs";
import { parseArgs, fail } from "../lib/args.mjs";

export const MIN_DECS = 10;
export const GRID = { max: 0.10, step: 0.01 };
export const DEFAULT_OUT_DIR = join(TABLES_DIR, "proposals");
const WEIGHT = { smentita: 1, parziale: 0.5, confermata: 0 };
const Y = { confermata: 1, parziale: 0.5, smentita: 0 };
const round6 = (x) => Math.round(x * 1e6) / 1e6;
const parse = (s, d) => { try { return JSON.parse(s) ?? d; } catch { return d; } };

function verifiedDecs(db, table, { customer, shape, cluster } = {}) {
  const where = ["d.table_code = ?", "o.result in ('confermata','smentita','parziale')"];
  const args = [table];
  if (customer) { where.push("d.code like ?"); args.push(`L.${customer}.%`); }
  if (shape) { where.push("json_extract(d.inputs, '$.shape') = ?"); args.push(shape); }
  if (cluster) { where.push("d.subject_cluster = ?"); args.push(cluster); }
  return db.prepare(`select d.code, d.inputs, d.priors, d.outcome, d.agent, d.at, o.result, c.confidence
    from decisions d join outcomes o on o.decision_code = d.code left join decision_context c on c.decision_code = d.code
    where ${where.join(" and ")} order by d.code`).all(...args);
}

function shifted(table, boundary, to) {
  const t = structuredClone(table);
  const move = (x) => (x === boundary ? to : x);
  t.thresholds = t.thresholds.map((b) => ({ ...b, from: move(b.from), to: move(b.to) }));
  if (t.outcome_selectors) t.outcome_selectors = t.outcome_selectors.map((s) => ({ ...s, from: move(s.from), to: move(s.to) }));
  t.version = (table.version ?? 1) + 1;
  return t;
}

const lexLess = (a, b) => { const i = a.findIndex((v, j) => v !== b[j]); return i >= 0 && a[i] < b[i]; };

function score(rows, outcomes, ask) {
  let smentite = 0; let unnecessary = 0; let added = 0;
  const changed = [];
  rows.forEach((r, i) => {
    const now = outcomes[i];
    if (now === r.outcome) { smentite += WEIGHT[r.result]; return; }
    changed.push(r.code);
    const becameAsk = ask.has(now) && !ask.has(r.outcome);
    if (becameAsk) { added++; if (r.result === "confermata") unnecessary++; }
    if (r.result === "confermata" && !ask.has(now)) smentite += 1;
  });
  return { smentite_after: round6(smentite), unnecessary_asks: unnecessary, added_asks: added, changed };
}

export function proposeFor(db, tableCode, { filters = {}, tolerance, askOutcomes = ["chiedi"], minDecs = MIN_DECS } = {}) {
  const table = loadTable(tableCode);
  const raw = verifiedDecs(db, tableCode, filters);
  const rows = [];
  for (const r of raw) {
    const inputs = parse(r.inputs, {});
    const priors = Object.fromEntries(parse(r.priors, []).filter((p) => p && p.name).map((p) => [p.name, p.value]));
    try { evaluate(table, inputs, { priors }); rows.push({ ...r, inputs, priors }); } catch { /* input di una versione precedente fuori dominio: esclusa */ }
  }
  const n = rows.length;
  if (n < minDecs) return { skipped: { table: tableCode, n, reason: `< ${minDecs} DEC con esito verificato` } };
  const ask = new Set(askOutcomes);
  const tol = tolerance ?? Math.max(1, Math.ceil(0.10 * n));
  const before = round6(rows.reduce((a, r) => a + WEIGHT[r.result], 0));
  const edges = [...new Set(table.thresholds.flatMap((b) => [b.from, b.to]).filter((e) => e > 0 && e < 1))].sort((a, b) => a - b);
  const steps = Math.round(GRID.max / GRID.step);
  let best = null;
  for (const b of edges) {
    for (let k = -steps; k <= steps; k++) {
      if (k === 0) continue;
      const delta = round6(k * GRID.step);
      const to = round6(b + delta);
      if (to <= 0 || to >= 1) continue;
      const cand = shifted(table, b, to);
      if (!validateTable(cand).ok) continue;
      const outs = rows.map((r) => evaluate(cand, r.inputs, { priors: r.priors }).outcome);
      const s = score(rows, outs, ask);
      if (s.unnecessary_asks > tol || s.smentite_after >= before) continue;
      const key = [s.smentite_after, s.unnecessary_asks, Math.abs(delta), b, delta];
      if (!best || lexLess(key, best.key)) best = { key, boundary: b, to, delta, ...s };
    }
  }
  if (!best) return { skipped: { table: tableCode, n, reason: `nessuna soglia riduce le smentite (${before}) entro la tolleranza di ${tol} domande in più su DEC confermate` } };
  return {
    proposal: {
      table: tableCode, from_version: table.version, to_version: table.version + 1,
      change: { boundary: best.boundary, from: best.boundary, to: best.to, delta: round6(best.delta) },
      supporting_decs: best.changed, smentite_before: before, smentite_after: best.smentite_after,
      unnecessary_asks: best.unnecessary_asks, added_asks: best.added_asks, n, tolerance: tol,
      filters: Object.fromEntries(Object.entries(filters).filter(([, v]) => v)),
    },
  };
}

export function confidenceCalibration(db, { table, customer } = {}) {
  const where = ["o.result in ('confermata','smentita','parziale')", "c.confidence is not null"];
  const args = [];
  if (table) { where.push("d.table_code = ?"); args.push(table); }
  if (customer) { where.push("d.code like ?"); args.push(`L.${customer}.%`); }
  const rows = db.prepare(`select d.agent, d.table_code, d.at, o.result, c.confidence from decisions d
    join outcomes o on o.decision_code = d.code join decision_context c on c.decision_code = d.code where ${where.join(" and ")}`).all(...args);
  const groups = new Map();
  for (const r of rows) {
    const key = JSON.stringify([agentName(r.agent) || "?", r.table_code, String(r.at ?? "").slice(0, 7) || "?"]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, rs]) => {
    const [agent, dt, month] = JSON.parse(key);
    const n = rs.length;
    const meanC = rs.reduce((a, r) => a + r.confidence, 0) / n;
    const rate = rs.reduce((a, r) => a + Y[r.result], 0) / n;
    const brier = round6(rs.reduce((a, r) => a + (r.confidence - Y[r.result]) ** 2, 0) / n);
    const over = round6(meanC - rate);
    const effects = [];
    if (over > 0.10) effects.push(`sovraconfidenza ${over} > 0.10: la soglia decide_if_confidence di ${dt} sale per ${agent}; le sue domande all'utente aumentano finché non si ricalibra`);
    if (over < -0.10) effects.push(`sottoconfidenza ${-over} > 0.10: la soglia decide_if_confidence di ${dt} scende per ${agent}; chiede meno`);
    if (brier > 0.25) effects.push(`Brier ${brier} > 0.25 (peggio del caso): ${agent} non emette più confidence su ${dt} e deve escalare; il compito va rivisto`);
    if (brier < 0.10) effects.push(`Brier ${brier} < 0.10: la confidenza di ${agent} entra nel prior di DT-002 con peso pieno`);
    return { agent, table: dt, month, n, mean_confidence: round6(meanC), confirm_rate: round6(rate), brier, overconfidence: over, effects, applied: false };
  });
}

export function calibrate(db, { table, customer, shape, cluster, outDir = DEFAULT_OUT_DIR, tolerance, askOutcomes, at = new Date().toISOString(), filters } = {}) {
  const f = { customer, shape, cluster, ...(filters ?? {}) };
  const tables = table ? [table] : db.prepare(`select distinct d.table_code as t from decisions d join outcomes o on o.decision_code = d.code
    where o.result in ('confermata','smentita','parziale') and d.table_code is not null order by d.table_code`).all().map((r) => r.t);
  const proposals = [];
  const skipped = [];
  for (const t of tables) {
    const r = proposeFor(db, t, { filters: f, tolerance, askOutcomes });
    if (r.skipped) { skipped.push(r.skipped); continue; }
    const file = join(outDir, `${t}.v${r.proposal.to_version}.proposal.yaml`);
    if (existsSync(file)) { proposals.push({ ...r.proposal, file, exists: true }); continue; }
    mkdirSync(outDir, { recursive: true });
    const doc = { ...r.proposal, proposed_at: at, status: "da-approvare",
      note: "proposta di calibrazione (§12.5): un umano approva; la tabella cambia solo con nuova version e motivazione" };
    writeFileSync(file, YAML.stringify(doc));
    proposals.push({ ...r.proposal, file, exists: false });
  }
  return { proposals, skipped };
}

export const HELP = `uso: learn calibrate --propose --db <knowledge.db> [--table DT-0nn] [--customer ACME] [--shape <forma>]
                 [--cluster CL-…] [--out-dir <dir>] [--tolerance N] [--json] [--help]

Calibrazione (§12.5, §17.4): per ogni DT con ≥ ${MIN_DECS} DEC verificate cerca lo spostamento di un bordo di
banda (±0.10, passo 0.01) che minimizza le smentite senza aggiungere più di --tolerance domande su DEC
confermate (default max(1, 10% delle DEC)); scrive <out-dir>/DT-0nn.v<N+1>.proposal.yaml (default
decision-tables/proposals/), mai la tabella. Brier e sovraconfidenza per (agente, DT, mese): effetti elencati,
non applicati.

Exit code: 0 ok · 1 errore utente (argomenti, DB assente, --propose mancante) · 2 errore di sistema.`;

export function run(argv) {
  const { opts } = parseArgs(argv, { flags: ["propose"] });
  const asJson = !!opts.json;
  if (opts.help) { console.log(HELP); return 0; }
  if (!opts.propose) return fail(asJson, 1, "calibrate propone soltanto: aggiungi --propose");
  if (!opts.db) return fail(asJson, 1, "richiesto --db");
  let db;
  try { db = openDb(opts.db, { createIfMissing: false }); } catch (e) { return fail(asJson, 1, String(e.message ?? e)); }
  try {
    const r = calibrate(db, { table: opts.table, customer: opts.customer, shape: opts.shape, cluster: opts.cluster,
      outDir: opts["out-dir"] ?? DEFAULT_OUT_DIR, tolerance: opts.tolerance !== undefined ? Number(opts.tolerance) : undefined });
    const out = { ...r, confidence: confidenceCalibration(db, { table: opts.table, customer: opts.customer }) };
    console.log(JSON.stringify(asJson ? { ok: true, ...out } : out));
    return 0;
  } catch (e) { return fail(asJson, 2, `errore di sistema: ${e.message ?? e}`); } finally { db.close(); }
}

if (isMain(import.meta.url)) process.exit(run(process.argv.slice(2)));
