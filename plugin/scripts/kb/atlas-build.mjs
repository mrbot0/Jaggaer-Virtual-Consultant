// scripts/kb/atlas-build.mjs — soluzione A (spec 2026-09-30 §A2): dal registro dell'esplorazione della sessione
// (customers/<C>/.sessions/<sid>/atlas/pages.jsonl, scritto solo da observe-append) a FLD, SEL e percorsi (FLW
// "Percorso: <pagina>") nella conoscenza del cliente, tramite writeDraft di atlas-write (validazione, doppioni, codici).
//   kb atlas-build --session <sid> [--scope <S>] [--customer <C>] [--workspace <dir>] [--json]
// Exit: 0 ok · 1 uso o registro assente · 2 sistema · 3 cliente diverso dalla sessione.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import YAML from "yaml";
import { writeDraft, enrichField, AtlasWriteError } from "./atlas-write.mjs";
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
// valori di una tendina: solo se aperta (≥ 2 opzioni) e mai per elenchi di persone (dati, non struttura)
const PERSON_LABEL = /\b(richiedente|utente|user|buyer|acquirente|approvatore|approver|requester|owner|proprietario|assegnatario|assignee|referente|contatto|contact|responsabile|creato da|created by|nominativo|nome e cognome|dipendente|employee|richiesto da|approvato da|delegato|delegate|manager|persona|person)\b/i;
const CREATE_DOC = /\b(crea|creare|creazione|nuov[oaie]|new|create)\b/i;
const SAVE_LABEL = /\b(salva|save)\b/i;
const SEND_LABEL = /\b(invia|inoltra|trasmetti|submit|send|conferma|confirm|approva|approve|pubblica|publish|place order)\b/i;
const MASK = /\[[a-z][a-z.-]*\]/i;
const BREADCRUMB = /\b(breadcrumbs?|briciole|percorso|sei qui|you are here)\b/i;
const MODULE_SEP = " › ";
const ROOT_CRUMB = /^(home|pagina iniziale|inizio|start|dashboard)$/i;
const clipModule = (m) => (m ? String(m).replace(/\s+/g, " ").trim().slice(0, 120) : null);
const moduleKey = (m) => m ?? "";

// Modulo di una pagina (richiesta dell'utente, 30/09/2026): dalle briciole di pane dell'ultima visita (al più due livelli,
// senza la pagina stessa), altrimenti dal percorso di menu: i click verso pagine che non sono moduli di creazione, al più due.
function breadcrumbModule(els, document) {
  const nav = els.find((e) => e.role === "navigation" && BREADCRUMB.test(String(e.name ?? "")));
  if (!nav) return null;
  const inside = (e) => { let q = e.parent; for (let hop = 0; q != null && hop < 200; hop++) { if (q === nav.i) return true; q = els[q]?.parent; } return false; };
  // revisione del modulo: niente radice (Home…), niente livelli con numeri o dati oscurati (record, persone), mai la pagina
  const names = els.filter((e) => e.role === "link" && e.name && inside(e)).map((e) => e.name)
    .filter((n) => normLabel(n) !== normLabel(document) && !ROOT_CRUMB.test(String(n).trim()) && !/\d/.test(n) && !MASK.test(n));
  return names.length ? names.slice(0, 2).join(MODULE_SEP) : null;
}

// Revisione finale (I3, I6, I7): tutte le visite di una pagina si uniscono (opzioni e obbligo visti in una visita
// qualsiasi); un'etichetta ripetuta nella stessa visita con lo stesso gruppo di ruolo è ambigua (nessun SEL, FLD marcato:
// compose-plan chiede invece di scegliere); un click su un'etichetta con effetto non diventa un arco di percorso.
// tipo di un campo di testo dagli indizi della pagina (05/10/2026): data o numero da nome, aiuto, segnaposto o valore
const DATE_HINT = /(gg\/mm|dd\/mm|mm\/dd|\bdata\b|\bdate\b)/i;
const DATE_VALUE = /^\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}$|^\d{4}-\d{2}-\d{2}$/;
const NUMBER_HINT = /(quantit|importo|prezzo|amount|qty|quantity|price|valore|totale|total)/i;
function fieldTypeOf(e) {
  const base = FIELD_TYPE[e.role];
  if (base !== "text" || e.multiline) return base;
  const hints = `${e.name ?? ""} ${e.help ?? ""} ${e.placeholder ?? ""}`;
  if (DATE_HINT.test(hints) || DATE_VALUE.test(String(e.sample ?? ""))) return "date";
  // il numero solo dagli indizi: un valore numerico da solo (codici, CAP, numeri d'ordine) non fa di un campo un numero
  if (NUMBER_HINT.test(hints)) return "number";
  return base;
}

export function buildDrafts(lines, { knownModules = new Map() } = {}) {
  const pages = new Map();
  const edges = [];
  const effects = [];
  let pendingClick = null;
  // revisione 05/10/2026 (I5): ogni azione con effetto entra subito nell'elenco; la pagina successiva ne completa il
  // risultato (anche di più azioni di fila); quelle in coda restano con risultato null
  let openEffects = [];
  for (const l of lines) {
    if (l.kind === "click") {
      if (l.effect) { const e = { from: l.from_sig ?? null, to: null, action: l.target?.name ?? "", ts: l.ts ?? null, ...(l.uncertain ? { uncertain: true } : {}) }; effects.push(e); openEffects.push(e); }
      // un click su un record (riga, cella) non diventa mai un arco di percorso: è un dato, non la navigazione (e chiude
      // l'arco di un click precedente)
      pendingClick = l.record ? null : l;
      continue;
    }
    if (l.kind !== "page" || !l.page_sig) continue;
    const name = pendingClick?.target?.name ?? "";
    if (pendingClick?.from_sig && pendingClick.from_sig !== l.page_sig && name && !EFFECT_LABEL.test(name)) edges.push({ from: pendingClick.from_sig, to: l.page_sig, name });
    for (const e of openEffects) e.to = l.page_sig;
    pendingClick = null;
    openEffects = [];
    const els = l.elements ?? [];
    // nome della pagina = titolo principale (h1), come il document dei suoi FLD: il percorso "Percorso: <nome>" e i campi
    // devono coincidere perché compose-plan li trovi insieme (il titolo della scheda ha spesso il nome del tenant)
    const document = els.find((e) => e.role === "heading" && e.level === 1 && e.name)?.name ?? l.title ?? l.page_sig;
    const p = pages.get(l.page_sig) ?? { title: l.title, document, url_path: l.url_path, visits: [], unlabeled: 0, iframes: 0, masked: false };
    p.visits.push(els);
    // seconda revisione: lo stato "da fare" viene dall'ULTIMA visita (così l'elenco si svuota quando l'agente rimedia)
    p.unlabeled = els.filter((e) => FIELD_TYPE[e.role] && !e.name).length;
    p.iframes = Number(l.iframes) || 0;
    p.masked = els.some((e) => MASK.test(String(e.name ?? "")));
    pages.set(l.page_sig, p);
  }
  // percorsi (BFS dall'ingresso) prima dei campi: servono anche per il modulo di ogni pagina
  const entry = lines.find((l) => l.kind === "page" && l.page_sig)?.page_sig ?? null;
  const prev = new Map(entry ? [[entry, null]] : []);
  if (entry) {
    const queue = [entry];
    while (queue.length) {
      const cur = queue.shift();
      for (const e of edges.filter((x) => x.from === cur)) if (!prev.has(e.to)) { prev.set(e.to, e); queue.push(e.to); }
    }
  }
  const chainOf = (sig) => { const chain = []; for (let x = prev.get(sig); x; x = prev.get(x.from)) chain.unshift(x); return chain; };
  for (const [sig, p] of pages) {
    const last = p.visits.at(-1) ?? [];
    const menu = chainOf(sig).filter((c) => !CREATE_DOC.test(pages.get(c.to)?.document ?? "")).map((c) => c.name).slice(0, 2);
    // il modulo è della PAGINA, non della strada fatta: quello già memorizzato per questa firma vince (revisione del modulo)
    p.module = clipModule(knownModules.get(sig) ?? breadcrumbModule(last, p.document) ?? (menu.length ? menu.join(MODULE_SEP) : null));
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
        if (e.record || !e.name || (!SEL_ROLES.has(e.role) && !FIELD_TYPE[e.role])) continue;
        const k = `${groupOf(e.role)}|${normLabel(e.name)}`;
        count.set(k, (count.get(k) ?? 0) + 1);
      }
      for (const [k, n] of count) if (n > 1) ambiguous.add(k);
      for (const e of els) {
        if (!e.name || e.record) continue;
        const k = `${groupOf(e.role)}|${normLabel(e.name)}`;
        if (FIELD_TYPE[e.role]) {
          const f = fmap.get(k) ?? { type: "FLD", page_sig: sig, label: e.name, document: p.document, section: sectionOf(e), field_type: fieldTypeOf(e), mandatory: "undocumented", options: [], samples: [], ...(p.module ? { module: p.module } : {}) };
          if (e.required) f.mandatory = "always";
          if (e.sample && !f.samples.includes(e.sample) && f.samples.length < 5) f.samples.push(e.sample);
          if (e.help && !f.help) f.help = e.help;
          if (e.placeholder && !f.placeholder) f.placeholder = e.placeholder;
          if (e.readonly) f.readonly = true;
          if (f.field_type === "text" && fieldTypeOf(e) !== "text") f.field_type = fieldTypeOf(e);
          for (const o of els.filter((x) => x.parent === e.i && x.role === "option" && x.name)) if (!f.options.includes(o.name)) f.options.push(o.name);
          fmap.set(k, f);
        }
        if (SEL_ROLES.has(e.role) && !smap.has(k)) smap.set(k, { type: "SEL", page_sig: sig, label: e.name, role: e.role, ...(p.module ? { module: p.module } : {}), ...(FIELD_TYPE[e.role] ? { fieldLabel: e.name, document: p.document } : {}) });
      }
    }
    for (const [k, f] of fmap) {
      // elenchi di persone: né opzioni né valori di esempio (nomi di persone)
      if (PERSON_LABEL.test(f.label)) { f.person_list = true; delete f.options; delete f.samples; } else if (f.options.length < 2) delete f.options;
      if (f.samples && !f.samples.length) delete f.samples;
      if (ambiguous.has(k)) f.ambiguous = true;
      fields.push(f);
    }
    for (const [k, sel] of smap) if (!ambiguous.has(k)) sels.push(sel);
    // tabelle (05/10/2026): un SEL per tabella con nome, con le colonne e fino a 5 righe di esempio dell'ultima visita
    const last = p.visits.at(-1) ?? [];
    const under = (e, t) => { let q = e.parent; for (let hop = 0; q != null && hop < 200; hop++) { if (q === t.i) return true; q = last[q]?.parent; } return false; };
    for (const t of last.filter((e) => (e.role === "table" || e.role === "grid") && e.name)) {
      const columns = last.filter((e) => e.role === "columnheader" && e.name && under(e, t)).map((e) => e.name);
      const sample_rows = last.filter((e) => e.role === "row" && under(e, t))
        .map((r) => last.filter((c) => (c.role === "cell" || c.role === "gridcell") && c.name && c.parent === r.i).map((c) => c.name))
        .filter((r) => r.length).slice(0, 5);
      sels.push({ type: "SEL", page_sig: sig, label: t.name, role: t.role, ...(p.module ? { module: p.module } : {}), ...(columns.length ? { columns } : {}), ...(sample_rows.length ? { sample_rows } : {}) });
    }
  }
  const routes = [];
  if (entry) {
    for (const [sig, e] of prev) {
      if (!e) continue;
      const chain = chainOf(sig);
      routes.push({ page_sig: sig, title: pages.get(sig)?.document ?? sig, module: pages.get(sig)?.module ?? null, steps: [{ kind: "navigate", url_path: pages.get(entry)?.url_path ?? "/", sig: entry },
        ...chain.map((c) => ({ kind: "click", name: c.name, role: (pages.get(c.from)?.visits ?? []).flat().find((el) => normLabel(el.name) === normLabel(c.name))?.role ?? "link", from_sig: c.from, to_sig: c.to }))] });
    }
  }
  const doc = (s) => pages.get(s)?.document ?? s;
  return { pages, fields, sels, routes, effects: effects.map((e) => ({ page: e.from ? doc(e.from) : null, action: e.action, result: e.to ? doc(e.to) : null, result_sig: e.to, module: pages.get(e.from)?.module ?? null, ts: e.ts, ...(e.uncertain ? { uncertain: true } : {}) })) };
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
  // moduli già memorizzati per pagina (dai SEL esistenti): una pagina raggiunta per un'altra strada non cambia modulo
  const knownModules = new Map(scopeItems(ws, customer, scope, "selectors").filter((s) => s.page && s.module).map((s) => [s.page, s.module]));
  const d = buildDrafts(readLog(file), { knownModules });
  const written = [];
  const skipped = [];
  const add = (r) => { written.push(...r.written); skipped.push(...r.skipped); };
  const updated = [];
  for (const sig of new Set(d.fields.map((f) => f.page_sig))) {
    const items = d.fields.filter((f) => f.page_sig === sig).map(({ page_sig, person_list, ...f }) => f);
    const r = writeDraft({ ws, customer, scope, draft: { page: { signature: sig, title: d.pages.get(sig)?.title }, items } });
    add(r);
    // un campo già memorizzato (sessione precedente) si arricchisce con ciò che questa sessione ha visto in più
    for (const sk of r.skipped.filter((x) => x.type === "FLD" && /\.FLD\.\d{4}/.test(String(x.existing)))) {
      const it = items.find((i) => i.label === sk.label);
      if (it && enrichField({ ws, customer, scope, code: sk.existing, options: it.options ?? [], mandatory: it.mandatory, ambiguous: !!it.ambiguous })) updated.push(sk.existing);
    }
  }
  const flds = scopeItems(ws, customer, scope, "fields");
  // stesso campo = stessa etichetta, stesso documento e stesso modulo (un campo senza modulo vale per ogni modulo)
  const fldCode = (label, document, module) => {
    const same = flds.filter((f) => normLabel(f.label?.it) === normLabel(label) && normLabel(f.document) === normLabel(document));
    // prima lo stesso modulo, poi un campo senza modulo (item precedenti), mai il campo di un altro modulo
    return (same.find((f) => (f.module ?? null) === (module ?? null)) ?? same.find((f) => !f.module) ?? (!module ? same[0] : null))?.id;
  };
  for (const sig of new Set(d.sels.map((s) => s.page_sig))) {
    const items = d.sels.filter((s) => s.page_sig === sig).map(({ page_sig, fieldLabel, document, ...s }) => {
      const code = fieldLabel ? fldCode(fieldLabel, document, s.module) : null;
      return code ? { ...s, field: code } : s;
    });
    add(writeDraft({ ws, customer, scope, draft: { page: { signature: sig, title: d.pages.get(sig)?.title }, items } }));
  }
  const sels = scopeItems(ws, customer, scope, "selectors");
  const selCode = (name, sig) => sels.find((s) => normLabel(s.label) === normLabel(name) && (!s.page || s.page === sig))?.id;
  const haveTitles = new Set(scopeItems(ws, customer, scope, "flows").map((f) => `${f.title}|${moduleKey(f.module)}`));
  const flws = [];
  for (const r of d.routes) {
    const title = `Percorso: ${r.title}`.slice(0, 140);
    if (haveTitles.has(`${title}|${moduleKey(r.module)}`)) { skipped.push({ type: "FLW", label: title, existing: "stesso titolo e modulo" }); continue; }
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
    if (ok) flws.push({ type: "FLW", title, trigger: "navigazione", steps, ...(r.module ? { module: r.module } : {}) });
    else skipped.push({ type: "FLW", label: title, existing: "passo senza selettore" });
  }
  if (flws.length) add(writeDraft({ ws, customer, scope, draft: { items: flws } }));
  const todo = atlasTodo(d);
  return { pages: d.pages.size, written, skipped, updated, todo, modules: moduleSummary(d, todo), effects: d.effects };
}

// Verifica automatica della mappa (taratura sulle pagine vere): ciò che la mappa non sa ancora, come azioni che l'agente
// esegue da solo durante l'esplorazione (poi rilancia atlas-build finché l'elenco è vuoto o il budget finisce).
export function atlasTodo(d) {
  const todo = [];
  const entry = [...d.pages.keys()][0];
  const routed = new Set(d.routes.map((r) => r.page_sig));
  for (const [sig, p] of d.pages) {
    const page = p.document;
    const add = (t) => todo.push({ ...t, module: p.module ?? null });
    const fields = d.fields.filter((f) => f.page_sig === sig);
    for (const f of fields) {
      if (f.field_type === "list" && !f.options && !f.person_list) add({ kind: "open-dropdown", auto: true, page, what: f.label, action: `apri la tendina «${f.label}» nella pagina «${page}» e rifai take_snapshot a tendina aperta` });
      if (f.ambiguous) add({ kind: "ambiguous", auto: false, page, what: f.label, action: `l'etichetta «${f.label}» compare più volte in «${page}»: completa con atlas-write un SEL distinto (testid o css) per ciascuno, con la sezione` });
    }
    if (p.unlabeled) add({ kind: "unlabeled", auto: false, page, what: String(p.unlabeled), action: `${p.unlabeled} campi senza etichetta in «${page}»: identificali (tooltip, etichetta vicina, segnaposto) e completali con atlas-write` });
    if (sig !== entry && !routed.has(sig)) add({ kind: "no-route", auto: true, page, action: `raggiungi «${page}» cliccando dal menu (non aprendo l'indirizzo), così il percorso si memorizza` });
    if (p.iframes) add({ kind: "iframe", auto: false, page, what: String(p.iframes), action: `«${page}» contiene ${p.iframes} iframe non letti: apri il contenuto del frame solo se il suo host è fra quelli dichiarati (navigate all'indirizzo del frame, poi take_snapshot); altrimenti segnalalo` });
    if (fields.length && CREATE_DOC.test(page) && !d.sels.some((s) => s.page_sig === sig && SAVE_LABEL.test(s.label) && !SEND_LABEL.test(s.label))) {
      add({ kind: "no-save", auto: true, page, action: `pulsante di solo salvataggio non visto in «${page}»: scorri o espandi la pagina (sezioni chiuse, barra in fondo) e rifai take_snapshot` });
    }
    if (p.masked) add({ kind: "redacted", auto: false, page, action: `in «${page}» alcune etichette contenevano dati personali (oscurati): non usarle come riferimento e segnalalo nel rapporto` });
  }
  return todo;
}

// Copertura per modulo: pagine, campi, selettori e voci "da fare" di ogni modulo ("(senza modulo)" per l'ingresso e le
// pagine non ancora collocate)
export function moduleSummary(d, todo) {
  const out = {};
  const bucket = (m) => (out[m ?? "(senza modulo)"] ??= { pages: 0, fields: 0, selectors: 0, todo: 0 });
  for (const [sig, p] of d.pages) {
    const b = bucket(p.module);
    b.pages++;
    b.fields += d.fields.filter((f) => f.page_sig === sig).length;
    b.selectors += d.sels.filter((x) => x.page_sig === sig).length;
  }
  for (const t of todo) bucket(t.module).todo++;
  return out;
}

export const HELP = `uso: kb atlas-build --session <sid> [--scope <S>] [--customer <C>] [--workspace <dir>] [--json]

Dal registro dell'esplorazione della sessione (scritto da observe-append) alla mappa nella conoscenza del cliente:
FLD (tipo, obbligo, sezione, valori delle tendine), SEL (legati ai campi, effetto dall'etichetta) e percorsi di
navigazione "Percorso: <pagina>" (FLW). Doppioni scartati; seconda esecuzione sulla stessa sessione senza item nuovi;
campi già memorizzati arricchiti (valori, obbligo). Restituisce l'elenco "todo" di ciò che la mappa non sa ancora
(tendine da aprire, campi senza etichetta, etichette ripetute, pagine senza percorso, iframe, salvataggio non visto).

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
    console.log(JSON.stringify({ ok: true, customer, scope, pages: r.pages, written: r.written.length, skipped: r.skipped.length, updated: r.updated.length, modules: r.modules, effects: r.effects, todo: r.todo, ...(asJson ? { written_items: r.written, skipped_items: r.skipped } : {}) }));
    return 0;
  } catch (err) {
    if (err instanceof AtlasWriteError) return fail(asJson, err.code, err.message);
    return fail(asJson, 2, `errore di sistema: ${err?.message ?? err}`);
  }
}

if (isMain(import.meta.url)) process.exit(await main(process.argv.slice(2)));
