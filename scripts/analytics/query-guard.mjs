// Query Analytics consegnabili (§20.3, DT-015) — WP09d.
//   limit   — il testo SQL diventa UNA SELECT (o WITH … SELECT) di sola lettura con LIMIT: iniettato se manca, ridotto al
//             massimo se più alto; DML/DDL, più istruzioni, commenti che nascondono istruzioni ⇒ rifiutati.
//   record  — registra un'esecuzione (righe, coerenza con il profilo: coerente|parziale|incoerente, conoscenza delle
//             tabelle) in query_runs del DB del cliente.
//   check   — consegnabile solo se eseguita con LIMIT e giudicata coerente (DT-015); su tabelle ignote porta
//             l'avvertenza esplicita e non diventa QRY finché non è stata eseguita due volte con risultati coerenti.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { openDb } from "../kb/db.mjs";
import { evaluate, loadTable } from "../decide/dt-eval.mjs";
import { parseArgs, fail } from "../lib/args.mjs";
import { isMain } from "../lib/is-main.mjs";
import { readTextFile, inputBase } from "../lib/text-file.mjs";

export const DEFAULT_LIMIT = 1000;
export const MAX_LIMIT = 10000;
export const COHERENCE = ["coerente", "parziale", "incoerente"];
export const KNOWLEDGE = ["validate", "empiriche", "ignote"];
export const WARNING_UNKNOWN = "avvertenza: la query interroga tabelle ignote (nessuna TBL validata): il risultato va verificato; non diventa QRY finché non è stata eseguita due volte con risultati coerenti (§20.3)";
export class QueryError extends Error { constructor(m) { super(m); this.name = "QueryError"; } }

// (REPLACE come funzione di stringa è ammesso: REPLACE INTO è negato da INTO)
const FORBIDDEN = /\b(insert|update|delete|merge|upsert|drop|alter|create|truncate|grant|revoke|exec|execute|call|attach|detach|pragma|vacuum|copy|lock|unlock|set|use|commit|rollback|into)\b/i;
// Testo senza commenti e senza il contenuto delle stringhe (le parole chiave dentro una stringa non contano).
export function scrub(sql) {
  return String(sql).replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/'(?:[^']|'')*'/g, "''").replace(/"(?:[^"]|"")*"/g, '""');
}

// → { sql, limit, injected, capped }
export function ensureLimit(sql, { max: maxAsked = MAX_LIMIT, dflt = DEFAULT_LIMIT } = {}) {
  // giro 1 (m4): il massimo chiesto non supera mai MAX_LIMIT
  const max = Math.min(Number.isFinite(Number(maxAsked)) && Number(maxAsked) > 0 ? Number(maxAsked) : MAX_LIMIT, MAX_LIMIT);
  if (typeof sql !== "string" || !sql.trim()) throw new QueryError("testo SQL vuoto");
  let text = sql.trim().replace(/;\s*$/, "");
  const bare = scrub(text);
  if (/;/.test(bare)) throw new QueryError("più istruzioni in un testo: una query è UNA SELECT");
  if (!/^\s*(select|with)\b/i.test(bare)) throw new QueryError("solo SELECT (o WITH … SELECT) di sola lettura");
  const bad = FORBIDDEN.exec(bare);
  if (bad) throw new QueryError(`parola chiave non ammessa in una query di sola lettura: ${bad[1].toUpperCase()}`);
  const m = /\blimit\s+(\d+)(\s+offset\s+\d+)?\s*$/i.exec(bare) ?? /\bfetch\s+first\s+(\d+)\s+rows?\s+only\s*$/i.exec(bare);
  const top = /^\s*select\s+(?:distinct\s+)?top\s*\(?\s*(\d+)/i.exec(bare);
  const n = m ? Number(m[1]) : top ? Number(top[1]) : null;
  if (n == null) return { sql: `${text}\nLIMIT ${dflt}`, limit: dflt, injected: true, capped: false };
  if (n <= max && n > 0) return { sql: text, limit: n, injected: false, capped: false };
  const limit = max;
  if (m) text = text.replace(new RegExp(`${m[1]}(?=(\\s+offset\\s+\\d+)?\\s*(rows?\\s+only)?\\s*$)`, "i"), String(limit));
  else text = text.replace(/(top\s*\(?\s*)(\d+)/i, `$1${limit}`);
  return { sql: text, limit, injected: false, capped: true };
}

// Identità della query: testo normalizzato senza la clausola di limite (limiti diversi = stessa query).
export function queryHash(sql) {
  const norm = scrub(sql).replace(/;\s*$/, "").replace(/\blimit\s+\d+(\s+offset\s+\d+)?\s*$/i, "").replace(/\bfetch\s+first\s+\d+\s+rows?\s+only\s*$/i, "")
    .replace(/(^\s*select\s+(?:distinct\s+)?)top\s*\(?\s*\d+\s*\)?/i, "$1").replace(/\s+/g, " ").trim().toLowerCase();
  return createHash("sha256").update(norm).digest("hex").slice(0, 32);
}

export function recordRun(db, { sql, rowCount = null, coherence, tablesKnowledge = "ignote", tables = [], customer = null, session = null, note = null, at = new Date() }) {
  if (!COHERENCE.includes(coherence)) throw new QueryError(`coerenza non valida: ${coherence} (${COHERENCE.join(" | ")})`);
  if (!KNOWLEDGE.includes(tablesKnowledge)) throw new QueryError(`conoscenza delle tabelle non valida: ${tablesKnowledge} (${KNOWLEDGE.join(" | ")})`);
  // giro 1 (m2): il LIMIT registrato è quello del testo ESEGUITO (il file SQL è il testo che è girato): se il limite
  // mancava ed è solo stato calcolato, l'esecuzione è registrata senza limite (row_limit 0) e DT-015 dice no.
  const { limit: computed, injected } = ensureLimit(sql);
  const limit = injected ? 0 : computed;
  const hash = queryHash(sql);
  db.prepare(`insert into query_runs(query_hash, customer, executed_at, row_limit, row_count, coherence, tables, tables_knowledge, session, note)
    values (?,?,?,?,?,?,?,?,?,?)`).run(hash, customer, at.toISOString(), limit, rowCount, coherence, JSON.stringify(tables), tablesKnowledge, session, note);
  return { query_hash: hash, limit };
}

let DT015 = null;
export function deliverable(db, { sql, tablesKnowledge = null, patternKnown = false }) {
  DT015 ??= loadTable("DT-015");
  const hash = queryHash(sql);
  const runs = db.prepare("select executed_at, row_limit, row_count, coherence, tables_knowledge from query_runs where query_hash = ? order by id").all(hash);
  const last = runs.at(-1) ?? null;
  // giro 1 (m3): la conoscenza delle tabelle è quella REGISTRATA nelle esecuzioni (la peggiore); il chiamante può solo
  // abbassarla (più prudenza), mai alzarla (ignote → validate saltarebbe la regola delle due esecuzioni coerenti).
  const RANK = { validate: 0, empiriche: 1, ignote: 2 };
  const recorded = runs.reduce((w, r) => (RANK[r.tables_knowledge] > RANK[w] ? r.tables_knowledge : w), runs.length ? "validate" : "ignote");
  const knowledge = tablesKnowledge && RANK[tablesKnowledge] > RANK[recorded] ? tablesKnowledge : recorded;
  const coherentRuns = runs.filter((r) => r.coherence === "coerente" && r.row_limit > 0).length;
  if (!last) return { query_hash: hash, deliverable: false, reason: "query non eseguita: si consegna solo dopo un'esecuzione con LIMIT giudicata coerente (§20.3)", runs: 0, coherent_runs: 0, qry_eligible: false };
  const dt = evaluate(DT015, { coherence: last.coherence, tables_knowledge: knowledge, pattern_known: !!patternKnown, executed_with_limit: last.row_limit > 0 });
  const warn = knowledge === "ignote" || dt.combined.includes("avvertenza-tabelle-ignote");
  const qryEligible = dt.outcome === "sì" && (knowledge !== "ignote" || coherentRuns >= 2);
  return { query_hash: hash, deliverable: dt.outcome === "sì", reason: dt.outcome === "sì" ? null : `DT-015: no (${dt.rule}, coerenza ${last.coherence})`,
    warning: warn ? WARNING_UNKNOWN : null, runs: runs.length, coherent_runs: coherentRuns, qry_eligible: qryEligible, dt: { outcome: dt.outcome, score: dt.score, rule: dt.rule, combined: dt.combined } };
}

export const HELP = `uso: node scripts/analytics/query-guard.mjs limit  --sql-file <file.sql> [--max N] [--json]
     node scripts/analytics/query-guard.mjs record --db <knowledge.db> --sql-file <file.sql> --coherence coerente|parziale|incoerente
            --tables-knowledge validate|empiriche|ignote [--rows N] [--tables T1,T2] [--customer C] [--session SES] [--json]
     node scripts/analytics/query-guard.mjs check  --db <knowledge.db> --sql-file <file.sql> [--tables-knowledge …] [--pattern-known] [--json]

limit: una SELECT di sola lettura con LIMIT (iniettato se manca, al massimo ${MAX_LIMIT}); DML/DDL e più istruzioni rifiutati.
record: un'esecuzione della query (righe, coerenza con il profilo) nel DB del cliente.
check: consegnabile solo se eseguita con LIMIT e coerente (DT-015); tabelle ignote ⇒ avvertenza, QRY solo dopo 2 esecuzioni coerenti.
Il testo SQL si passa sempre da file (mai inline).

Exit code: 0 ok / consegnabile · 1 errore d'uso o SQL rifiutato · 2 errore di sistema · 3 non consegnabile.`;

export function run(argv) {
  const { opts, positional } = parseArgs(argv, { flags: ["pattern-known"] });
  const asJson = !!opts.json;
  if (opts.help) { console.log(HELP); return 0; }
  const [cmd] = positional;
  if (!["limit", "record", "check"].includes(cmd)) return fail(asJson, 1, `comando sconosciuto: ${cmd ?? "(nessuno)"} (limit | record | check)`);
  let sql;
  // WP10a giro 1 (minore 2): il file SQL sta nel workspace (percorsi fuori o .. che escono sono rifiutati)
  const wsq = inputBase();   // revisione finale: il workspace degli hook, mai --workspace
  const t = readTextFile(wsq, opts["sql-file"] ?? positional[1] ?? "", { max: 256 * 1024 });
  if (t.error) return fail(asJson, 1, `richiesto --sql-file <file.sql> leggibile nel workspace: ${t.error}`);
  sql = t.text;
  try {
    if (cmd === "limit") {
      const r = ensureLimit(sql, { max: opts.max ? Number(opts.max) : MAX_LIMIT });
      console.log(asJson ? JSON.stringify({ ok: true, ...r }) : r.sql);
      return 0;
    }
    if (!opts.db) return fail(asJson, 1, "richiesto --db <knowledge.db>");
    const db = openDb(opts.db);
    try {
      if (cmd === "record") {
        const r = recordRun(db, { sql, rowCount: opts.rows != null ? Number(opts.rows) : null, coherence: opts.coherence, tablesKnowledge: opts["tables-knowledge"],
          tables: opts.tables ? String(opts.tables).split(",").filter(Boolean) : [], customer: opts.customer ?? null, session: opts.session ?? null });
        console.log(JSON.stringify({ ok: true, ...r, ...deliverable(db, { sql }) }));
        return 0;
      }
      const r = deliverable(db, { sql, tablesKnowledge: opts["tables-knowledge"] ?? null, patternKnown: !!opts["pattern-known"] });
      console.log(JSON.stringify({ ok: r.deliverable, ...r }));
      return r.deliverable ? 0 : 3;
    } finally { db.close(); }
  } catch (err) {
    if (err instanceof QueryError) return fail(asJson, 1, err.message);
    return fail(asJson, 2, `errore di sistema: ${err?.message ?? err}`);
  }
}

if (isMain(import.meta.url)) process.exitCode = run(process.argv.slice(2));
