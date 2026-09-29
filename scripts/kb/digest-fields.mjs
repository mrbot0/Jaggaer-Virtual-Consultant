// Digestione a lotti dei campi (§19.6.4 passi 3-4, budget §29.10): nessun passaggio
// vede più di 50 campi, la digestione di un documento resta nel suo budget.
//
//   plan(docId, { root, scope?, related?, budget = 80000, unitBudget = 3000, resume?, maxBatch = 50 })
//     legge i grezzi _inbox/<scope>/fields/<doc>/<sezione>.yaml (scripts/ingest/field-table.mjs),
//     deduplica (anche con i documenti `related`: il manuale e la spec dello stesso campo diventano
//     un campo con due fonti), raggruppa per sezione in lotti ≤ 50 (parti uguali) e scrive
//     _inbox/<scope>/fields/<doc>/batch-nn.yaml con, per riga, la regola di obbligatorietà
//     suggerita (scripts/ingest/deontic.mjs) e il cluster CL-FLD suggerito dalla sezione.
//     Budget: 80k token per documento, 3k per unità (§29.10); una riga oltre i 3k va in residuo
//     (`over_unit_budget`), il piano si ferma al primo lotto che sforerebbe il budget e restituisce
//     il cursore (`resume: "batch-nn"` riprende da lì, alla sessione successiva). budget e unitBudget si possono
//     solo abbassare (sopra 80000/3000 → BudgetPolicyError, exit 3). I token consumati sono salvati con il
//     cursore in _cursor.yaml per sessione REALE (resolveDigestSession): la stessa sessione continua il
//     conteggio, una sessione reale nuova del cliente riparte da zero, senza sessione reale si somma tutto.
//     _inbox/<scope>/fields/<doc>/_residue.yaml: righe ambigue (regola non determinata) e oltre budget.
//   accept(batchFile, digested, { root? })
//     valida ogni FLD digerito del lotto con validateFld e scrive i candidati in
//     _inbox/<scope>/digested/<codice>.yaml — mai in kb/ (§29.6: solo la validazione e gli script
//     di promozione portano in kb/). Rifiuta: FLD invalidi, campi che non appartengono al lotto,
//     codici di un altro scope, e un mandatory.kind su una riga la cui regola è ambigua
//     (Review Focus 5: la regola resta in residuo finché la revisione non la risolve).
//   estimateTokens(x) ≈ caratteri JSON / 4.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, unlinkSync } from "node:fs";
import { join, resolve, relative, dirname, isAbsolute } from "node:path";
import YAML from "yaml";
import { dedupe, normalizeLabel, normalizeTechnicalName } from "../ingest/dedupe.mjs";
import { chunkEven } from "../ingest/segment.mjs";
import { safeName } from "../ingest/field-table.mjs";
import { parseMandatoryText } from "../ingest/deontic.mjs";
import { validateFld } from "./validate-fld.mjs";
import { SCOPES, parseCode } from "./codes.mjs";
import { isMain } from "../lib/is-main.mjs";
import { resolveSessionId } from "../admin/session.mjs";
import { readPointer, sessionFile } from "../../hooks/lib/workspace.mjs";
import { checkSessionText } from "../../hooks/lib/session-state.mjs";
import { parseArgs, fail } from "../lib/args.mjs";
import { confineInputs, inputFile } from "../lib/text-file.mjs";

export const MAX_BATCH = 50;
export const DOC_BUDGET = 80000;
export const UNIT_BUDGET = 3000;
// Istruzioni e intestazione del lotto per il digester, oltre alle righe.
export const BATCH_OVERHEAD = 500;

export class UsageError extends Error { constructor(m) { super(m); this.name = "UsageError"; } }
// §29.10: i budget sono limiti, mai alzati da un agente — un valore sopra il limite è un rifiuto di policy (exit 3).
export class BudgetPolicyError extends Error { constructor(m) { super(m); this.name = "BudgetPolicyError"; } }

export function checkBudgets(budget, unitBudget) {
  for (const [name, v, max] of [["budget", budget, DOC_BUDGET], ["unit-budget", unitBudget, UNIT_BUDGET]]) {
    if (!Number.isFinite(v) || !(v > 0)) throw new UsageError(`${name} non valido: ${v}`);
    if (v > max) throw new BudgetPolicyError(`${name} ${v} oltre il limite di ${max} token (§29.10): i budget si possono solo abbassare, mai alzare`);
  }
}

export const estimateTokens = (x) => Math.ceil(JSON.stringify(x ?? null).length / 4);

// ——— suggerimenti ———
// Parole chiave (normalizzate, prefisso di parola o frase) per le sezioni di CL-FLD (§19.6.3),
// in ordine di specificità: una sezione "header.accounting" è contabilità, non intestazione.
const SECTION_KEYWORDS = [
  ["011", "custom-cliente", ["custom", "personalizz", "udf", "user defined", "campi aggiuntivi", "extension"]],
  ["012", "sistema-audit", ["audit", "system", "sistema", "log", "history", "storico", "tracking", "tracciatura"]],
  ["008", "allegati", ["attachment", "allegat"]],
  ["003", "contabilita", ["accounting", "contabil", "cost center", "centro di costo", "account", "conto", "commess", "budget", "gl"]],
  ["004", "fiscalita", ["tax", "fiscal", "iva", "vat", "ritenut", "withholding"]],
  ["007", "prezzi-valute", ["price", "pricing", "prezz", "currency", "valut", "amount", "import"]],
  ["005", "logistica", ["delivery", "shipping", "ship", "logistic", "consegn", "spedizion", "address", "indirizz"]],
  ["006", "riferimento-fornitore", ["supplier", "fornitor", "vendor"]],
  ["009", "workflow-approvazione", ["workflow", "approval", "approvazion", "approver"]],
  ["010", "riferimenti-monte", ["reference", "riferiment", "upstream", "monte", "origin"]],
  ["013", "testi-note", ["notes", "note", "text", "testi", "testo", "comment"]],
  ["002", "righe", ["lines", "line", "righe", "riga", "items", "positions", "posizion"]],
  ["001", "intestazione", ["header", "testata", "intestazion", "general", "dati generali"]],
];
function keywordHit(norm, kw) {
  if (kw.includes(" ")) return ` ${norm} `.includes(` ${kw} `);
  return norm.split(" ").some((t) => t.startsWith(kw));
}
export function suggestCluster(section, title = "") {
  const lastSeg = String(section ?? "").split(/[./>]/).filter(Boolean).pop() ?? "";
  for (const cand of [lastSeg, title, section].map((s) => normalizeLabel(s)).filter(Boolean)) {
    for (const [n, fs, kws] of SECTION_KEYWORDS) if (kws.some((k) => keywordHit(cand, k))) return { code: `CL-FLD-${n}`, functional_section: fs };
  }
  return null;
}

const TYPE_KEYWORDS = [
  ["table", ["table", "tabella", "griglia", "grid"]],
  ["file", ["file", "allegato", "attachment", "upload"]],
  ["flag", ["flag", "checkbox", "check box", "casella", "boolean", "booleano", "si no", "yes no", "spunta"]],
  ["date", ["date", "data", "datetime", "timestamp"]],
  ["number", ["number", "numero", "numerico", "numeric", "decimal", "decimale", "integer", "intero", "importo", "amount", "quantita", "quantity", "currency"]],
  ["lookup", ["lookup", "ricerca", "search", "reference", "riferimento"]],
  ["list", ["list", "lista", "elenco", "picklist", "dropdown", "drop down", "menu a tendina", "combo", "combobox", "select", "selezione"]],
  ["text", ["text", "testo", "string", "stringa", "alfanumerico", "alphanumeric", "char", "varchar", "memo"]],
];
export function suggestFieldType(typeText) {
  const n = normalizeLabel(typeText);
  if (!n) return null;
  for (const [t, kws] of TYPE_KEYWORDS) if (kws.some((k) => keywordHit(n, k))) return t;
  return null;
}

// ——— lettura dei grezzi ———
const RAW_FILE = (f) => f.endsWith(".yaml") && !/^batch-\d+\.yaml$/.test(f) && !f.startsWith("_");
const natural = (a, b) => a.localeCompare(b, "en", { numeric: true });

export function findScope(root, docId) {
  const base = join(root, "_inbox");
  if (!existsSync(base)) return null;
  const hits = readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory() && existsSync(join(base, e.name, "fields", safeName(docId))))
    .map((e) => e.name);
  if (hits.length > 1) throw new UsageError(`documento ${docId} presente in più scope (${hits.join(", ")}): indicare --scope`);
  return hits[0] ?? null;
}

function docDir(root, scope, docId) { return join(root, "_inbox", scope, "fields", safeName(docId)); }

export function readRawRows(root, scope, docId) {
  const dir = docDir(root, scope, docId);
  if (!existsSync(dir)) throw new UsageError(`nessun grezzo per ${docId} in _inbox/${scope}/fields/`);
  const files = readdirSync(dir).filter(RAW_FILE).sort(natural);
  const sections = [];
  const rows = [];
  for (const f of files) {
    const d = YAML.parse(readFileSync(join(dir, f), "utf8")) ?? {};
    sections.push({ section: d.section, title: d.section_title ?? "" });
    for (const r of d.rows ?? []) rows.push({ ...r, document: r.document ?? d.document ?? docId, section: r.section ?? d.section });
  }
  return { rows, sections };
}

// ——— lotti ———
export function writeBatch(root, scope, docId, name, content) {
  const n = content?.rows?.length ?? 0;
  if (n > MAX_BATCH) throw new RangeError(`lotto ${name} con ${n} campi: il limite è ${MAX_BATCH} (§19.6.4)`);
  if (!SCOPES.has(scope)) throw new UsageError(`scope sconosciuto: ${scope}`);
  const dir = docDir(root, scope, docId);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${name}.yaml`);
  writeFileSync(file, YAML.stringify(content));
  return file;
}

function suggestionFor(field, title) {
  const p = parseMandatoryText(field.mandatory_text);
  const cl = suggestCluster(field.section, title);
  const s = { field_type: suggestFieldType(field.type), cluster: cl?.code ?? null, functional_section: cl?.functional_section ?? null,
    modality: p.modality, confidence: p.confidence };
  if (p.mandatory) s.mandatory = p.mandatory;
  if (p.validation) s.validation = p.validation;
  if (p.reason) s.reason = p.reason;
  if (p.residue) s.residue = p.residue;
  if (field.conflicts.some((c) => c.attribute === "mandatory_text")) s.contradiction = "le fonti divergono sull'obbligatorietà: candidato CTR";
  return s;
}

function buildBatches(root, scope, docId, { related = [], unitBudget = UNIT_BUDGET, maxBatch = MAX_BATCH } = {}) {
  const own = readRawRows(root, scope, docId);
  const extra = related.flatMap((d) => readRawRows(root, scope, d).rows);
  const { fields, merge_candidates } = dedupe([...own.rows, ...extra]);
  const titles = new Map(own.sections.map((s) => [s.section, s.title]));
  const mine = fields.filter((f) => f.sources.some((s) => s.document === docId));
  const residue = { ambiguous: [], over_unit_budget: [] };
  const bySection = new Map();
  for (const f of mine) {
    const row = { key: f.key, label: f.label, labels: f.labels, technical_name: f.technical_name, section: f.section, type: f.type,
      mandatory_text: f.mandatory_text, allowed_values: f.allowed_values, notes: f.notes, sources: f.sources, conflicts: f.conflicts,
      suggested: suggestionFor(f, titles.get(f.section) ?? "") };
    if (estimateTokens(row) > unitBudget) { residue.over_unit_budget.push({ key: f.key, label: f.label, tokens: estimateTokens(row) }); continue; }
    if (row.suggested.residue === "ambiguous") residue.ambiguous.push({ key: f.key, label: f.label, mandatory_text: f.mandatory_text, sources: f.sources.map((s) => s.source_unit) });
    if (!bySection.has(f.section)) bySection.set(f.section, []);
    bySection.get(f.section).push(row);
  }
  const batches = [];
  for (const [section, rows] of bySection) {
    const parts = chunkEven(rows, Math.min(maxBatch, MAX_BATCH));
    parts.forEach((chunk, i) => {
      const name = `batch-${String(batches.length + 1).padStart(2, "0")}`;
      const content = { document: docId, scope, batch: name, section, section_title: titles.get(section) ?? "", part: i + 1, parts: parts.length, rows: chunk };
      content.tokens_estimate = estimateTokens(chunk) + BATCH_OVERHEAD;
      batches.push({ name, content });
    });
  }
  return { batches, residue, merge_candidates };
}

// ——— sessione del consumo (§29.10) ———
// La sessione NON è scelta dal chiamante: si risolve come ovunque nel plugin (resolveSessionId:
// JVC_SESSION_ID, poi .jvc/current-session del workspace) e conta solo se è REALE per il cliente del
// documento — root = <workspace>/customers/<C>, puntatore .jvc/sessions/<sid>.json del cliente C e
// session.json leggibile per il predicato condiviso degli hook (checkSessionText: JSON, schema, cliente,
// session_id). Altrimenti (nessuna sessione, id inventato, puntatore forgiato, session.json non conforme,
// sessione di un altro cliente) il consumo di partenza è la SOMMA di tutte le sessioni del cursore.
export const NO_SESSION = "_senza-sessione";
export function resolveDigestSession(root, env = process.env) {
  const abs = resolve(root);
  const m = /[\\/]customers[\\/]([A-Z0-9]{4})[\\/]?$/.exec(abs);
  if (!m) return { sid: null, customer: null, reason: "root fuori da <workspace>/customers/<C>: nessuna sessione di cliente" };
  const customer = m[1];
  const ws = resolve(abs, "..", "..");
  const sid = resolveSessionId({ workspace: ws, arg: undefined, env });
  if (!sid) return { sid: null, customer, reason: "nessuna sessione (JVC_SESSION_ID, .jvc/current-session)" };
  let ptr = null;
  try { ptr = readPointer(ws, sid); } catch (e) { return { sid: null, customer, reason: `puntatore di sessione illeggibile: ${e.message}` }; }
  if (!ptr || ptr.customer !== customer) return { sid: null, customer, reason: `la sessione ${sid} non è del cliente ${customer}` };
  const file = sessionFile(ws, customer, sid);
  if (!existsSync(file)) return { sid: null, customer, reason: `session.json di ${sid} assente` };
  const c = checkSessionText(readFileSync(file, "utf8"), { customer, sid });
  if (!c.ok) return { sid: null, customer, reason: `session.json di ${sid} non valido: ${c.reason}` };
  return { sid, customer, reason: null };
}

export function plan(docId, { root, scope, related = [], budget = DOC_BUDGET, unitBudget = UNIT_BUDGET, resume = null, maxBatch = MAX_BATCH, env = process.env, ...rest } = {}) {
  if (!root) throw new UsageError("plan richiede root");
  if ("session" in rest) throw new UsageError("la sessione non si passa a plan: si risolve da JVC_SESSION_ID / .jvc/current-session e deve essere reale (§29.10)");
  checkBudgets(budget, unitBudget);
  const sc = scope ?? findScope(root, docId);
  if (!sc) throw new UsageError(`nessun grezzo per ${docId} in _inbox/*/fields/`);
  if (!SCOPES.has(sc)) throw new UsageError(`scope sconosciuto: ${sc}`);
  const { batches, residue, merge_candidates } = buildBatches(root, sc, docId, { related, unitBudget, maxBatch });
  for (const b of batches) if (b.content.rows.length > MAX_BATCH) throw new RangeError(`lotto ${b.name} > ${MAX_BATCH}`);
  // Stato del cursore: consumo per sessione (by_session). Un piano interrotto si riprende con --resume;
  // un piano nuovo non lo azzera; --resume senza cursore salvato è rifiutato.
  const stateFile = join(docDir(root, sc, docId), "_cursor.yaml");
  const prevState = existsSync(stateFile) ? YAML.parse(readFileSync(stateFile, "utf8")) ?? {} : null;
  let start = 0;
  if (resume) {
    start = batches.findIndex((b) => b.name === resume);
    if (start < 0) throw new UsageError(`cursore ${resume} inesistente (lotti: batch-01…batch-${String(batches.length).padStart(2, "0")})`);
    if (!prevState) throw new UsageError(`nessun cursore salvato per ${docId} (_cursor.yaml): --resume richiede un piano interrotto`);
  } else {
    if (prevState?.cursor) throw new BudgetPolicyError(`il piano di ${docId} è interrotto al cursore ${prevState.cursor}: riprendere con --resume ${prevState.cursor} (un piano nuovo non azzera il consumo, §29.10)`);
    const dir = docDir(root, sc, docId);
    for (const f of readdirSync(dir)) if (/^batch-\d+\.yaml$/.test(f)) unlinkSync(join(dir, f));   // piano nuovo: niente lotti vecchi
  }
  // I token consumati viaggiano con il cursore, per sessione reale: la stessa sessione continua il suo
  // conteggio; una sessione reale nuova del cliente riparte da zero (§29.10: "riprende alla sessione
  // successiva"); senza sessione reale si parte dalla somma di tutte le sessioni — mai un azzeramento.
  const ledger = {};
  if (resume && prevState) {
    Object.assign(ledger, prevState.by_session ?? {});
    if (!prevState.by_session && Number.isFinite(prevState.tokens_used)) ledger[prevState.session ?? NO_SESSION] = prevState.tokens_used;   // cursore del giro 1
  }
  const who = resolveDigestSession(root, env);
  const key = who.sid ?? NO_SESSION;
  const total = Object.values(ledger).reduce((a, v) => a + (Number(v) || 0), 0);
  const carried = who.sid ? Number(ledger[who.sid]) || 0 : total;
  const written = [];
  let used = carried;
  let cursor = null;
  for (let i = start; i < batches.length; i++) {
    const b = batches[i];
    if (used + b.content.tokens_estimate > budget) { cursor = b.name; break; }
    const file = writeBatch(root, sc, docId, b.name, b.content);
    used += b.content.tokens_estimate;
    written.push({ batch: b.name, file, section: b.content.section, rows: b.content.rows.length, tokens: b.content.tokens_estimate });
  }
  writeFileSync(join(docDir(root, sc, docId), "_residue.yaml"), YAML.stringify({ document: docId, scope: sc, ...residue }));
  if (used > carried || key in ledger) ledger[key] = (Number(ledger[key]) || 0) + (used - carried);
  writeFileSync(stateFile, YAML.stringify({ document: docId, scope: sc, cursor, by_session: ledger, budget, at: new Date().toISOString() }));
  return { ok: true, status: cursor ? "budget-exceeded" : "complete", document: docId, scope: sc, batches: written, cursor,
    total_batches: batches.length, tokens_used: used, tokens_carried: carried, session: who.sid, session_note: who.reason, budget, residue: { ambiguous: residue.ambiguous.length, over_unit_budget: residue.over_unit_budget.length },
    merge_candidates };
}

// ——— accettazione ———
function rootFromBatch(batchFile) {
  // <root>/_inbox/<scope>/fields/<doc>/batch-nn.yaml
  return resolve(dirname(batchFile), "..", "..", "..", "..");
}
function within(parent, child) {
  const r = relative(parent, child);
  return r && !r.startsWith("..") && !isAbsolute(r);
}

export function accept(batchFile, digested, { root } = {}) {
  const batch = YAML.parse(readFileSync(batchFile, "utf8"));
  if (!batch?.scope || !SCOPES.has(batch.scope) || !Array.isArray(batch.rows)) throw new UsageError(`${batchFile}: non è un lotto di digest-fields`);
  if (batch.rows.length > MAX_BATCH) throw new RangeError(`lotto con ${batch.rows.length} campi (> ${MAX_BATCH})`);
  const base = resolve(root ?? rootFromBatch(batchFile));
  const outDir = join(base, "_inbox", batch.scope, "digested");
  if (!within(join(base, "_inbox"), outDir)) throw new UsageError("destinazione fuori da _inbox");
  const items = Array.isArray(digested) ? digested : Array.isArray(digested?.items) ? digested.items : [digested];
  const byTech = new Map(batch.rows.filter((r) => r.technical_name).map((r) => [normalizeTechnicalName(r.technical_name), r]));
  const byLabel = new Map(batch.rows.flatMap((r) => (r.labels ?? [r.label]).map((l) => [normalizeLabel(l), r])));
  const accepted = [];
  const rejected = [];
  const seen = new Set();
  for (const it of items) {
    const id = it?.id ?? null;
    const errors = [...validateFld(it ?? {}).errors];
    if (id && seen.has(id)) errors.push(`codice ${id} ripetuto nel lotto`);
    if (id) seen.add(id);
    const code = id ? parseCode(id) : null;
    if (code && code.scope !== batch.scope) errors.push(`il codice ${id} non è dello scope ${batch.scope}`);
    const row = (it?.technical_name && byTech.get(normalizeTechnicalName(it.technical_name)))
      ?? [it?.label?.it, it?.label?.en].filter(Boolean).map((l) => byLabel.get(normalizeLabel(l))).find(Boolean);
    if (!row) errors.push(`il campo non appartiene al lotto ${batch.batch} (né nome tecnico né label corrispondono)`);
    else {
      // §19.10 e Review Focus 5, qualunque cosa dichiari il digester: la modalità suggerita dal parser
      // deontico sulla riga del lotto vincola il kind. Ambiguo (o in residuo) → nessun kind, nemmeno
      // never: la regola resta in revisione. Raccomandazione → al più never, mai un obbligo.
      const modality = row.suggested?.modality ?? null;
      const kind = it?.mandatory?.kind;
      if (kind && (modality === "ambiguo" || row.suggested?.residue === "ambiguous")) {
        errors.push(`regola ambigua in residuo («${row.mandatory_text}»): nessun mandatory.kind finché la revisione non la risolve (Review Focus 5)`);
      } else if (kind && kind !== "never" && modality === "raccomandazione") {
        errors.push(`la regola della riga è una raccomandazione («${row.mandatory_text}»): kind ${kind} non ammesso, al più never (§19.10: mai promossa a obbligo)`);
      }
    }
    if (errors.length) { rejected.push({ id, errors }); continue; }
    mkdirSync(outDir, { recursive: true });
    const file = join(outDir, `${id}.yaml`);
    writeFileSync(file, YAML.stringify(it));
    accepted.push({ id, file });
  }
  return { ok: rejected.length === 0, batch: batch.batch, document: batch.document, scope: batch.scope, accepted, rejected };
}

// ——— CLI ———
const HELP = `uso: node scripts/kb/digest-fields.mjs <comando> [opzioni] [--json] [--help]

Comandi:
  plan <documento> --root <dir> [--scope P2P] [--related DOC2,DOC3] [--budget ≤80000] [--unit-budget ≤3000] [--resume batch-nn]
       sessione: JVC_SESSION_ID, poi .jvc/current-session; conta solo una sessione reale del cliente
       (<root> = <workspace>/customers/<C>), altrimenti il consumo è la somma di tutte le sessioni
       lotti ≤ 50 campi per sezione in _inbox/<scope>/fields/<documento>/batch-nn.yaml, con regola di
       obbligatorietà e cluster CL-FLD suggeriti; si ferma al budget del documento con un cursore
  accept <batch-nn.yaml> --digested <file.yaml> [--root <dir>]
       valida i FLD digeriti del lotto (validateFld) e li scrive in _inbox/<scope>/digested/ (mai kb/)

Exit code: 0 ok · 1 errore utente (argomenti, grezzi assenti, FLD rifiutati) · 2 errore di sistema ·
3 budget del documento raggiunto (il piano si ferma: riprendere con --resume <cursore> alla sessione successiva)
  oppure budget oltre il limite (--budget > 80000, --unit-budget > 3000: si possono solo abbassare).`;

function main(argv) {
  const [cmd, ...rest] = argv;
  const { opts, positional } = parseArgs(rest);
  const asJson = !!opts.json || argv.includes("--json");
  if (!cmd || cmd === "--help" || opts.help) { console.log(HELP); return cmd ? 0 : 1; }
  try {
    if (cmd === "plan") {
      if (!positional[0] || !opts.root) return fail(asJson, 1, "plan richiede <documento> e --root");
      if (rest.includes("--session")) return fail(asJson, 1, "--session non è ammesso: la sessione si risolve da JVC_SESSION_ID / .jvc/current-session e deve essere reale (§29.10)");
      const num = (v, d) => (v === undefined ? d : Number(v));
      const r = plan(positional[0], { root: opts.root, scope: opts.scope, related: opts.related ? String(opts.related).split(",").filter(Boolean) : [],
        budget: num(opts.budget, DOC_BUDGET), unitBudget: num(opts["unit-budget"], UNIT_BUDGET), resume: opts.resume ?? null,
        env: process.env });
      console.log(JSON.stringify(r));
      return r.status === "complete" ? 0 : 3;
    }
    if (cmd === "accept") {
      { const bad = confineInputs(opts, ["digested"], {}); if (bad) return fail(asJson, 1, bad); }
      if (!positional[0] || !opts.digested) return fail(asJson, 1, "accept richiede <batch-nn.yaml> e --digested <file>");
      const bf = inputFile(positional[0]); if (bf.error) return fail(asJson, 1, bf.error); positional[0] = bf.abs;
      let digested;
      try { digested = YAML.parse(readFileSync(opts.digested, "utf8")); } catch (e) { return fail(asJson, 1, `file digerito illeggibile: ${e.message}`); }
      const r = accept(positional[0], digested, { root: opts.root });
      console.log(JSON.stringify(r));
      return r.ok ? 0 : 1;
    }
    return fail(asJson, 1, `comando sconosciuto: ${cmd}`);
  } catch (e) {
    if (e instanceof BudgetPolicyError) return fail(asJson, 3, e.message);
    if (e instanceof UsageError || e?.code === "ENOENT") return fail(asJson, 1, e.message);
    return fail(asJson, 2, `errore di sistema: ${e.message ?? e}`);
  }
}

if (isMain(import.meta.url)) process.exit(main(process.argv.slice(2)));
