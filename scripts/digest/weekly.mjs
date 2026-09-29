// Digestione settimanale (§22, §45.6) — WP09d. Orchestratore:
//   lock knowledge.lock su product/ e su ogni cliente → collect (sola lettura) → pseudonimizzazione → align →
//   portability (+ CTR di prodotto → CL-PRT) → outcomes-rates → calibrate --propose (≥ 10 DEC) → promote-candidates →
//   decay → report → reindex di product/ e di ogni cliente → unlock.
// Non sposta dati di business fra clienti, non promuove (i candidati attendono `APPROVO PROMOZIONE <codice>` e
// `kb promote --to product`), non cancella, non cambia una DT (le proposte di calibrazione restano proposte).
// Scritture: product/digest/<settimana>/ (report e candidati PSEUDONIMIZZATI), customers/<C>/digest/<settimana>/
// (la corrispondenza privata candidato → codici del cliente e le proposte di calibrazione del cliente), i contatori dei
// cluster vuoti (recordDigest) e l'indice (reindex).
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import YAML from "yaml";
import { withLock } from "../kb/lock.mjs";
import { openDb } from "../kb/db.mjs";
import { reindex } from "../kb/reindex.mjs";
import { recordDigest } from "../kb/cluster.mjs";
import { collect, listCustomers, isoWeek, openReadonly } from "./collect.mjs";
import { align } from "./align.mjs";
import { portability } from "./portability.mjs";
import { promoteCandidates } from "./promote-candidates.mjs";
import { decay } from "./decay.mjs";
import { buildReport, renderReport } from "./report.mjs";
import { rates } from "./outcomes-rates.mjs";
import { calibrate } from "./calibrate.mjs";
import { pseudonymizer, saltFrom, PseudonymError } from "./pseudonymize.mjs";
import { customerNames } from "../kb/lifecycle.mjs";
import { parseArgs, fail } from "../lib/args.mjs";
import { isMain } from "../lib/is-main.mjs";

export const LOCK_TTL_MS = 30 * 60000;
const OPEN_CTR = new Set(["aperto", "aperta", "open", "irrisolta"]);

// Lock annidati: product/ poi ogni cliente in ordine (sempre lo stesso ordine: niente stalli fra due digestioni).
async function withLocks(dirs, fn) {
  if (!dirs.length) return fn();
  const [d, ...rest] = dirs;
  mkdirSync(d, { recursive: true });
  return withLock(d, "knowledge", LOCK_TTL_MS, () => withLocks(rest, fn));
}

function previousDisproved(ws, week) {
  const dir = join(ws, "product", "digest");
  if (!existsSync(dir)) return null;
  try {
    const weeks = readdirSync(dir).filter((x) => /^\d{4}-W\d{2}$/.test(x) && x < week).sort();
    const last = weeks.at(-1);
    if (!last) return null;
    return JSON.parse(readFileSync(join(dir, last, "report.json"), "utf8")).decisions?.disproved_pct ?? null;
  } catch { return null; }
}

export async function weekly({ ws, now = new Date(), env = process.env, customers = listCustomers(ws) } = {}) {
  const salt = saltFrom(env);
  const week = isoWeek(now);
  const dirs = [join(ws, "product"), ...customers.map((c) => join(ws, "customers", c))];
  return withLocks(dirs, async () => {
    // 1 RACCOLTA (sola lettura)
    const data = collect(ws, { customers, window: { from: week.from, to: week.to } });
    // 2 NORMALIZZAZIONE: token per clienti, persone, fornitori, documenti
    const names = { customerNames: [], people: [], suppliers: [] };
    for (const c of customers) { const n = customerNames(ws, c); for (const k of Object.keys(names)) names[k].push(...n[k]); }
    const ps = pseudonymizer({ salt, customers, ...names });
    const tok = (c) => ps.token("customer", c);
    const cond = (c) => (c ? { ...c, customers: c.customers.map(tok) } : null);
    // 3-5 ALLINEAMENTO, PORTABILITÀ, CONTRADDIZIONI
    const items = Object.values(data.customers).flatMap((d) => d.items);
    const openCtr = new Set(Object.values(data.customers).flatMap((d) => d.contradictions.filter((x) => OPEN_CTR.has(String(x.status ?? "").toLowerCase()) || (x.status == null && x.resolution == null)).flatMap((x) => [x.a_code, x.b_code])));
    const groups = align(items);
    for (const g of groups) g.portability = portability(g, { openCtr });
    const multi = groups.filter((g) => g.portability.observed >= 2);
    const ctr = multi.filter((g) => g.portability.ctr_proposal).map((g) => ({ key: ps.text(g.key), cluster: g.portability.ctr_proposal.cluster, facet: g.portability.facet,
      customers: g.portability.ctr_proposal.customers.map(tok), confirming: g.portability.confirming.map(tok), contradicting: g.portability.contradicting.map(tok), note: g.portability.ctr_proposal.note }));
    const clustersNew = multi.filter((g) => ["condizionata", "universale"].includes(g.portability.class)).map((g) => ({ key: ps.text(g.key), cluster: g.portability.cluster_proposal, class: g.portability.class }));
    // 8 ESITI: tassi per (DT, cliente) — i priori di dt-eval --priors auto li leggono dal registro
    const outcomeRates = {};
    // 9 CALIBRAZIONE: proposte per cliente (≥ 10 DEC verificate per tabella), nella cartella del cliente
    const calibration = [];
    for (const c of customers) {
      const db = openReadonly(join(ws, "customers", c, "knowledge.db"));
      if (!db) continue;
      try {
        let tables = [];
        try { tables = db.prepare("select distinct table_code as t from decisions where table_code is not null order by t").all().map((r) => r.t); } catch { tables = []; }
        outcomeRates[tok(c)] = Object.fromEntries(tables.map((t) => [t, rates(db, { table: t })]));
        if (tables.length) {
          const r = calibrate(db, { outDir: join(ws, "customers", c, "digest", week.id, "calibration"), at: now.toISOString() });
          for (const p of r.proposals) calibration.push({ ...p, customer: tok(c), supporting_decs: p.supporting_decs.map((x) => ps.text(x)), file: undefined, filters: undefined });
        }
      } finally { db.close(); }
    }
    // 6 PROMOZIONE: candidati in attesa di approvazione
    const cand = promoteCandidates(groups, { openCtr, week: week.id });
    // 11 DECADIMENTO
    const dec = decay(data);
    // REPORT (pseudonimizzato)
    const allDecs = Object.values(data.customers).flatMap((d) => d.decisions);
    const report = buildReport({
      week: week.id,
      candidates: cand.candidates.map((c) => ({ id: c.id, key: ps.text(c.key), class: c.class, p: c.p, condition: cond(c.condition), customers: [...new Set(c.members.map((m) => tok(m.customer)))] })),
      ctr, clusters_new: clustersNew, decay: { items: dec.items, clusters: dec.clusters },
      epistemic: Object.values(data.customers).flatMap((d) => d.epistemic), decisions: allDecs, previous_disproved_pct: previousDisproved(ws, week.id),
      sessions: Object.values(data.customers).flatMap((d) => d.sessions), calibration,
      checks: Object.values(data.customers).reduce((a, d) => ({ total: a.total + d.checks.total, new: a.new + d.checks.new }), { total: 0, new: 0 }),
    });
    const text = renderReport(report);
    // Scritture: product/ solo pseudonimizzato; la corrispondenza reale resta nella cartella del cliente.
    const pdir = join(ws, "product", "digest", week.id);
    mkdirSync(join(pdir, "candidates"), { recursive: true });
    writeFileSync(join(pdir, "competence-report.md"), text);
    writeFileSync(join(pdir, "report.json"), JSON.stringify({ ...report, outcome_rates: outcomeRates, excluded: cand.excluded.map((e) => ({ key: ps.text(e.key), reason: ps.text(e.reason) })) }, null, 2) + "\n");
    for (const c of cand.candidates) {
      writeFileSync(join(pdir, "candidates", `${c.id}.yaml`), YAML.stringify({ id: c.id, key: ps.text(c.key), type: c.type, scope: c.scope, class: c.class, condition: cond(c.condition), p: c.p,
        quality_class: c.quality_class, dt: c.dt, status: c.status, members: c.members.map((m) => ({ customer: tok(m.customer), item: ps.token("item", m.code) })),
        next: "in ogni sessione del cliente: `APPROVO PROMOZIONE <codice>` dell'utente, poi `kb promote <codice> --customer <C> --to product --approval <token>`" }));
    }
    for (const c of customers) {
      const mine = cand.candidates.map((x) => ({ id: x.id, class: x.class, p: x.p, items: x.members.filter((m) => m.customer === c).map((m) => m.code) })).filter((x) => x.items.length);
      if (!mine.length) continue;
      const cdir = join(ws, "customers", c, "digest", week.id);
      mkdirSync(cdir, { recursive: true });
      writeFileSync(join(cdir, "candidates.yaml"), YAML.stringify({ week: week.id, customer: c, candidates: mine }));
    }
    // 7 CLUSTER (contatori delle digestioni vuote) e 12 REINDEX
    const reindexed = {};
    for (const [name, root] of [["product", join(ws, "product")], ...customers.map((c) => [c, join(ws, "customers", c)])]) {
      const dbf = join(root, "knowledge.db");
      if (!existsSync(dbf) && !existsSync(join(root, "kb"))) continue;
      const db = openDb(dbf);
      try { recordDigest(db, { now: now.toISOString() }); } finally { db.close(); }
      const st = reindex(root, dbf);
      reindexed[name === "product" ? name : tok(name)] = { scanned: st.scanned, upserted: st.upserted, deprecated: st.deprecated };
    }
    return { week: week.id, customers: customers.map(tok), groups: groups.length, multi_customer_groups: multi.length, candidates: report.promotions_pending, excluded: cand.excluded.length,
      ctr: ctr.length, calibration: calibration.length, decay: { items: dec.items, clusters: dec.clusters.length }, report_file: join(pdir, "competence-report.md"), reindexed, text };
  });
}

export const HELP = `uso: learn digest-weekly [--workspace <dir>] [--date YYYY-MM-DD] [--json] [--help]

Digestione settimanale (§22, §45.6): lock su product/ e su ogni cliente; raccolta in sola lettura; pseudonimizzazione
(sale SOLO da JVC_PSEUDO_SALT); allineamento; portabilità (DT-006) e CTR di prodotto; tassi di esito; proposte di
calibrazione (≥ 10 DEC); candidati S (DT-010) in attesa di approvazione; decadimenti; competence report
(product/digest/<settimana>/competence-report.md); reindex; unlock. Non promuove, non cancella.

Exit code: 0 ok · 1 argomenti non validi · 2 errore di sistema · 3 rifiutato (sale assente, lock attivo).`;

export async function run(argv, env = process.env) {
  const { opts } = parseArgs(argv);
  const asJson = !!opts.json;
  if (opts.help) { console.log(HELP); return 0; }
  const ws = resolve(opts.workspace || env.JVC_WORKSPACE || env.CLAUDE_PROJECT_DIR || process.cwd());
  const now = opts.date ? new Date(`${opts.date}T12:00:00Z`) : new Date();
  if (Number.isNaN(now.getTime())) return fail(asJson, 1, `data non valida: ${opts.date}`);
  try {
    const r = await weekly({ ws, now, env });
    if (asJson) { const { text, ...rest } = r; console.log(JSON.stringify({ ok: true, ...rest })); } else console.log(r.text);
    return 0;
  } catch (err) {
    if (err instanceof PseudonymError) return fail(asJson, 3, err.message);
    if (/lock attivo/.test(String(err?.message))) return fail(asJson, 3, `${err.message}: un'altra digestione è in corso (admin lock per vederlo)`);
    return fail(asJson, 2, `errore di sistema: ${err?.message ?? err}`);
  }
}

// competence-report: l'ultimo report scritto (o quello di --week).
export async function runReport(argv, env = process.env) {
  const { opts } = parseArgs(argv);
  const asJson = !!opts.json;
  if (opts.help) { console.log("uso: learn competence-report [--week YYYY-Www] [--workspace <dir>] [--json]"); return 0; }
  const ws = resolve(opts.workspace || env.JVC_WORKSPACE || env.CLAUDE_PROJECT_DIR || process.cwd());
  const dir = join(ws, "product", "digest");
  const weeks = existsSync(dir) ? readdirSync(dir).filter((x) => /^\d{4}-W\d{2}$/.test(x)).sort() : [];
  const week = opts.week ?? weeks.at(-1);
  if (!week || !existsSync(join(dir, week, "report.json"))) return fail(asJson, 1, "nessun competence report: esegui learn digest-weekly");
  if (asJson) console.log(JSON.stringify({ ok: true, week, report: JSON.parse(readFileSync(join(dir, week, "report.json"), "utf8")) }));
  else console.log(readFileSync(join(dir, week, "competence-report.md"), "utf8"));
  return 0;
}

if (isMain(import.meta.url)) run(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (e) => { console.error(e); process.exitCode = 2; });
