// scripts/kb/atlas-build.mjs — soluzione A (spec 2026-09-30 §A2): dal registro dell'esplorazione della sessione
// (customers/<C>/.sessions/<sid>/atlas/pages.jsonl, scritto solo da observe-append) a FLD, SEL e percorsi (FLW
// "Percorso: <pagina>") nella conoscenza del cliente, tramite writeDraft di atlas-write (validazione, doppioni, codici).
//   kb atlas-build --session <sid> [--scope <S>] [--customer <C>] [--workspace <dir>] [--json]
// Exit: 0 ok · 1 uso o registro assente · 2 sistema · 3 cliente diverso dalla sessione.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import YAML from "yaml";
import { writeDraft, AtlasWriteError } from "./atlas-write.mjs";
import { SCOPES } from "./codes.mjs";
import { isSafeSessionId } from "../../hooks/lib/workspace.mjs";
import { EFFECT_LABEL } from "../../hooks/lib/guards/config-scope.mjs";
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

const INPUT_ROLES = new Set(["textbox", "searchbox", "spinbutton", "combobox", "textarea", "listbox"]);
const groupOf = (role) => (INPUT_ROLES.has(role) ? "input" : role);

// Revisione finale (I3, I6, I7): tutte le visite di una pagina si uniscono (opzioni e obbligo visti in una visita
// qualsiasi); un'etichetta ripetuta nella stessa visita con lo stesso gruppo di ruolo è ambigua (nessun SEL, FLD marcato:
// compose-plan chiede invece di scegliere); un click su un'etichetta con effetto non diventa un arco di percorso.
export function buildDrafts(lines) {
  const pages = new Map();
  const edges = [];
  let pendingClick = null;
  for (const l of lines) {
    if (l.kind === "click") { pendingClick = l; continue; }
    if (l.kind !== "page" || !l.page_sig) continue;
    const name = pendingClick?.target?.name ?? "";
    if (pendingClick?.from_sig && pendingClick.from_sig !== l.page_sig && name && !EFFECT_LABEL.test(name)) edges.push({ from: pendingClick.from_sig, to: l.page_sig, name });
    pendingClick = null;
    const els = l.elements ?? [];
    // nome della pagina = titolo principale (h1), come il document dei suoi FLD: il percorso "Percorso: <nome>" e i campi
    // devono coincidere perché compose-plan li trovi insieme (il titolo della scheda ha spesso il nome del tenant)
    const document = els.find((e) => e.role === "heading" && e.level === 1 && e.name)?.name ?? l.title ?? l.page_sig;
    const p = pages.get(l.page_sig) ?? { title: l.title, document, url_path: l.url_path, visits: [] };
    p.visits.push(els);
    pages.set(l.page_sig, p);
  }
  const fields = [];
  const sels = [];
  for (const [sig, p] of pages) {
    const fmap = new Map();
    const smap = new Map();
    const ambiguous = new Set();
    for (const els of p.visits) {
      const sectionOf = (e) => {
        let q = e.parent;
        for (let hop = 0; q != null && hop < 200; hop++) { const a = els[q]; if (!a) break; if (SECTION_ROLES.has(a.role) && a.name) return a.name; q = a.parent; }
        return "principale";
      };
      const count = new Map();
      for (const e of els) {
        if (!e.name || (!SEL_ROLES.has(e.role) && !FIELD_TYPE[e.role])) continue;
        const k = `${groupOf(e.role)}|${normLabel(e.name)}`;
        count.set(k, (count.get(k) ?? 0) + 1);
      }
      for (const [k, n] of count) if (n > 1) ambiguous.add(k);
      for (const e of els) {
        if (!e.name) continue;
        const k = `${groupOf(e.role)}|${normLabel(e.name)}`;
        if (FIELD_TYPE[e.role]) {
          const f = fmap.get(k) ?? { type: "FLD", page_sig: sig, label: e.name, document: p.document, section: sectionOf(e), field_type: FIELD_TYPE[e.role], mandatory: "undocumented", options: [] };
          if (e.required) f.mandatory = "always";
          for (const o of els.filter((x) => x.parent === e.i && x.role === "option" && x.name)) if (!f.options.includes(o.name)) f.options.push(o.name);
          fmap.set(k, f);
        }
        if (SEL_ROLES.has(e.role) && !smap.has(k)) smap.set(k, { type: "SEL", page_sig: sig, label: e.name, role: e.role, ...(FIELD_TYPE[e.role] ? { fieldLabel: e.name, document: p.document } : {}) });
      }
    }
    for (const [k, f] of fmap) {
      if (!f.options.length) delete f.options;
      if (ambiguous.has(k)) f.ambiguous = true;
      fields.push(f);
    }
    for (const [k, sel] of smap) if (!ambiguous.has(k)) sels.push(sel);
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
        ...chain.map((c) => ({ kind: "click", name: c.name, role: (pages.get(c.from)?.visits ?? []).flat().find((el) => normLabel(el.name) === normLabel(c.name))?.role ?? "link", from_sig: c.from, to_sig: c.to }))] });
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
  // revisione finale (C1): mai un percorso costruito da valori non validati (sessione, cliente, scope)
  if (!isSafeSessionId(String(sid ?? ""))) throw new AtlasWriteError(1, `sessione non valida: ${sid}`);
  if (!/^[A-Z0-9]{4}$/.test(String(customer ?? ""))) throw new AtlasWriteError(1, `cliente non valido: ${customer}`);
  if (!SCOPES.has(scope)) throw new AtlasWriteError(1, `scope non valido: ${scope}`);
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
    if (opts.session != null && !isSafeSessionId(String(opts.session))) return fail(asJson, 1, `--session non valida: ${opts.session}`);
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
