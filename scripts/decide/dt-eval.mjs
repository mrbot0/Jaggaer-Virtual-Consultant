// Valutatore delle tabelle di decisione (§15, contratto §46.6).
//
// `evaluate` è una funzione pura: nessun Date, nessun Math.random, nessun I/O.
// Stesso input → stesso output, byte per byte. Il punteggio è arrotondato a
// 1e-6 prima di scegliere la banda, così che somme come .175 + .15 + .15 non
// dipendano dagli ultimi bit della virgola mobile.
//
// Ordine: overrides (primo che corrisponde) → banda [from, to) che contiene
// il punteggio (l'ultima include 1) → outcome_selectors della banda (primo che
// corrisponde) → outcome / outcome_from della banda.
import Ajv2020 from "ajv/dist/2020.js";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { openDb } from "../kb/db.mjs";
import { assignSeq, formatCode } from "../kb/assign-seq.mjs";
import { isValidCode } from "../kb/codes.mjs";
import { rates } from "../digest/outcomes-rates.mjs";
import { rootFromDb } from "../lib/root-from-db.mjs";
import { isMain } from "../lib/is-main.mjs";
import { parseArgs, fail } from "../lib/args.mjs";

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const TABLES_DIR = join(PLUGIN_ROOT, "decision-tables");
const ajv = new Ajv2020({ allErrors: true, strict: false });
const validateSchema = ajv.compile(JSON.parse(readFileSync(join(PLUGIN_ROOT, "schemas", "dt.schema.json"), "utf8")));

export class DtDomainError extends Error { constructor(m) { super(m); this.name = "DtDomainError"; } }
export class DtNullError extends DtDomainError { constructor(m) { super(m); this.name = "DtNullError"; } }
export class DtTableError extends Error { constructor(m) { super(m); this.name = "DtTableError"; } }

const EPS = 0.001;
const round6 = (x) => Math.round(x * 1e6) / 1e6;
const has = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k);

// ——— dominio ———
function domainKeys(domain) {
  if (domain.enum) return Object.keys(domain.enum);
  if (domain.boolean) return ["true", "false"];
  return null;
}
// WP10c giro 1 (I1): alias ASCII dei valori di dominio con caratteri che i guard negano in ogni argomento di shell
// (< e >: DT-003 volume, classi di precedente di DT-017/DT-023 — e `>` senza virgolette è una redirezione;
// l'apostrofo: il genere "d'uso" di DT-011/DT-019). Una sola regola, applicata a ogni valore enum di ogni tabella:
// `<` → `-lt-`, `>` → `-gt-`, `'` → `-`, poi via i trattini doppi e ai bordi ("<5k" → "lt-5k",
// "confermato-d<0.2" → "confermato-d-lt-0.2", "d'uso" → "d-uso"). L'alias si riporta al valore canonico PRIMA della
// valutazione: uscita, DEC e confronti usano il canonico. Stesso trattamento per le chiavi numeriche con zeri iniziali
// (DT-007 area "005"): nome=valore le tipizza come numero (5), che si riporta alla chiave se è l'unica con quel valore.
export const ALIAS_UNSAFE = /[<>']/;
export const asciiAlias = (value) => String(value).replace(/</g, "-lt-").replace(/>/g, "-gt-").replace(/'/g, "-").replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "");
export function canonicalValue(domain, v) {
  if (!domain?.enum || has(domain.enum, String(v))) return v;
  if (typeof v === "number") {
    const ks = Object.keys(domain.enum).filter((key) => /^\d+$/.test(key) && Number(key) === v);
    return ks.length === 1 ? ks[0] : v;
  }
  if (typeof v !== "string") return v;
  const k = Object.keys(domain.enum).find((key) => ALIAS_UNSAFE.test(key) && asciiAlias(key) === v);
  return k ?? v;
}
const aliasNote = (domain) => {
  const a = domainKeys(domain)?.filter((k) => ALIAS_UNSAFE.test(k)).map((k) => `${k} = ${asciiAlias(k)}`) ?? [];
  return a.length ? `; alias ASCII: ${a.join(" · ")}` : "";
};
function inDomain(domain, v) {
  if (domain.enum) return (typeof v === "string" || typeof v === "number" || typeof v === "boolean") && has(domain.enum, String(v));
  if (domain.boolean) return typeof v === "boolean";
  const [min, max] = domain.range;
  return typeof v === "number" && Number.isFinite(v) && v >= min && (v <= max || !!domain.saturate);
}
function scoreOf(inp, v) {
  const d = inp.domain;
  if (!inDomain(d, v)) {
    const allowed = d.range ? `[${d.range.join(", ")}]` : domainKeys(d).join(" · ");
    throw new DtDomainError(`input '${inp.name}': valore ${JSON.stringify(v)} fuori dominio (${allowed}${d.range ? "" : aliasNote(d)})`);
  }
  if (d.enum) return d.enum[String(v)];
  if (d.boolean) return d.boolean[String(v)];
  const [min, max] = d.range;
  const norm = max === min ? 0 : (Math.min(v, max) - min) / (max - min);
  return d.invert ? 1 - norm : norm;
}
function worstValue(d) {
  if (d.enum) return Object.entries(d.enum).reduce((best, e) => (e[1] > best[1] ? e : best))[0];
  if (d.boolean) return d.boolean.true >= d.boolean.false;
  return d.invert ? d.range[0] : d.range[1];
}
function parseDefault(d, raw) {
  if (d.boolean) return raw === "true" ? true : raw === "false" ? false : raw;
  if (d.range) return Number(raw);
  return raw;
}
function matches(when, values) {
  return Object.entries(when).every(([k, v]) => {
    if (!has(values, k)) return false;
    const actual = String(values[k]);
    return Array.isArray(v) ? v.some((x) => String(x) === actual) : String(v) === actual;
  });
}
const inBand = (score, from, to) => score >= from && (score < to || (to === 1 && score <= 1));

// ——— validazione della tabella ———
export function validateTable(t) {
  const errors = [];
  if (!validateSchema(t)) {
    errors.push(...validateSchema.errors.map((e) => `${e.instancePath || "/"} ${e.message}`));
    return { ok: false, errors };
  }
  const all = [...t.inputs, ...t.priors];
  const names = all.map((x) => x.name);
  if (new Set(names).size !== names.length) errors.push("nomi di input/prior duplicati");
  const sum = all.reduce((a, x) => a + x.weight, 0);
  if (Math.abs(sum - 1) > EPS) errors.push(`somma dei pesi ${round6(sum)} ≠ 1.0 ± ${EPS}`);
  const byName = Object.fromEntries(t.inputs.map((i) => [i.name, i]));
  for (const i of t.inputs) if (i.domain.range && !(i.domain.range[1] > i.domain.range[0])) errors.push(`input '${i.name}': range vuoto`);
  // alias ASCII (WP10c giro 1): un alias non può coincidere con un altro valore del dominio né con un altro alias
  for (const i of t.inputs.filter((x) => x.domain.enum)) {
    const keys = Object.keys(i.domain.enum);
    const aliases = keys.filter((k) => ALIAS_UNSAFE.test(k)).map(asciiAlias);
    if (new Set([...keys, ...aliases]).size !== keys.length + aliases.length) errors.push(`input '${i.name}': alias ASCII in collisione con un valore del dominio`);
  }
  // bande contigue che coprono [0, 1]
  const th = t.thresholds;
  if (th[0].from !== 0) errors.push("bande: la prima deve partire da 0");
  if (th[th.length - 1].to !== 1) errors.push("bande: l'ultima deve arrivare a 1");
  th.forEach((b, i) => {
    if (!(b.to > b.from)) errors.push(`bande: [${b.from}, ${b.to}) vuota`);
    if (i > 0 && b.from !== th[i - 1].to) errors.push(`bande non contigue: ${th[i - 1].to} → ${b.from}`);
  });
  const outcomes = new Set(t.outcomes);
  const checkOutcome = (o, where) => { if (!outcomes.has(o)) errors.push(`${where}: esito '${o}' non dichiarato in outcomes`); };
  const checkWhen = (when, where) => {
    for (const [k, v] of Object.entries(when)) {
      const inp = byName[k];
      if (!inp) { errors.push(`${where}: input '${k}' inesistente`); continue; }
      for (const x of Array.isArray(v) ? v : [v]) if (!inDomain(inp.domain, x)) errors.push(`${where}: valore ${JSON.stringify(x)} fuori dominio di '${k}'`);
    }
  };
  th.forEach((b, i) => {
    if (b.outcome) checkOutcome(b.outcome, `thresholds[${i}]`);
    if (b.outcome_from) {
      const inp = byName[b.outcome_from];
      if (!inp?.domain.enum) errors.push(`thresholds[${i}]: outcome_from '${b.outcome_from}' non è un input enum`);
      else for (const k of Object.keys(inp.domain.enum)) checkOutcome(k, `thresholds[${i}].outcome_from`);
    }
  });
  (t.outcome_selectors ?? []).forEach((s, i) => {
    checkOutcome(s.outcome, `outcome_selectors[${i}]`); checkWhen(s.when, `outcome_selectors[${i}]`);
    if (!(s.to > s.from)) errors.push(`outcome_selectors[${i}]: intervallo vuoto`);
  });
  (t.overrides ?? []).forEach((o, i) => { checkOutcome(o.outcome, `overrides[${i}]`); checkWhen(o.when, `overrides[${i}]`); });
  (t.combinations ?? []).forEach((c, i) => checkWhen(c.when, `combinations[${i}]`));
  for (const k of Object.keys(t.outcome_annotations ?? {})) checkOutcome(k, "outcome_annotations");
  for (const i of t.inputs) {
    const p = t.null_policy[i.name];
    if (!p) { errors.push(`null_policy: manca la politica per '${i.name}'`); continue; }
    if (p.startsWith("default:") && !inDomain(i.domain, parseDefault(i.domain, p.slice(8)))) errors.push(`null_policy '${i.name}': default fuori dominio`);
  }
  for (const k of Object.keys(t.null_policy)) if (!byName[k]) errors.push(`null_policy: input '${k}' inesistente`);
  for (const p of t.priors) {
    // neutral = il valore che NON sposta il punteggio: 0 per un prior diretto, 1 per un prior invertito.
    const noShift = p.invert ? 1 : 0;
    if (p.neutral !== noShift) errors.push(`prior '${p.name}': neutral ${p.neutral} sposta il punteggio (deve valere ${noShift}${p.invert ? " per un prior invertito" : ""})`);
    for (const k of [p.source.outcome_input, ...(p.source.match_inputs ?? [])].filter(Boolean)) {
      if (!byName[k]) errors.push(`prior '${p.name}': input '${k}' inesistente`);
    }
    if (p.source.outcome && !p.source.table) checkOutcome(p.source.outcome, `prior '${p.name}'.source.outcome`);
  }
  return { ok: errors.length === 0, errors };
}

const validated = new WeakSet();
function ensureValid(t) {
  if (validated.has(t)) return;
  const v = validateTable(t);
  if (!v.ok) throw new DtTableError(`tabella ${t?.id ?? "?"} non valida: ${v.errors.join("; ")}`);
  validated.add(t);
}

export function loadTable(ref) {
  const file = /^DT-0\d{2}$/.test(ref) ? join(TABLES_DIR, `${ref}.yaml`) : ref;
  if (!existsSync(file)) throw new DtTableError(`tabella non trovata: ${ref}`);
  const t = YAML.parse(readFileSync(file, "utf8"));
  ensureValid(t);
  return t;
}

// ——— valutazione (pura) ———
export function evaluate(table, inputs = {}, { priors = {} } = {}) {
  ensureValid(table);
  // Un refuso non deve cadere nella null_policy: le chiavi non dichiarate sono un errore.
  const declared = new Set(table.inputs.map((i) => i.name));
  const undeclared = Object.keys(inputs ?? {}).filter((k) => !declared.has(k));
  if (undeclared.length) throw new DtDomainError(`input non dichiarati in ${table.id}: ${undeclared.join(", ")} (ammessi: ${[...declared].join(", ")})`);
  const declaredPriors = new Set(table.priors.map((p) => p.name));
  const undeclaredPriors = Object.keys(priors ?? {}).filter((k) => !declaredPriors.has(k));
  if (undeclaredPriors.length) throw new DtDomainError(`priori non dichiarati in ${table.id}: ${undeclaredPriors.join(", ")}`);
  const values = {};
  const components = [];
  for (const inp of table.inputs) {
    let v = canonicalValue(inp.domain, inputs[inp.name]);
    let applied = null;
    if (v === undefined || v === null) {
      const policy = table.null_policy[inp.name];
      if (policy === "error") throw new DtNullError(`input '${inp.name}' mancante (null_policy: error)`);
      v = policy === "worst" ? worstValue(inp.domain) : parseDefault(inp.domain, policy.slice(8));
      applied = policy;
    }
    const score = scoreOf(inp, v);
    values[inp.name] = v;
    const c = { name: inp.name, kind: "input", value: v, score: round6(score), weight: inp.weight, contribution: round6(inp.weight * score) };
    if (applied) c.null_policy = applied;
    components.push(c);
  }
  const prior_used = [];
  for (const p of table.priors) {
    const given = priors[p.name];
    const obj = given !== null && typeof given === "object" ? given : { value: given };
    let value = obj.value;
    let applied = "provided";
    if (value === undefined || value === null || obj.sufficient === false) { value = p.neutral; applied = "neutral"; }
    else if (obj.source === "auto") applied = "auto";
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
      throw new DtDomainError(`prior '${p.name}': valore ${JSON.stringify(value)} fuori da [0, 1]`);
    }
    const score = p.invert ? 1 - value : value;
    const used = { name: p.name, value, applied };
    if (obj.n !== undefined) used.n = obj.n;
    if (obj.sufficient !== undefined) used.sufficient = obj.sufficient;
    prior_used.push(used);
    components.push({ name: p.name, kind: "prior", value, score: round6(score), weight: p.weight, contribution: round6(p.weight * score) });
  }
  const score = Math.min(1, Math.max(0, round6(components.reduce((a, c) => a + c.weight * c.score, 0))));
  let outcome;
  let rule;
  const oi = (table.overrides ?? []).findIndex((o) => matches(o.when, values));
  if (oi >= 0) { outcome = table.overrides[oi].outcome; rule = `override[${oi}]`; }
  else {
    const si = (table.outcome_selectors ?? []).findIndex((s) => inBand(score, s.from, s.to) && matches(s.when, values));
    if (si >= 0) { outcome = table.outcome_selectors[si].outcome; rule = `selector[${si}]`; }
    else {
      const bi = table.thresholds.findIndex((b) => inBand(score, b.from, b.to));
      const band = table.thresholds[bi];
      outcome = band.outcome ?? String(values[band.outcome_from]);
      rule = `band[${bi}]`;
    }
  }
  const combined = [...new Set((table.combinations ?? []).filter((c) => matches(c.when, values)).map((c) => c.add))];
  return {
    table: table.id,
    table_version: table.version,
    outcome,
    score,
    rule,
    components,
    prior_used,
    combined,
    annotation: table.outcome_annotations?.[outcome] ?? null,
    inputs: values,
  };
}

// ——— priori dal registro (§12.2) ———
export function autoPriors(db, table, inputs, { customer, cluster, strategy } = {}) {
  const out = {};
  for (const p of table.priors) {
    if (p.source.metric !== "rate_disproved") { out[p.name] = null; continue; }
    const by = p.source.by ?? [];
    const ctx = { customer, cluster, strategy, shape: inputs.shape };
    if (by.some((k) => ctx[k] === undefined || ctx[k] === null)) { out[p.name] = { value: null, n: 0, sufficient: false }; continue; }
    const outcome = p.source.outcome_input ? inputs[p.source.outcome_input] : p.source.outcome;
    const match = {};
    for (const k of p.source.match_inputs ?? []) match[k] = inputs[k];
    if ((p.source.outcome_input && outcome == null) || Object.values(match).some((v) => v == null)) {
      out[p.name] = { value: null, n: 0, sufficient: false }; continue;
    }
    const filter = { table: p.source.table ?? table.id, outcome: outcome == null ? undefined : String(outcome), match };
    for (const k of by) filter[k] = ctx[k];
    const r = rates(db, filter);
    out[p.name] = { value: r.sufficient ? r.rate_disproved : null, n: r.n, sufficient: r.sufficient, source: "auto" };
  }
  return out;
}

// ——— scrittura della DEC (§29.6: prima di restituire l'esito) ———
// `context` (facoltativo, K3): { release, shape, facets, confidence, effects } in decision_context —
// età in release e forma al momento per la distanza dei precedenti (§12.3), confidenza dichiarata
// per la calibrazione (§17.4), effetti per il self-check (§17.1 #4-#5).
export function writeDecision(db, { customer, scope, root, result, agent = null, session = null, subject = null, cluster = null, strategy = null, at, context = null }) {
  return db.transaction(() => {
    const key = { level: "L", customer, scope, type: "DEC" };
    const code = formatCode({ ...key, seq: assignSeq(db, key, { table: "decisions" }) });
    if (!isValidCode(code)) throw new DtDomainError(`codice DEC non valido: ${code} (cliente di 4 caratteri, scope del registro)`);
    const strat = strategy ?? (result.table === "DT-017" ? result.outcome : null);
    db.prepare(`insert into decisions(code,table_code,agent,session,subject_code,subject_cluster,inputs,priors,score,outcome,strategy,at)
      values (?,?,?,?,?,?,?,?,?,?,?,?)`).run(code, result.table, agent, session, subject, cluster, JSON.stringify(result.inputs),
      JSON.stringify(result.prior_used), result.score, result.outcome, strat, at);
    if (context) {
      const shape = context.shape ?? result.inputs?.shape ?? null;
      db.prepare("insert into decision_context(decision_code,release_ref,shape,facets,confidence,effects) values (?,?,?,?,?,?)")
        .run(code, context.release ?? null, shape, context.facets ? JSON.stringify(context.facets) : null,
          Number.isFinite(context.confidence) ? context.confidence : null, context.effects === undefined || context.effects === null ? null : context.effects ? 1 : 0);
    }
    const doc = { id: code, type: "DEC", table: result.table, table_version: result.table_version, at, agent, session,
      subject, subject_cluster: cluster, strategy: strat, inputs: result.inputs, priors: result.prior_used,
      score: result.score, outcome: result.outcome, rule: result.rule, combined: result.combined, components: result.components };
    const dir = join(root, "decisions");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${code}.yaml`), YAML.stringify(doc));
    return code;
  })();
}

const HELP = `uso: node scripts/decide/dt-eval.mjs --table DT-002 (--inputs inputs.json | nome=valore …) [--priors auto|file.json]
       [--customer ACME] [--scope ADM] [--db path] [--root <dir cliente>] [--session SES…] [--agent nome]
       [--subject CODICE] [--cluster CL-…] [--strategy STR-…] [--write-dec]
       [--release R] [--confidence 0.85] [--effects | --no-effects] [--json] [--help]

Valuta una tabella di decisione (§15, §46.6) e stampa
{ outcome, score, components, prior_used, table_version, dec_code }.
--inputs: file JSON (o JSON inline) con i valori degli input; i mancanti applicano null_policy.
nome=valore (posizionali, ripetibili): gli input senza file (true/false/null/numeri tipizzati); sovrascrivono
--inputs. È la forma per gli agenti che non scrivono file (mai JSON in linea negli argomenti degli agenti).
Valori con < > o apostrofo (volume di DT-003, classi di precedente, genere d'uso): sulla riga di comando la forma ASCII,
regola < → -lt-, > → -gt-, ' → - (volume=lt-5k · volume=gt-30k · precedent=confermato-d-lt-0.2 · preferred_genre=d-uso):
i guard negano quei caratteri negli argomenti. Le chiavi numeriche con zeri (area=005) valgono anche come numero.
--priors auto: tassi dal registro (outcomes-rates); sotto 30 DEC verificate vale il 'neutral' dichiarato.
--priors file.json: { nome_prior: valore } in [0, 1].
--effects / --no-effects: la decisione ha / non ha effetti; senza nessuno dei due gli effetti sono
ignoti (NULL) e il self-check li deduce dal compito.
--write-dec: scrive la DEC (riga in decisions + <root>/decisions/<codice>.yaml) PRIMA di stampare
l'esito (§29.6); richiede --db, --customer (4 caratteri), --scope e --root (default solo se --db è
customers/<C>/knowledge.db del --customer dichiarato; mai product/ o kb/). --release, --confidence
e --effects registrano il contesto della DEC (età in release per i precedenti §12.3, confidenza
dichiarata per la calibrazione §17.4, decisione con effetti per il self-check §17.1).

Exit code: 0 ok · 1 errore utente (input fuori dominio o mancante con null_policy error, tabella
non valida o sconosciuta, argomenti) · 2 errore di sistema · 3 riservato (violazione di policy).`;

function readJsonArg(v) {
  if (v.trim().startsWith("{")) return JSON.parse(v);
  return JSON.parse(readFileSync(v, "utf8"));
}

// WP10b (ruling 6): input come argomenti posizionali `nome=valore` (per gli agenti che non scrivono file); true/false,
// null e numeri sono tipizzati, il resto è testo. Mai JSON in linea negli argomenti degli agenti.
export function parseKeyValues(args) {
  const out = {};
  for (const a of args) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(a);
    if (!m) throw new Error(`argomento non riconosciuto: ${a} (atteso nome=valore)`);
    const v = m[2];
    out[m[1]] = v === "true" ? true : v === "false" ? false : v === "null" ? null : /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v;
  }
  return out;
}

function main(argv) {
  const { opts, positional } = parseArgs(argv, { flags: ["write-dec", "effects", "no-effects"] });
  const asJson = !!opts.json;
  if (opts.help) { console.log(HELP); return 0; }
  if (!opts.table || (!opts.inputs && !positional.length)) return fail(asJson, 1, "richiesti --table e gli input (--inputs <file.json> e/o nome=valore)");
  let table, inputs, filePriors = null, db = null;
  try {
    table = loadTable(opts.table);
    inputs = { ...(opts.inputs ? readJsonArg(opts.inputs) : {}), ...parseKeyValues(positional) };
    // file dei priori letto qui: un file mancante o malformato è un errore utente (exit 1)
    if (opts.priors && opts.priors !== "auto") filePriors = readJsonArg(opts.priors);
  } catch (e) { return fail(asJson, 1, String(e.message ?? e)); }
  const needDb = opts.priors === "auto" || opts["write-dec"];
  if (needDb && !opts.db) return fail(asJson, 1, "--priors auto e --write-dec richiedono --db");
  if (opts["write-dec"]) {
    opts.root = rootFromDb(opts);
    if (!opts.root || !opts.customer || !opts.scope) return fail(asJson, 1, "--write-dec richiede --customer, --scope e --root (default solo se --db è customers/<C>/knowledge.db del --customer)");
  }
  try {
    if (needDb) db = openDb(opts.db, { createIfMissing: false });
  } catch (e) { return fail(asJson, 1, String(e.message ?? e)); }
  try {
    let priors = {};
    if (opts.priors === "auto") priors = autoPriors(db, table, inputs, { customer: opts.customer, cluster: opts.cluster, strategy: opts.strategy });
    else if (filePriors) priors = filePriors;
    const result = evaluate(table, inputs, { priors });
    let dec_code = null;
    if (opts["write-dec"]) {
      dec_code = writeDecision(db, { customer: opts.customer, scope: opts.scope, root: opts.root, result, agent: opts.agent ?? null,
        session: opts.session ?? null, subject: opts.subject ?? null, cluster: opts.cluster ?? null, strategy: opts.strategy ?? null,
        at: new Date().toISOString(),
        context: { release: opts.release ?? null, confidence: opts.confidence !== undefined ? Number(opts.confidence) : null, effects: opts.effects ? true : opts["no-effects"] ? false : undefined } });
    }
    const out = { outcome: result.outcome, score: result.score, components: result.components, prior_used: result.prior_used,
      table_version: result.table_version, dec_code, table: result.table, rule: result.rule, combined: result.combined, annotation: result.annotation };
    console.log(JSON.stringify(asJson ? { ok: true, ...out } : out));
    return 0;
  } catch (e) {
    if (e instanceof DtDomainError || e instanceof DtTableError || e instanceof SyntaxError) return fail(asJson, 1, String(e.message));
    return fail(asJson, 2, `errore di sistema: ${e.message ?? e}`);
  } finally { db?.close(); }
}

if (isMain(import.meta.url)) process.exit(main(process.argv.slice(2)));
