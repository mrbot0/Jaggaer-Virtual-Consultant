// ingest complete — ponte T0 → T1 della digestione (18/11/2026, richiesta dell'utente: «la parte di Digestion T1 non funziona
// correttamente e non macina quello che viene passato da T0»). Misurato su ENEL: 193 grezzi, 73 ancora needs_llm, 1 solo
// item digerito (il profilo); prodotto XSC: 149 needs_llm, 0 digeriti. Causa: T0 scrive UN file grezzo per documento
// (_inbox/<S>/raw/DOCnnnn.yaml, decine di item, ancore YAML) e lo scope-extractor, senza Edit né indice delle unità, avrebbe
// dovuto riscriverlo a mano; il digester riceveva grezzi incompleti e nessuna coda di ciò che è pronto. Questo script dà a
// T1 strumenti deterministici: i modelli decidono il contenuto, lo script legge le unità e scrive i file.
//   status                         per documento: grezzi, da completare, completati in T1, irrisolti, pronti, digeriti
//   next  [--doc DOCnnnn] [--max N]  prossimo lotto da completare: per ogni grezzo i campi mancanti, l'estrazione T0 e il
//                                  TESTO dell'unità con quello dell'unità precedente e successiva
//   apply --file <completamenti.yaml> applica [{ raw_id, fields: { <campo mancante>: valore }, citation?: { unit, section },
//                                  unresolved?: "<motivo>" }]: campi in extraction, needs_llm false, t1 { status, by, at };
//                                  un grezzo con campi ancora mancanti resta needs_llm con missing aggiornato; gli errori di
//                                  un grezzo non fermano gli altri (`errors`); scrittura atomica per documento
//   ready [--max N]                grezzi pronti per lo scope-digester (completi in T0 o T1, non irrisolti, non digeriti)
//   mark  --raw-id <R…> --code <codice>   il digester segna il grezzo come digerito nell'item <codice>
// Livello: --customer <C> (customers/<C>/_inbox/<S>, unità in customers/<C>/sources/units) oppure --product (_inbox/<S>,
// unità in product/sources/units). Opzioni: --scope <S> (obbligatorio) --workspace <dir> --json. Exit 0 ok · 1 uso · 2 sistema.
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { isMain } from "../lib/is-main.mjs";
import { parseArgs, fail } from "../lib/args.mjs";
import { inputBase, confinedPath, INPUT_FILE_MAX } from "../lib/text-file.mjs";
import { readCurrentSession, readPointer, sessionFile, isSafeSessionId } from "../../hooks/lib/workspace.mjs";
import { allows } from "../../hooks/lib/policy.mjs";
import { SCOPES } from "../kb/codes.mjs";
import { writeFileAtomic } from "../../hooks/lib/fsx.mjs";

const DOC_RE = /^DOC\d{4}$/;
const RAW_ID = /^R\.(DOC\d{4})\.\d{4}$/;
const UNIT_RE = /^U\.DOC\d{4}\.\d{4}$/;
const now = () => new Date().toISOString();

export function paths(ws, { customer = null, scope }) {
  if (!SCOPES.has(scope)) throw new Error(`scope non valido: ${scope}`);
  if (customer != null && !/^[A-Z0-9]{4}$/.test(String(customer))) throw new Error(`cliente non valido: ${customer}`);
  const base = customer ? join(ws, "customers", customer) : ws;
  return { raw: join(base, "_inbox", scope, "raw"), units: join(customer ? base : join(ws, "product"), "sources", "units") };
}
const docs = (p) => (existsSync(p.raw) ? readdirSync(p.raw).filter((f) => /^DOC\d{4}\.yaml$/.test(f)).map((f) => f.slice(0, -5)).sort() : []);
const loadDoc = (p, doc) => YAML.parseDocument(readFileSync(join(p.raw, `${doc}.yaml`), "utf8"));
// i grezzi di T0 usano ancore YAML (&a1 / *a1) per item: oltre 100 alias la libreria si ferma («Excessive alias count»)
const ALIASES = 100000;
const itemsOf = (d) => { const js = d.toJS({ maxAliasCount: ALIASES }); return Array.isArray(js?.items) ? js.items : []; };
const state = (it) => (it.digested_as ? "digerito" : it.t1?.status === "unresolved" ? "irrisolto" : it.needs_llm === true ? "da completare" : "pronto");

export function status(ws, opts) {
  const p = paths(ws, opts);
  const out = [];
  for (const doc of docs(p)) {
    const its = itemsOf(loadDoc(p, doc));
    const c = { doc, grezzi: its.length, "da completare": 0, pronto: 0, irrisolto: 0, digerito: 0, completati_t1: its.filter((i) => i.t1?.status === "completed").length };
    for (const it of its) c[state(it)]++;
    out.push(c);
  }
  const tot = {};
  for (const c of out) for (const k of ["grezzi", "da completare", "pronto", "irrisolto", "digerito", "completati_t1"]) tot[k] = (tot[k] ?? 0) + c[k];
  return { docs: out, totale: tot };
}

function unitText(p, doc, unit) {
  if (!UNIT_RE.test(String(unit ?? ""))) return null;
  const f = join(p.units, doc, `${unit}.yaml`);
  if (!existsSync(f)) return null;
  try { const u = YAML.parse(readFileSync(f, "utf8")); return { unit, text: u?.text ?? null, section: u?.context?.section ?? null, prev: u?.context?.prev ?? null, next: u?.context?.next ?? null }; } catch { return null; }
}

export function next(ws, opts, { doc = null, max = 12 } = {}) {
  const p = paths(ws, opts);
  for (const d of doc ? [doc] : docs(p)) {
    if (!DOC_RE.test(d) || !existsSync(join(p.raw, `${d}.yaml`))) throw new Error(`documento grezzo inesistente: ${d}`);
    const its = itemsOf(loadDoc(p, d)).filter((it) => state(it) === "da completare");
    if (!its.length) continue;
    const batch = its.slice(0, Math.max(1, max)).map((it) => {
      const u = unitText(p, d, it.source_unit);
      const near = (id) => (id ? unitText(p, d, id)?.text ?? null : null);
      return { raw_id: it.raw_id, missing: it.missing ?? [], unit_type: it.unit_type, section: it.section, candidates: it.candidates ?? [], extraction: it.extraction ?? null,
        unit: u ? { id: u.unit, text: u.text, prev_text: near(u.prev), next_text: near(u.next) } : { id: it.source_unit, text: null, error: "unità non trovata" } };
    });
    return { doc: d, remaining: its.length, batch };
  }
  return { doc: null, remaining: 0, batch: [] };
}

// Completamento di un grezzo: solo i campi mancanti, mai altri campi; un valore vuoto non completa.
export function applyCompletions(ws, opts, completions, { by = "scope-extractor" } = {}) {
  const p = paths(ws, opts);
  const errors = [];
  const byDoc = new Map();
  for (const c of Array.isArray(completions) ? completions : []) {
    const m = RAW_ID.exec(String(c?.raw_id ?? ""));
    if (!m) { errors.push({ raw_id: c?.raw_id ?? null, error: "raw_id non valido (R.DOCnnnn.nnnn)" }); continue; }
    if (!byDoc.has(m[1])) byDoc.set(m[1], []);
    byDoc.get(m[1]).push(c);
  }
  const applied = [];
  const filled = (v) => v !== null && v !== undefined && String(v).trim() !== "";
  for (const [doc, list] of byDoc) {
    const file = join(p.raw, `${doc}.yaml`);
    if (!existsSync(file)) { for (const c of list) errors.push({ raw_id: c.raw_id, error: `documento grezzo inesistente: ${doc}` }); continue; }
    const d = loadDoc(p, doc);
    const its = itemsOf(d);
    for (const c of list) {
      const i = its.findIndex((it) => it.raw_id === c.raw_id);
      if (i < 0) { errors.push({ raw_id: c.raw_id, error: "grezzo non trovato nel documento" }); continue; }
      const it = its[i];
      if (it.digested_as) { errors.push({ raw_id: c.raw_id, error: `già digerito in ${it.digested_as}` }); continue; }
      const missing = Array.isArray(it.missing) ? it.missing : [];
      const fields = c.fields && typeof c.fields === "object" && !Array.isArray(c.fields) ? c.fields : {};
      const extra = Object.keys(fields).filter((k) => !missing.includes(k));
      if (extra.length) { errors.push({ raw_id: c.raw_id, error: `campi non mancanti: ${extra.join(", ")} (si completano solo ${missing.join(", ") || "—"})` }); continue; }
      if (c.citation && !UNIT_RE.test(String(c.citation.unit ?? ""))) { errors.push({ raw_id: c.raw_id, error: "citation.unit non valida (U.DOCnnnn.nnnn)" }); continue; }
      for (const [k, v] of Object.entries(fields)) if (filled(v)) d.setIn(["items", i, "extraction", k], v);
      const still = missing.filter((k) => !filled(fields[k]));
      const unresolved = typeof c.unresolved === "string" && c.unresolved.trim() ? c.unresolved.trim().slice(0, 300) : null;
      const st = unresolved ? "unresolved" : still.length ? "partial" : "completed";
      d.setIn(["items", i, "missing"], still);
      d.setIn(["items", i, "needs_llm"], still.length > 0 && !unresolved);
      d.setIn(["items", i, "t1"], { status: st, by, at: now(), ...(unresolved ? { reason: unresolved } : {}), citation: { unit: c.citation?.unit ?? it.source_unit ?? null, section: c.citation?.section ?? it.section ?? null } });
      applied.push({ raw_id: c.raw_id, status: st, still_missing: still });
    }
    const after = itemsOf(d);
    d.setIn(["stats", "needs_llm"], after.filter((it) => it.needs_llm === true).length);
    d.setIn(["stats", "t1_completed"], after.filter((it) => it.t1?.status === "completed").length);
    writeFileAtomic(file, d.toString({ lineWidth: 0 }));
  }
  return { applied, errors };
}

export function ready(ws, opts, { max = 20 } = {}) {
  const p = paths(ws, opts);
  const out = [];
  for (const doc of docs(p)) {
    for (const it of itemsOf(loadDoc(p, doc))) {
      if (state(it) !== "pronto") continue;
      out.push({ raw_id: it.raw_id, doc, candidates: it.candidates ?? [], type_hint: it.type_hint?.outcome ?? null, section: it.section, unit: it.source_unit, extraction: it.extraction ?? null, t1: it.t1?.status ?? "t0" });
      if (out.length >= max) return { items: out, more: true };
    }
  }
  return { items: out, more: false };
}

export function mark(ws, opts, rawId, code) {
  const m = RAW_ID.exec(String(rawId ?? ""));
  if (!m) throw new Error("raw_id non valido (R.DOCnnnn.nnnn)");
  if (!/^[SCL]\.[A-Z0-9]{3,4}\.[A-Z0-9]{3}\.[A-Z]{3}\.\d{4}$/.test(String(code ?? ""))) throw new Error(`codice non valido: ${code}`);
  const p = paths(ws, opts);
  const file = join(p.raw, `${m[1]}.yaml`);
  if (!existsSync(file)) throw new Error(`documento grezzo inesistente: ${m[1]}`);
  const d = loadDoc(p, m[1]);
  const i = itemsOf(d).findIndex((it) => it.raw_id === rawId);
  if (i < 0) throw new Error(`grezzo non trovato: ${rawId}`);
  d.setIn(["items", i, "digested_as"], code);
  writeFileAtomic(file, d.toString({ lineWidth: 0 }));
  return { raw_id: rawId, digested_as: code };
}

// revisione di sicurezza: con una sessione attiva nel workspace si lavora solo sul suo cliente e sul suo scope (tutti gli scope
// del cliente nel profilo esplorazione, policy celle_cliente); il livello prodotto solo senza un cliente attivo
// Fail-closed (seconda revisione): valgono la sessione corrente del workspace E quella di JVC_SESSION_ID, se diversa; un
// identificativo non valido, un puntatore o un session.json illeggibili ⇒ { error }.
export function activeSessions(ws, env) {
  const ids = [...new Set([readCurrentSession(ws), env.JVC_SESSION_ID ?? null].filter((x) => x != null && x !== ""))];
  const out = [];
  for (const sid of ids) {
    if (!isSafeSessionId(String(sid))) return { error: `identificativo di sessione non valido: ${String(sid).slice(0, 40)}` };
    let p;
    try { p = readPointer(ws, sid); } catch (err) { return { error: `puntatore della sessione illeggibile (${err.message})` }; }
    if (!p?.customer) continue;
    try { out.push(JSON.parse(readFileSync(sessionFile(ws, p.customer, sid), "utf8"))); } catch (err) { return { error: `session.json della sessione ${sid} illeggibile (${err.code ?? err.message})` }; }
  }
  return { sessions: out };
}
export function cellRefusal(session, lvl) {
  if (!session?.customer) return null;
  if (lvl.customer == null) return `livello prodotto non ammesso con il cliente ${session.customer} attivo`;
  if (lvl.customer !== session.customer) return `cliente ${lvl.customer} diverso da quello della sessione (${session.customer})`;
  if (session.scope && lvl.scope !== session.scope && !allows(session, "celle_cliente")) return `scope ${lvl.scope} diverso da quello della sessione (${session.scope})`;
  return null;
}

const HELP = `uso: node scripts/ingest/complete.mjs <status|next|apply|ready|mark> (--customer <C> | --product) --scope <S> [opzioni] [--json]

Ponte T0 → T1 della digestione: lo scope-extractor completa i grezzi needs_llm a lotti senza riscrivere i file, lo
scope-digester prende la coda dei grezzi pronti e li segna digeriti.
  status                         avanzamento per documento (grezzi, da completare, pronti, irrisolti, digeriti)
  next [--doc DOCnnnn] [--max 12] prossimo lotto da completare, con il testo dell'unità e delle vicine
  apply --file <completamenti.yaml> [{ raw_id, fields: { <campo mancante>: valore }, citation?: { unit, section }, unresolved?: motivo }]
  ready [--max 20]               grezzi pronti per il digester, non ancora digeriti
  mark --raw-id <R.DOCnnnn.nnnn> --code <codice dell'item digerito>
Opzioni: --workspace <dir> (default: $JVC_WORKSPACE, poi la cartella del progetto).
Exit code: 0 ok · 1 errore d'uso · 2 errore di sistema.`;

export function main(argv, env = process.env) {
  const { opts, positional } = parseArgs(argv, { flags: ["product"] });
  const json = !!opts.json;
  if (opts.help || !positional.length) { console.log(HELP); return opts.help ? 0 : 1; }
  const cmd = positional[0];
  const ws = opts.workspace ? String(opts.workspace) : inputBase(env);
  if (!opts.product && !opts.customer) return fail(json, 1, "serve --customer <C> oppure --product");
  const lvl = { customer: opts.product ? null : String(opts.customer), scope: String(opts.scope ?? "").toUpperCase() };
  const act = activeSessions(ws, env);
  if (act.error) return fail(json, 1, act.error);
  for (const sess of act.sessions) { const cell = cellRefusal(sess, lvl); if (cell) return fail(json, 1, cell); }
  const num = (v, d) => { if (v === undefined) return d; const n = Number(v); return Number.isInteger(n) && n > 0 ? n : NaN; };
  try {
    let r;
    if (cmd === "status") r = status(ws, lvl);
    else if (cmd === "next") { const max = num(opts.max, 12); if (Number.isNaN(max)) return fail(json, 1, "--max: intero positivo"); r = next(ws, lvl, { doc: opts.doc ?? null, max }); }
    else if (cmd === "ready") { const max = num(opts.max, 20); if (Number.isNaN(max)) return fail(json, 1, "--max: intero positivo"); r = ready(ws, lvl, { max }); }
    else if (cmd === "apply") {
      if (!opts.file) return fail(json, 1, "apply: serve --file <completamenti.yaml>");
      // il file dei completamenti sta sempre nel workspace (confinato, anche con --workspace) e ha un limite di dimensione
      const f = confinedPath(ws, String(opts.file));
      if (f.error) return fail(json, 1, f.error);
      if (!existsSync(f.abs) || !statSync(f.abs).isFile()) return fail(json, 1, `file inesistente: ${opts.file}`);
      if (statSync(f.abs).size > INPUT_FILE_MAX) return fail(json, 1, `file dei completamenti troppo grande: ${opts.file}`);
      let list;
      try { list = YAML.parse(readFileSync(f.abs, "utf8")); } catch (err) { return fail(json, 1, `file dei completamenti illeggibile: ${err.message}`); }
      r = applyCompletions(ws, lvl, Array.isArray(list) ? list : list?.completions);
    } else if (cmd === "mark") r = mark(ws, lvl, opts["raw-id"], opts.code);
    else return fail(json, 1, `comando sconosciuto: ${cmd}`);
    console.log(json ? JSON.stringify({ ok: true, ...r }) : YAML.stringify(r));
    return 0;
  } catch (err) {
    const usage = /non valid|inesistente|non trovato|serve/.test(String(err?.message));
    return fail(json, usage ? 1 : 2, String(err?.message ?? err));
  }
}

if (isMain(import.meta.url)) process.exit(main(process.argv.slice(2)));
