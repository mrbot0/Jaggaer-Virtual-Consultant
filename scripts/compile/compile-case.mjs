// compile-case (F4.1, §46.3, §27.1, §29.6): da un caso NRT.* al piano di esecuzione come traccia attesa.
//
//   compileCase(ws, caso, { customer?, env = "sandbox", envType?, run?, registry? }) →
//     { plan, trace[], evidence[], fixtures{}, compensations[], warnings[] }
//   - il caso deve validare (nrt-case.schema.json: derivation e boundary obbligatori) e non citare il dominio analitico
//     (PAT PBK BRF RUL, §1.1): altrimenti rifiuto;
//   - passi della composizione fino a boundary.stop_at_step (il confine: oltre non si esegue); dai passi della FLW
//     (from_flow) si ereditano verbo, target, dati e expect; ogni passo ha un expect (dal caso, dalla FLW o, per un
//     target SEL, "l'elemento del SEL è visibile"): la traccia attesa per passo; un target SEL deve esistere nell'Atlas;
//   - fixture risolte con lookup_or_fail (scripts/run/fixtures.mjs): una fixture mancante rifiuta il caso;
//     {{fixture.<nome>}} e {{fixture.<nome>.<attributo>}} sostituiti nei dati e negli expect; {{prefix}} = NRT-<data>-<run>;
//   - ogni passo che crea, modifica o invia (classe ACT-CREATE/UPDATE/SUBMIT con verbo SAVE/SUBMIT/TOGGLE/UPLOAD, o
//     `creates`) ha la sua compensazione (close · cancel · deactivate · restore) nel piano, legata al passo: step-check
//     la registra in session.pending.compensations e runs/<RUN>/compensations.yaml PRIMA del passo (§29.6, §47.2 #1).
//     Un passo che crea senza compensazione ⇒ rifiuto (test F4.1);
//   - il piano valida contro execution-plan.schema.json e il catalogo delle azioni (validate-plan).
//
// CLI: node scripts/compile/compile-case.mjs --case <file.yaml> [--customer C] [--env <id>] [--env-type sandbox|preprod|prod]
//      [--run <RUN>] [--out <file.json>] [--workspace <dir>] [--json]
// Exit: 0 compilato · 1 caso malformato · 2 errore di sistema · 3 rifiuto (compensazione mancante, fixture mancante,
//       dominio analitico, SEL assente, piano non valido).
import { readFileSync, mkdirSync } from "node:fs";
import { join, resolve as resolvePath, dirname } from "node:path";
import YAML from "yaml";
import { parseArgs, fail } from "../lib/args.mjs";
import { isMain } from "../lib/is-main.mjs";
import { writeFileAtomic } from "../../hooks/lib/fsx.mjs";
import { validateCase } from "../kb/validate-schema.mjs";
import { validatePlan } from "../decide/validate-plan.mjs";
import { loadItem, analyticCodes, typeOf } from "../lib/kb-items.mjs";
import { loadRegistry, resolveCaseFixtures, entityPrefix } from "../run/fixtures.mjs";
import { COMMIT_VERBS } from "../../hooks/lib/guards/config-scope.mjs";
import { caseFingerprint } from "../lib/fingerprint.mjs";

export class CompileError extends Error { constructor(code, msg, extra = {}) { super(msg); this.code = code; Object.assign(this, extra); } }
export const COMP_CLASSES = new Set(["ACT-CREATE", "ACT-UPDATE", "ACT-SUBMIT"]);

// Classe d'azione di un passo del caso: dichiarata, oppure dedotta dal verbo e da `creates`.
export function classOf(step) {
  if (step.action_class) return step.action_class;
  const k = step.creates?.kind;
  if (step.verb === "SUBMIT") return "ACT-SUBMIT";
  if (step.verb === "UPLOAD") return "ACT-UPLOAD";
  if (step.verb === "SAVE") return k === "update" ? "ACT-UPDATE" : k === "submit" ? "ACT-SUBMIT" : "ACT-CREATE";
  if (step.verb === "TOGGLE") return k === "create" ? "ACT-CREATE" : "ACT-UPDATE";
  if (step.verb === "CHOOSE") return "ACT-CREATE";
  return "ACT-OBS";   // NAVIGATE · READ · WAIT · VERIFY · CAPTURE · ASK · CLICK · FILL · SELECT
}
// Compensazione fornita dalla FLW per un passo del caso (la stessa regola in compile-case e lint-spec, giro 1): quella
// della FLW del passo (from_flow) o, senza, quella dell'unica FLW della composizione.
export function flowCompensationFor(caso, s0, flowOf) {
  if (s0?.from_flow) return flowOf(s0.from_flow.flow)?.compensation ?? null;
  const flows = caso?.composition?.flows ?? [];
  return flows.length === 1 ? flowOf(flows[0])?.compensation ?? null : null;
}
// Passo del caso con ciò che eredita dalla FLW (from_flow).
export function mergedStep(s0, flowOf) {
  if (!s0?.from_flow) return s0;
  const fs = (flowOf(s0.from_flow.flow)?.steps ?? []).find((x) => x.n === s0.from_flow.step);
  return fs ? { ...fs, ...s0, expect: s0.expect ?? fs.expect } : s0;
}
export const isCreating = (step, cls = classOf(step)) => !!step.creates || (COMP_CLASSES.has(cls) && COMMIT_VERBS.has(step.verb));

const EVIDENCE_KIND = { assertion: "assertion", failure: "failure", entry: "before", result: "after", input: "context", transition: "context", integration: "context", snapshot: "context" };

function substitute(value, ctx, missing) {
  if (typeof value === "string") {
    return value.replace(/\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g, (m, key) => {
      const parts = key.split(".");
      if (parts[0] === "prefix") { if (ctx.prefix) return ctx.prefix; missing.add(key); return m; }
      if (parts[0] !== "fixture") return m;   // segnaposti di dati del compito: restano (il generatore li risolve)
      const fx = ctx.fixtures[parts[1]];
      if (!fx) { missing.add(key); return m; }
      const v = parts.length > 2 ? fx.attrs?.[parts[2]] ?? fx[parts[2]] : fx.value ?? fx.name;
      if (v == null) { missing.add(key); return m; }
      return String(v);
    });
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, ctx, missing));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, ctx, missing)]));
  return value;
}

export function compileCase(ws, caso, { customer = null, env = "sandbox", envType = null, run = null, registry = null } = {}) {
  const v = validateCase(caso);
  if (!v.ok) throw new CompileError(1, `caso non valido: ${v.errors.join("; ")}`);
  const analytic = analyticCodes(caso);
  if (analytic.length) throw new CompileError(3, `il caso cita il dominio analitico (${analytic.join(", ")}): i test non citano PAT PBK BRF RUL (§1.1)`);
  const idCust = caso.id.split(".")[1];
  const cust = idCust === "STD" ? customer : idCust;
  if (!cust) throw new CompileError(1, `caso standard ${caso.id}: serve --customer`);
  if (customer && idCust !== "STD" && customer !== idCust) throw new CompileError(1, `il caso è del cliente ${idCust}, non di ${customer}`);
  const warnings = [];
  const reg = registry ?? loadRegistry(ws, cust);
  const fx = resolveCaseFixtures(caso, reg, { env });
  if (fx.missing.length) throw new CompileError(3, `fixture mancanti (lookup_or_fail): ${fx.missing.map((m) => `${m.name} [${Object.entries(m.criteria).map(([k, x]) => `${k}=${x}`).join(" ")}]`).join(", ")} — il caso non le crea`, { missing: fx.missing });
  const ctx = { fixtures: fx.values, prefix: run ? entityPrefix(run) : null };
  const missing = new Set();
  const stop = caso.boundary.stop_at_step;
  const src = [...caso.composition.steps].sort((a, b) => a.n - b.n);
  const beyond = src.filter((s) => s.n > stop).map((s) => s.n);
  if (beyond.length) warnings.push(`passi ${beyond.join(", ")} oltre il confine (boundary.stop_at_step ${stop}): esclusi dal piano`);
  const flows = new Map();
  const flowOf = (code) => { if (!flows.has(code)) flows.set(code, loadItem(ws, code, cust)); return flows.get(code); };
  const steps = [];
  const trace = [];
  const compensations = [];
  const abortOn = [];
  for (const s0 of src.filter((s) => s.n <= stop)) {
    let base = {};
    let source = "caso";
    if (s0.from_flow) {
      const f = flowOf(s0.from_flow.flow);
      if (!f) throw new CompileError(3, `passo ${s0.n}: FLW ${s0.from_flow.flow} non trovata nella knowledge base`);
      const fs = (f.steps ?? []).find((x) => x.n === s0.from_flow.step);
      if (!fs) throw new CompileError(3, `passo ${s0.n}: la FLW ${f.id} non ha il passo ${s0.from_flow.step}`);
      base = fs;
      source = `${f.id}#${fs.n}`;
    }
    const s = { ...base, ...s0, expect: s0.expect ?? base.expect };
    if (s.verb === "DELETE") throw new CompileError(3, `passo ${s.n}: il verbo DELETE non esiste (ADR-06: close/cancel)`);
    const selTarget = typeof s.target === "string" ? s.target : null;
    if (selTarget) {
      if (typeOf(selTarget) !== "SEL") throw new CompileError(3, `passo ${s.n}: target ${selTarget} non è un SEL`);
      if (!loadItem(ws, selTarget, cust)) throw new CompileError(3, `passo ${s.n}: ${selTarget} non è nell'Atlas (kb/scopes/*/selectors): il caso non si compila`);
    }
    let expect = s.expect;
    let expectFrom = s0.expect ? "caso" : base.expect ? source : null;
    if (!expect && s.verb === "VERIFY" && s.check) { expect = { check: s.check, result: "pass" }; expectFrom = "check"; }
    if (!expect && selTarget) { expect = { elements: [selTarget] }; expectFrom = "sel"; }
    if (!expect) throw new CompileError(3, `passo ${s.n} (${s.verb}) senza expect: la traccia attesa è obbligatoria per ogni passo (§46.3)`);
    const cls = classOf(s);
    const step = { n: s.n, verb: s.verb, action_class: cls, ...(s.target ? { target: s.target } : {}), ...(s.check ? { check: s.check } : {}),
      ...(s.data !== undefined ? { data: substitute(s.data, ctx, missing) } : {}), ...(s.risk ? { risk: s.risk } : {}), ...(s.wait_for ? { wait_for: s.wait_for } : {}),
      ...(s.timeout_ms ? { timeout_ms: s.timeout_ms } : {}), expect: substitute(expect, ctx, missing), ...(s.note ? { note: s.note } : {}) };
    let comp = null;
    if (isCreating(s, cls)) {
      const c = (caso.compensations ?? []).find((x) => x.step === s.n);
      const fromFlow = flowCompensationFor(caso, s0, flowOf);
      const cc = c ?? (fromFlow ? { ...fromFlow, step: s.n } : null);
      if (!cc) throw new CompileError(3, `passo ${s.n} (${s.verb}, ${cls}) crea o modifica ${s.creates?.entity ?? "un'entità"} senza compensazione (close · cancel · deactivate · restore): va registrata PRIMA del passo (§29.6)`);
      if (!["close", "cancel", "deactivate", "restore"].includes(cc.kind)) throw new CompileError(3, `passo ${s.n}: compensazione ${cc.kind} non ammessa (mai delete, ADR-06)`);
      comp = { step: s.n, kind: cc.kind, ...(cc.entity ?? s.creates?.entity ? { entity: cc.entity ?? s.creates.entity } : {}), ...(cc.action ? { action: cc.action } : {}), ...(cc.ref ? { ref: substitute(cc.ref, ctx, missing) } : {}),
        note: `registrata prima del passo ${s.n} (§29.6)${c ? "" : ` — dalla FLW ${s0.from_flow?.flow ?? caso.composition.flows[0]}`}` };
      compensations.push(comp);
      abortOn.push(s.n);
    }
    steps.push(step);
    trace.push({ n: s.n, verb: s.verb, action_class: cls, target: s.target ?? null, expect: step.expect, expect_from: expectFrom, source, ...(comp ? { compensation: { kind: comp.kind, before_step: s.n } } : {}), ...(s.n === stop ? { boundary: true } : {}) });
  }
  const fixMissing = [...missing].filter((k) => k.startsWith("fixture.") || k === "prefix");
  if (fixMissing.length) throw new CompileError(3, `segnaposti non risolti: ${fixMissing.map((k) => `{{${k}}}`).join(", ")}${fixMissing.includes("prefix") ? " (serve --run per il prefisso NRT-<data>-<run>)" : ""}`);
  const evidence = (caso.evidence ?? []).filter((e) => e.at <= stop).map((e) => ({ at: e.at, kind: EVIDENCE_KIND[e.kind] ?? "context", ...(e.capture ? { capture: e.capture } : {}), ...(e.region ? { region: e.region } : {}),
    caption: e.caption ?? `${e.kind} al passo ${e.at}` }));
  const subject = (caso.derivation.from ?? []).find((c) => /^[SCL]\./.test(c));
  const plan = {
    plan_id: `PLAN.${caso.id}`, fingerprint: caseFingerprint(caso), customer: cust, env, ...(caso.persona ? { persona: caso.persona, storage_state: `.auth/${caso.persona}.json` } : {}),
    goal: caso.title, ...(subject ? { subject } : {}), steps, ...(evidence.length ? { evidence } : {}),
    repair_policy: { skip_allowed: [], substitute_allowed: [], abort_on: abortOn },
    ...(compensations.length ? { compensations } : {}),
  };
  const pv = validatePlan(plan, { env: { id: env, type: envType ?? (["sandbox", "dev", "preprod", "prod"].includes(env) ? env : "sandbox") } });
  if (!pv.ok) throw new CompileError(3, `piano non valido: ${pv.errors.join("; ")}`, { plan });
  return { plan, trace, evidence: (caso.evidence ?? []).filter((e) => e.at <= stop), fixtures: Object.fromEntries(Object.entries(fx.values).map(([k, f]) => [k, f.name])), compensations, warnings };
}

const HELP = `uso: node scripts/compile/compile-case.mjs --case <file.yaml> [--customer C] [--env <id>] [--env-type sandbox|preprod|prod]
       [--run <RUN>] [--out <file.json>] [--workspace <dir>] [--json] [--help]

Compila un caso NRT.* nel piano di esecuzione (§46.3): traccia attesa per passo (caso, FLW, SEL), evidenze,
compensazioni legate ai passi che creano (registrate da step-check PRIMA del passo), fixture lookup_or_fail.
Con --run e senza --out il piano va in customers/<C>/runs/<RUN>/cases/<caso>/plan.json.

Exit code: 0 compilato · 1 caso malformato · 2 errore di sistema · 3 rifiuto (compensazione o fixture mancante,
dominio analitico, SEL assente, piano non valido).`;

export function run(argv, env = process.env) {
  const { opts } = parseArgs(argv);
  const asJson = !!opts.json;
  if (opts.help) { console.log(HELP); return 0; }
  if (!opts.case) return fail(asJson, 1, "richiesto --case <file.yaml>");
  const ws = resolvePath(opts.workspace || env.JVC_WORKSPACE || env.CLAUDE_PROJECT_DIR || process.cwd());
  let caso;
  try { caso = YAML.parse(readFileSync(resolvePath(opts.case), "utf8")); } catch (err) { return fail(asJson, 1, `caso illeggibile: ${err.message}`); }
  try {
    const r = compileCase(ws, caso, { customer: opts.customer ?? null, env: opts.env ?? "sandbox", envType: opts["env-type"] ?? null, run: opts.run ?? null });
    let out = opts.out ? resolvePath(opts.out) : null;
    if (!out && opts.run) out = join(ws, "customers", r.plan.customer, "runs", opts.run, "cases", caso.id, "plan.json");
    if (out) {
      mkdirSync(dirname(out), { recursive: true });
      writeFileAtomic(out, `${JSON.stringify(r.plan, null, 2)}\n`);
      writeFileAtomic(out.replace(/\.json$/, "") + ".trace.yaml", YAML.stringify({ case: caso.id, trace: r.trace, evidence: r.evidence, fixtures: r.fixtures, warnings: r.warnings }));
    }
    if (asJson) console.log(JSON.stringify({ ok: true, ...(out ? { file: out } : {}), ...r }));
    else console.log(out ? `piano ${r.plan.plan_id}: ${r.plan.steps.length} passi, ${r.compensations.length} compensazioni → ${out}` : JSON.stringify(r.plan, null, 2));
    return 0;
  } catch (err) {
    if (err instanceof CompileError) return fail(asJson, err.code, err.message);
    return fail(asJson, 2, `errore di sistema: ${err?.message ?? err}`);
  }
}

if (isMain(import.meta.url)) process.exit(run(process.argv.slice(2)));
