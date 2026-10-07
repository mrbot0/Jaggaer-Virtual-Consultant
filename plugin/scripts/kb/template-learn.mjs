// kb template-learn (spec 2026-10-06 §3.8): impara un template di caricamento massivo (xlsx) — foglio, intestazione,
// colonne, obbligatori, liste di valori — e lo salva come voce TPL del cliente, con il file vuoto accanto.
//   node scripts/kb/template-learn.mjs --file <xlsx> --object "<oggetto>" --scope <S> --page <sig> [--tipo config|dati] [--customer C] [--modulo <M>] [--fonte utente|tenant] [--json]
// Exit code: 0 scritto · 1 uso · 2 sistema · 3 cliente diverso da quello della sessione.
// Revisione finale: il file salvato è sempre ripulito delle righe sotto l'intestazione (anche dalle shared strings) e
// l'impronta è la sua; `example` non salva mai valori di celle (Ruling F3: dati del cliente fuori da kb/); intestazione su
// più righe ⇒ rifiuto (Ruling F4: template-fill cancellerebbe la seconda riga); `kind` config|data (Ruling F1, predefinito
// config: fail-closed — un import di configurazione in produzione chiede l'istantanea dei dati attuali).
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import YAML from "yaml";
import { parseXlsx, rangeRef } from "../ingest/parse-xlsx.mjs";
import { blankTemplate } from "../ingest/lib/xlsx-sheet.mjs";
import { SCOPES } from "./codes.mjs";
import { validateItem } from "./validate-schema.mjs";
import { parseArgs, fail } from "../lib/args.mjs";
import { isMain } from "../lib/is-main.mjs";
import { confineInputs } from "../lib/text-file.mjs";

const REQ = /\s*(\*|\((obbligatorio|required|mandatory)\))\s*$/i;
const norm = (s) => String(s ?? "").trim().toLowerCase();
export const templatesDir = (ws, customer, scope) => join(ws, "customers", customer, "kb", "scopes", scope, "templates");
export const KINDS = Object.freeze(["config", "data"]);
const TIPO = { config: "config", dati: "data", data: "data" };

export function learnTemplate({ ws, customer, scope, file, object, page = null, source = "utente", module = null, kind = "config", now = new Date() }) {
  if (!/^[A-Z0-9]{4}$/.test(String(customer ?? ""))) throw new Error(`cliente non valido: ${customer}`);
  if (!SCOPES.has(scope)) throw new Error(`scope non valido: ${scope}`);
  if (!String(object ?? "").trim()) throw new Error("serve --object (es. \"data element\")");
  if (!["utente", "tenant"].includes(source)) throw new Error("--fonte: utente o tenant");
  if (!KINDS.includes(kind)) throw new Error("--tipo: config (oggetti di configurazione, predefinito) o dati (record di business)");
  const buf = readFileSync(file);
  const doc = parseXlsx(buf, { id: "tpl" });
  const sec = doc.sections.find((s) => !s.hidden && s.tables?.length && s.tables[0].headers.some((h) => h));
  if (!sec) throw new Error("nessun foglio visibile con un'intestazione: non sembra un template di caricamento");
  const t = sec.tables[0];
  if ((t.header_rows ?? 1) > 1) throw new Error(`intestazione su più righe nel foglio "${sec.title}" (${t.header_rows} righe): non supportata — template-fill cancellerebbe le righe d'intestazione sotto la prima. Semplifica il template a una sola riga d'intestazione (o usa il file vuoto scaricato dal tenant, senza righe di dati)`);
  const headerRow = t.start_row ?? 1;
  const lists = (sec.validations ?? []).filter((v) => v.type === "list" && Array.isArray(v.values) && v.values.length);
  const listFor = (c) => lists.find((v) => String(v.sqref).split(/\s+/).some((ref) => { const r = rangeRef(ref); return r && c >= r.c1 && c <= r.c2; }))?.values ?? null;
  const columns = t.headers.map((h, c) => {
    const values = listFor(c);
    // il primo valore della colonna serve solo a dedurre il tipo: non si salva (Ruling F3)
    const first = t.rows.find((r) => r[c] != null)?.[c] ?? null;
    return { name: String(h).replace(REQ, "").trim(), col: c, required: REQ.test(h), type: values ? "list" : typeof first === "number" ? "number" : "text", values, example: null };
  }).filter((c) => c.name);
  // il file salvato è il template SENZA righe di dati (Ruling F3): l'impronta è la sua
  const blank = blankTemplate(buf, sec.title, headerRow);
  const d = templatesDir(ws, customer, scope);
  mkdirSync(join(d, "files"), { recursive: true });
  const prefix = `C.${customer}.${scope}.TPL.`;
  const yamls = readdirSync(d).filter((f) => f.startsWith(prefix) && f.endsWith(".yaml"));
  const existing = yamls.map((f) => { try { return YAML.parse(readFileSync(join(d, f), "utf8")); } catch { return null; } }).find((x) => x && norm(x.object) === norm(object));
  const maxSeq = yamls.reduce((m, f) => Math.max(m, Number(f.slice(prefix.length, prefix.length + 4)) || 0), 0);
  const code = existing?.id ?? `${prefix}${String(maxSeq + 1).padStart(4, "0")}`;
  const item = { id: code, type: "TPL", object: String(object).trim(), kind, module, page, source, file: `templates/files/${code}.xlsx`,
    sha256: createHash("sha256").update(blank).digest("hex"), sheet: sec.title, header_row: headerRow, columns, learned_at: now.toISOString().slice(0, 10) };
  const v = validateItem(item);
  if (!v.ok) throw new Error(`voce TPL non valida: ${v.errors.join("; ")}`);
  writeFileSync(join(d, "files", `${code}.xlsx`), blank);
  writeFileSync(join(d, `${code}.yaml`), YAML.stringify(item));
  return { code, item, blank: join(d, "files", `${code}.xlsx`) };
}

const HELP = `uso: node scripts/kb/template-learn.mjs --file <xlsx> --object "<oggetto>" --scope <S> --page <sig> [--tipo config|dati] [--customer <C>] [--modulo <M>] [--fonte utente|tenant] [--workspace <dir>] [--json]

Impara un template di caricamento massivo (foglio, riga d'intestazione, colonne, obbligatori marcati con "*" o
"(obbligatorio)", liste di valori dalle convalide) e lo salva come voce TPL in customers/<C>/kb/scopes/<S>/templates/,
con il file vuoto in templates/files/. Lo stesso oggetto aggiorna la voce esistente.
  --page    firma della pagina di import (page_signature): compose-plan la usa per il percorso e i pulsanti
  --tipo    config (predefinito): oggetti di configurazione — in produzione l'import chiede l'istantanea dei dati
            attuali (compose-plan --istantanea); dati: record di business (fornitori, articoli…)
Il file salvato è sempre ripulito delle righe sotto l'intestazione e la voce non salva valori delle celle: un template
già compilato non porta dati del cliente nella knowledge. Un'intestazione su più righe è rifiutata.

Exit code: 0 scritto · 1 uso · 2 sistema · 3 cliente diverso da quello della sessione.`;

export async function main(argv, env = process.env) {
  const { opts } = parseArgs(argv);
  const asJson = !!opts.json;
  if (opts.help) { console.log(HELP); return 0; }
  const ws = resolve(opts.workspace || env.JVC_WORKSPACE || env.CLAUDE_PROJECT_DIR || process.cwd());
  try {
    if (!opts.file || !opts.object || !opts.scope) return fail(asJson, 1, "richiesti --file --object --scope --page");
    // minore della revisione finale: senza la pagina di import la voce non serve a compose-plan (nessun percorso né pulsanti)
    if (typeof opts.page !== "string" || !opts.page.trim()) return fail(asJson, 1, "richiesto --page <firma della pagina di import>: senza, compose-plan non trova percorso e pulsanti dell'import");
    const scope = String(opts.scope).toUpperCase();
    if (!SCOPES.has(scope)) return fail(asJson, 1, `scope non valido: ${opts.scope}`);
    if (opts.fonte !== undefined && !["utente", "tenant"].includes(String(opts.fonte))) return fail(asJson, 1, "--fonte: utente o tenant");
    const kind = opts.tipo === undefined ? "config" : TIPO[String(opts.tipo)];
    if (!kind) return fail(asJson, 1, "--tipo: config (oggetti di configurazione, predefinito) o dati (record di business)");
    const bad = confineInputs(opts, ["file"], { env });
    if (bad) return fail(asJson, 1, bad);
    const { resolveSessionId, loadSession } = await import("../admin/session.mjs");
    let session = null;
    try { const sid = resolveSessionId({ workspace: ws, arg: opts.session, env }); session = sid ? loadSession(ws, sid).session : null; } catch { session = null; }
    const customer = opts.customer ?? session?.customer;
    if (!customer) return fail(asJson, 1, "nessun cliente: --customer <C> o una sessione attiva");
    if (session?.customer && customer !== session.customer) return fail(asJson, 3, `--customer ${customer} diverso dal cliente della sessione (${session.customer})`);
    if (!existsSync(join(ws, "customers", customer))) return fail(asJson, 1, `cliente ${customer} non presente nel workspace`);
    const r = learnTemplate({ ws, customer, scope, file: opts.file, object: String(opts.object), page: String(opts.page).trim(), kind,
      source: opts.fonte ? String(opts.fonte) : "utente", module: opts.modulo ? String(opts.modulo) : null });
    console.log(JSON.stringify({ ok: true, code: r.code, kind: r.item.kind, file: r.item.file, columns: r.item.columns.length, required: r.item.columns.filter((c) => c.required).map((c) => c.name) }));
    return 0;
  } catch (err) {
    const m = String(err?.message ?? err);
    // errori d'uso (argomenti, file non leggibile come template, intestazione su più righe) → 1; il resto è di sistema → 2
    return /^(cliente non valido|scope non valido|serve --object|--fonte|--tipo|nessun foglio visibile|intestazione su più righe|foglio ".*" non (trovato|risolto)|voce TPL non valida)/.test(m) || err?.name === "ParseError" || err?.name === "ZipError" ? fail(asJson, 1, m) : fail(asJson, 2, `errore di sistema: ${m}`);
  }
}

if (isMain(import.meta.url)) process.exit(await main(process.argv.slice(2)));
