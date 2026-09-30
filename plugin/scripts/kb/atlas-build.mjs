// scripts/kb/atlas-build.mjs — soluzione A (spec 2026-09-30 §A2): dal registro dell'esplorazione della sessione
// (customers/<C>/.sessions/<sid>/atlas/pages.jsonl, scritto solo da observe-append) a FLD, SEL e percorsi (FLW
// "Percorso: <pagina>") nella conoscenza del cliente, tramite writeDraft di atlas-write (validazione, doppioni, codici).
//   kb atlas-build --session <sid> [--scope <S>] [--customer <C>] [--workspace <dir>] [--json]
// Exit: 0 ok · 1 uso o registro assente · 2 sistema · 3 cliente diverso dalla sessione.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import YAML from "yaml";
import { writeDraft, AtlasWriteError } from "./atlas-write.mjs";
import { normLabel } from "../chrome/snapshot-parse.mjs";
import { parseArgs, fail } from "../lib/args.mjs";
import { isMain } from "../lib/is-main.mjs";

const SEL_ROLES = new Set(["button", "link", "menuitem", "tab", "checkbox", "radio", "combobox", "textbox", "searchbox", "spinbutton", "switch", "textarea"]);
const FIELD_TYPE = { textbox: "text", textarea: "text", spinbutton: "number", combobox: "list", listbox: "list", checkbox: "flag", switch: "flag", searchbox: "lookup" };
const SECTION_ROLES = new Set(["group", "region", "form", "tabpanel"]);
const sigPath = (sig) => String(sig ?? "").split("#")[0];

export function readLog(file) {
  return readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

export function buildDrafts(lines) {
  const pages = new Map();
  const fields = [];
  const sels = [];
  const edges = [];
  let pendingClick = null;
  for (const l of lines) {
    if (l.kind === "click") { pendingClick = l; continue; }
    if (l.kind !== "page" || !l.page_sig) continue;
    if (pendingClick?.from_sig && pendingClick.from_sig !== l.page_sig) edges.push({ from: pendingClick.from_sig, to: l.page_sig, name: pendingClick.target?.name });
    pendingClick = null;
    const first = !pages.has(l.page_sig);
    const els = l.elements ?? [];
    // nome della pagina = titolo principale (h1), come il document dei suoi FLD: il percorso "Percorso: <nome>" e i campi
    // devono coincidere perché compose-plan li trovi insieme (il titolo della scheda ha spesso il nome del tenant)
    const document = els.find((e) => e.role === "heading" && e.level === 1 && e.name)?.name ?? l.title ?? l.page_sig;
    pages.set(l.page_sig, { title: l.title, document, url_path: l.url_path, elements: els });
    if (!first) continue;
    const sectionOf = (e) => {
      let p = e.parent;
      for (let hop = 0; p != null && hop < 200; hop++) { const a = els[p]; if (!a) break; if (SECTION_ROLES.has(a.role) && a.name) return a.name; p = a.parent; }
      return "principale";
    };
    for (const e of els) {
      if (!e.name) continue;
      if (FIELD_TYPE[e.role]) {
        const options = els.filter((o) => o.parent === e.i && o.role === "option" && o.name).map((o) => o.name);
        fields.push({ type: "FLD", page_sig: l.page_sig, label: e.name, document, section: sectionOf(e), field_type: FIELD_TYPE[e.role], mandatory: e.required ? "always" : "undocumented", ...(options.length ? { options } : {}) });
      }
      if (SEL_ROLES.has(e.role)) sels.push({ type: "SEL", page_sig: l.page_sig, label: e.name, role: e.role, ...(FIELD_TYPE[e.role] ? { fieldLabel: e.name, document } : {}) });
    }
  }
  const entry = lines.find((l) => l.kind === "page" && l.page_sig)?.page_sig ?? null;
  const routes = [];
  if (entry) {
    const prev = new Map([[entry, null]]);
    const queue = [entry];
    while (queue.length) {
      const cur = queue.shift();
      for (const e of edges.filter((x) => x.from === cur)) if (!prev.has(e.to)) { prev.set(e.to, e); queue.push(e.to); }
    }
    for (const [sig, e] of prev) {
      if (!e) continue;
      const chain = [];
      for (let x = e; x; x = prev.get(x.from)) chain.unshift(x);
      routes.push({ page_sig: sig, title: pages.get(sig)?.document ?? sig, steps: [{ kind: "navigate", url_path: pages.get(entry)?.url_path ?? "/", sig: entry },
        ...chain.map((c) => ({ kind: "click", name: c.name, role: (pages.get(c.from)?.elements ?? []).find((el) => normLabel(el.name) === normLabel(c.name))?.role ?? "link", from_sig: c.from, to_sig: c.to }))] });
    }
  }
  return { pages, fields, sels, routes };
}

function scopeItems(ws, customer, scope, dir) {
  const d = join(ws, "customers", customer, "kb", "scopes", scope, dir);
  if (!existsSync(d)) return [];
  return readdirSync(d).filter((f) => f.endsWith(".yaml")).map((f) => { try { return YAML.parse(readFileSync(join(d, f), "utf8")); } catch { return null; } }).filter(Boolean);
}

export function atlasBuild({ ws, customer, scope, sid }) {
  const file = join(ws, "customers", customer, ".sessions", sid, "atlas", "pages.jsonl");
  if (!existsSync(file)) throw new AtlasWriteError(1, `nessun registro dell'esplorazione per la sessione ${sid}`);
  const d = buildDrafts(readLog(file));
  const written = [];
  const skipped = [];
  const add = (r) => { written.push(...r.written); skipped.push(...r.skipped); };
  for (const sig of new Set(d.fields.map((f) => f.page_sig))) {
    const items = d.fields.filter((f) => f.page_sig === sig).map(({ page_sig, ...f }) => f);
    add(writeDraft({ ws, customer, scope, draft: { page: { signature: sig, title: d.pages.get(sig)?.title }, items } }));
  }
  const flds = scopeItems(ws, customer, scope, "fields");
  const fldCode = (label, document) => flds.find((f) => normLabel(f.label?.it) === normLabel(label) && normLabel(f.document) === normLabel(document))?.id;
  for (const sig of new Set(d.sels.map((s) => s.page_sig))) {
    const items = d.sels.filter((s) => s.page_sig === sig).map(({ page_sig, fieldLabel, document, ...s }) => {
      const code = fieldLabel ? fldCode(fieldLabel, document) : null;
      return code ? { ...s, field: code } : s;
    });
    add(writeDraft({ ws, customer, scope, draft: { page: { signature: sig, title: d.pages.get(sig)?.title }, items } }));
  }
  const sels = scopeItems(ws, customer, scope, "selectors");
  const selCode = (name, sig) => sels.find((s) => normLabel(s.label) === normLabel(name) && (!s.page || s.page === sig))?.id;
  const haveTitles = new Set(scopeItems(ws, customer, scope, "flows").map((f) => f.title));
  const flws = [];
  for (const r of d.routes) {
    const title = `Percorso: ${r.title}`.slice(0, 140);
    if (haveTitles.has(title)) { skipped.push({ type: "FLW", label: title, existing: "stesso titolo" }); continue; }
    const steps = [];
    let ok = true;
    for (const s of r.steps) {
      if (s.kind === "navigate") steps.push({ verb: "NAVIGATE", action_class: "ACT-OBS", target: { url_pattern: s.url_path }, expect: { page_sig: sigPath(s.sig) } });
      else {
        const code = selCode(s.name, s.from_sig);
        if (!code) { ok = false; break; }
        steps.push({ verb: "CLICK", action_class: "ACT-OBS", target: code, expect: { page_sig: sigPath(s.to_sig) } });
      }
    }
    if (ok) flws.push({ type: "FLW", title, trigger: "navigazione", steps });
    else skipped.push({ type: "FLW", label: title, existing: "passo senza selettore" });
  }
  if (flws.length) add(writeDraft({ ws, customer, scope, draft: { items: flws } }));
  return { pages: d.pages.size, written, skipped };
}

export const HELP = `uso: kb atlas-build --session <sid> [--scope <S>] [--customer <C>] [--workspace <dir>] [--json]

Dal registro dell'esplorazione della sessione (scritto da observe-append) alla mappa nella conoscenza del cliente:
FLD (tipo, obbligo, sezione, valori delle tendine), SEL (legati ai campi, effetto dall'etichetta) e percorsi di
navigazione "Percorso: <pagina>" (FLW). Doppioni scartati; seconda esecuzione sulla stessa sessione senza item nuovi.

Exit code: 0 ok · 1 uso o registro assente · 2 sistema · 3 cliente diverso dalla sessione.`;

export async function main(argv, env = process.env) {
  const { opts } = parseArgs(argv);
  const asJson = !!opts.json;
  if (opts.help) { console.log(HELP); return 0; }
  const ws = resolve(opts.workspace || env.JVC_WORKSPACE || env.CLAUDE_PROJECT_DIR || process.cwd());
  try {
    const { resolveSessionId, loadSession } = await import("../admin/session.mjs");
    let sid = opts.session ?? null;
    try { sid ??= resolveSessionId({ workspace: ws, arg: null, env }); } catch { /* nessuna sessione attiva */ }
    if (!sid) return fail(asJson, 1, "--session <sid> obbligatorio (nessuna sessione attiva)");
    let session = null;
    try { session = loadSession(ws, sid).session ?? null; } catch { session = null; }
    const customer = opts.customer ?? session?.customer;
    if (!customer) return fail(asJson, 1, "nessun cliente: --customer <C> o una sessione attiva");
    if (session?.customer && customer !== session.customer) return fail(asJson, 3, `--customer ${customer} diverso dal cliente della sessione (${session.customer})`);
    const scope = String(opts.scope ?? session?.scope ?? "").toUpperCase();
    const r = atlasBuild({ ws, customer, scope, sid: String(sid) });
    console.log(JSON.stringify({ ok: true, customer, scope, pages: r.pages, written: r.written.length, skipped: r.skipped.length, ...(asJson ? r : {}) }));
    return 0;
  } catch (err) {
    if (err instanceof AtlasWriteError) return fail(asJson, err.code, err.message);
    return fail(asJson, 2, `errore di sistema: ${err?.message ?? err}`);
  }
}

if (isMain(import.meta.url)) process.exit(await main(process.argv.slice(2)));
