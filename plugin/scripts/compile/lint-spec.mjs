// lint-spec (F4.1, §30.4): lint dei casi NRT e dei piani di esecuzione — e il linter anti-indebolimento.
//
//   lintCase(caso, { previous? }) → violations[{ rule, at, message }]
//     L-EXPECT       ogni passo ha un expect (dichiarato o ereditato da from_flow)
//     L-DELETE       compensazione delete o azione che cancella (la compensazione è close/cancel/deactivate/restore); il verbo
//                    DELETE e la classe ACT-DELETE solo in un piano di produzione (spec 2026-10-06 §3.7: ammessi in sandbox e
//                    pre-produzione, in produzione mai — ADR-06 resta lì)
//     L-COMP         ogni passo che crea, modifica o invia ha la sua compensazione (§29.6)
//     L-DERIVATION   derivation (from + risk_mode) e boundary (stop_at_step + does_not_assert) presenti (§27.1)
//     L-ANALYTIC     nessun codice del dominio analitico (PAT PBK BRF RUL, §1.1)
//     L-NEG          un NEG promosso dichiara expected_errors
//     con --against <vecchio>: L-WEAKEN (§30.4 "mai indebolire un'asserzione") — uguaglianza sostituita da verità o
//     contenimento (value → value_contains/contains/truthy), asserzione rimossa (chiave di expect, messaggio, elemento,
//     passo con expect, expected_errors), tolleranza allargata (tolerance, tolerances.numeric, ignore_fields), confine
//     anticipato (stop_at_step minore) o does_not_assert allargato
//   lintPlan(piano, { previous? }) → stesse regole sui passi del piano (L-EXPECT, L-DELETE, L-COMP, L-WEAKEN)
//
// CLI: node scripts/compile/lint-spec.mjs <file…> [--against <file vecchio>] [--json]
// Exit: 0 pulito · 1 file illeggibile · 2 errore di sistema · 3 violazione.
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import YAML from "yaml";
import { parseArgs, fail } from "../lib/args.mjs";
import { isMain } from "../lib/is-main.mjs";
import { analyticCodes } from "../lib/kb-items.mjs";
import { classOf, isCreating, flowCompensationFor, mergedStep } from "./compile-case.mjs";
import { loadItem } from "../lib/kb-items.mjs";
import { confineList, confineInputs } from "../lib/text-file.mjs";

const DELETE_ACTION = /\b(delete|deletion|remove|purge|elimina\w*|cancella\w*|rimuov\w*)\b/i;
const v = (rule, at, message) => ({ rule, at, message });
const stepsOfCase = (c) => (Array.isArray(c?.composition?.steps) ? c.composition.steps : []);
const stepsOfPlan = (p) => (Array.isArray(p?.steps) ? p.steps : []);
const isPlan = (x) => typeof x?.plan_id === "string";

// env: ambiente del piano ("prod" ⇒ DELETE/ACT-DELETE vietati); un caso non ha ambiente (il validate-plan lo nega in prod)
function commonRules(steps, compensations, out, { env = null } = {}) {
  const prod = env === "prod";
  for (const s of steps) {
    const at = `passo ${s?.n ?? "?"}`;
    if (!s?.expect && !s?.from_flow) out.push(v("L-EXPECT", at, `${at} (${s?.verb}) senza expect: ogni passo dichiara ciò che si osserva dopo (§46.3)`));
    else if (s?.expect && typeof s.expect === "object" && !Object.keys(s.expect).length) out.push(v("L-EXPECT", at, `${at}: expect vuoto`));
    if (prod && s?.verb === "DELETE") out.push(v("L-DELETE", at, `${at}: il verbo DELETE non esiste in produzione (ammesso solo in sandbox e pre-produzione, spec 2026-10-06 §3.7; ADR-06: close/cancel)`));
    if (prod && s?.action_class === "ACT-DELETE") out.push(v("L-DELETE", at, `${at}: ACT-DELETE non è ammessa in produzione`));
    if (s && isCreating(s, classOf(s)) && !compensations.some((c) => c?.step === s.n)) out.push(v("L-COMP", at, `${at} (${s.verb}) crea o modifica senza compensazione registrata prima (§29.6)`));
  }
  for (const c of compensations) {
    if (!["close", "cancel", "deactivate", "restore"].includes(c?.kind)) out.push(v("L-DELETE", `compensazione del passo ${c?.step ?? "?"}`, `compensazione ${c?.kind}: solo close · cancel · deactivate · restore (mai delete)`));
    if (c?.action && DELETE_ACTION.test(c.action)) out.push(v("L-DELETE", `compensazione del passo ${c?.step ?? "?"}`, `l'azione di compensazione "${c.action}" cancella: si chiude o si annulla, mai si cancella`));
  }
}

// ——— anti-indebolimento (§30.4) ———
const WEAK_KEYS = ["value_contains", "contains", "truthy", "value_truthy", "present", "matches", "value_any"];
const asArr = (x) => (Array.isArray(x) ? x : x == null ? [] : [x]);
const norm = (x) => JSON.stringify(x);
function weakenExpect(prev = {}, cur = {}, at, out) {
  for (const k of Object.keys(prev)) {
    if (!(k in cur)) {
      const weak = k === "value" && WEAK_KEYS.find((w) => w in cur);
      out.push(v("L-WEAKEN", at, weak ? `${at}: uguaglianza su value sostituita da ${weak} (asserzione indebolita)` : `${at}: asserzione expect.${k} rimossa`));
      continue;
    }
    if (k === "value" && prev.value !== null && prev.value !== undefined && prev.value !== true && (cur.value === true || cur.value === "*" || cur.value === "")) out.push(v("L-WEAKEN", at, `${at}: value ${norm(prev.value)} sostituito da ${norm(cur.value)} (verità al posto dell'uguaglianza)`));
    if (["messages", "elements"].includes(k)) {
      const c = new Set(asArr(cur[k]).map(norm));
      for (const x of asArr(prev[k])) if (!c.has(norm(x))) out.push(v("L-WEAKEN", at, `${at}: ${k} ${norm(x)} non più verificato`));
    }
    if (k === "tolerance" && Number(cur[k]) > Number(prev[k])) out.push(v("L-WEAKEN", at, `${at}: tolleranza allargata da ${prev[k]} a ${cur[k]}`));
  }
  if (!("value" in prev)) return;
  for (const w of WEAK_KEYS) if (w in cur && !(w in prev) && "value" in cur) out.push(v("L-WEAKEN", at, `${at}: aggiunto ${w} accanto a value (asserzione allentata)`));
}
function weakenTolerances(prev = {}, cur = {}, at, out) {
  for (const [k, t] of Object.entries(prev.numeric ?? {})) {
    const c = cur.numeric?.[k];
    if (c === undefined) out.push(v("L-WEAKEN", at, `${at}: tolleranza numerica su ${k} rimossa (il campo non è più confrontato come prima)`));
    else if (Number(c) > Number(t)) out.push(v("L-WEAKEN", at, `${at}: tolleranza su ${k} allargata da ${t} a ${c}`));
  }
  const ig = new Set(asArr(prev.ignore_fields));
  for (const f of asArr(cur.ignore_fields)) if (!ig.has(f)) out.push(v("L-WEAKEN", at, `${at}: campo ${f} aggiunto a ignore_fields`));
  const oi = new Set(asArr(prev.order_insensitive));
  for (const f of asArr(cur.order_insensitive)) if (!oi.has(f)) out.push(v("L-WEAKEN", at, `${at}: ordine di ${f} non più verificato`));
}
export function weakening(prev, cur) {
  const out = [];
  const plan = isPlan(cur);
  const ps = plan ? stepsOfPlan(prev) : stepsOfCase(prev);
  const cs = plan ? stepsOfPlan(cur) : stepsOfCase(cur);
  for (const p of ps) {
    const c = cs.find((x) => x?.n === p?.n);
    const at = `passo ${p?.n}`;
    if (!c) { if (p?.expect) out.push(v("L-WEAKEN", at, `${at} con expect rimosso dal ${plan ? "piano" : "caso"}`)); continue; }
    if (p.expect && c.expect) weakenExpect(p.expect, c.expect, at, out);
    else if (p.expect && !c.expect) out.push(v("L-WEAKEN", at, `${at}: expect rimosso`));
  }
  if (!plan) {
    const ce = new Set(asArr(cur?.expected_errors));
    for (const e of asArr(prev?.expected_errors)) if (!ce.has(e)) out.push(v("L-WEAKEN", "expected_errors", `errore atteso ${e} rimosso`));
    const pb = prev?.boundary ?? {}; const cb = cur?.boundary ?? {};
    if (Number.isInteger(pb.stop_at_step) && Number.isInteger(cb.stop_at_step) && cb.stop_at_step < pb.stop_at_step) out.push(v("L-WEAKEN", "boundary", `confine anticipato: stop_at_step da ${pb.stop_at_step} a ${cb.stop_at_step}`));
    const dna = new Set(asArr(pb.does_not_assert));
    for (const x of asArr(cb.does_not_assert)) if (!dna.has(x)) out.push(v("L-WEAKEN", "boundary", `does_not_assert allargato: "${x}"`));
    weakenTolerances(prev?.baseline?.tolerances, cur?.baseline?.tolerances, "baseline", out);
  }
  return out;
}

export function lintCase(caso, { previous = null, ws = null, customer = null } = {}) {
  const out = [];
  if (!caso?.derivation?.from?.length || !caso?.derivation?.risk_mode) out.push(v("L-DERIVATION", "derivation", "derivation mancante o incompleta (from, risk_mode): un caso senza derivation non si emette (§27.1)"));
  if (!Number.isInteger(caso?.boundary?.stop_at_step) || !Array.isArray(caso?.boundary?.does_not_assert)) out.push(v("L-DERIVATION", "boundary", "boundary mancante o incompleto (stop_at_step, does_not_assert)"));
  const a = analyticCodes(caso);
  if (a.length) out.push(v("L-ANALYTIC", "caso", `cita il dominio analitico: ${a.join(", ")} (§1.1)`));
  if (caso?.genre === "NEG" && caso?.state === "promoted" && !asArr(caso?.expected_errors).length) out.push(v("L-NEG", "expected_errors", "un NEG promosso dichiara gli errori attesi (ERR)"));
  // giro 1: con il workspace la FLW si risolve come in compile-case (passi ereditati, compensazione fornita dalla FLW)
  let steps = stepsOfCase(caso);
  let comps = asArr(caso?.compensations);
  if (ws) {
    const cust = customer ?? (String(caso?.id ?? "").split(".")[1] !== "STD" ? String(caso?.id ?? "").split(".")[1] : null);
    const cache = new Map();
    const flowOf = (code) => { if (!cache.has(code)) cache.set(code, loadItem(ws, code, cust)); return cache.get(code); };
    steps = steps.map((s0) => mergedStep(s0, flowOf));
    comps = [...comps];
    for (const s of steps) {
      if (!s || comps.some((c) => c?.step === s.n) || !isCreating(s, classOf(s))) continue;
      const fc = flowCompensationFor(caso, stepsOfCase(caso).find((x) => x.n === s.n), flowOf);
      if (fc) comps.push({ ...fc, step: s.n });
    }
  }
  commonRules(steps, comps, out);
  if (previous) out.push(...weakening(previous, caso));
  return out;
}

export function lintPlan(plan, { previous = null } = {}) {
  const out = [];
  const a = analyticCodes(plan);
  if (a.length) out.push(v("L-ANALYTIC", "piano", `cita il dominio analitico: ${a.join(", ")} (§1.1)`));
  commonRules(stepsOfPlan(plan), asArr(plan?.compensations), out, { env: typeof plan?.env === "string" ? plan.env : null });
  if (previous) out.push(...weakening(previous, plan));
  return out;
}

export const lintAny = (doc, opts) => (isPlan(doc) ? lintPlan(doc, opts) : lintCase(doc, opts));

const HELP = `uso: node scripts/compile/lint-spec.mjs <file…> [--against <file vecchio>] [--workspace <dir> [--customer C]] [--json] [--help]

Lint di casi NRT e piani: expect su ogni passo, nessun DELETE, compensazione per i passi che creano, derivation e
boundary, nessun codice analitico; con --against il linter anti-indebolimento (§30.4) confronta con la versione
precedente (uguaglianza → contenimento/verità, asserzioni rimosse, tolleranze allargate, confine anticipato).

Exit code: 0 pulito · 1 file illeggibile · 2 errore di sistema · 3 violazione.`;

const read = (f) => { const t = readFileSync(resolvePath(f), "utf8"); return f.endsWith(".json") ? JSON.parse(t) : YAML.parse(t); };
export function run(argv) {
  const { opts, positional } = parseArgs(argv);
  const asJson = !!opts.json;
  if (opts.help) { console.log(HELP); return 0; }
  if (!positional.length) return fail(asJson, 1, "nessun file da controllare");
  { const bad = confineInputs(opts, ["against"]); if (bad) return fail(asJson, 1, bad); }
  const conf = confineList(positional);   // revisione finale: i file nel workspace degli hook
  if (conf.error) return fail(asJson, 1, conf.error);
  const at = new Map(positional.map((f, i) => [f, conf.files[i]]));
  let previous = null;
  try { if (opts.against) previous = read(opts.against); } catch (err) { return fail(asJson, 1, `--against illeggibile: ${err.message}`); }
  const results = [];
  try {
    for (const f of positional) {
      let doc;
      try { doc = read(at.get(f)); } catch (err) { return fail(asJson, 1, `${f} illeggibile: ${err.message}`); }
      results.push({ file: f, violations: lintAny(doc, { previous, ws: opts.workspace ? resolvePath(opts.workspace) : null, customer: opts.customer ?? null }) });
    }
  } catch (err) { return fail(asJson, 2, `errore di sistema: ${err?.message ?? err}`); }
  const n = results.reduce((a, r) => a + r.violations.length, 0);
  if (asJson) console.log(JSON.stringify({ ok: n === 0, results }));
  else for (const r of results) { if (!r.violations.length) console.log(`✓ ${r.file}`); else { console.log(`✗ ${r.file}`); for (const x of r.violations) console.log(`  ${x.rule} ${x.message}`); } }
  return n ? 3 : 0;
}

if (isMain(import.meta.url)) process.exit(run(process.argv.slice(2)));
