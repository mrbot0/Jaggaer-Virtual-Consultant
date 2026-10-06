// kb atlas-write — la memoria dell'esplorazione (soluzione B, richiesta dell'utente del 30/09/2026). L'agente non scrive
// mai in kb/: descrive ciò che ha visto in una bozza (YAML/JSON nella sua cartella di lavoro) e questo script la valida,
// scarta i doppioni dell'Atlas, assegna i codici dal DB e scrive gli item nella conoscenza del CLIENTE
// (customers/<C>/kb/scopes/<S>/…), marcati "osservato in esplorazione" (F1 osservazione-chrome, F12 digerito, F15
// empirica): non validati da una persona.
//
//   atlas-write --in <bozza> --customer <C> --scope <S> [--session <id>] [--workspace <dir>] [--json]
//       bozza: { page: { url, signature?, title? }, obs?: <codice OBS>, items: [ … ] }
//         SEL { type: SEL, label, role, effect?: read|write, testid?, css?, field?, stability?, concept? }
//             effect assente ⇒ dedotto dall'etichetta (salva, invia, conferma… ⇒ write)
//         FLD { type: FLD, label, document, section, field_type, mandatory?: always|never|conditional|undocumented,
//               options?: [valori osservati], technical_name? }
//         FLW { type: FLW, title, document?, trigger?, steps: [passi nel vocabolario dei piani] }
//   atlas-write --from-plan <plan.json> --title "<processo>" --customer <C> --scope <S> [--run <RUN>]
//       il piano di un'esecuzione riuscita (result green in runs/<RUN>/results/) diventa una procedura FLW; i valori dei
//       campi (data) sono redatti e restano come esempio da sostituire alla volta successiva.
//
// Exit code: 0 ok · 1 errore d'uso o bozza non valida · 2 errore di sistema · 3 rifiutato (cliente diverso dalla
// sessione, piano non riuscito).
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, dirname, resolve, basename } from "node:path";
import YAML from "yaml";
import { openDb } from "./db.mjs";
import { isValidCode, SCOPES } from "./codes.mjs";
import { assignSeq, formatCode } from "./assign-seq.mjs";
import { validateItem } from "./validate-schema.mjs";
import { indexItemFile } from "./reindex.mjs";
import { itemFile } from "../lib/kb-items.mjs";
import { atlasIndex, atlasMatch } from "../chrome/atlas.mjs";
import { redactText } from "../chrome/redact.mjs";
import { EFFECT_LABEL } from "../../hooks/lib/guards/config-scope.mjs";
import { confineInputs } from "../lib/text-file.mjs";
import { parseArgs, fail } from "../lib/args.mjs";
import { isMain } from "../lib/is-main.mjs";

// Campo la cui etichetta compare più volte nella stessa pagina (soluzione A): compose-plan non sceglie, chiede.
export const AMBIGUOUS_NOTE = "ambiguo: etichetta ripetuta nella pagina";
export class AtlasWriteError extends Error { constructor(code, m) { super(m); this.code = code; } }
const E1 = (m) => new AtlasWriteError(1, m);
const ROLES = new Set(["button", "link", "menuitem", "tab", "textbox", "combobox", "listbox", "option", "checkbox", "radio", "searchbox", "search_box", "row", "cell", "heading", "img", "switch", "treeitem", "spinbutton", "dialog", "table", "grid"]);
const FIELD_TYPES = new Set(["text", "number", "date", "lookup", "list", "flag", "file", "table"]);
const MANDATORY = new Set(["always", "conditional", "never", "undocumented"]);
const today = () => new Date().toISOString().slice(0, 10);
const clip = (s, n) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const red = (s) => (typeof s === "string" ? redactText(s, { profile: "standard" }).text : s);

function facets(f4) {
  return { F1: "osservazione-chrome", F4: f4, F5: "saas-core", F6: [], F7: "nessuno", F8: "specifica", F9: "ripetitiva", F10: "R0",
    F11: "deterministico", F12: "digerito", F13: { verified_at: today(), release: "osservata" }, F15: "empirica" };
}
function sourcesOf(draft) {
  const s = { kind: "esplorazione", observed_at: today() };
  if (draft.obs) s.obs = String(draft.obs);
  if (draft.page?.url) s.url = red(String(draft.page.url));
  if (draft.run) s.run = String(draft.run);
  return [s];
}

function buildSel(it, draft) {
  const label = clip(it.label, 120);
  const role = String(it.role ?? "").toLowerCase();
  if (!label) throw E1("SEL senza label (il nome dell'elemento come appare nello snapshot)");
  if (!ROLES.has(role)) throw E1(`SEL "${label}": role non riconosciuto (${it.role}); usa il ruolo dello snapshot (button, link, textbox, combobox, tab, menuitem…)`);
  const effect = it.effect ?? (EFFECT_LABEL.test(label) ? "write" : "read");
  if (!["read", "write"].includes(effect)) throw E1(`SEL "${label}": effect deve essere read o write`);
  const strategies = [
    ...(it.testid ? [{ kind: "testid", value: String(it.testid) }] : []),
    { kind: "role", value: role, name: label },
    { kind: "text", value: label },
    ...(it.css ? [{ kind: "css", value: String(it.css) }] : []),
  ];
  return (code) => ({
    id: code, type: "SEL", title: clip(`Selettore ${label}`, 140), summary: clip(`${role} "${label}" osservato in esplorazione${draft.page?.title ? ` nella pagina ${draft.page.title}` : ""}.`, 400),
    concept: clip(it.concept ?? label, 120), label, role, effect, strategies, stability: it.stability ?? "medium", ...(it.module ? { module: clip(red(String(it.module)), 120) } : {}),
    ...(draft.page?.signature ? { page: String(draft.page.signature) } : {}), ...(it.field ? { field: String(it.field) } : {}),
    ...(Array.isArray(it.columns) && it.columns.length ? { columns: it.columns.map((c) => clip(red(String(c)), 80)).filter(Boolean).slice(0, 100) } : {}),
    ...(Array.isArray(it.sample_rows) && it.sample_rows.length ? { sample_rows: it.sample_rows.slice(0, 20).map((r) => (Array.isArray(r) ? r : [r]).map((c) => clip(red(String(c)), 80))) } : {}),
    facets: facets("comportamento-ui"), sources: sourcesOf(draft),
  });
}

function buildFld(it, draft) {
  const label = clip(it.label, 120);
  if (!label) throw E1("FLD senza label");
  const ft = String(it.field_type ?? "text");
  if (!FIELD_TYPES.has(ft)) throw E1(`FLD "${label}": field_type non valido (${ft}): ${[...FIELD_TYPES].join(", ")}`);
  if (it.mandatory && !MANDATORY.has(it.mandatory)) throw E1(`FLD "${label}": mandatory non valido (${it.mandatory})`);
  const document = clip(it.document ?? draft.page?.title ?? "", 80);
  if (!document) throw E1(`FLD "${label}": manca document (il documento JAGGAER: ordine, contratto, richiesta…)`);
  const options = Array.isArray(it.options) ? it.options.map((o) => clip(red(String(o)), 80)).filter(Boolean).slice(0, 100) : [];
  // registro più ricco (05/10/2026): aiuto, segnaposto, sola lettura e valori di esempio (redatti) nelle note del campo;
  // "valori osservati" (le opzioni) resta l'ultimo segmento (enrichField lo aggiorna)
  const samples = Array.isArray(it.samples) ? [...new Set(it.samples.map((v) => clip(red(String(v)), 80)).filter(Boolean))].slice(0, 5) : [];
  const extra = [it.help ? `aiuto: ${clip(red(String(it.help)), 200)}` : null, it.placeholder ? `segnaposto: ${clip(red(String(it.placeholder)), 120)}` : null,
    it.readonly ? "sola lettura" : null, samples.length ? `valori di esempio: ${samples.join(" · ")}` : null].filter(Boolean);
  return (code) => ({
    id: code, type: "FLD", title: clip(`Campo ${label} (${document})`, 140), summary: clip(`Campo ${ft} "${label}" del documento ${document}, osservato in esplorazione.`, 400),
    document, label: { it: label }, section: clip(it.section ?? "principale", 80), field_type: ft, ...(it.module ? { module: clip(red(String(it.module)), 120) } : {}),
    ...(it.technical_name ? { technical_name: String(it.technical_name) } : {}),
    mandatory: { kind: it.mandatory ?? "undocumented" },
    ...((it.ambiguous || options.length || extra.length) ? { notes: [it.ambiguous ? AMBIGUOUS_NOTE : null, ...extra, options.length ? `valori osservati: ${options.join(" · ")}` : null].filter(Boolean).join(" · ") } : {}),
    facets: facets("struttura-dati"), sources: sourcesOf(draft),
  });
}

const PLAN_STEP_KEYS = ["n", "verb", "target", "check", "data", "wait_for", "expect", "risk", "action_class", "timeout_ms", "note"];
function redData(d) {
  if (typeof d === "string") return red(d);
  if (Array.isArray(d)) return d.map(redData);
  if (d && typeof d === "object") return Object.fromEntries(Object.entries(d).map(([k, v]) => [k, redData(v)]));
  return d;
}
function buildFlw(it, draft) {
  const title = clip(it.title, 140);
  if (title.length < 3) throw E1("FLW senza title (il nome del processo: crea ordine, crea contratto…)");
  if (!Array.isArray(it.steps) || !it.steps.length) throw E1(`FLW "${title}": nessun passo`);
  const steps = it.steps.map((s, i) => {
    const o = Object.fromEntries(PLAN_STEP_KEYS.filter((k) => s[k] !== undefined).map((k) => [k, k === "data" ? redData(s[k]) : s[k]]));
    o.n = i + 1;
    return o;
  });
  return (code) => ({
    id: code, type: "FLW", title, summary: clip(it.summary ?? `Procedura "${title}" (${steps.length} passi) ${draft.run ? `memorizzata dall'esecuzione riuscita ${draft.run}` : "osservata in esplorazione"}.`, 400),
    ...(it.document ? { document: String(it.document) } : {}), ...(it.trigger ? { trigger: String(it.trigger) } : {}),
    steps, ...(it.compensation ? { compensation: it.compensation } : {}), ...(it.module ? { module: clip(red(String(it.module)), 120) } : {}),
    facets: facets("procedura"), sources: sourcesOf(draft),
  });
}

function existingFld(ws, customer, scope, label, document, module = null) {
  const dir = join(ws, "customers", customer, "kb", "scopes", scope, "fields");
  let files = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith(".yaml")); } catch { return null; }
  const norm = (s) => String(s ?? "").toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/[\s:*]+$/g, "").trim();
  const same = [];
  for (const f of files) {
    try {
      const o = YAML.parse(readFileSync(join(dir, f), "utf8"));
      if (norm(o?.label?.it) === norm(label) && norm(o?.document) === norm(document)) same.push(o);
    } catch { /* file illeggibile: non è un doppione */ }
  }
  // stesso campo = stessa etichetta e documento; con i moduli: prima lo stesso modulo, poi un campo senza modulo
  // (item precedenti); un campo di un altro modulo non è un doppione
  const hit = same.find((o) => (o.module ?? null) === (module ?? null)) ?? same.find((o) => !o.module) ?? (!module ? same.find((o) => o.module) : null);
  return hit?.id ?? null;
}

// → { written: [{code, type, label}], skipped: [{type, label, existing}] }
export function writeDraft({ ws, customer, scope, draft }) {
  if (!/^[A-Z0-9]{4}$/.test(String(customer ?? ""))) throw E1("--customer <C> (4 caratteri) obbligatorio");
  if (!SCOPES.has(scope)) throw E1(`scope non valido: ${scope}`);
  if (!existsSync(join(ws, "customers", customer))) throw E1(`il cliente ${customer} non esiste nel workspace`);
  const items = Array.isArray(draft?.items) ? draft.items : null;
  if (!items || !items.length) throw E1("la bozza non ha items");
  if (items.length > 300) throw E1("al più 300 item per bozza");
  const atlas = atlasIndex(ws, customer, scope);
  const builders = [];
  const skipped = [];
  const seen = new Set();
  for (const it of items) {
    const type = String(it?.type ?? "").toUpperCase();
    if (type === "SEL") {
      const b = buildSel(it, draft);
      const probe = { role: String(it.role).toLowerCase(), name: clip(it.label, 120) };
      const hits = atlas.filter((a) => atlasMatch([a], probe));
      const hit = hits.find((h) => (h.page ?? null) === (draft.page?.signature ?? null)) ?? null;
      const k = `SEL|${probe.role}|${probe.name.toLowerCase()}|${draft.page?.signature ?? ""}`;
      if (hit || seen.has(k)) { skipped.push({ type, label: probe.name, existing: hit?.code ?? "nella bozza" }); continue; }
      seen.add(k); builders.push({ type, label: probe.name, b });
    } else if (type === "FLD") {
      const b = buildFld(it, draft);
      const doc = clip(it.document ?? draft.page?.title ?? "", 80);
      const mod = it.module ? clip(red(String(it.module)), 120) : null;   // confronto sul valore che si memorizza
      const ex = existingFld(ws, customer, scope, it.label, doc, mod);
      const k = `FLD|${clip(it.label, 120).toLowerCase()}|${doc.toLowerCase()}|${mod ?? ""}`;
      if (ex || seen.has(k)) { skipped.push({ type, label: clip(it.label, 120), existing: ex ?? "nella bozza" }); continue; }
      seen.add(k); builders.push({ type, label: clip(it.label, 120), b });
    } else if (type === "FLW") {
      builders.push({ type, label: clip(it.title, 140), b: buildFlw(it, draft) });
    } else throw E1(`tipo non ammesso nella bozza: ${it?.type} (SEL, FLD, FLW)`);
  }
  const db = openDb(join(ws, "customers", customer, "knowledge.db"));
  try {
    const written = db.transaction(() => builders.map(({ type, label, b }) => {
      const key = { level: "C", customer, scope, type };
      const code = formatCode({ ...key, seq: assignSeq(db, key) });
      if (!isValidCode(code)) throw E1(`codice ${code} non valido per il registro`);
      const obj = b(code);
      const v = validateItem(obj);
      if (!v.ok) throw E1(`${type} "${label}" non valido: ${v.errors.slice(0, 4).join("; ")}`);
      const file = itemFile(ws, code, customer);
      if (existsSync(file)) throw E1(`il file ${code} esiste già`);
      const text = YAML.stringify(obj, { lineWidth: 0 });
      indexItemFile(db, join(ws, "customers", customer), file, text);
      return { code, type, label, file, text };
    }))();
    for (const w of written) { mkdirSync(dirname(w.file), { recursive: true }); writeFileSync(w.file, w.text); }
    return { written: written.map(({ code, type, label }) => ({ code, type, label })), skipped };
  } finally { db.close(); }
}

// Un FLD già memorizzato si arricchisce (sessioni successive dell'esplorazione): opzioni unite, obbligo "always" se visto.
// Validato e reindicizzato come un item nuovo; mai altri campi. → true se il file è cambiato
export function enrichField({ ws, customer, scope, code, options = [], mandatory = null, ambiguous = false }) {
  // seconda revisione: solo un FLD del cliente attivo e dello scope, nel file che porta il suo codice
  if (!/^[A-Z0-9]{4}$/.test(String(customer)) || !SCOPES.has(scope)) return false;
  if (!new RegExp("^C\\." + customer + "\\." + scope + "\\.FLD\\.\\d{4}$").test(String(code))) return false;
  const file = itemFile(ws, code, customer);
  if (!file || !existsSync(file)) return false;
  const cur = YAML.parse(readFileSync(file, "utf8"));
  if (cur?.id !== code) return false;
  const next = structuredClone(cur);
  let notes = String(cur.notes ?? "");
  // un'ambiguità vista in una sessione successiva si registra: compose-plan chiederà invece di scegliere
  if (ambiguous && !notes.includes(AMBIGUOUS_NOTE)) { notes = [AMBIGUOUS_NOTE, notes || null].filter(Boolean).join(" · "); next.notes = notes; }
  const seen = /valori osservati: (.*)$/.exec(notes)?.[1]?.split(" · ").filter(Boolean) ?? [];
  const add = options.map((o) => clip(red(String(o)), 80)).filter((o) => o && !seen.includes(o));
  if (add.length) {
    const all = [...seen, ...add].slice(0, 100);
    const head = notes.replace(/(?: · )?valori osservati: .*$/, "");
    next.notes = [head || null, `valori osservati: ${all.join(" · ")}`].filter(Boolean).join(" · ");
  }
  if (mandatory === "always" && next.mandatory?.kind !== "always") next.mandatory = { kind: "always" };
  if (JSON.stringify(next) === JSON.stringify(cur)) return false;
  const v = validateItem(next);
  if (!v.ok) throw E1(`${code} non valido dopo l'arricchimento: ${v.errors.slice(0, 3).join("; ")}`);
  const text = YAML.stringify(next, { lineWidth: 0 });
  const db = openDb(join(ws, "customers", customer, "knowledge.db"));
  try { db.transaction(() => { indexItemFile(db, join(ws, "customers", customer), file, text); writeFileSync(file, text); })(); } finally { db.close(); }
  return true;
}

// Piano di un'esecuzione riuscita → bozza con una FLW
export function draftFromPlan({ ws, customer, planFile, title, run = null }) {
  const plan = JSON.parse(readFileSync(planFile, "utf8"));
  if (plan.customer && plan.customer !== customer) throw new AtlasWriteError(3, `il piano è del cliente ${plan.customer}, non di ${customer}`);
  const runId = run ?? basename(dirname(planFile));
  const resFile = join(ws, "customers", customer, "runs", runId, "results", `${plan.plan_id}.yaml`);
  let res = null;
  try { res = YAML.parse(readFileSync(resFile, "utf8")); } catch { /* assente */ }
  if (!res || res.status !== "green") throw new AtlasWriteError(3, `il piano ${plan.plan_id} non ha un esito verde in runs/${runId}/results/: si memorizzano solo esecuzioni riuscite`);
  const comp = (plan.compensations ?? [])[0];
  return { run: runId, items: [{ type: "FLW", title, document: plan.subject ?? undefined, trigger: plan.goal ?? undefined, steps: plan.steps,
    ...(comp ? { compensation: { kind: comp.kind, action: comp.action, entity: comp.entity } } : {}) }] };
}

export const HELP = `uso: kb atlas-write --in <bozza.yaml|json> --customer <C> --scope <S> [--session <id>] [--workspace <dir>] [--json]
     kb atlas-write --from-plan <runs/<RUN>/plan.json> --title "<processo>" --customer <C> --scope <S> [--json]

Scrive nella conoscenza del cliente (customers/<C>/kb/scopes/<S>/selectors|fields|flows) ciò che l'agente ha osservato:
SEL (pulsanti, link, schede, campi come elementi), FLD (campi con tipo, obbligo, valori delle tendine), FLW (procedure).
Doppioni dell'Atlas scartati (stessa etichetta e ruolo compatibile), codici dal DB, schema validato, item marcati
osservazione-chrome / digerito / empirica. --from-plan: solo un piano con esito verde diventa procedura.

Exit code: 0 ok · 1 errore d'uso o bozza non valida · 2 errore di sistema · 3 rifiutato.`;

export async function main(argv, env = process.env) {
  const { opts } = parseArgs(argv);
  const asJson = !!opts.json;
  if (opts.help) { console.log(HELP); return 0; }
  const ws = resolve(opts.workspace || env.JVC_WORKSPACE || env.CLAUDE_PROJECT_DIR || process.cwd());
  try {
    const { resolveSessionId, loadSession } = await import("../admin/session.mjs");
    let sc = null;
    try { const sid = resolveSessionId({ workspace: ws, arg: opts.session, env }); sc = sid ? loadSession(ws, sid).session?.customer ?? null : null; } catch { sc = null; }
    const customer = opts.customer ?? sc;
    if (sc && customer !== sc) return fail(asJson, 3, `--customer ${customer} diverso dal cliente della sessione (${sc})`);
    const scope = String(opts.scope ?? "").toUpperCase();
    const bad = confineInputs(opts, ["in", "from-plan"], { env });
    if (bad) return fail(asJson, 1, bad);
    let draft;
    if (opts["from-plan"]) {
      if (!opts.title) return fail(asJson, 1, "--from-plan richiede --title \"<processo>\"");
      draft = draftFromPlan({ ws, customer, planFile: opts["from-plan"], title: String(opts.title), run: opts.run ?? null });
    } else if (opts.in) {
      const text = readFileSync(opts.in, "utf8");
      try { draft = /\.json$/i.test(opts.in) ? JSON.parse(text) : YAML.parse(text); } catch (e) { return fail(asJson, 1, `bozza illeggibile: ${e.message}`); }
    } else return fail(asJson, 1, "serve --in <bozza> oppure --from-plan <plan.json>");
    const r = writeDraft({ ws, customer, scope, draft });
    console.log(JSON.stringify({ ok: true, customer, scope, written: r.written.length, skipped: r.skipped.length, ...(asJson ? r : { codes: r.written.map((w) => `${w.code} ${w.label}`) }) }));
    return 0;
  } catch (err) {
    if (err instanceof AtlasWriteError) return fail(asJson, err.code, err.message);
    return fail(asJson, 2, `errore di sistema: ${err?.message ?? err}`);
  }
}

if (isMain(import.meta.url)) process.exit(await main(process.argv.slice(2)));
