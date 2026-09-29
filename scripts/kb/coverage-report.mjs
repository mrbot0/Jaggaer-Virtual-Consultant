// Report di copertura epistemica per scope (§9.6): per tipo, quanti soggetti per forma e i K medi per genere di fonte,
// con la riga "identità dei dati" (carta d'identità dei FLD, §19.20) e, con --plan, il piano R0: le osservazioni mirate
// che porterebbero i soggetti `libresco` a `consolidato` e le domande per gli `ignoto` (dalle banche di domande).
//
//   subjectsOf(db, scope) → [{ code, type, k_tech, k_use, k_obs, k_exec, shape, gaps, source }]
//     il profilo EPI dal DB (tabella epistemic) se c'è; altrimenti dalla copertura della digestione guidata
//     (attribute_coverage → epistemic.coverage, senza osservazioni né esecuzioni); altrimenti ignoto con tutti i gap.
//   report(db, { scope, customer?, date? }) → { scope, rows: [{ type, n, consolidato, libresco, empirico, ignoto, contraddittorio,
//       k_tech, k_use, k_obs, k_exec }], identity: { fld, blocks_avg, complete, missing_system_of_record, missing_lineage }, reading }
//   plan(db, { scope }) → { observations: [{ subject, type, gaps, minutes }], questions: [{ subject, attribute, question }], hours }
//   formatReport(r, p?) → testo con il layout di §9.6
// CLI: node scripts/kb/coverage-report.mjs --db <file> --scope <S> [--customer ACME] [--plan] [--json]
//      (anche: node scripts/kb/kb.mjs epistemic --scope <S> [--plan] --db <file>)
import { readFileSync, existsSync } from "node:fs";
import YAML from "yaml";
import { openDb } from "./db.mjs";
import { coverage } from "./epistemic.mjs";
import { identityCoverage } from "./identity.mjs";
import { SCOPES } from "./codes.mjs";
import { isMain } from "../lib/is-main.mjs";
import { parseArgs, fail } from "../lib/args.mjs";

const EXPECTED = YAML.parse(readFileSync(new URL("../../schemas/expected-attributes.yaml", import.meta.url), "utf8"));
const SHAPES = ["consolidato", "libresco", "empirico", "ignoto", "contraddittorio"];
const OBS_MINUTES = 5;   // un'osservazione mirata R0 (una pagina, un soggetto): ordine di grandezza per il piano
const r2 = (x) => Math.round(x * 100) / 100;

export function subjectsOf(db, scope, { customer = null } = {}) {
  const items = db.prepare("select code, type, customer from items where scope=? and status <> 'deprecato'").all(scope)
    .filter((r) => EXPECTED[r.type] && (!customer || r.customer === customer || r.customer === "STD"));
  const epi = db.prepare("select * from epistemic where subject_code=?");
  const cov = db.prepare("select attribute, genre, answered, contradiction from attribute_coverage where subject_code=?");
  return items.map((it) => {
    const e = epi.get(it.code);
    if (e?.shape) return { code: it.code, type: it.type, k_tech: e.k_tech ?? 0, k_use: e.k_use ?? 0, k_obs: e.k_obs ?? 0, k_exec: e.k_exec ?? 0, shape: e.shape, gaps: [], source: "epistemic" };
    const rows = cov.all(it.code);
    const attrs = {};
    for (const r of rows.filter((x) => x.answered)) attrs[r.attribute] = r.genre ? (r.genre.includes(",") ? r.genre.split(",") : r.genre) : "tecnica";
    const c = coverage({ type: it.type, attrs }, { obsConfirmations: 0, execWithOutcome: 0, userStatements: 0, freshness: 1, openContradictions: rows.filter((x) => x.contradiction).length });
    return { code: it.code, type: it.type, k_tech: c.k_tech, k_use: c.k_use, k_obs: c.k_obs, k_exec: c.k_exec, shape: c.shape, gaps: c.gaps, source: rows.length ? "digestione" : "nessuna" };
  });
}

// WP10a giro 1 (I4, §56.3 `kb epistemic <soggetto>`): il profilo epistemico di UN soggetto — K per genere di fonte,
// forma, CTR aperte, attributi attesi mancanti (gap) e il prossimo passo (osservazione R0, domande, CTR da risolvere).
// Stessa fonte del report per scope: EPI dal DB (tabella epistemic), altrimenti la copertura della digestione guidata,
// altrimenti ignoto con tutti i gap. Codice inesistente ⇒ Error "non trovato".
export function subjectProfile(db, code) {
  const it = db.prepare("select code, type, scope, customer, status from items where code=?").get(code);
  if (!it) throw new Error(`soggetto non trovato: ${code}`);
  const expected = EXPECTED[it.type];
  if (!expected) throw new Error(`il tipo ${it.type} non ha attributi attesi: nessuna copertura epistemica per ${code}`);
  const e = db.prepare("select * from epistemic where subject_code=?").get(code);
  const rows = db.prepare("select attribute, genre, answered, contradiction from attribute_coverage where subject_code=?").all(code);
  const answered = new Set(rows.filter((r) => r.answered).map((r) => r.attribute));
  let p;
  if (e?.shape) {
    p = { k_tech: e.k_tech ?? 0, k_use: e.k_use ?? 0, k_obs: e.k_obs ?? 0, k_exec: e.k_exec ?? 0, k_user: e.k_user ?? null, k_level: e.k_level ?? null, shape: e.shape,
      open_contradictions: e.open_contradictions ?? 0, gaps: rows.length ? expected.filter((a) => !answered.has(a)) : [], source: "epistemic", computed_at: e.computed_at ?? null };
  } else {
    const s = subjectsOf(db, it.scope).find((x) => x.code === code) ?? { k_tech: 0, k_use: 0, k_obs: 0, k_exec: 0, shape: "ignoto", gaps: [...expected], source: "nessuna" };
    p = { k_tech: s.k_tech, k_use: s.k_use, k_obs: s.k_obs, k_exec: s.k_exec, shape: s.shape, open_contradictions: rows.filter((x) => x.contradiction).length,
      gaps: s.gaps.length || s.source !== "nessuna" ? s.gaps : [...expected], source: s.source };
  }
  const next = p.shape === "consolidato" ? "nessuna azione: si agisce con la precedenza del modo (progettare: tecnica; eseguire: scoperto)"
    : p.shape === "libresco" ? `osservazioni mirate R0 (~${OBS_MINUTES} minuti ciascuna) per passare da libresco a consolidato${p.gaps.length ? `; gap: ${p.gaps.join(", ")}` : ""}`
      : p.shape === "empirico" ? "cercare la fonte tecnica o d'uso che conferma ciò che si è visto (digestione mirata)"
        : p.shape === "contraddittorio" ? "risolvere le contraddizioni aperte prima di agire (DT-011)"
          : `chiedere all'utente gli attributi mancanti (${p.gaps.join(", ")}) o osservare il soggetto`;
  return { code, type: it.type, scope: it.scope, customer: it.customer, status: it.status, ...p, next };
}

export function report(db, { scope, customer = null, date = new Date().toISOString().slice(0, 10) } = {}) {
  if (!SCOPES.has(scope)) throw new Error(`scope sconosciuto: ${scope}`);
  const subjects = subjectsOf(db, scope, { customer });
  const byType = new Map();
  for (const s of subjects) { if (!byType.has(s.type)) byType.set(s.type, []); byType.get(s.type).push(s); }
  const rows = [...byType].sort((a, b) => a[0].localeCompare(b[0])).map(([type, list]) => {
    const row = { type, n: list.length };
    for (const sh of SHAPES) row[sh] = list.filter((s) => s.shape === sh).length;
    for (const k of ["k_tech", "k_use", "k_obs", "k_exec"]) row[k] = r2(list.reduce((a, s) => a + s[k], 0) / list.length);
    return row;
  });
  const flds = db.prepare("select f.code, f.identity from fields f join items i on i.code = f.code where i.scope=? and i.status <> 'deprecato'").all(scope);
  const covs = flds.map((f) => identityCoverage(f.identity ? JSON.parse(f.identity) : null));
  const identity = { fld: flds.length, blocks_avg: flds.length ? r2(covs.reduce((a, c) => a + c.blocks_covered, 0) / flds.length) : 0, blocks_total: 12,
    complete: covs.filter((c) => c.blocks_covered === 12).length, missing_system_of_record: covs.filter((c) => c.missing_blocks.includes("system_of_record")).length,
    missing_relations: covs.filter((c) => c.missing_blocks.includes("relations")).length };
  const count = (sh) => subjects.filter((s) => s.shape === sh).length;
  const lib = count("libresco"), ign = count("ignoto"), ctr = count("contraddittorio");
  const docHigh = rows.reduce((a, r) => a + r.k_tech + r.k_use, 0) > rows.reduce((a, r) => a + r.k_obs + r.k_exec, 0);
  const reading = !subjects.length ? `Nessun soggetto nello scope ${scope}: la copertura nasce con la digestione (§19.11) e il reindex.`
    : `${docHigh ? "Lo scope è più documentato che osservato ed esercitato." : "Lo scope è più osservato ed esercitato che documentato."}${lib ? ` ${lib} osservazioni mirate (R0, ~${Math.ceil((lib * OBS_MINUTES) / 60)} h) porterebbero ${lib} soggetti da libresco a consolidato.` : ""}${ign ? ` ${ign} ignoti sono da chiedere.` : ""}${ctr ? ` ${ctr} contraddittori da risolvere prima di agire (DT-011).` : ""}`;
  return { scope, customer, date, subjects: subjects.length, rows, identity, reading };
}

export function plan(db, { scope, customer = null } = {}) {
  const subjects = subjectsOf(db, scope, { customer });
  const observations = subjects.filter((s) => s.shape === "libresco").map((s) => ({ subject: s.code, type: s.type, gaps: s.gaps.filter((g) => ["empirica"].includes(EXPECTED.genres?.[s.type]?.[g])), risk: "R0", minutes: OBS_MINUTES }));
  const questions = [];
  for (const s of subjects.filter((x) => x.shape === "ignoto")) {
    const bank = new URL(`../../product/question-banks/${s.type}.yaml`, import.meta.url);
    if (!existsSync(bank)) continue;
    const qs = YAML.parse(readFileSync(bank, "utf8")).questions;
    const gaps = s.gaps.length ? s.gaps : EXPECTED[s.type];
    for (const q of qs.filter((x) => gaps.includes(x.attribute) && (x.critical_for_r2 || x.always_critical))) questions.push({ subject: s.code, attribute: q.attribute, question: q.question });
  }
  return { scope, observations, questions, hours: Math.ceil((observations.length * OBS_MINUTES) / 60 * 10) / 10 };
}

export function formatReport(r, p = null) {
  const head = `COPERTURA EPISTEMICA — ${r.customer ?? "STD"} — scope ${r.scope} — ${r.date}`;
  const cols = `${"".padEnd(14)}consolidato  libresco  empirico  ignoto  contradd.   K_tech  K_use  K_obs  K_exec`;
  const lines = r.rows.map((x) => `${`${x.type} (${x.n})`.padEnd(14)}${String(x.consolidato).padStart(6)}${String(x.libresco).padStart(12)}${String(x.empirico).padStart(10)}${String(x.ignoto).padStart(8)}${String(x.contraddittorio).padStart(9)}   ${x.k_tech.toFixed(2).padStart(6)} ${x.k_use.toFixed(2).padStart(6)} ${x.k_obs.toFixed(2).padStart(6)} ${x.k_exec.toFixed(2).padStart(6)}`);
  const id = r.identity;
  const idLine = `Identità dei dati (FLD ${id.fld}): blocchi coperti in media ${id.blocks_avg}/${id.blocks_total} · carte complete ${id.complete} · senza system_of_record ${id.missing_system_of_record} · senza relazioni ${id.missing_relations}`;
  const out = [head, "", cols, ...lines, idLine, "", `Lettura: ${r.reading}`];
  if (p) {
    out.push("", `Piano R0 (${p.observations.length} osservazioni, ~${p.hours} h):`);
    for (const o of p.observations.slice(0, 50)) out.push(`  osserva ${o.subject} (${o.type})${o.gaps.length ? ` — ${o.gaps.join(", ")}` : ""}`);
    out.push(`Domande (${p.questions.length}):`);
    for (const q of p.questions.slice(0, 50)) out.push(`  ${q.subject} · ${q.attribute}: ${q.question}`);
  }
  return out.join("\n");
}

export function formatSubject(s) {
  const k = (v) => (v == null ? "—" : Number(v).toFixed(2));
  return [`COPERTURA EPISTEMICA — ${s.code} (${s.type}, scope ${s.scope})`,
    `Forma      ${s.shape} (fonte: ${s.source})${s.open_contradictions ? ` · CTR aperte ${s.open_contradictions}` : ""}`,
    `K          tecnica ${k(s.k_tech)} · d'uso ${k(s.k_use)} · osservata ${k(s.k_obs)} · esercitata ${k(s.k_exec)}${s.k_user != null ? ` · utente ${k(s.k_user)}` : ""}`,
    `Gap        ${s.gaps.length ? s.gaps.join(", ") : "nessuno"}`,
    `Prossimo   ${s.next}`].join("\n");
}

const HELP = `uso: node scripts/kb/coverage-report.mjs --db <knowledge.db> --scope <SCOPE> [--customer ACME] [--plan] [--json] [--help]
     node scripts/kb/coverage-report.mjs --db <knowledge.db> <codice del soggetto> [--json]
     (node scripts/kb/kb.mjs epistemic --scope <SCOPE> [--plan] --db <knowledge.db> · kb.mjs epistemic <codice> --db <knowledge.db>)

Per soggetto (§56.3): K per genere di fonte, forma, CTR aperte, attributi attesi mancanti e il prossimo passo.

Report di copertura epistemica per scope (§9.6): per tipo, soggetti per forma e K medi; riga "identità dei dati"
(carta d'identità dei FLD); --plan: osservazioni R0 per i soggetti libreschi e domande per gli ignoti (§34.2).

Exit code: 0 ok · 1 errore utente (argomenti, scope sconosciuto, DB assente) · 2 errore di sistema.`;

export function main(argv) {
  const { opts, positional } = parseArgs(argv, { flags: ["plan"] });
  const asJson = !!opts.json;
  if (opts.help) { console.log(HELP); return 0; }
  // WP10a giro 1 (I4): per soggetto — `epistemic <codice>` (o --subject <codice>)
  const subject = opts.subject ?? positional[0];
  if (subject && !opts.scope) {
    let db;
    try { db = openDb(opts.db ?? "knowledge.db", { createIfMissing: false }); } catch (e) { return fail(asJson, 1, e.message); }
    try {
      const s = subjectProfile(db, subject);
      console.log(asJson ? JSON.stringify({ ok: true, subject: s }) : formatSubject(s));
      return 0;
    } catch (e) { return fail(asJson, 1, e.message ?? String(e)); }
    finally { db.close(); }
  }
  if (!opts.scope) return fail(asJson, 1, "richiesto --scope <SCOPE> o il codice del soggetto");
  if (!SCOPES.has(opts.scope)) return fail(asJson, 1, `scope sconosciuto: ${opts.scope}`);
  let db;
  try { db = openDb(opts.db ?? "knowledge.db", { createIfMissing: false }); } catch (e) { return fail(asJson, 1, e.message); }
  try {
    const r = report(db, { scope: opts.scope, customer: opts.customer ?? null });
    const p = opts.plan ? plan(db, { scope: opts.scope, customer: opts.customer ?? null }) : null;
    console.log(asJson ? JSON.stringify({ ok: true, report: r, ...(p ? { plan: p } : {}) }) : formatReport(r, p));
    return 0;
  } catch (e) { return fail(asJson, 2, `errore di sistema: ${e.message ?? e}`); }
  finally { db.close(); }
}

if (isMain(import.meta.url)) process.exit(main(process.argv.slice(2)));
