// /vc status (§56.1, §48.2, §35) — WP09d. Stato della sessione: cliente, ambiente, scope, modalità, budget, pendenze,
// piano attivo; ultime 5 DEC; ultime 3 sorprese; salute della conoscenza (item per stato, debito di quarantena oltre 2
// settimane); coda Xray. --metrics: metriche derivate di §35 (calcolate a richiesta, JSON). Sola lettura: i DB si aprono
// in sola lettura, nessun file si scrive.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { openReadonly, listCustomers, surprisesByTask } from "../digest/collect.mjs";
import { graph } from "../kb/registries.mjs";
import { parseArgs, fail } from "../lib/args.mjs";
import { isMain } from "../lib/is-main.mjs";

export const QUARANTINE_DEBT_DAYS = 14;
const DAY = 86400000;
const safe = (fn, d) => { try { return fn(); } catch { return d; } };
const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : null);

export function kbHealth(dbFile, { now = Date.now() } = {}) {
  const db = openReadonly(dbFile);
  if (!db) return null;
  try {
    const byStatus = Object.fromEntries(safe(() => db.prepare("select status, count(*) as n from items group by status order by status").all(), []).map((r) => [r.status, r.n]));
    const q = safe(() => db.prepare("select code, updated_at from items where status = 'quarantena' order by updated_at").all(), []);
    const debt = q.filter((r) => now - Date.parse(r.updated_at ?? "") > QUARANTINE_DEBT_DAYS * DAY);
    return { items: Object.values(byStatus).reduce((a, n) => a + n, 0), by_status: byStatus, quarantine: q.length, quarantine_debt: { over_days: QUARANTINE_DEBT_DAYS, count: debt.length, codes: debt.slice(0, 10).map((r) => r.code) } };
  } finally { db.close(); }
}

export function xrayQueue(ws, c) {
  const d = join(ws, "customers", c, "queue");
  const by = { pending: 0, sent: 0, failed: 0 };
  if (!existsSync(d)) return by;
  for (const f of readdirSync(d).filter((x) => x.endsWith(".json"))) {
    const e = safe(() => JSON.parse(readFileSync(join(d, f), "utf8")), null);
    if (e?.status && e.status in by) by[e.status]++;
  }
  return by;
}

function lastDecisions(dbFile, n = 5) {
  const db = openReadonly(dbFile);
  if (!db) return [];
  try {
    return safe(() => db.prepare(`select d.code, d.table_code as tbl, d.outcome, d.strategy, d.at, o.result from decisions d left join outcomes o on o.decision_code = d.code
      order by d.at desc, d.code desc limit ?`).all(n), []);
  } finally { db.close(); }
}

function sessionsOf(ws, c) {
  const d = join(ws, "customers", c, ".sessions");
  if (!existsSync(d)) return [];
  return readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory())
    .map((e) => safe(() => JSON.parse(readFileSync(join(d, e.name, "session.json"), "utf8")), null)).filter(Boolean);
}

// Metriche derivate (§35.1, §35.2) per un cliente. null = non derivabile dai dati presenti.
export function metrics(ws, c) {
  const dbFile = join(ws, "customers", c, "knowledge.db");
  const db = openReadonly(dbFile);
  const out = { customer: c, cognition: {}, knowledge: {}, fields: {} };
  const sessions = sessionsOf(ws, c);
  const surprises = sessions.flatMap((s) => (Array.isArray(s.surprises) ? s.surprises : []));
  const per = sessions.map((s) => surprisesByTask(Array.isArray(s.surprises) ? s.surprises : []));
  const tasks = per.reduce((a, x) => a + x.tasks, 0);
  const stopped = per.reduce((a, x) => a + x.stopped, 0);
  out.cognition.surprises_per_task = tasks ? Math.round((surprises.length / tasks) * 100) / 100 : null;
  out.cognition.stopped_tasks_pct = pct(stopped, tasks);
  if (!db) return { ...out, note: "knowledge.db assente" };
  try {
    const decs = safe(() => db.prepare("select d.code, d.strategy, o.result from decisions d left join outcomes o on o.decision_code = d.code").all(), []);
    const ver = decs.filter((d) => ["confermata", "smentita", "parziale"].includes(d.result));
    const dis = ver.reduce((a, d) => a + (d.result === "smentita" ? 1 : d.result === "parziale" ? 0.5 : 0), 0);
    out.cognition.dec_total = decs.length;
    out.cognition.dec_verified_pct = pct(ver.length, decs.length);
    out.cognition.dec_disproved_pct = pct(dis, ver.length);
    const withStrategy = decs.filter((d) => d.strategy);
    out.cognition.str_replay_pct = pct(withStrategy.filter((d) => d.strategy === "STR-REPLAY").length, withStrategy.length);
    const epi = safe(() => db.prepare(`select e.shape, json_extract(i.facets, '$.F10') as risk from epistemic e left join items i on i.code = e.subject_code`).all(), []);
    const critical = epi.filter((e) => ["R2", "R3"].includes(e.risk));
    out.cognition.critical_subjects_ignoto_pct = pct(critical.filter((e) => e.shape === "ignoto").length, critical.length);
    out.cognition.subjects_ignoto_pct = pct(epi.filter((e) => e.shape === "ignoto").length, epi.length);
    // giro 1 (m11): costo di un compito ripetuto rispetto alla prima volta (§35.1, target ≤ 0.3): sessioni con una DEC
    // STR-REPLAY = ripetute, le altre = prima volta; costo = token usati dalla sessione (budget.used). Approssimazione per
    // sessione (il costo per compito non è registrato).
    const replaySessions = new Set(safe(() => db.prepare("select distinct session from decisions where strategy = 'STR-REPLAY' and session is not null").all(), []).map((r) => r.session));
    const cost = (list) => (list.length ? list.reduce((a, s) => a + (s.budget?.used ?? 0), 0) / list.length : null);
    const rep = cost(sessions.filter((s) => replaySessions.has(s.session_id)));
    const first = cost(sessions.filter((s) => !replaySessions.has(s.session_id)));
    out.cognition.repeated_vs_first_cost = rep != null && first ? Math.round((rep / first) * 100) / 100 : null;
    // Osservazioni R0 suggerite eseguite nella settimana (§35.1, target ≥ 80%): suggerite = soggetti in forma ignoto (come
    // il competence report, §22.1), eseguite = OBS degli ultimi 7 giorni (payload.ts), al massimo il 100%.
    const ignoto = epi.filter((e) => e.shape === "ignoto").length;
    const weekAgo = Date.now() - 7 * 86400000;
    const obsWeek = safe(() => db.prepare("select payload from observations").all(), []).filter((r) => { try { return Date.parse(JSON.parse(r.payload)?.ts ?? "") >= weekAgo; } catch { return false; } }).length;
    out.cognition.r0_suggested_executed_pct = ignoto ? Math.min(100, pct(obsWeek, ignoto)) : null;
    const calDir = join(ws, "customers", c, "digest");
    out.cognition.calibration_proposals = existsSync(calDir) ? readdirSync(calDir).reduce((a, w) => a + safe(() => readdirSync(join(calDir, w, "calibration")).length, 0), 0) : 0;
    const items = safe(() => db.prepare("select count(*) as n from items where status <> 'deprecato'").get().n, 0);
    const clustered = safe(() => db.prepare("select count(distinct item_code) as n from cluster_members").get().n, 0);
    out.knowledge.items = items;
    out.knowledge.clustered_pct = pct(clustered, items);
    const g = safe(() => graph(db, { root: join(ws, "customers", c) }), null);
    out.knowledge.orphans = g ? g.dangling_total : null;
    out.knowledge.missing_handoffs = g ? g.missing_handoffs.length : null;
    const runs = safe(() => db.prepare("select count(*) as n, sum(case when coherence = 'coerente' then 1 else 0 end) as ok from query_runs").get(), { n: 0, ok: 0 });
    out.knowledge.queries_coherent_pct = pct(runs.ok ?? 0, runs.n ?? 0);
    const mand = safe(() => db.prepare("select count(*) as n, sum(case when reason_kind is not null then 1 else 0 end) as r, sum(case when reason_kind = 'ui' then 1 else 0 end) as ui from fields where mandatory_kind in ('always','conditional')").get(), { n: 0 });
    out.fields.mandatory = mand.n ?? 0;
    out.fields.mandatory_with_reason_pct = pct(mand.r ?? 0, mand.n ?? 0);
    out.fields.reason_ui_only = mand.ui ?? 0;
  } finally { db.close(); }
  const auditDir = join(ws, "customers", c, "audit");
  const month = new Date().toISOString().slice(0, 7);
  const lines = safe(() => readFileSync(join(auditDir, `${month}.jsonl`), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)), []);
  const guardEvents = lines.filter((e) => e.kind === "guard");
  out.cognition.guard_denies_month = guardEvents.filter((e) => e.payload?.decision !== "ask").length;
  out.cognition.trace_rejections_month = lines.filter((e) => /subagent-trace|cognitive-trace/.test(String(e.actor)) && /block|deny|reject/.test(JSON.stringify(e.payload ?? {}))).length;
  return out;
}

export async function status({ ws, sid = null, withMetrics = false, now = Date.now() }) {
  const out = { workspace: ws, session: null, product: kbHealth(join(ws, "product", "knowledge.db"), { now }), customers: listCustomers(ws) };
  let session = null;
  if (sid) {
    const { loadSession } = await import("./session.mjs");
    try { session = loadSession(ws, sid).session; } catch (err) { out.session_error = String(err?.message ?? err); }
  }
  if (session) {
    const c = session.customer;
    const b = session.budget ?? {};
    const pend = session.pending ?? {};
    out.session = {
      id: sid, customer: c, scope: session.scope, mode: session.mode,
      env: session.env ? { id: session.env.id, type: session.env.type, verified: !!session.env.verified } : null,
      budget: { tokens: b.tokens ?? null, used: b.used ?? 0, remaining: Number.isFinite(b.tokens) ? b.tokens - (b.used ?? 0) : null, by_model: b.by_model ?? {} },
      pending: Object.fromEntries(["compensations", "approvals", "questions", "expected_outcomes"].map((k) => [k, Array.isArray(pend[k]) ? pend[k].length : 0])),
      active_plan: session.active_plan ? { plan_id: session.active_plan.plan_id, step: session.active_plan.step ?? null } : null,
      last_decisions: lastDecisions(join(ws, "customers", c, "knowledge.db"), 5),
      last_surprises: (Array.isArray(session.surprises) ? session.surprises : []).slice(-3),
      kb: kbHealth(join(ws, "customers", c, "knowledge.db"), { now }),
      xray_queue: xrayQueue(ws, c),
    };
    if (withMetrics) out.metrics = metrics(ws, c);
  } else if (withMetrics) out.metrics = out.customers.map((c) => metrics(ws, c));
  out.suggested = suggestedActions(out);
  return out;
}

// WP10a giro 1 (minore 7, §56.1 "azioni suggerite"): dallo stato, in ordine di urgenza, cosa fare adesso.
// → [{ action, why }] (action = il comando o la frase da usare)
export function suggestedActions(s) {
  const x = s?.session;
  const out = [];
  const add = (action, why) => out.push({ action, why });
  if (!x) { add("/jaggaer-virtual-consultant:use customer <ID> [--new]", "nessun cliente attivo"); add("/jaggaer-virtual-consultant:vc doctor", "diagnosi dell'installazione prima di lavorare"); return out; }
  if (x.pending?.compensations) add("compensa tutto · lascia <entità>", `${x.pending.compensations} compensazioni pendenti da chiudere (sessione interrotta o in corso)`);
  if (x.pending?.approvals) add("la frase di approvazione richiesta (APPROVO PIANO / PROVA / PASSO, oppure sì)", `${x.pending.approvals} approvazioni in attesa`);
  if (x.pending?.questions) add("rispondere alle domande aperte", `${x.pending.questions} domande in attesa della risposta dell'utente`);
  if (!x.env) add("/jaggaer-virtual-consultant:use env <sandbox|preprod|prod>", "nessun ambiente dichiarato: senza non si agisce sul browser");
  else if (!x.env.verified) add(`/jaggaer-virtual-consultant:use env ${x.env.id}`, "impronta dell'ambiente non verificata: solo navigazione e lettura finché env-check non la verifica");
  if (!x.scope) add("/jaggaer-virtual-consultant:use scope <ID>", "nessuno scope attivo");
  if (x.kb?.quarantine_debt?.count) add("/jaggaer-virtual-consultant:kb review --only quarantena", `${x.kb.quarantine_debt.count} item in quarantena da oltre ${x.kb.quarantine_debt.over_days ?? 14} giorni`);
  if (x.xray_queue?.pending || x.xray_queue?.failed) add("/jaggaer-virtual-consultant:nrt push-xray --retry-queued", `coda Xray: ${x.xray_queue.pending ?? 0} in attesa, ${x.xray_queue.failed ?? 0} fallite`);
  if (x.pending?.expected_outcomes) add("/jaggaer-virtual-consultant:learn outcomes --session", `${x.pending.expected_outcomes} esiti attesi da verificare`);
  if (!out.length) add("scrivere un intento, es. \"Su <cliente> <ambiente>, apri la richiesta più recente e dimmi in che stato è\"", "sessione pronta");
  return out;
}

export function render(s) {
  const L = [];
  if (!s.session) L.push("Nessuna sessione con cliente attivo (/use customer <id>).");
  else {
    const x = s.session;
    L.push(`Cliente ${x.customer} · scope ${x.scope ?? "—"} · modalità ${x.mode} · ambiente ${x.env ? `${x.env.id} (${x.env.type}${x.env.verified ? ", verificato" : ", NON verificato"})` : "non dichiarato"}`);
    L.push(`Budget: ${x.budget.used}/${x.budget.tokens ?? "?"} token (restano ${x.budget.remaining ?? "?"})`);
    L.push(`Pendenze: compensazioni ${x.pending.compensations} · approvazioni ${x.pending.approvals} · domande ${x.pending.questions} · esiti attesi ${x.pending.expected_outcomes}`);
    if (x.active_plan) L.push(`Piano attivo: ${x.active_plan.plan_id} al passo ${x.active_plan.step ?? "?"}`);
    L.push(`Ultime decisioni: ${x.last_decisions.map((d) => `${d.code} ${d.tbl}→${d.outcome}${d.result ? ` (${d.result})` : ""}`).join(" · ") || "—"}`);
    L.push(`Ultime sorprese: ${x.last_surprises.map((z) => z?.kind ?? z?.what ?? JSON.stringify(z)).join(" · ") || "—"}`);
    if (x.kb) L.push(`Conoscenza: ${x.kb.items} item (${Object.entries(x.kb.by_status).map(([k, v]) => `${k} ${v}`).join(", ")}) · quarantena ${x.kb.quarantine}, di cui oltre ${x.kb.quarantine_debt.over_days} giorni: ${x.kb.quarantine_debt.count}`);
    L.push(`Coda Xray: in attesa ${x.xray_queue.pending} · fallite ${x.xray_queue.failed} · inviate ${x.xray_queue.sent}`);
  }
  if (s.product) L.push(`Prodotto: ${s.product.items} item S`);
  const sug = s.suggested ?? suggestedActions(s);
  if (sug.length) { L.push("Azioni suggerite:"); for (const a of sug) L.push(`  ${a.action} — ${a.why}`); }
  return L.join("\n");
}

export const HELP = `uso: node scripts/admin/status.mjs [--session <id>] [--metrics] [--workspace <dir>] [--json]

/vc status (§56.1, §48.2): stato della sessione, budget, pendenze, ultime 5 decisioni, ultime 3 sorprese, salute della
conoscenza (item per stato, quarantene oltre 2 settimane), coda Xray, azioni suggerite (§56.1). --metrics: metriche
derivate di §35.

Exit code: 0 ok · 1 argomenti non validi · 2 errore di sistema.`;

export async function run(argv, env = process.env) {
  const { opts } = parseArgs(argv, { flags: ["metrics"] });
  const asJson = !!opts.json;
  if (opts.help) { console.log(HELP); return 0; }
  const ws = resolve(opts.workspace || env.JVC_WORKSPACE || env.CLAUDE_PROJECT_DIR || process.cwd());
  if (!existsSync(ws)) return fail(asJson, 1, `workspace non trovato: ${ws}`);
  try {
    const { resolveSessionId } = await import("./session.mjs");
    const sid = resolveSessionId({ workspace: ws, arg: opts.session, env });
    const s = await status({ ws, sid, withMetrics: !!opts.metrics });
    console.log(asJson ? JSON.stringify({ ok: true, ...s }) : render(s));
    return 0;
  } catch (err) { return fail(asJson, 2, `errore di sistema: ${err?.message ?? err}`); }
}

if (isMain(import.meta.url)) run(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (e) => { console.error(e); process.exitCode = 2; });
