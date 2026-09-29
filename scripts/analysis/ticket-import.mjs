// learn tickets <xlsx|csv> (§56.7, §1.1, F8) — WP09d. Estrazione dei ticket di esercizio con PSEUDONIMIZZAZIONE
// all'importazione (sale solo da JVC_PSEUDO_SALT): segnalante e assegnatario → PERS-…, id del ticket → TKT-…, email,
// numeri di documento, nomi del cliente e delle persone citati nel testo → token; i riferimenti a test (NRT.*) nel testo
// diventano "rif-test" (analysis/ non referenzia mai un test). XLSX con scripts/ingest/parse-xlsx.mjs (primo foglio con
// tabella), CSV con separatore , o ; e virgolette. Colonne riconosciute per alias (it/en).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve, extname, basename } from "node:path";
import { createHash } from "node:crypto";
import { pseudonymizer, saltFrom, PseudonymError } from "../digest/pseudonymize.mjs";
import { customerNames } from "../kb/lifecycle.mjs";
import { parseArgs, fail } from "../lib/args.mjs";
import { isMain } from "../lib/is-main.mjs";

export const COLUMNS = Object.freeze({
  id: ["id", "ticket", "ticket id", "ticket_id", "numero", "numero ticket", "n.", "key", "chiave", "incident", "case"],
  summary: ["summary", "titolo", "oggetto", "subject", "title", "sintomo", "symptom", "problema"],
  description: ["description", "descrizione", "dettaglio", "details", "testo"],
  module: ["module", "modulo", "componente", "component", "area", "applicazione"],
  error_code: ["error code", "error_code", "codice errore", "codice", "errore", "error"],
  immediate_cause: ["cause", "causa", "causa immediata", "immediate cause", "immediate_cause"],
  root_cause: ["root cause", "root_cause", "causa radice", "causa principale", "causa root"],
  resolution: ["resolution", "risoluzione", "soluzione", "fix", "workaround"],
  status: ["status", "stato"],
  created: ["created", "created at", "data apertura", "aperto il", "opened", "data"],
  reporter: ["reporter", "segnalante", "opened by", "richiedente", "requester", "utente"],
  assignee: ["assignee", "assegnatario", "assigned to", "owner", "incaricato"],
  scope: ["scope"],
});
const PEOPLE_COLS = ["reporter", "assignee"];
const TEXT_COLS = ["summary", "description", "immediate_cause", "root_cause", "resolution", "module", "error_code", "status"];
const NRT_TEXT = /\bNRT[.-][A-Z0-9.]+/g;
const norm = (s) => String(s ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

// CSV: separatore rilevato sulla prima riga (; o ,), virgolette doppie con "" come escape, a capo nelle virgolette.
export function parseCsv(text) {
  const src = String(text).replace(/^\uFEFF/, "");
  const first = src.split(/\r?\n/, 1)[0] ?? "";
  const sep = (first.match(/;/g) ?? []).length > (first.match(/,/g) ?? []).length ? ";" : ",";
  const rows = [];
  let row = [];
  let cell = "";
  let q = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === '"' && src[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c;
    } else if (c === '"') q = true;
    else if (c === sep) { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && src[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  const clean = rows.filter((r) => r.some((x) => String(x).trim() !== ""));
  return { headers: (clean[0] ?? []).map((h) => String(h).trim()), rows: clean.slice(1) };
}

export async function readTable(file) {
  const ext = extname(file).toLowerCase();
  if (ext === ".csv" || ext === ".txt") return parseCsv(readFileSync(file, "utf8"));
  if (ext === ".xlsx") {
    const { parseXlsx } = await import("../ingest/parse-xlsx.mjs");
    const doc = parseXlsx(readFileSync(file), { id: "TICKETS", title: basename(file) });
    const t = doc.sections.flatMap((s) => (s.hidden ? [] : s.tables ?? []))[0];
    if (!t) throw new Error("nessuna tabella nel file XLSX");
    return { headers: t.headers.map((h) => String(h).trim()), rows: t.rows };
  }
  throw new Error(`formato non supportato: ${ext} (xlsx | csv)`);
}

export function mapColumns(headers) {
  const map = {};
  headers.forEach((h, i) => {
    const n = norm(h);
    for (const [k, aliases] of Object.entries(COLUMNS)) if (map[k] === undefined && aliases.includes(n)) { map[k] = i; break; }
  });
  return map;
}

// → { columns, tickets[] } pseudonimizzati; ps: pseudonymizer del cliente.
export function importRows({ headers, rows }, { salt, customer, customerNames: names = [], people = [] }) {
  const cols = mapColumns(headers);
  if (cols.summary === undefined && cols.description === undefined) throw new Error("nessuna colonna di sintomo (summary/titolo/oggetto o descrizione)");
  const cell = (r, k) => (cols[k] === undefined ? null : String(r[cols[k]] ?? "").trim() || null);
  const found = new Set(people);
  for (const r of rows) for (const k of PEOPLE_COLS) { const v = cell(r, k); if (v) found.add(v); }
  const ps = pseudonymizer({ salt, customers: customer ? [customer] : [], customerNames: names, people: [...found] });
  const text = (s) => (s == null ? null : ps.text(String(s).replace(NRT_TEXT, "rif-test")));
  const tickets = rows.map((r, i) => {
    const t = { id: ps.token("ticket", cell(r, "id") ?? `riga-${i + 2}`) };
    for (const k of TEXT_COLS) t[k] = text(cell(r, k));
    t.created = cell(r, "created");
    for (const k of PEOPLE_COLS) { const v = cell(r, k); t[k] = v ? ps.token("person", v) : null; }
    t.scope = cell(r, "scope");
    return t;
  });
  return { columns: Object.fromEntries(Object.entries(cols).map(([k, i]) => [k, headers[i]])), tickets };
}

export const HELP = `uso: learn tickets <file.xlsx|file.csv> --customer <C> [--write] [--workspace <dir>] [--json]

Importa i ticket di esercizio (§1.1, F8) pseudonimizzandoli all'importazione (JVC_PSEUDO_SALT): persone e id dei ticket
diventano token, email, numeri di documento e nomi del cliente nel testo pure; i riferimenti a test diventano "rif-test".
--write: customers/<C>/analysis/_import/<data>-<impronta>.json (poi \`learn patterns\`).

Exit code: 0 ok · 1 errore d'uso o file illeggibile · 2 errore di sistema · 3 sale assente.`;

export async function run(argv, env = process.env) {
  const { opts, positional } = parseArgs(argv, { flags: ["write"] });
  const asJson = !!opts.json;
  if (opts.help) { console.log(HELP); return 0; }
  const file = positional[0] ?? opts.in;
  if (!file || !opts.customer || !/^[A-Z0-9]{4}$/.test(opts.customer)) return fail(asJson, 1, "richiesti <file.xlsx|csv> e --customer <C> (4 caratteri)");
  const ws = resolve(opts.workspace || env.JVC_WORKSPACE || env.CLAUDE_PROJECT_DIR || process.cwd());
  let salt;
  try { salt = saltFrom(env); } catch (err) { return fail(asJson, 3, err.message); }
  let table;
  try { table = await readTable(file); } catch (err) { return fail(asJson, 1, `file illeggibile: ${err.message}`); }
  try {
    const n = customerNames(ws, opts.customer);
    const r = importRows(table, { salt, customer: opts.customer, customerNames: n.customerNames, people: n.people });
    const out = { customer: opts.customer, imported_at: new Date().toISOString(), source_sha256: createHash("sha256").update(readFileSync(file)).digest("hex"), count: r.tickets.length, columns: r.columns, tickets: r.tickets };
    let written = null;
    if (opts.write) {
      const dir = join(ws, "customers", opts.customer, "analysis", "_import");
      mkdirSync(dir, { recursive: true });
      written = join(dir, `${out.imported_at.slice(0, 10)}-${out.source_sha256.slice(0, 8)}.json`);
      writeFileSync(written, JSON.stringify(out, null, 2) + "\n");
    }
    console.log(JSON.stringify({ ok: true, count: out.count, columns: out.columns, file: written, ...(opts.write ? {} : { tickets: out.tickets }) }));
    return 0;
  } catch (err) {
    if (err instanceof PseudonymError) return fail(asJson, 3, err.message);
    return fail(asJson, 1, err.message);
  }
}

if (isMain(import.meta.url)) run(process.argv.slice(2)).then((c) => { process.exitCode = c; });
