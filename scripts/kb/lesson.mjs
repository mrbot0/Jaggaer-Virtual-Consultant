// Lezioni (§21): parsing della forma fissa (frontmatter + otto sezioni) e validazione di §21.2
// con DT-004. Gli esiti, nell'ordine in cui la ragione viene riportata:
//   forma (frontmatter, otto sezioni, codici esistenti) → rejected: forma
//   §7 vuota                                             → rejected (la 7 è il test di serietà)
//   esiti attesi mancanti per una DEC con effetti        → rejected: non verificabile
//   analysis/, altri clienti, altro scope senza handoff  → rejected: confine
//   sorprese / ipotesi rifiutate non citate in §3        → rejected: non fondata (§17.3 narrazione a posteriori)
//   §7 incoerente con l'ipotesi di portabilità           → rejected: portabilità
//   duplicato di una lezione validata                    → merged (+1 conferma)
//   nessun artefatto candidato                           → validated: inerte
// La lezione la scrive l'agente; lo stato lo cambia solo questo script (§29.6).
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { sessionDir, isSafeSessionId } from "../../hooks/lib/workspace.mjs";
import { checkSessionText } from "../../hooks/lib/session-state.mjs";
import YAML from "yaml";
import { validateWith } from "../lib/schemas.mjs";
import { evaluate, loadTable, writeDecision } from "../decide/dt-eval.mjs";
import { parseCode } from "./codes.mjs";
import { openDb } from "./db.mjs";
import { declareExpected } from "../digest/outcomes.mjs";
import { parseArgs, fail } from "../lib/args.mjs";
import { isMain } from "../lib/is-main.mjs";
import { rootFromDb } from "../lib/root-from-db.mjs";

export const SECTION_TITLES = ["Contesto", "Cosa ho tentato", "Cosa ho osservato", "Decisioni prese", "Esito", "Lezione",
  "Cosa NON generalizzerei", "Domande aperte"];
export const ITEM_CODE_RE = /\b[SCL]\.[A-Z0-9]{3,4}\.[A-Z0-9]{3}\.[A-Z]{3}\.\d{4}(?:\.v\d+)?\b/g;
const RUN_CODE_RE = /\b(?:NRT|RUN|SES)\.([A-Z0-9]{3,4})\./g;
const ANALYSIS_TYPES = new Set(["PAT", "PBK", "BRF", "RUL"]);
const EMPTY_WORDS = /^(nessun[oa]?|niente|n\/?a|-|—|\.{3}|…|tbd|todo)\.?$/i;

// "agent: x · session: y" → due righe (§21.1 usa più chiavi per riga).
function expandCompact(yamlText) {
  return yamlText.split("\n").map((line) => (/^[A-Za-z_][\w]*:\s/.test(line) ? line.split(/ · (?=[A-Za-z_][\w]*:\s)/).join("\n") : line)).join("\n");
}

export function parseLesson(md) {
  const errors = [];
  const text = String(md ?? "").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const m = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)([\s\S]*)$/.exec(text);
  let frontmatter = null;
  let body = text;
  if (!m) errors.push("frontmatter assente");
  else {
    body = m[2];
    try {
      frontmatter = YAML.parse(expandCompact(m[1]));
      if (!frontmatter || typeof frontmatter !== "object" || Array.isArray(frontmatter)) { errors.push("frontmatter non è una mappa"); frontmatter = null; }
    } catch (e) { errors.push(`frontmatter YAML non valido: ${e.message}`); }
  }
  const sections = {};
  const titles = {};
  const re = /^##\s+(\d)\.\s*(.*)$/gm;
  const heads = [...body.matchAll(re)];
  heads.forEach((h, i) => {
    const start = h.index + h[0].length;
    const end = i + 1 < heads.length ? heads[i + 1].index : body.length;
    if (sections[h[1]] !== undefined) errors.push(`sezione ${h[1]} duplicata`);
    sections[h[1]] = body.slice(start, end).replace(/^\n/, "").trimEnd();
    titles[h[1]] = h[2].trim();
  });
  return { frontmatter, sections, titles, body, errors };
}

export function sectionEmpty(text) {
  const t = String(text ?? "").replace(/<!--[\s\S]*?-->/g, "").trim();
  return t === "" || EMPTY_WORDS.test(t);
}

const normalize = (s) => String(s ?? "").replace(/<!--[\s\S]*?-->/g, "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
  .replace(/[^a-z0-9.]+/g, " ").trim();
const codesIn = (s) => [...new Set(String(s ?? "").match(ITEM_CODE_RE) ?? [])];

export function subjectOf(lesson) {
  return lesson.frontmatter?.subject ?? codesIn(lesson.sections?.[1])[0] ?? lesson.frontmatter?.task ?? null;
}

// Reason in ordine di brief/§21.2; `code` = etichetta dell'esito (rejected: <code>).
// sessionError: la sessione della lezione non si è potuta leggere → la fondatezza (§17.3) non è verificabile.
export function validateLesson(lesson, { kbExists = () => true, sessionSurprises = 0, hypotheses = null, sessionError = null, validatedLessons = [], hasEffects = () => true } = {}) {
  const l = typeof lesson === "string" ? parseLesson(lesson) : lesson;
  const fm = l.frontmatter ?? {};
  const reasons = [];
  const add = (code, detail) => reasons.push({ code, detail });
  const lessonId = fm.id ?? null;
  const own = lessonId ? parseCode(lessonId) : null;
  const allText = `${YAML.stringify(fm)}\n${l.body ?? ""}`;

  // forma
  for (const e of l.errors ?? []) add("forma", e);
  const v = validateWith("lesson.schema.json", fm);
  if (!v.ok) for (const e of v.errors) add("forma", `frontmatter: ${e}`);
  for (let n = 1; n <= 8; n++) if (l.sections?.[n] === undefined) add("forma", `sezione ${n} (${SECTION_TITLES[n - 1]}) mancante`);
  const missing = codesIn(allText).filter((c) => c !== lessonId && !kbExists(c));
  if (missing.length) add("forma", `codici inesistenti: ${missing.join(", ")}`);
  // §7
  const s7empty = l.sections?.[7] !== undefined && sectionEmpty(l.sections[7]);
  if (s7empty) add("§7 vuota", "la sezione 7 (cosa NON generalizzerei) è vuota");
  // esiti attesi
  const declared = new Set((fm.expected_outcomes ?? []).filter((e) => e && typeof e.expect === "string" && e.expect.trim()).map((e) => e.decision));
  const undeclared = (fm.decision_refs ?? []).filter((d) => hasEffects(d) && !declared.has(d));
  if (undeclared.length) add("non verificabile", `esito atteso mancante per ${undeclared.join(", ")}`);
  // confini
  const bodyAndFm = allText;
  if (/(^|[\s/\\`'"(])analysis[/\\]/i.test(bodyAndFm)) add("confine", "cita analysis/ (dominio analitico)");
  const codes = codesIn(bodyAndFm);
  for (const c of codes) {
    const p = parseCode(c);
    if (!p) continue;
    if (ANALYSIS_TYPES.has(p.type)) add("confine", `cita ${c} (${p.type}: dominio analitico)`);
    else if (own && p.customer !== "STD" && p.customer !== own.customer) add("confine", `cita ${c} di un altro cliente`);
  }
  for (const mm of bodyAndFm.matchAll(RUN_CODE_RE)) if (own && mm[1] !== own.customer && mm[1] !== "STD") add("confine", `cita ${mm[0]}… di un altro cliente`);
  if (own) {
    const hasHandoff = codes.some((c) => parseCode(c)?.type === "HND");
    const outOfScope = codes.filter((c) => { const p = parseCode(c); return p && p.scope !== own.scope && p.scope !== "XSC" && !ANALYSIS_TYPES.has(p.type); });
    if (outOfScope.length && !hasHandoff) add("confine", `fuori scope senza handoff: ${outOfScope.join(", ")}`);
  }
  // fondatezza (§17.3): la lezione non racconta una linea retta che non c'è stata
  const s3 = l.sections?.[3] ?? "";
  if (sessionError) add("non fondata", `fondatezza non verificabile: ${sessionError}`);
  const surprisesCount = Number(sessionSurprises) || 0;
  if (surprisesCount > 0) {
    if ((fm.surprises ?? 0) < surprisesCount) add("non fondata", `la sessione ha registrato ${surprisesCount} sorprese, la lezione ne dichiara ${fm.surprises ?? 0}`);
    if (!/\b(?:[SCL]\.[A-Z0-9]{3,4}\.[A-Z0-9]{3}\.)?(?:OBS|CTR)\.\d{4}\b/.test(s3)) add("non fondata", "la §3 non cita nessuna OBS/CTR delle sorprese di sessione");
  }
  const refuted = (Array.isArray(hypotheses) ? hypotheses : hypotheses?.hypotheses ?? []).filter((h) => h.status === "refuted");
  const narrative = `${s3}\n${l.sections?.[4] ?? ""}\n${l.sections?.[6] ?? ""}`;
  for (const h of refuted) if (!new RegExp(`\\b${h.id}\\b`).test(narrative)) add("non fondata", `l'ipotesi rifiutata ${h.id} non compare nella lezione`);
  // portabilità: §7 coerente con l'ipotesi
  const ph = fm.portability_hypothesis;
  if (ph?.class === "condizionata" && ph.condition && !s7empty) {
    const tokens = String(ph.condition).match(/\bCL-[A-Z-]+-\d{3}\b|\bF(?:1[0-5]|[1-9])\b/g);
    const s7 = normalize(l.sections?.[7]);
    const coherent = tokens?.length
      ? tokens.some((t) => (l.sections?.[7] ?? "").includes(t))
      : normalize(ph.condition).split(" ").filter((w) => w.length >= 4).some((w) => s7.includes(w));
    if (!coherent) add("portabilità", `la §7 non cita la condizione dell'ipotesi condizionata (${ph.condition})`);
  }
  // novità
  const subj = subjectOf(l);
  const s6 = normalize(l.sections?.[6]);
  const dup = validatedLessons.map((x) => (typeof x === "string" ? parseLesson(x) : x))
    .find((x) => x.frontmatter?.id !== lessonId && (x.frontmatter?.status ?? "validated") === "validated" && subjectOf(x) === subj && s6 && normalize(x.sections?.[6]) === s6);
  // azionabilità
  const actionable = !!fm.cluster_proposal || (Array.isArray(fm.candidates) && fm.candidates.length > 0)
    || /\b(propo\w*|candidat\w*|CHK)\b/i.test(l.sections?.[6] ?? "");

  const has = (code) => reasons.some((r) => r.code === code);
  const inputs = {
    form_ok: !has("forma") && !has("§7 vuota"),
    grounded: !has("non fondata"),
    boundaries_ok: !has("confine"),
    portability_ok: !has("portabilità"),
    expected_outcomes_declared: !has("non verificabile"),
    novel: !dup,
    actionable,
  };
  const r = evaluate(loadTable("DT-004"), inputs);
  const order = ["forma", "§7 vuota", "non verificabile", "confine", "non fondata", "portabilità"];
  const primary = order.find(has) ?? null;
  const inert = r.combined.includes("inerte");
  const status = r.outcome;
  return {
    status,
    reason: status === "rejected" ? primary : status === "merged" ? "duplicato" : inert ? "inerte" : null,
    reasons,
    inert: status === "validated" && inert,
    merged_into: status === "merged" ? dup.frontmatter.id : null,
    dt: { table: r.table, table_version: r.table_version, outcome: r.outcome, score: r.score, rule: r.rule, inputs: r.inputs, result: r },
  };
}

// ——— CLI: learn validate ———
function kbExistsFromDb(db) {
  const stmts = ["items", "decisions", "lessons", "observations", "contradictions"].map((t) => db.prepare(`select 1 from ${t} where code=?`));
  return (code) => stmts.some((s) => s.get(code));
}

export function serializeLesson(fm, body) {
  return `---\n${YAML.stringify(fm).trimEnd()}\n---\n${body.startsWith("\n") ? body.slice(1) : body}`;
}

// La lezione cita la sessione col codice SES (§21.1); le cartelle di sessione sono per session_id di
// runtime (resolveSessionId, workspace.sessionDir: customers/<C>/.sessions/<sid>/). Si cerca prima la
// cartella del riferimento stesso (la lezione cita il sid), poi il session.json il cui `session_code` è
// il riferimento. Stesso predicato di hook e CLI (checkSessionText: JSON + schema + cliente + sid).
// Sessione non trovata o illeggibile → { error }, che la validazione riporta come motivo: mai "0 sorprese".
export function resolveLessonSession(root, ref, { customer } = {}) {
  if (typeof ref !== "string" || !ref) return { error: "la lezione non cita la sessione" };
  const up = dirname(root);
  const base = basename(up).toLowerCase() === "customers" && customer ? dirname(sessionDir(dirname(up), customer, "x")) : join(root, ".sessions");
  const load = (sid) => {
    const file = join(base, sid, "session.json");
    let text;
    try { text = readFileSync(file, "utf8"); } catch (e) { return e.code === "ENOENT" ? null : { error: `session.json della sessione ${sid} illeggibile: ${e.code ?? e.message}` }; }
    const c = checkSessionText(text, { customer, sid });
    return c.ok ? { sid, session: c.session } : { error: `session.json della sessione ${sid} illeggibile: ${c.reason}` };
  };
  let found = isSafeSessionId(ref) ? load(ref) : null;
  if (!found) {
    const unreadable = [];
    let dirs = [];
    try { dirs = readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory() && isSafeSessionId(d.name)).map((d) => d.name).sort(); } catch { dirs = []; }
    for (const sid of dirs) {
      const r = load(sid);
      if (!r) continue;
      if (r.error) { unreadable.push(r.error); continue; }
      if (r.session.session_code === ref) { found = r; break; }
    }
    if (!found) {
      return { error: `sessione ${ref} non trovata in ${base} (né come session_id né come session_code)${unreadable.length ? `; illeggibili: ${unreadable.join("; ")}` : ""}` };
    }
  }
  if (found.error) return found;
  const session = found.session;
  let hypotheses = null;
  const hfile = session.hypotheses_file ? join(root, session.hypotheses_file) : join(base, found.sid, "hypotheses.yaml");
  if (existsSync(hfile)) {
    try { hypotheses = YAML.parse(readFileSync(hfile, "utf8")); } catch (e) { return { error: `registro delle ipotesi della sessione ${found.sid} illeggibile: ${e.message}` }; }
  }
  return { sid: found.sid, surprises: (session.surprises ?? []).length, hypotheses };
}

export function validateLessons(db, root, { session, at = new Date().toISOString(), by = "lesson-validator" } = {}) {
  const dir = join(root, "lessons");
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => /^L\..*\.LSN\.\d{4}(\.v\d+)?\.md$/.test(f)).sort() : [];
  const parsed = files.map((f) => ({ file: join(dir, f), lesson: parseLesson(readFileSync(join(dir, f), "utf8")) }));
  const validated = parsed.filter((p) => p.lesson.frontmatter?.status === "validated").map((p) => p.lesson);
  const kbExists = kbExistsFromDb(db);
  const effectsStmt = db.prepare("select effects from decision_context where decision_code=?");
  // effetti ignoti (NULL: dt-eval senza --effects) contano come effetti: serve l'esito atteso.
  const hasEffects = (dec) => effectsStmt.get(dec)?.effects !== 0;
  const release = (() => { try { return JSON.parse(db.prepare("select value from meta where key='releases'").get()?.value ?? "[]").at(-1) ?? null; } catch { return null; } })();
  const results = [];
  for (const p of parsed) {
    const fm = p.lesson.frontmatter;
    if (!fm || (fm.status ?? "proposed") !== "proposed") continue;
    if (session && fm.session !== session) continue;
    const ctx = resolveLessonSession(root, fm.session, { customer: parseCode(fm.id ?? "")?.customer });
    const r = validateLesson(p.lesson, { kbExists, sessionSurprises: ctx.surprises ?? 0, hypotheses: ctx.hypotheses ?? null, sessionError: ctx.error ?? null,
      validatedLessons: validated, hasEffects });
    const own = parseCode(fm.id ?? "");
    let decCode = null;
    if (own) {
      decCode = writeDecision(db, { customer: own.customer, scope: own.scope, root, result: r.dt.result, agent: by, session: fm.session ?? null,
        subject: fm.id, at, context: { effects: false } });
    }
    const newFm = { ...fm, status: r.status, validation: { table: "DT-004", decision: decCode, reason: r.reason, reasons: r.reasons.map((x) => `${x.code}: ${x.detail}`), by, at } };
    if (r.merged_into) newFm.merged_into = r.merged_into;
    db.transaction(() => {
      db.prepare(`insert into lessons(code,agent,session,scope,status,payload,validated_by) values (?,?,?,?,?,?,?)
        on conflict(code) do update set status=excluded.status, payload=excluded.payload, validated_by=excluded.validated_by`)
        .run(fm.id ?? p.file, fm.agent ?? null, fm.session ?? null, fm.scope ?? null, r.status, JSON.stringify(newFm), by);
      if (r.status === "validated") {
        for (const e of fm.expected_outcomes ?? []) declareExpected(db, { dec: e.decision, expect: e.expect, lesson: fm.id, session: fm.session ?? null, release, at });
        validated.push({ ...p.lesson, frontmatter: newFm });
      }
      if (r.status === "merged") {
        const target = parsed.find((x) => x.lesson.frontmatter?.id === r.merged_into);
        if (target) {
          target.lesson.frontmatter.confirmations = (target.lesson.frontmatter.confirmations ?? 0) + 1;
          writeFileSync(target.file, serializeLesson(target.lesson.frontmatter, target.lesson.body));
        }
      }
      writeFileSync(p.file, serializeLesson(newFm, p.lesson.body));
    })();
    results.push({ code: fm.id, status: r.status, reason: r.reason, inert: r.inert, merged_into: r.merged_into, decision: decCode });
  }
  return results;
}

export const HELP = `uso: learn validate [--session SES…] [--root <cartella del cliente> | --customer <C>] --db <knowledge.db> [--json] [--help]

Valida le lezioni 'proposed' di <root>/lessons/ con DT-004 (§21.2): forma, §7, esiti attesi, confini,
fondatezza (sorprese e ipotesi rifiutate della sessione: <root>/.sessions/<sid>/ il cui session.json ha
session_id o session_code uguale alla sessione della lezione; non trovata o illeggibile → rejected), portabilità,
novità, azionabilità. Aggiorna lo stato nel frontmatter e nel DB, scrive la DEC di DT-004 e, per le
validate, registra gli esiti attesi (learn outcomes li verificherà).

Exit code: 0 ok · 1 errore utente (argomenti, DB assente) · 2 errore di sistema.`;

export function run(argv) {
  const { opts } = parseArgs(argv);
  const asJson = !!opts.json;
  if (opts.help) { console.log(HELP); return 0; }
  opts.root = rootFromDb(opts);
  if (!opts.root || !opts.db) return fail(asJson, 1, "richiesti --db e --root (default: customers/<C> se --db è customers/<C>/knowledge.db e --customer <C>)");
  let db;
  try { db = openDb(opts.db, { createIfMissing: false }); } catch (e) { return fail(asJson, 1, String(e.message ?? e)); }
  try {
    const results = validateLessons(db, opts.root, { session: opts.session });
    console.log(JSON.stringify(asJson ? { ok: true, results } : results));
    return 0;
  } catch (e) { return fail(asJson, 2, `errore di sistema: ${e.message ?? e}`); } finally { db.close(); }
}

if (isMain(import.meta.url)) process.exit(run(process.argv.slice(2)));
