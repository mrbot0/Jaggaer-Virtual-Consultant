// Tassi di esito dal registro (§12.2): decisions ⨝ outcomes.
// `smentita` = smentita (1), `confermata` = confermata (1), `parziale` vale
// 0.5 da entrambe le parti, `non-verificabile` è escluso dai tassi (§12.1).
// `sufficient` = n ≥ windowMin (finestra minima di 30 DEC, piano K1.5):
// sotto la finestra un prior non è affidabile e `dt-eval --priors auto`
// applica il valore `neutral` dichiarato nella tabella.
import { openDb } from "../kb/db.mjs";
import { isMain } from "../lib/is-main.mjs";
import { parseArgs, fail } from "../lib/args.mjs";

export function rates(db, { table, cluster, customer, shape, strategy, outcome, windowMin = 30 } = {}) {
  const where = ["o.result in ('confermata','smentita','parziale')"];
  const params = [];
  if (table) { where.push("d.table_code = ?"); params.push(table); }
  if (cluster) { where.push("d.subject_cluster = ?"); params.push(cluster); }
  if (customer) { where.push("d.code like ?"); params.push(`L.${customer}.%`); }
  if (shape) { where.push("json_extract(d.inputs, '$.shape') = ?"); params.push(shape); }
  if (strategy) { where.push("d.strategy = ?"); params.push(strategy); }
  if (outcome) { where.push("d.outcome = ?"); params.push(outcome); }
  const row = db.prepare(`select count(*) as n,
      coalesce(sum(case o.result when 'confermata' then 1.0 when 'parziale' then 0.5 else 0 end), 0) as confirmed,
      coalesce(sum(case o.result when 'smentita' then 1.0 when 'parziale' then 0.5 else 0 end), 0) as disproved
    from decisions d join outcomes o on o.decision_code = d.code where ${where.join(" and ")}`).get(...params);
  const n = row.n;
  return {
    n,
    confirmed: row.confirmed,
    disproved: row.disproved,
    rate_disproved: n ? Math.round((row.disproved / n) * 1e4) / 1e4 : null,
    sufficient: n >= windowMin,
  };
}

const HELP = `uso: node scripts/digest/outcomes-rates.mjs --db <file> [--table DT-nnn] [--cluster CL-…]
       [--customer ACME] [--shape <forma>] [--strategy STR-…] [--outcome <esito>] [--window 30] [--json] [--help]

Tassi di esito dal registro delle decisioni (§12.2): { n, confirmed, disproved,
rate_disproved, sufficient }. parziale = 0.5; non-verificabile escluso;
sufficient = n ≥ --window (default 30).

Exit code: 0 ok · 1 errore utente (argomenti, DB assente) · 2 errore di sistema.`;

if (isMain(import.meta.url)) {
  const { opts } = parseArgs(process.argv.slice(2));
  const asJson = !!opts.json;
  if (opts.help) { console.log(HELP); process.exit(0); }
  if (!opts.db) process.exit(fail(asJson, 1, "richiesto --db <file>"));
  let db;
  try { db = openDb(opts.db, { createIfMissing: false }); } catch (e) { process.exit(fail(asJson, 1, String(e.message ?? e))); }
  try {
    const r = rates(db, { table: opts.table, cluster: opts.cluster, customer: opts.customer, shape: opts.shape,
      strategy: opts.strategy, outcome: opts.outcome, windowMin: opts.window ? Number(opts.window) : 30 });
    console.log(JSON.stringify(asJson ? { ok: true, ...r } : r));
    process.exit(0);
  } catch (e) { process.exit(fail(asJson, 2, `errore di sistema: ${e.message ?? e}`)); }
}
