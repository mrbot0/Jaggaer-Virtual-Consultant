// Digestione guidata dagli attributi attesi (§19.11): il digester non legge il documento, INTERROGA il corpus delle
// unità con la banca di domande del tipo (product/question-banks/<TIPO>.yaml), una domanda per attributo atteso.
// "I gap sono gratuiti": ogni domanda senza risposta è un attributo non coperto, e il vettore K è il sottoprodotto.
//
//   loadBank(type) → { type, questions[] }
//   planSubject(db, { subject, type, label?, doc?, top = 5 }) → { subject, type, questions: [{ attribute, question, genre,
//       critical_for_r2, always_critical, units: [{ code, doc, section, page, score, near, text }] }], estimated_reads }
//     le unità candidate sono quelle che nominano il soggetto (etichetta) o stanno nella sua sezione sorgente;
//     fra queste, l'ordine è quello della domanda (FTS bm25 + prossimità). Nessuna candidata ⇒ domanda sulle unità del doc.
//   recordAnswers(db, { subject, type, answers: [{ attribute, units[], genre?, answered?, contradiction? }] })
//     → { attrs, coverage (epistemic.coverage), gaps, contradictions, completeness (DT-022) }
//     scrive attribute_coverage (attributo → unità + genere) e subject_units; il genere, se non dato, è quello del
//     DOC delle unità (doc_profiles.genre). Due unità che rispondono diversamente ⇒ contradiction (candidato CTR).
//   completeness(type, attrs, { level }) → esito di DT-022 (digerito | quarantena, combinazioni, gaps)
// CLI: node scripts/kb/digest-plan.mjs plan --db <file> --type CFG --subject <codice> [--label <etichetta>] [--doc <DOC>] [--top 5] [--out <file>] [--json]
//      node scripts/kb/digest-plan.mjs record-answers --db <file> --answers-file <file.yaml|json> [--out <file>] [--json]
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import YAML from "yaml";
import { openDb } from "./db.mjs";
import { units as searchUnits, ftsQuery, linkSubjectUnits } from "./units.mjs";
import { coverage } from "./epistemic.mjs";
import { evaluate, loadTable } from "../decide/dt-eval.mjs";
import { parseCode } from "./codes.mjs";
import { isMain } from "../lib/is-main.mjs";
import { parseArgs, fail } from "../lib/args.mjs";

export class DigestInputError extends Error { constructor(m) { super(m); this.name = "DigestInputError"; } }
export const EXPECTED = YAML.parse(readFileSync(new URL("../../schemas/expected-attributes.yaml", import.meta.url), "utf8"));
const BANKS = new URL("../../product/question-banks/", import.meta.url);
const TYPE_RE = /^[A-Z]{2,3}$/;

export function loadBank(type) {
  if (!TYPE_RE.test(String(type ?? ""))) throw new DigestInputError(`tipo non valido: ${type}`);
  const file = new URL(`${type}.yaml`, BANKS);
  if (!existsSync(file)) throw new DigestInputError(`nessuna banca di domande per ${type} (product/question-banks/${type}.yaml)`);
  return YAML.parse(readFileSync(file, "utf8"));
}

function candidateCodes(db, { subject, label }) {
  const out = new Set();
  const q = ftsQuery(label);
  if (q) {
    // tutte le parole dell'etichetta devono comparire (AND), per non annegare nelle domande
    const and = q.split(" OR ").join(" AND ");
    for (const r of db.prepare("select code from units_fts where units_fts match ? limit 400").all(and)) out.add(r.code);
  }
  for (const r of db.prepare(`select u2.code from subject_units s join units u on u.code = s.unit_code
    join units u2 on u2.doc = u.doc and u2.section_path = u.section_path where s.subject_code = ?`).all(subject)) out.add(r.code);
  return out;
}

export const retrievalQuery = (q) => [...(q.keywords?.en ?? []), ...(q.keywords?.it ?? []), q.question].join(" ");

export function planSubject(db, { subject, type, label = null, doc = null, top = 5 }) {
  if (!subject) throw new DigestInputError("serve il soggetto (codice o etichetta)");
  const bank = loadBank(type);
  const within = candidateCodes(db, { subject, label: label ?? (parseCode(subject) ? null : subject) });
  const questions = bank.questions.map((q) => {
    // giro 1 (M7): la ricerca usa le parole chiave it+en della domanda (il corpus è in gran parte in inglese)
    const query = retrievalQuery(q);
    let hits = within.size ? searchUnits(db, { doc, near: subject, query, top, within }) : [];
    if (!hits.length && within.size) hits = searchUnits(db, { doc, near: subject, query: label ?? subject, top, within });
    if (!hits.length && doc) hits = searchUnits(db, { doc, near: subject, query, top });
    return { attribute: q.attribute, question: q.question, genre: q.genre, critical_for_r2: !!q.critical_for_r2, always_critical: !!q.always_critical,
      units: hits.map((h) => ({ code: h.code, doc: h.doc, section: h.section, page: h.page, score: h.score, near: h.near, text: h.text })) };
  });
  return { subject, type, label, doc, candidates: within.size, questions, estimated_reads: questions.reduce((a, q) => a + q.units.length, 0) };
}

export function completeness(type, attrs, { level = "S" } = {}) {
  const expected = EXPECTED[type] ?? [];
  const critical = EXPECTED.critical?.[type] ?? [];
  const always = EXPECTED.always_critical?.[type] ?? [];
  const covered = expected.filter((a) => attrs[a] !== undefined && attrs[a] !== null && !(Array.isArray(attrs[a]) && !attrs[a].length));
  const w = (a) => (critical.includes(a) || always.includes(a) ? 2 : 1);
  const total = expected.reduce((s, a) => s + w(a), 0) || 1;
  const got = covered.reduce((s, a) => s + w(a), 0);
  const deficit = Math.round((1 - got / total) * 1e4) / 1e4;
  const r2Critical = critical.filter((a) => a !== "current_state" || level === "C");
  const r2Missing = r2Critical.filter((a) => !covered.includes(a));
  const alwaysMissing = always.filter((a) => !covered.includes(a));
  const threshold = 0.7;
  const inputs = { coverage_deficit: deficit, r2_critical_missing: r2Missing.length > 0, critical_missing: alwaysMissing.length > 0, below_type_threshold: covered.length / (expected.length || 1) < threshold };
  const r = evaluate(loadTable("DT-022"), inputs);
  return { outcome: r.outcome, combinations: r.combined ?? [], score: r.score, inputs, gaps: expected.filter((a) => !covered.includes(a)), missing_critical: alwaysMissing, missing_r2_critical: r2Missing };
}

export function recordAnswers(db, { subject, type, answers = [], level = null }) {
  if (!subject || !TYPE_RE.test(String(type ?? ""))) throw new DigestInputError("servono subject e type");
  const expected = EXPECTED[type] ?? [];
  const genreOfDoc = db.prepare("select genre from doc_profiles where code = (select doc from units where code=?)");
  const textOf = db.prepare("select text from units where code=?");
  const up = db.prepare(`insert into attribute_coverage(subject_code, attribute, units, genre, answered, contradiction, recorded_at) values (?,?,?,?,?,?,?)
    on conflict(subject_code, attribute) do update set units=excluded.units, genre=excluded.genre, answered=excluded.answered, contradiction=excluded.contradiction, recorded_at=excluded.recorded_at`);
  const attrs = {};
  const contradictions = [];
  const unknown = [];
  const now = new Date().toISOString();
  db.transaction(() => {
    for (const a of answers) {
      if (!expected.includes(a.attribute)) { unknown.push(a.attribute); continue; }
      const us = [...new Set(a.units ?? [])];
      const answered = a.answered ?? us.length > 0;
      const genres = a.genre ? [].concat(a.genre) : [...new Set(us.map((u) => genreOfDoc.get(u)?.genre).filter(Boolean))];
      if (answered) attrs[a.attribute] = genres.length > 1 ? genres : genres[0] ?? "tecnica";
      if (a.contradiction) contradictions.push({ attribute: a.attribute, units: us, texts: us.map((u) => textOf.get(u)?.text ?? null) });
      up.run(subject, a.attribute, JSON.stringify(us), genres.join(",") || null, answered ? 1 : 0, a.contradiction ? 1 : 0, now);
      if (us.length) linkSubjectUnits(db, subject, us);
    }
  })();
  if (unknown.length) throw new DigestInputError(`attributi non attesi per ${type}: ${unknown.join(", ")}`);
  const lvl = level ?? parseCode(subject)?.level ?? "S";
  const cov = coverage({ type, attrs }, { obsConfirmations: 0, execWithOutcome: 0, userStatements: 0, freshness: 1, openContradictions: contradictions.length });
  return { subject, type, attrs, coverage: cov, gaps: cov.gaps, contradictions, completeness: completeness(type, attrs, { level: lvl }) };
}

const HELP = `uso: node scripts/kb/digest-plan.mjs plan --db <file> --type <TIPO> --subject <codice> [--label <etichetta>] [--doc <DOC>] [--top 5] [--out <file>] [--json]
     node scripts/kb/digest-plan.mjs record-answers --db <file> --answers-file <file.yaml|json> [--out <file>] [--json]

plan            per il soggetto candidato e il suo tipo: una domanda per attributo atteso (banca di domande) con le
                5 unità migliori (FTS + prossimità di sezione), §19.11
record-answers  registra la copertura (attributo → unità + genere) in attribute_coverage: è l'input epistemico
                (vettore K, gaps) e l'esito di completezza DT-022 (digerito con gaps | quarantena)
                file: { subject, type, answers: [{ attribute, units: [U…], genre?, answered?, contradiction? }] }

Exit code: 0 ok · 1 errore utente (argomenti, tipo senza banca, attributi non attesi) · 2 errore di sistema.`;

function main(argv) {
  const [cmd, ...rest] = argv;
  const { opts } = parseArgs(rest);
  const asJson = !!opts.json;
  if (!cmd || cmd === "--help" || opts.help) { console.log(HELP); return cmd ? 0 : 1; }
  if (!["plan", "record-answers"].includes(cmd)) return fail(asJson, 1, `comando sconosciuto: ${cmd}`);
  if (!opts.db) return fail(asJson, 1, "richiesto --db <file>");
  let db;
  try { db = openDb(opts.db, { createIfMissing: false }); } catch (e) { return fail(asJson, 1, e.message); }
  try {
    let out;
    if (cmd === "plan") {
      if (!opts.type || !opts.subject) return fail(asJson, 1, "richiesti --type e --subject");
      out = planSubject(db, { subject: opts.subject, type: opts.type, label: opts.label ?? null, doc: opts.doc ?? null, top: Number(opts.top ?? 5) });
    } else {
      if (!opts["answers-file"]) return fail(asJson, 1, "richiesto --answers-file <file>");
      const txt = readFileSync(opts["answers-file"], "utf8");
      out = recordAnswers(db, /^\s*[{[]/.test(txt) ? JSON.parse(txt) : YAML.parse(txt));
    }
    if (opts.out) { mkdirSync(dirname(opts.out), { recursive: true }); writeFileSync(opts.out, YAML.stringify(out, { lineWidth: 0 })); }
    console.log(JSON.stringify({ ok: true, ...out }));
    return 0;
  } catch (e) {
    if (e instanceof DigestInputError) return fail(asJson, 1, e.message);
    return fail(asJson, 2, `errore di sistema: ${e.message ?? e}`);
  } finally { db.close(); }
}

if (isMain(import.meta.url)) process.exit(main(process.argv.slice(2)));
