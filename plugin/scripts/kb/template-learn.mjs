// kb template-learn (spec 2026-10-06 §3.8): impara un template di caricamento massivo (xlsx) — foglio, intestazione,
// colonne, obbligatori, liste di valori — e lo salva come voce TPL del cliente, con il file vuoto accanto.
//   node scripts/kb/template-learn.mjs --file <xlsx> --object "<oggetto>" --scope <S> [--customer C] [--page <sig>] [--modulo <M>] [--fonte utente|tenant] [--json]
// Exit code: 0 scritto · 1 uso · 2 sistema.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import YAML from "yaml";
import { parseXlsx, rangeRef } from "../ingest/parse-xlsx.mjs";
import { SCOPES } from "./codes.mjs";
import { validateItem } from "./validate-schema.mjs";
import { parseArgs, fail } from "../lib/args.mjs";
import { isMain } from "../lib/is-main.mjs";
import { confineInputs } from "../lib/text-file.mjs";

const REQ = /\s*(\*|\((obbligatorio|required|mandatory)\))\s*$/i;
const norm = (s) => String(s ?? "").trim().toLowerCase();
export const templatesDir = (ws, customer, scope) => join(ws, "customers", customer, "kb", "scopes", scope, "templates");

export function learnTemplate({ ws, customer, scope, file, object, page = null, source = "utente", module = null, now = new Date() }) {
  if (!/^[A-Z0-9]{4}$/.test(String(customer ?? ""))) throw new Error(`cliente non valido: ${customer}`);
  if (!SCOPES.has(scope)) throw new Error(`scope non valido: ${scope}`);
  if (!String(object ?? "").trim()) throw new Error("serve --object (es. \"data element\")");
  if (!["utente", "tenant"].includes(source)) throw new Error("--fonte: utente o tenant");
  const buf = readFileSync(file);
  const doc = parseXlsx(buf, { id: "tpl" });
  const sec = doc.sections.find((s) => !s.hidden && s.tables?.length && s.tables[0].headers.some((h) => h));
  if (!sec) throw new Error("nessun foglio visibile con un'intestazione: non sembra un template di caricamento");
  const t = sec.tables[0];
  const lists = (sec.validations ?? []).filter((v) => v.type === "list" && Array.isArray(v.values) && v.values.length);
  const listFor = (c) => lists.find((v) => String(v.sqref).split(/\s+/).some((ref) => { const r = rangeRef(ref); return r && c >= r.c1 && c <= r.c2; }))?.values ?? null;
  const columns = t.headers.map((h, c) => {
    const values = listFor(c);
    const example = t.rows.find((r) => r[c] != null)?.[c] ?? null;
    return { name: String(h).replace(REQ, "").trim(), col: c, required: REQ.test(h), type: values ? "list" : typeof example === "number" ? "number" : "text", values, example };
  }).filter((c) => c.name);
  const d = templatesDir(ws, customer, scope);
  mkdirSync(join(d, "files"), { recursive: true });
  const prefix = `C.${customer}.${scope}.TPL.`;
  const yamls = readdirSync(d).filter((f) => f.startsWith(prefix) && f.endsWith(".yaml"));
  const existing = yamls.map((f) => { try { return YAML.parse(readFileSync(join(d, f), "utf8")); } catch { return null; } }).find((x) => x && norm(x.object) === norm(object));
  const maxSeq = yamls.reduce((m, f) => Math.max(m, Number(f.slice(prefix.length, prefix.length + 4)) || 0), 0);
  const code = existing?.id ?? `${prefix}${String(maxSeq + 1).padStart(4, "0")}`;
  const item = { id: code, type: "TPL", object: String(object).trim(), module, page, source, file: `templates/files/${code}.xlsx`,
    sha256: createHash("sha256").update(buf).digest("hex"), sheet: sec.title, header_row: t.start_row ?? 1, columns, learned_at: now.toISOString().slice(0, 10) };
  const v = validateItem(item);
  if (!v.ok) throw new Error(`voce TPL non valida: ${v.errors.join("; ")}`);
  copyFileSync(file, join(d, "files", `${code}.xlsx`));
  writeFileSync(join(d, `${code}.yaml`), YAML.stringify(item));
  return { code, item, blank: join(d, "files", `${code}.xlsx`) };
}

const HELP = `uso: node scripts/kb/template-learn.mjs --file <xlsx> --object "<oggetto>" --scope <S> [--customer <C>] [--page <sig>] [--modulo <M>] [--fonte utente|tenant] [--workspace <dir>] [--json]

Impara un template di caricamento massivo (foglio, riga d'intestazione, colonne, obbligatori marcati con "*" o
"(obbligatorio)", liste di valori dalle convalide) e lo salva come voce TPL in customers/<C>/kb/scopes/<S>/templates/,
con il file vuoto in templates/files/. Lo stesso oggetto aggiorna la voce esistente.

Exit code: 0 scritto · 1 uso · 2 sistema.`;

export async function main(argv, env = process.env) {
  const { opts } = parseArgs(argv);
  const asJson = !!opts.json;
  if (opts.help) { console.log(HELP); return 0; }
  const ws = resolve(opts.workspace || env.JVC_WORKSPACE || env.CLAUDE_PROJECT_DIR || process.cwd());
  try {
    if (!opts.file || !opts.object || !opts.scope) return fail(asJson, 1, "richiesti --file --object --scope");
    const scope = String(opts.scope).toUpperCase();
    if (!SCOPES.has(scope)) return fail(asJson, 1, `scope non valido: ${opts.scope}`);
    if (opts.fonte !== undefined && !["utente", "tenant"].includes(String(opts.fonte))) return fail(asJson, 1, "--fonte: utente o tenant");
    const bad = confineInputs(opts, ["file"], { env });
    if (bad) return fail(asJson, 1, bad);
    const { resolveSessionId, loadSession } = await import("../admin/session.mjs");
    let session = null;
    try { const sid = resolveSessionId({ workspace: ws, arg: opts.session, env }); session = sid ? loadSession(ws, sid).session : null; } catch { session = null; }
    const customer = opts.customer ?? session?.customer;
    if (!customer) return fail(asJson, 1, "nessun cliente: --customer <C> o una sessione attiva");
    if (session?.customer && customer !== session.customer) return fail(asJson, 3, `--customer ${customer} diverso dal cliente della sessione (${session.customer})`);
    if (!existsSync(join(ws, "customers", customer))) return fail(asJson, 1, `cliente ${customer} non presente nel workspace`);
    const r = learnTemplate({ ws, customer, scope, file: opts.file, object: String(opts.object), page: opts.page ? String(opts.page) : null,
      source: opts.fonte ? String(opts.fonte) : "utente", module: opts.modulo ? String(opts.modulo) : null });
    console.log(JSON.stringify({ ok: true, code: r.code, file: r.item.file, columns: r.item.columns.length, required: r.item.columns.filter((c) => c.required).map((c) => c.name) }));
    return 0;
  } catch (err) {
    const m = String(err?.message ?? err);
    // errori d'uso (argomenti, file non leggibile come template) → 1; il resto è di sistema → 2
    return /^(cliente non valido|scope non valido|serve --object|--fonte|nessun foglio visibile|voce TPL non valida)/.test(m) || err?.name === "ParseError" ? fail(asJson, 1, m) : fail(asJson, 2, `errore di sistema: ${m}`);
  }
}

if (isMain(import.meta.url)) process.exit(await main(process.argv.slice(2)));
