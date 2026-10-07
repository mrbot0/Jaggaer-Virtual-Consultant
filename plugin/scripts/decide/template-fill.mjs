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
import { templatesDir } from "../kb/template-learn.mjs";
import { SCOPES } from "../kb/codes.mjs";
import { parseArgs, fail } from "../lib/args.mjs";
import { isMain } from "../lib/is-main.mjs";
import { confineInputs, DATA_FILE_MAX } from "../lib/text-file.mjs";

const OUT = /^runs\/RUN\.[A-Z0-9]{4}\.\d{8}\.\d{4}\.[A-Z0-9]{3}\/import\/[A-Za-z0-9._-]+\.xlsx$/;
const TPL = /^C\.[A-Z0-9]{4}\.[A-Z0-9]{3}\.TPL\.\d{4}$/;
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const unesc = (s) => String(s).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const attr = (tag, name) => new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];
const colName = (c) => { let s = ""; for (let n = c + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };
// i caratteri di controllo non ammessi in XML 1.0 si tolgono (un valore con \u0000 renderebbe il file illeggibile)
// eslint-disable-next-line no-control-regex
const xmlText = (v) => esc(String(v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ""));

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
  // foglio dell'item: nome in workbook.xml → r:id → Target in workbook.xml.rels
  const wb = zip.text("xl/workbook.xml");
  const sheetTag = [...wb.matchAll(/<sheet\b[^>]*>/g)].map((m) => m[0]).find((t) => unesc(attr(t, "name") ?? "") === item.sheet);
  const rid = sheetTag && /\br:id="([^"]+)"/.exec(sheetTag)?.[1];
  const relTag = rid && [...zip.text("xl/_rels/workbook.xml.rels").matchAll(/<Relationship\b[^>]*>/g)].map((m) => m[0]).find((t) => attr(t, "Id") === rid);
  const target = relTag && attr(relTag, "Target");
  const sheetPath = target ? (target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`) : "xl/worksheets/sheet1.xml";
  if (!zip.has(sheetPath)) throw new Error(`foglio "${item.sheet}" non trovato nel file vuoto del template`);
  const first = headerRow + 1;
  const body = rows.map((r, i) => {
    const n = first + i;
    const cells = item.columns.map((c, k) => {
      const v = r[c.name];
      if (v == null || String(v).trim() === "") return "";
      return c.type === "number" ? `<c r="${colName(k)}${n}"><v>${Number(v)}</v></c>` : `<c r="${colName(k)}${n}" t="inlineStr"><is><t xml:space="preserve">${xmlText(v)}</t></is></c>`;
    }).join("");
    return `<row r="${n}">${cells}</row>`;
  }).join("");
  let xml = zip.text(sheetPath);
  // le righe d'esempio sotto l'intestazione si tolgono (anche vuote o senza r=); quelle fino all'intestazione restano
  let prev = 0;
  xml = xml.replace(/<row\b([^>]*?)(?:\/>|>[\s\S]*?<\/row>)/g, (m, attrs) => { const n = Number(attr(attrs, "r") ?? prev + 1); prev = n; return n > headerRow ? "" : m; });
  xml = /<sheetData\s*\/>/.test(xml) ? xml.replace(/<sheetData\s*\/>/, `<sheetData>${body}</sheetData>`) : xml.replace("</sheetData>", `${body}</sheetData>`);
  const last = first + rows.length - 1;
  xml = xml.replace(/<dimension ref="([A-Z]+)(\d+)(?::[A-Z]+\d+)?"\s*\/>/, (_, c1, r1) => `<dimension ref="${c1}${r1}:${colName(item.columns.length - 1)}${Math.max(last, headerRow)}"/>`);
  const buf = makeZip(zip.names.map((name) => ({ name, data: name === sheetPath ? Buffer.from(xml, "utf8") : zip.read(name) })));
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, buf, { flag: "wx" });
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
    return /^(cliente non valido|scope non valido|codice TPL non valido|l'uscita deve stare|--data:|template .* non trovato|.* esiste già|foglio ".*" non trovato)/.test(m) ? fail(asJson, 1, m) : fail(asJson, 2, `errore di sistema: ${m}`);
  }
}

if (isMain(import.meta.url)) process.exit(await main(process.argv.slice(2)));
