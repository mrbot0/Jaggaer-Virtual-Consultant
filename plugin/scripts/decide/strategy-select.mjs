// Selezione della strategia (§14.3) con DT-017 via dt-eval: l'agente non inventa il piano, lo
// seleziona e lo esegue. Punteggio = forma×0.35 + rischio×0.30 + precedente×0.20 + sorprese×0.15.
//
// Oltre al punteggio (tutto dentro DT-017, qui solo la traduzione degli input):
//  - STR-BISECT per diagnosi con prima divergenza ignota, indipendente dal punteggio (override);
//  - STR-MIN-CHANGE in combinazione in modalità configurazione con ipotesi da verificare;
//  - STR-PREMORTEM in combinazione per R ≥ R2 in deliberazione profonda;
//  - STR-DISCONFIRM in combinazione con un'ipotesi preferita di prior > 0.6;
//  - dopo STR-DRY-RUN, `then` = la strategia di forma ("poi la strategia di forma", §14.3; §18.1).
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { evaluate, loadTable, canonicalValue, asciiAlias, DtDomainError, DtTableError } from "./dt-eval.mjs";
import { isMain } from "../lib/is-main.mjs";
import { parseArgs, fail } from "../lib/args.mjs";
import { confineInputs } from "../lib/text-file.mjs";

export const STRATEGIES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "strategies");
export const MODES = ["nrt", "config", "ops", "diag"];
const MODE_ALIASES = { configurazione: "config", configuration: "config", operativa: "ops", operations: "ops", diagnosi: "diag", diagnosis: "diag", collaudo: "nrt" };
// Le classi del precedente vengono dal dominio di DT-017 (WP10c giro 1): sulla riga di comando anche nella forma ASCII
// (confermato-d-lt-0.2 …, regola di asciiAlias in dt-eval), riportata qui al valore canonico.
const PRECEDENT_DOMAIN = loadTable("DT-017").inputs.find((i) => i.name === "precedent").domain;
const PRECEDENT_CLASSES = Object.keys(PRECEDENT_DOMAIN.enum);
// La strategia di forma dopo la prova a vuoto (le righe 0.35–0.55 e 0.55–0.75 di §14.3).
const SHAPE_STRATEGY = { libresco: "STR-VERIFY-FIRST", empirico: "STR-GENERALIZE-CAUTIOUSLY", contraddittorio: "STR-TRIANGULATE", ignoto: "STR-ASK-EARLY" };

export class StrategyInputError extends DtDomainError { constructor(m) { super(m); this.name = "StrategyInputError"; } }

// Il precedente più vicino nelle classi di DT-017. Accetta la classe stessa, una riga di
// `kb precedents` ({ d, result }) o l'elenco ordinato restituito da precedents() (vale il primo:
// "precedente più vicino", con le smentite già in testa a parità di distanza). §12.4: un
// confermato oltre 0.5 o uno smentito oltre 0.3 non conta (nessuno). `parziale` entro 0.3 vale
// come smentita (prudenza: l'esito non ha confermato la scelta), oltre come nessuno.
export function precedentClass(p) {
  if (p === undefined || p === null) return "nessuno";
  if (typeof p === "string") {
    const c = canonicalValue(PRECEDENT_DOMAIN, p);
    if (!PRECEDENT_CLASSES.includes(c)) throw new StrategyInputError(`precedente '${p}' fuori dominio (${PRECEDENT_CLASSES.map((k) => (asciiAlias(k) === k ? k : `${asciiAlias(k)} = ${k}`)).join(" · ")})`);
    return c;
  }
  const row = Array.isArray(p) ? p[0] : p;
  if (!row) return "nessuno";
  const d = Number(row.d);
  if (!Number.isFinite(d)) throw new StrategyInputError("precedente senza distanza d");
  if (row.result === "confermata") return d < 0.2 ? "confermato-d<0.2" : d < 0.5 ? "confermato-d<0.5" : "nessuno";
  if (row.result === "smentita" || row.result === "parziale") return d < 0.3 ? "smentito-d<0.3" : "nessuno";
  return "nessuno";
}

function normMode(mode) {
  if (mode === undefined || mode === null) return null;
  const m = MODE_ALIASES[mode] ?? mode;
  if (!MODES.includes(m)) throw new StrategyInputError(`modalità '${mode}' sconosciuta (${MODES.join(" · ")})`);
  return m;
}

export function selectStrategy({ shape, risk, precedent, surprises = 0, mode, divergence_unknown = false, has_hypotheses = false,
  depth, preferred_prior } = {}, { table = loadTable("DT-017"), priors = {} } = {}) {
  const m = normMode(mode);
  const n = surprises === undefined || surprises === null ? 0 : Number(surprises);
  if (!Number.isInteger(n) || n < 0) throw new StrategyInputError(`sorprese '${surprises}' non è un intero ≥ 0`);
  if (preferred_prior !== undefined && preferred_prior !== null && !(Number(preferred_prior) >= 0 && Number(preferred_prior) <= 1)) {
    throw new StrategyInputError(`prior dell'ipotesi preferita '${preferred_prior}' fuori da [0, 1]`);
  }
  const inputs = {
    shape, risk,
    precedent: precedentClass(precedent),
    surprises: String(Math.min(n, 3)),                       // dalla terza in poi il compito si ferma (§13.3)
    diagnosis_unknown_divergence: m === "diag" && !!divergence_unknown,
    config_hypothesis: m === "config" && !!has_hypotheses,
    depth: depth ?? undefined,
    preferred_hypothesis_strong: preferred_prior !== undefined && preferred_prior !== null && Number(preferred_prior) > 0.6,
  };
  for (const k of Object.keys(inputs)) if (inputs[k] === undefined) delete inputs[k];
  const r = evaluate(table, inputs, { priors });
  const out = { strategy: r.outcome, combine: r.combined, score: r.score, rule: r.rule, inputs: r.inputs, table_version: r.table_version };
  if (r.outcome === "STR-DRY-RUN" && SHAPE_STRATEGY[r.inputs.shape]) out.then = SHAPE_STRATEGY[r.inputs.shape];
  return out;
}

export function loadStrategies(dir = STRATEGIES_DIR) {
  const out = {};
  for (const f of readdirSync(dir).filter((x) => /^STR-[A-Z-]+\.yaml$/.test(x)).sort()) {
    const s = YAML.parse(readFileSync(join(dir, f), "utf8"));
    out[s.code] = s;
  }
  return out;
}

const HELP = `uso: node scripts/decide/strategy-select.mjs --shape <forma> --risk R0..R3 [--precedent <classe>|--precedents file.json]
       [--surprises N] [--mode nrt|config|ops|diag] [--divergence-unknown] [--has-hypotheses]
       [--depth rapida|standard|profonda] [--preferred-prior 0.7] [--input file.json] [--plan] [--json] [--help]

Sceglie la strategia (§14.3) con DT-017 e stampa { strategy, then?, combine, score, rule }.
--precedent: confermato-d-lt-0.2 · confermato-d-lt-0.5 · nessuno · smentito-d-lt-0.3 (forma ASCII delle classi
            di DT-017 confermato-d<0.2 …: < e > negli argomenti sono negati dai guard; regola < → -lt-)
--precedents: l'output di 'kb precedents --json' (vale il più vicino).
--input: tutti gli input in un file JSON (chiavi come sopra, in snake_case).
--plan: aggiunge il piano della strategia scelta (strategies/STR-*.yaml).

Exit code: 0 ok · 1 errore utente (input fuori dominio o mancante, file illeggibile) · 2 errore di sistema.`;

function readJson(v) { return JSON.parse(v.trim().startsWith("{") || v.trim().startsWith("[") ? v : readFileSync(v, "utf8")); }

export function run(argv) {
  const { opts } = parseArgs(argv, { flags: ["divergence-unknown", "has-hypotheses", "plan"] });
  const asJson = !!opts.json;
  if (opts.help) { console.log(HELP); return 0; }
  { const bad = confineInputs(opts, ["input","precedents"], {}); if (bad) return fail(asJson, 1, bad); }
  let input;
  try {
    input = opts.input ? readJson(opts.input) : {};
    const precedents = opts.precedents ? readJson(opts.precedents) : undefined;
    const set = (k, v) => { if (v !== undefined) input[k] = v; };
    set("shape", opts.shape);
    set("risk", opts.risk);
    set("precedent", precedents?.items ?? precedents ?? opts.precedent);
    set("surprises", opts.surprises !== undefined ? Number(opts.surprises) : undefined);
    set("mode", opts.mode);
    if (opts["divergence-unknown"]) input.divergence_unknown = true;
    if (opts["has-hypotheses"]) input.has_hypotheses = true;
    set("depth", opts.depth);
    set("preferred_prior", opts["preferred-prior"] !== undefined ? Number(opts["preferred-prior"]) : undefined);
  } catch (e) { return fail(asJson, 1, `input illeggibile: ${e.message ?? e}`); }
  try {
    const r = selectStrategy(input);
    const { inputs, ...rest } = r;
    const out = { ...rest, inputs };
    if (opts.plan && r.strategy !== "nessuna") out.plan = loadStrategies()[r.strategy] ?? null;
    console.log(JSON.stringify(asJson ? { ok: true, ...out } : out));
    return 0;
  } catch (e) {
    if (e instanceof DtDomainError || e instanceof DtTableError) return fail(asJson, 1, e.message);
    return fail(asJson, 2, `errore di sistema: ${e.message ?? e}`);
  }
}

if (isMain(import.meta.url)) process.exit(run(process.argv.slice(2)));
