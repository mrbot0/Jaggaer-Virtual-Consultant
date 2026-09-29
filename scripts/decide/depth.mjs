// Profondità di deliberazione (§10.4) con DT-023: quanto pensare prima di agire. Il manager la
// assegna prima del passo 2 (RICHIAMARE); fissa quanti item e precedenti richiamare, quante
// alternative confrontare, se aprire i file oltre i summary, se fare pre-mortem, il tier e
// l'auto-verifica (ridotta in rapida: controlli 1, 3, 9 più #11; l'insieme viene da self-check-controls.mjs,
// la stessa fonte che self-check esegue).
import { evaluate, loadTable, DtDomainError, DtTableError } from "./dt-eval.mjs";
import { precedentClass } from "./strategy-select.mjs";
import { controlsFor } from "./self-check-controls.mjs";
import { readFileSync } from "node:fs";
import YAML from "yaml";
import { isMain } from "../lib/is-main.mjs";
import { parseArgs, fail } from "../lib/args.mjs";

const RISK_RANK = { R0: 0, R1: 1, R2: 2, R3: 3 };

// La tabella di §10.4, colonna "Cosa cambia nel ciclo".
export const PROFILES = {
  rapida: { recall: { items: 3, precedents: 1, other_customers: false }, alternatives: 0, open_files: "no", hypotheses_register: false,
    self_check_controls: controlsFor("rapida"), tier: "T0" },
  standard: { recall: { items: 8, precedents: 3, other_customers: false }, alternatives: 2, open_files: "se-il-summary-non-basta",
    hypotheses_register: false, self_check_controls: controlsFor("standard"), tier: "T1" },
  profonda: { recall: { items: 15, precedents: 5, other_customers: true }, alternatives: "esplicite con costi e rischi", open_files: "sì",
    hypotheses_register: true, self_check_controls: controlsFor("standard"), tier: "T2" },
};

export function deliberationDepth({ risk, shape, surprises = 0, precedent, graph_radius, graph_radius_gt5, never_executed_here } = {}) {
  const n = Number(surprises ?? 0);
  if (!Number.isInteger(n) || n < 0) throw new DtDomainError(`sorprese '${surprises}' non è un intero ≥ 0`);
  const inputs = {
    risk, shape,
    surprises: String(Math.min(n, 3)),
    precedent: precedentClass(precedent),
    graph_radius_gt5: graph_radius_gt5 ?? (graph_radius === undefined || graph_radius === null ? undefined : Number(graph_radius) > 5),
    never_executed_here,
  };
  for (const k of Object.keys(inputs)) if (inputs[k] === undefined) delete inputs[k];
  const r = evaluate(loadTable("DT-023"), inputs);
  const p = PROFILES[r.outcome];
  // Pre-mortem: in deliberazione profonda, per R ≥ R2 (§14.2 STR-PREMORTEM; la riga "profonda" di §10.4
  // lo elenca, la strategia ne precisa il perimetro: una modifica, cioè R ≥ R2).
  const premortem = r.outcome === "profonda" && (RISK_RANK[r.inputs.risk] ?? 0) >= 2;
  return { depth: r.outcome, score: r.score, rule: r.rule, ...structuredClone(p), premortem, inputs: r.inputs };
}

const HELP = `uso: node scripts/decide/depth.mjs --risk R0..R3 [--shape <forma>] [--surprises N] [--precedent <classe>|--precedents file.json]
       [--graph-radius N] [--never-executed-here true|false] [--input file.json|file.yaml] [--json] [--help]

Profondità di deliberazione (§10.4, DT-023): { depth, recall: {items, precedents, other_customers},
alternatives, open_files, premortem, hypotheses_register, self_check_controls, tier }.
--precedent: confermato-d-lt-0.2 · confermato-d-lt-0.5 · nessuno · smentito-d-lt-0.3 (forma ASCII delle classi di
             DT-023 confermato-d<0.2 …: < e > negli argomenti sono negati dai guard; regola < → -lt-)
--precedents: l'output di 'kb precedents --json' salvato in un file (vale il più vicino).
--input: tutti gli input in un file JSON o YAML (risk, shape, surprises, precedent, graph_radius, never_executed_here);
         le opzioni della riga di comando prevalgono sul file.

Exit code: 0 ok · 1 errore utente (input fuori dominio o mancante, file illeggibile) · 2 errore di sistema.`;

export function run(argv) {
  const { opts } = parseArgs(argv);
  const asJson = !!opts.json;
  if (opts.help) { console.log(HELP); return 0; }
  // WP10c giro 1 (I1): input anche da file, come strategy-select (--input, --precedents); le opzioni prevalgono.
  let input;
  try {
    const readFile = (p) => YAML.parse(readFileSync(p, "utf8"));
    input = opts.input ? readFile(opts.input) ?? {} : {};
    if (typeof input !== "object" || Array.isArray(input)) throw new Error("--input: atteso un oggetto");
    const precedents = opts.precedents ? readFile(opts.precedents) : undefined;
    const set = (k, v) => { if (v !== undefined) input[k] = v; };
    set("risk", opts.risk);
    set("shape", opts.shape);
    set("surprises", opts.surprises !== undefined ? Number(opts.surprises) : undefined);
    set("precedent", precedents?.items ?? precedents ?? opts.precedent);
    set("graph_radius", opts["graph-radius"] !== undefined ? Number(opts["graph-radius"]) : undefined);
    set("never_executed_here", opts["never-executed-here"] === undefined ? undefined : opts["never-executed-here"] === "true");
  } catch (e) { return fail(asJson, 1, `input illeggibile: ${e.message ?? e}`); }
  try {
    const r = deliberationDepth({ surprises: 0, ...input });
    console.log(JSON.stringify(asJson ? { ok: true, ...r } : r));
    return 0;
  } catch (e) {
    if (e instanceof DtDomainError || e instanceof DtTableError) return fail(asJson, 1, e.message);
    return fail(asJson, 2, `errore di sistema: ${e.message ?? e}`);
  }
}

if (isMain(import.meta.url)) process.exit(run(process.argv.slice(2)));
