// ops template-fill (spec 2026-10-06 §3.8): copia il file vuoto del TPL e scrive le righe nel foglio (stringhe inline;
// stili, convalide, celle unite e altri fogli intatti); prima controlla ogni riga e, con errori, non scrive nulla.
//   node scripts/decide/template-fill.mjs --tpl <codice> --data <righe.json|yaml> --out runs/<RUN>/import/<file>.xlsx --scope <S> [--customer C] [--workspace <dir>] [--json]
// Exit code: 0 scritto (stampa { path, sha256, rows }) · 1 uso · 2 sistema · 3 righe invalide (stampa errors).
// Il file scritto è quello che la guardia d'upload accetta: runs/<RUN>/import/<file>.xlsx con sha256 uguale a quello del
// piano, perciò si restituisce l'impronta dei byte esatti e un file già esistente non si riscrive mai.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import YAML from "yaml";
import { openZip } from "../ingest/lib/zip.mjs";
import { makeZip } from "../ingest/lib/zip-write.mjs";
import { parseXlsx } from "../ingest/parse-xlsx.mjs";
import { sheetPathOf, stripRowsBelow } from "../ingest/lib/xlsx-sheet.mjs";
import { templatesDir } from "../kb/template-learn.mjs";
import { SCOPES } from "../kb/codes.mjs";
import { parseArgs, fail } from "../lib/args.mjs";
import { isMain } from "../lib/is-main.mjs";
import { confineInputs, DATA_FILE_MAX } from "../lib/text-file.mjs";

const OUT = /^runs\/RUN\.[A-Z0-9]{4}\.\d{8}\.\d{4}\.[A-Z0-9]{3}\/import\/[A-Za-z0-9._-]+\.xlsx$/;
const TPL = /^C\.[A-Z0-9]{4}\.[A-Z0-9]{3}\.TPL\.\d{4}$/;
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const colName = (c) => { let s = ""; for (let n = c + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };
// i caratteri di controllo non ammessi in XML 1.0 si tolgono (un valore con \u0000 renderebbe il file illeggibile)
// eslint-disable-next-line no-control-regex
const sanitize = (v) => String(v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "");
const xmlText = (v) => esc(sanitize(v));
const same = (a, b) => String(a).replace(/\r\n?/g, "\n").trim() === String(b).replace(/\r\n?/g, "\n").trim();

// Ultima difesa: il file scritto si rilegge con parseXlsx e ogni valore deve essere nella riga e nella colonna attese;
// il suo sha256 è quello che la guardia d'upload considera valido, quindi un file monco non deve mai uscire.
// Se parseXlsx scambia la prima riga di dati per una seconda intestazione (euristica sui fogli con colonne vuote nell'intestazione),
// si rilegge una copia con una riga-sentinella numerica sotto l'intestazione: stesse celle, righe slittate di una.
function verifyFilled(buf, item, rows, headerRow, withSentinel) {
  const read = (b) => { try { return parseXlsx(b, { id: "verify" }).sections.find((s) => s.title === item.sheet)?.tables?.[0]; } catch (err) { throw new Error(`file compilato non rileggibile: ${err.message}`); } };
  let table = read(buf), skip = 0;
  if (table?.header_rows > 1) { table = read(withSentinel()); skip = 1; }
  const blank = (r) => item.columns.every((c) => r[c.name] == null || String(r[c.name]).trim() === "");
  let expected = rows.length;
  while (expected > 0 && blank(rows[expected - 1])) expected--;
  const got = (table?.rows ?? []).slice(skip);
  const fail = (why) => { throw new Error(`verifica del file compilato fallita: ${why}`); };
  if (!table || (table.start_row ?? 1) !== headerRow || table.header_rows > 1) fail("intestazione non rilevata dove atteso");
  if (got.length !== expected) fail(`righe rilette ${got.length}, attese ${expected}`);
  item.columns.forEach((c, k) => {
    const col = c.col ?? k;
    for (let i = 0; i < expected; i++) {
      const v = rows[i][c.name], a = got[i][col] ?? null;
      const empty = v == null || String(v).trim() === "";
      if (empty ? a != null : (c.type === "number" ? Number(a) !== Number(v) : !same(a, sanitize(v)))) fail(`riga ${i + 1}, colonna "${c.name}": riletto ${JSON.stringify(a)}`);
    }
  });
}

export function checkRows(item, rows) {
  const errors = [];
  const names = new Set(item.columns.map((c) => c.name));
  rows.forEach((r, i) => {
    const row = i + 1;
    for (const c of item.columns) {
      const v = r?.[c.name];
      const empty = v == null || String(v).trim() === "";
      if (c.required && empty) errors.push({ row, column: c.name, message: "obbligatorio" });
      if (!empty && c.values && !c.values.includes(String(v))) errors.push({ row, column: c.name, message: `valore fuori elenco (${c.values.join(", ")})` });
      if (!empty && c.type === "number" && !Number.isFinite(Number(v))) errors.push({ row, column: c.name, message: "atteso un numero" });
    }
    for (const k of Object.keys(r ?? {})) if (!names.has(k)) errors.push({ row, column: k, message: "colonna inesistente nel template" });
  });
  return errors;
}

export function fillTemplate({ ws, customer, scope, tpl, rows, out }) {
  if (!/^[A-Z0-9]{4}$/.test(String(customer ?? ""))) throw new Error(`cliente non valido: ${customer}`);
  if (!SCOPES.has(scope)) throw new Error(`scope non valido: ${scope}`);
  if (!TPL.test(String(tpl ?? ""))) throw new Error(`codice TPL non valido: ${tpl}`);
  if (!OUT.test(String(out ?? ""))) throw new Error("l'uscita deve stare in runs/<RUN>/import/<file>.xlsx");
  if (!Array.isArray(rows) || !rows.length || rows.some((r) => !r || typeof r !== "object" || Array.isArray(r))) throw new Error("--data: serve un array non vuoto di oggetti (una riga ciascuno)");
  const dir = templatesDir(ws, customer, scope);
  const yamlPath = join(dir, `${tpl}.yaml`);
  if (!existsSync(yamlPath)) throw new Error(`template ${tpl} non trovato in ${scope} del cliente ${customer}`);
  const item = YAML.parse(readFileSync(yamlPath, "utf8"));
  const errors = checkRows(item, rows);
  if (errors.length) return { ok: false, errors };
  const abs = join(ws, "customers", customer, out);
  if (existsSync(abs)) throw new Error(`${out} esiste già: il file legato a un piano non si riscrive (usa un nome nuovo)`);
  // item.file è "templates/files/<codice>.xlsx", relativo a scopes/<S>/ (la cartella che contiene templates/ = `dir`)
  const zip = openZip(readFileSync(join(dir, "..", item.file)));
  const headerRow = item.header_row ?? 1;
  // foglio dell'item: nome in workbook.xml → r:id → Target in workbook.xml.rels; nessun ripiego su sheet1.xml
  const sp = sheetPathOf(zip, item.sheet);
  if (sp.error === "unresolved") throw new Error(`foglio "${item.sheet}" non risolto nel file vuoto del template (nome o relazione mancante)`);
  if (sp.error) throw new Error(`foglio "${item.sheet}" non trovato nel file vuoto del template (${sp.path})`);
  const sheetPath = sp.path;
  let xml = zip.text(sheetPath);
  // prefisso di namespace del foglio (<x:sheetData>, <x:row>…): le celle nuove lo riprendono
  const sd = /<((?:\w+:)?)sheetData\b[^>]*?(\/)?>/.exec(xml);
  if (!sd) throw new Error("foglio senza <sheetData>: file vuoto del template non valido");
  const px = sd[1];
  const first = headerRow + 1;
  const colOf = (c, k) => c.col ?? k;
  const bodyOf = (shift) => rows.map((r, i) => {
    const n = first + shift + i;
    const cells = item.columns.map((c, k) => {
      const v = r[c.name];
      if (v == null || String(v).trim() === "") return "";
      const ref = `${colName(colOf(c, k))}${n}`;
      return c.type === "number" ? `<${px}c r="${ref}"><${px}v>${Number(v)}</${px}v></${px}c>` : `<${px}c r="${ref}" t="inlineStr"><${px}is><${px}t xml:space="preserve">${xmlText(v)}</${px}t></${px}is></${px}c>`;
    }).join("");
    return `<${px}row r="${n}">${cells}</${px}row>`;
  }).join("");
  // riga-sentinella numerica, solo per la verifica: impedisce a parseXlsx di leggere la prima riga di dati come seconda riga d'intestazione
  const sentinel = `<${px}row r="${first}"><${px}c r="A${first}"><${px}v>0</${px}v></${px}c></${px}row>`;
  // le righe d'esempio sotto l'intestazione si tolgono (anche vuote o senza r=); quelle fino all'intestazione restano
  // (helper condiviso con template-learn, che salva il file già ripulito: revisione finale I5)
  xml = stripRowsBelow(xml, headerRow);
  // i valori entrano con sostituzioni a funzione: "$&", "$'" e "$$" nei dati non sono pattern
  const withBody = (body) => xml.replace(/<((?:\w+:)?)sheetData\b[^>]*?(\/)?>(?:[\s\S]*?<\/(?:\w+:)?sheetData>)?/, (m, p, selfClosed) => {
    const open = m.slice(0, m.indexOf(">") + 1).replace(/\/>$/, ">");
    const inner = selfClosed ? "" : m.slice(open.length, m.lastIndexOf("</"));
    return open + inner + body + `</${p}sheetData>`;
  });
  const lastCol = colName(Math.max(...item.columns.map(colOf)));
  const withDim = (x, extra) => x.replace(/<((?:\w+:)?)dimension ref="([A-Z]+)(\d+)(?::[A-Z]+\d+)?"\s*\/>/, (_, p, c1, r1) => `<${p}dimension ref="${c1}${r1}:${lastCol}${Math.max(first + extra + rows.length - 1, headerRow)}"/>`);
  const bufOf = (x) => makeZip(zip.names.map((name) => ({ name, data: name === sheetPath ? Buffer.from(x, "utf8") : zip.read(name) })));
  const buf = bufOf(withDim(withBody(bodyOf(0)), 0));
  verifyFilled(buf, item, rows, headerRow, () => bufOf(withDim(withBody(sentinel + bodyOf(1)), 1)));
  mkdirSync(dirname(abs), { recursive: true });
  try { writeFileSync(abs, buf, { flag: "wx" }); } catch (err) { if (err?.code === "EEXIST") throw new Error(`${out} esiste già: il file legato a un piano non si riscrive (usa un nome nuovo)`); throw err; }
  return { ok: true, path: out, sha256: createHash("sha256").update(buf).digest("hex"), rows: rows.length };
}

const HELP = `uso: node scripts/decide/template-fill.mjs --tpl <codice TPL> --data <righe.json|yaml> --out runs/<RUN>/import/<file>.xlsx --scope <S> [--customer <C>] [--workspace <dir>] [--json]

Compila il template di caricamento (voce TPL del cliente) con le righe del file --data (array di oggetti: una chiave
per colonna) e scrive l'xlsx in customers/<C>/runs/<RUN>/import/. Ogni riga è controllata prima (obbligatori, valori
d'elenco, numeri, colonne inesistenti): con errori non si scrive nulla. Un file già esistente non si riscrive.

Exit code: 0 scritto · 1 uso · 2 sistema · 3 righe invalide.`;

export async function main(argv, env = process.env) {
  const { opts } = parseArgs(argv);
  const asJson = !!opts.json;
  if (opts.help) { console.log(HELP); return 0; }
  const ws = resolve(opts.workspace || env.JVC_WORKSPACE || env.CLAUDE_PROJECT_DIR || process.cwd());
  try {
    if (!opts.tpl || !opts.data || !opts.out || !opts.scope) return fail(asJson, 1, "richiesti --tpl --data --out --scope");
    const scope = String(opts.scope).toUpperCase();
    if (!SCOPES.has(scope)) return fail(asJson, 1, `scope non valido: ${opts.scope}`);
    const bad = confineInputs(opts, ["data"], { env, max: DATA_FILE_MAX });
    if (bad) return fail(asJson, 1, bad);
    const { resolveSessionId, loadSession } = await import("../admin/session.mjs");
    let session = null;
    try { const sid = resolveSessionId({ workspace: ws, arg: opts.session, env }); session = sid ? loadSession(ws, sid).session : null; } catch { session = null; }
    const customer = opts.customer ?? session?.customer;
    if (!customer) return fail(asJson, 1, "nessun cliente: --customer <C> o una sessione attiva");
    if (session?.customer && customer !== session.customer) return fail(asJson, 3, `--customer ${customer} diverso dal cliente della sessione (${session.customer})`);
    if (!existsSync(join(ws, "customers", customer))) return fail(asJson, 1, `cliente ${customer} non presente nel workspace`);
    let rows;
    try { const text = readFileSync(String(opts.data), "utf8").replace(/^\uFEFF/, ""); rows = /^\s*[[{]/.test(text) ? JSON.parse(text) : YAML.parse(text); } catch (err) { return fail(asJson, 1, `--data né JSON né YAML: ${String(err.message).slice(0, 80)}`); }
    const r = fillTemplate({ ws, customer, scope, tpl: String(opts.tpl), rows, out: String(opts.out) });
    if (!r.ok) {
      if (asJson) console.log(JSON.stringify({ ok: false, errors: r.errors }));
      else for (const e of r.errors) console.error(`riga ${e.row}, colonna "${e.column}": ${e.message}`);
      return 3;
    }
    console.log(JSON.stringify({ ok: true, path: r.path, sha256: r.sha256, rows: r.rows }));
    return 0;
  } catch (err) {
    const m = String(err?.message ?? err);
    // errori d'uso (argomenti, template assente, file già esistente) → 1; il resto è di sistema → 2
    return /^(cliente non valido|scope non valido|codice TPL non valido|l'uscita deve stare|--data:|template .* non trovato|.* esiste già|foglio ".*" non (trovato|risolto)|foglio senza|file compilato non rileggibile|verifica del file compilato)/.test(m) ? fail(asJson, 1, m) : fail(asJson, 2, `errore di sistema: ${m}`);
  }
}

if (isMain(import.meta.url)) process.exit(await main(process.argv.slice(2)));
