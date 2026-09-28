// compile-cfp (C1.1, C1.4, §5.5, §28.3 passo 2, §28.6, §14 STR-DRY-RUN): procedura di configurazione → piano.
//
//   composeCfp(S, C?) → { steps[], origin[] }   S + deviazioni C in ordine di passo: `step` sostituisce campi del passo
//     S (o lo salta, skip), `after: k` inserisce dopo il passo k di S (più inserimenti in ordine di dichiarazione); i passi
//     sono rinumerati 1..n e origin dice da dove viene ciascuno (S#k · C@after-k). La C dichiara il delta, mai una copia.
//   cfpPlan(ws, cfp, { customer, env, envType, params, dryRun, client? }) → { plan, sidecar, warnings }
//     - la CFP valida (verbo fuori vocabolario, DELETE compreso ⇒ invalida; rollback { kind: procedure } obbligatorio per
//       R ≥ R2), nessun codice del dominio analitico;
//     - passi di modifica (CHOOSE · TOGGLE · SAVE · SUBMIT · UPLOAD) ⇒ ACT-CFG-CHANGE con config { object, governs, area,
//       level DT-007 dal rischio }; gli altri ⇒ ACT-CFG-READ; ogni passo ha un expect (dichiarato, wait_for, target SEL,
//       check VERIFY);
//     - {{a.b}} risolti da params (file YAML o chiave=valore): un segnaposto non risolto ⇒ errore;
//     - --dry-run: SAVE, SUBMIT e UPLOAD sostituiti da CAPTURE (STR-DRY-RUN), piano PLAN.<CFP>.DRY senza compensazioni;
//     - rollback come compensazione del primo passo che salva: deactivate → CFP di rollback (disattivare, mai eliminare),
//       proposto e non applicato in autonomia (§28.1);
//     - sidecar: check pre/post (preconditions/postconditions), snapshot_before (default: governs), origine dei passi.
//   verifierCase(cfp, { customer, S?, shape?, persona? }) → caso NRT.<C>.<SCOPE>.CFG.<SEQ> (§28.6): il campo compare, è
//     obbligatorio quando dichiarato (un salvataggio a campo vuoto per OGNI campo obbligatorio: verifica campo per campo),
//     accetta i valori dichiarati, compare nel payload se rilevante (altrimenti does_not_assert).
//
// CLI: node scripts/compile/compile-cfp.mjs --cfp <file|codice> [--client <file|codice>] [--params <file.yaml>] [chiave=valore…]
//      [--dry-run] [--verify] [--customer C] [--env <id>] [--env-type sandbox|preprod|prod] [--shape libresco] [--out <file>]
//      [--workspace <dir>] [--json]
// Exit: 0 ok · 1 CFP malformata o parametri mancanti · 2 errore di sistema · 3 rifiuto (dominio analitico, piano non valido).
import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve as resolvePath, dirname } from "node:path";
import YAML from "yaml";
import { parseArgs, fail } from "../lib/args.mjs";
import { isMain } from "../lib/is-main.mjs";
import { writeFileAtomic } from "../../hooks/lib/fsx.mjs";
import { validateItem, validateCase } from "../kb/validate-schema.mjs";
import { validatePlan } from "../decide/validate-plan.mjs";
import { loadItem, analyticCodes, typeOf } from "../lib/kb-items.mjs";
import { RISK_LEVEL } from "../../hooks/lib/act-classes.mjs";
import { kvArgs, workspaceCustomer } from "../run/fixtures.mjs";

export class CfpError extends Error { constructor(code, msg, extra = {}) { super(msg); this.code = code; Object.assign(this, extra); } }
export const CHANGE_VERBS = new Set(["CHOOSE", "TOGGLE", "SAVE", "SUBMIT", "UPLOAD"]);
const SAVE_VERBS = new Set(["SAVE", "SUBMIT"]);

export function composeCfp(S, C = null) {
  const base = [...(S.steps ?? [])].sort((a, b) => a.n - b.n);
  if (!C) return { steps: base.map((s) => ({ ...s })), origin: base.map((s) => ({ n: s.n, from: `${S.id}#${s.n}` })) };
  if (C.derives_from !== S.id) throw new CfpError(1, `${C.id} deriva da ${C.derives_from}, non da ${S.id}`);
  const byN = new Map(base.map((s) => [s.n, { ...s }]));
  const skipped = new Set();
  const inserts = new Map();
  for (const d of C.deviations ?? []) {
    if (d.step != null) {
      const s = byN.get(d.step);
      if (!s) throw new CfpError(1, `${C.id}: deviazione sul passo ${d.step} che ${S.id} non ha`);
      if (d.skip) skipped.add(d.step);
      if (d.replace) Object.assign(s, d.replace);
      if (d.data_options_from) s.options_from = d.data_options_from;
      s.deviation = d.reason;
    } else {
      if (d.after !== 0 && !byN.has(d.after)) throw new CfpError(1, `${C.id}: inserimento dopo il passo ${d.after} che ${S.id} non ha`);
      if (!inserts.has(d.after)) inserts.set(d.after, []);
      inserts.get(d.after).push({ ...d.insert, deviation: d.reason ?? "inserimento del cliente" });
    }
  }
  const steps = [];
  const origin = [];
  const push = (s, from) => { const n = steps.length + 1; steps.push({ ...s, n }); origin.push({ n, from }); };
  for (const ins of inserts.get(0) ?? []) push(ins, `${C.id}@after-0`);
  for (const s of base) {
    if (!skipped.has(s.n)) push(byN.get(s.n), `${S.id}#${s.n}${byN.get(s.n).deviation ? ` (${C.id})` : ""}`);
    for (const ins of inserts.get(s.n) ?? []) push(ins, `${C.id}@after-${s.n}`);
  }
  return { steps, origin };
}

const get = (o, path) => path.split(".").reduce((a, k) => (a == null ? undefined : a[k]), o);
function fill(value, params, missing) {
  if (typeof value === "string") {
    const whole = /^\{\{\s*([A-Za-z0-9_.]+)\s*\}\}$/.exec(value);
    if (whole) { const v = get(params, whole[1]); if (v === undefined) { missing.add(whole[1]); return value; } return v; }
    return value.replace(/\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g, (m, k) => { const v = get(params, k); if (v === undefined) { missing.add(k); return m; } return String(v); });
  }
  if (Array.isArray(value)) return value.map((v) => fill(v, params, missing));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, params, missing)]));
  return value;
}

function checkCfp(cfp, what) {
  const v = validateItem(cfp);
  if (!v.ok) throw new CfpError(1, `${what} ${cfp?.id ?? "?"} non valida: ${v.errors.join("; ")}`);
  const a = analyticCodes(cfp);
  if (a.length) throw new CfpError(3, `${cfp.id} cita il dominio analitico (${a.join(", ")}): §1.1`);
}

export function resolveCfp(ws, cfp, { client = null, customer = null } = {}) {
  checkCfp(cfp, "CFP");
  let S = cfp;
  let C = client;
  if (cfp.derives_from) {
    C = cfp;
    S = loadItem(ws, cfp.derives_from, customer);
    if (!S) throw new CfpError(1, `${cfp.id} deriva da ${cfp.derives_from}, non trovata nella knowledge base`);
    checkCfp(S, "CFP standard");
  }
  if (C && C !== cfp) checkCfp(C, "CFP cliente");
  if (S.derives_from) throw new CfpError(1, `${S.id} non è una CFP standard (ha derives_from)`);
  return { S, C };
}

function expectOf(s) {
  if (s.expect) return s.expect;
  if (s.wait_for) return { elements: [s.wait_for] };
  if (s.verb === "VERIFY" && s.check) return { check: s.check, result: "pass" };
  if (typeof s.target === "string") return { elements: [s.target] };
  if (s.target?.url_pattern) return { page_sig: s.target.url_pattern };
  return null;
}

export function cfpPlan(ws, cfp, { customer = null, env = "sandbox", envType = null, params = {}, dryRun = false, client = null } = {}) {
  const { S, C } = resolveCfp(ws, cfp, { client, customer });
  const cust = customer ?? (C ? C.id.split(".")[1] : null);
  if (!cust || cust === "STD") throw new CfpError(1, "serve --customer: il piano è di un cliente");
  const { steps: composed, origin } = composeCfp(S, C);
  const warnings = [];
  const missing = new Set();
  const governs = S.governs;
  const risk = S.risk;
  const level = RISK_LEVEL[risk] ?? "rosso";
  const config = { object: governs[0], ...(governs.length > 1 ? { governs } : {}), ...(S.area ? { area: S.area } : {}), level };
  const steps = [];
  const changeSteps = [];
  for (const s0 of composed) {
    const s = fill(s0, params, missing);
    if (s.verb === "DELETE") throw new CfpError(1, `passo ${s.n}: DELETE non è nel vocabolario (disattivare, mai eliminare)`);
    let step;
    // giro 1: in prova a vuoto anche UPLOAD diventa CAPTURE (un caricamento spesso salva da solo)
    if (dryRun && (SAVE_VERBS.has(s.verb) || s.verb === "UPLOAD")) {
      step = { n: s.n, verb: "CAPTURE", action_class: "ACT-CFG-READ", ...(s.target ? { target: s.target } : {}), expect: typeof s.target === "string" ? { elements: [s.target] } : { page_sig: s.target?.url_pattern ?? "?" },
        note: `STR-DRY-RUN: ${s.verb} sostituito da CAPTURE (§14): nessun salvataggio` };
    } else {
      const expect = expectOf(s);
      if (!expect) throw new CfpError(1, `passo ${s.n} (${s.verb}) senza expect ricavabile`);
      const change = CHANGE_VERBS.has(s.verb);
      step = { n: s.n, verb: s.verb, action_class: change ? "ACT-CFG-CHANGE" : "ACT-CFG-READ", ...(s.target ? { target: s.target } : {}), ...(s.check ? { check: s.check } : {}),
        ...(s.data !== undefined ? { data: s.data } : {}), ...(s.wait_for ? { wait_for: s.wait_for } : {}), ...(change ? { risk, config } : {}), expect,
        ...(s.note || s.deviation ? { note: [s.note, s.deviation ? `deviazione: ${s.deviation}` : null].filter(Boolean).join(" · ") } : {}) };
      if (change) changeSteps.push(s.n);
    }
    steps.push(step);
  }
  if (missing.size) throw new CfpError(1, `parametri mancanti: ${[...missing].map((k) => `{{${k}}}`).join(", ")} (--params <file.yaml> o chiave=valore)`, { missing: [...missing] });
  const rbRef = S.rollback?.ref ?? null;
  if (rbRef && !loadItem(ws, rbRef, cust)) warnings.push(`CFP di rollback ${rbRef} non trovata nella knowledge base: il rollback va provato (S.STD.ADM.CHK.0052)`);
  const firstSave = steps.find((s) => SAVE_VERBS.has(s.verb) && s.action_class === "ACT-CFG-CHANGE");
  const compensations = !dryRun && rbRef && firstSave ? [{ step: firstSave.n, kind: "deactivate", ref: rbRef, entity: governs.join(" "), note: "rollback proposto, non applicato in autonomia (§28.1): disattivare, mai eliminare" }] : [];
  const evidence = (S.evidence ?? []).map((e) => ({ at: Math.min(e.at, steps.length), kind: e.kind === "assertion" ? "assertion" : e.kind === "failure" ? "failure" : "context", caption: e.caption ?? `${e.kind} al passo ${e.at} (${S.id})` }));
  const type = envType ?? (["sandbox", "dev", "preprod", "prod"].includes(env) ? env : "sandbox");
  const plan = {
    plan_id: `PLAN.${(C ?? S).id}${dryRun ? ".DRY" : ""}`, customer: cust, env, goal: `${(C ?? S).title}${dryRun ? " (prova a vuoto)" : ""}`, subject: governs[0],
    ...(dryRun ? { strategy: "STR-DRY-RUN" } : {}), steps, ...(evidence.length ? { evidence } : {}),
    repair_policy: { skip_allowed: [], substitute_allowed: [], abort_on: dryRun ? [] : changeSteps },
    ...(compensations.length ? { compensations } : {}), ...(type === "prod" ? { approvals: "3A" } : {}),
  };
  const pv = validatePlan(plan, { env: { id: env, type } });
  if (!pv.ok) throw new CfpError(3, `piano non valido: ${pv.errors.join("; ")}`, { plan });
  const sidecar = {
    cfp: S.id, client: C?.id ?? null, risk, level, governs, area: S.area ?? null, dry_run: dryRun,
    checks: { pre: (S.preconditions ?? []).map((p) => p.check), post: [...(S.postconditions ?? []).map((p) => p.check), ...steps.filter((s) => s.verb === "VERIFY" && s.check).map((s) => s.check)] },
    snapshot_before: S.snapshot_before ?? governs, rollback: S.rollback ?? null, verification_test: S.verification_test ?? null, origin,
    confirmed_by_observation: C?.confirmed_by_observation ?? [],
  };
  return { plan, sidecar, warnings };
}

export function verifierCase(cfp, { customer, S = null, shape = "libresco", persona = null } = {}) {
  const std = S ?? cfp;
  if (!customer || customer === "STD") throw new CfpError(1, "serve --customer per il verificatore");
  const scope = std.id.split(".")[2];
  const seq = (std.verification_test ?? `NRT.STD.${scope}.CFG.${std.id.split(".")[4]}`).split(".")[4];
  const id = `NRT.${customer}.${scope}.CFG.${seq}`;
  const fields = std.verification?.fields ?? (std.steps ?? []).filter((s) => ["FILL", "CHOOSE", "TOGGLE"].includes(s.verb) && typeof s.target === "string").map((s) => ({ sel: s.target }));
  if (!fields.length) throw new CfpError(1, `${std.id}: nessun campo da verificare (verification.fields o passi FILL/CHOOSE/TOGGLE)`);
  const nav = (std.steps ?? []).find((s) => s.verb === "NAVIGATE");
  const steps = [];
  const compensations = [];
  const expected = [];
  const add = (s) => { const n = steps.length + 1; steps.push({ n, ...s }); return n; };
  let curForm = null;
  const open = (form) => {
    const key = JSON.stringify(form);
    if (key === curForm) return;
    curForm = key;
    add({ verb: "NAVIGATE", target: form, expect: typeof form === "string" ? { elements: [form] } : { page_sig: form.url_pattern }, note: "apertura del form su cui la configurazione deve essere effettiva" });
  };
  for (const f of fields) {
    const form = f.form ?? nav?.target ?? null;
    if (!form) throw new CfpError(1, `campo ${f.sel}: nessun form da aprire (verification.fields[].form)`);
    open(form);
    add({ verb: "READ", target: f.sel, expect: { elements: [f.sel] }, note: `il campo ${f.label ?? f.sel} compare` });
    for (const v of f.accepts ?? []) add({ verb: "FILL", target: f.sel, data: v, expect: { value: String(v) }, note: `accetta il valore dichiarato ${v}` });
    if (f.mandatory === true) {
      if (!f.save) throw new CfpError(1, `campo ${f.sel} obbligatorio senza il SEL di salvataggio (verification.fields[].save)`);
      add({ verb: "FILL", target: f.sel, data: "", expect: { value: "" }, note: `svuota ${f.label ?? f.sel} per verificarne l'obbligatorietà` });
      const n = add({ verb: "SAVE", target: f.save, creates: { entity: "documento di verifica", kind: "create" }, expect: { messages: [f.error_text ?? `${f.label ?? f.sel} obbligatorio`] },
        note: `obbligatorietà di ${f.label ?? f.sel}: il salvataggio a campo vuoto è rifiutato (verifica campo per campo)` });
      compensations.push({ step: n, kind: "cancel", entity: "documento di verifica", action: "document.cancel-draft", note: "se il salvataggio non fosse rifiutato, il documento di verifica si annulla" });
      if (f.error && typeOf(f.error) === "ERR") expected.push(f.error);
      curForm = null;   // dopo un salvataggio rifiutato si riapre il form (stato pulito per il campo successivo)
    }
  }
  const inPayload = fields.filter((f) => f.in_payload).map((f) => f.in_payload);
  const c = {
    id, type: "NRT", title: `Verifica della configurazione ${std.title}`.slice(0, 140), scope, genre: "CFG", state: "candidate", ...(persona ? { persona } : {}),
    composition: { steps },
    derivation: { from: [...new Set([(cfp.derives_from ? cfp.id : std.id), ...(std.governs ?? [])])].filter((x) => /^[SCL]\..*\.(CFP|CFG)\.\d{4}$/.test(x)), risk_mode: "configurazione effettiva", rule: "§28.6: il campo compare, è obbligatorio quando dichiarato, accetta i valori dichiarati", strategy: "cfp" },
    boundary: { stop_at_step: steps.length, does_not_assert: inPayload.length ? [] : ["la presenza del campo nel payload verso i sistemi esterni"] },
    evidence: steps.filter((s) => s.verb === "SAVE" || s.verb === "READ").map((s) => ({ at: s.n, kind: "assertion" })),
    epistemic_at_generation: { shape, subject: std.governs?.[0] ?? std.id },
    compensations, ...(expected.length ? { expected_errors: [...new Set(expected)] } : {}),
    sources: [{ cfp: cfp.id }],
  };
  const v = validateCase(c);
  if (!v.ok) throw new CfpError(2, `verificatore generato non valido: ${v.errors.join("; ")}`);
  return c;
}

function readCfp(ws, ref, customer) {
  if (!ref) return null;
  if (/^[SC]\.[A-Z0-9]{3,4}\.[A-Z0-9]{3}\.CFP\.\d{4}$/.test(ref)) { const it = loadItem(ws, ref, customer); if (!it) throw new CfpError(1, `${ref} non trovata nella knowledge base`); return it; }
  return YAML.parse(readFileSync(resolvePath(ref), "utf8"));
}

const HELP = `uso: node scripts/compile/compile-cfp.mjs --cfp <file|codice> [--client <file|codice>] [--params <file.yaml>] [chiave=valore…]
       [--dry-run | --verify] [--customer C] [--env <id>] [--env-type sandbox|preprod|prod] [--shape libresco] [--persona admin]
       [--out <file>] [--workspace <dir>] [--json] [--help]

Compone la CFP standard con le deviazioni del cliente in ordine di passo (§28.3) e produce il piano (§46.3);
--dry-run sostituisce SAVE/SUBMIT con CAPTURE (STR-DRY-RUN); --verify genera il verificatore NRT.<C>.<S>.CFG.<SEQ>
(§28.6: il campo compare, obbligatorio campo per campo, valori accettati). Verbo fuori vocabolario ⇒ CFP invalida.

Exit code: 0 ok · 1 CFP malformata o parametri mancanti · 2 errore di sistema · 3 rifiuto (dominio analitico, piano non valido).`;

export function run(argv, env = process.env) {
  const { opts, positional } = parseArgs(argv, { flags: ["dry-run", "verify"] });
  const asJson = !!opts.json;
  if (opts.help) { console.log(HELP); return 0; }
  if (!opts.cfp) return fail(asJson, 1, "richiesto --cfp <file|codice>");
  const { ws, customer } = workspaceCustomer(opts, env);
  try {
    const cfp = readCfp(ws, opts.cfp, customer);
    const client = readCfp(ws, opts.client, customer);
    const cust = customer ?? (cfp?.derives_from ? cfp.id.split(".")[1] : client ? client.id.split(".")[1] : null);
    if (opts.verify) {
      const { S, C } = resolveCfp(ws, cfp, { client, customer: cust });
      const c = verifierCase(C ?? S, { customer: cust, S, shape: opts.shape ?? "libresco", persona: opts.persona ?? null });
      const out = opts.out ? resolvePath(opts.out) : join(ws, "customers", cust, "tests", "cases", c.scope, `${c.id}.yaml`);
      mkdirSync(dirname(out), { recursive: true });
      if (existsSync(out) && !opts.out) return fail(asJson, 1, `il caso ${c.id} esiste già in ${out}: --out per un altro file`);
      writeFileAtomic(out, YAML.stringify(c));
      console.log(asJson ? JSON.stringify({ ok: true, case: c, file: out }) : `verificatore ${c.id}: ${c.composition.steps.length} passi → ${out}`);
      return 0;
    }
    const params = { ...(opts.params ? YAML.parse(readFileSync(resolvePath(opts.params), "utf8")) ?? {} : {}) };
    for (const [k, v] of Object.entries(kvArgs(positional))) {
      const parts = k.split("."); let o = params;
      for (const p of parts.slice(0, -1)) o = o[p] ??= {};
      o[parts.at(-1)] = v === "true" ? true : v === "false" ? false : v;
    }
    const r = cfpPlan(ws, cfp, { customer: cust, env: opts.env ?? "sandbox", envType: opts["env-type"] ?? null, params, dryRun: !!opts["dry-run"], client });
    if (opts.out) {
      const out = resolvePath(opts.out);
      mkdirSync(dirname(out), { recursive: true });
      writeFileAtomic(out, `${JSON.stringify(r.plan, null, 2)}\n`);
      writeFileAtomic(out.replace(/\.json$/, "") + ".cfp.yaml", YAML.stringify(r.sidecar));
    }
    console.log(asJson ? JSON.stringify({ ok: true, ...r }) : `piano ${r.plan.plan_id}: ${r.plan.steps.length} passi${r.warnings.length ? ` · ${r.warnings.join(" · ")}` : ""}`);
    return 0;
  } catch (err) {
    if (err instanceof CfpError) return fail(asJson, err.code, err.message);
    return fail(asJson, 2, `errore di sistema: ${err?.message ?? err}`);
  }
}

if (isMain(import.meta.url)) process.exit(run(process.argv.slice(2)));
