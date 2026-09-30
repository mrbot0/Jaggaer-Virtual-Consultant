// scripts/decide/compose-plan.mjs — soluzione A (spec 2026-09-30 §A3): piano di un'attività (crea ordine, contratto,
// richiesta, fornitore, evento) dalla mappa del cliente e dai dati, oppure l'elenco preciso di ciò che manca.
// Non attiva nulla: il piano passa da validate-plan, APPROVO PIANO, step-check come ogni piano.
//   compose-plan --goal "<t>" --data <dati.yaml> --scope <S> --env <id> [--fino-a bozza|invio] --out runs/<RUN>/plan.json [--customer C] [--json]
// Exit: 0 piano scritto · 1 uso · 2 sistema · 3 mancanze (gaps).
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import YAML from "yaml";
import { normLabel } from "../chrome/snapshot-parse.mjs";
import { validatePlan } from "./validate-plan.mjs";
import { parseArgs, fail } from "../lib/args.mjs";
import { isMain } from "../lib/is-main.mjs";
import { confineInputs } from "../lib/text-file.mjs";
import { SCOPES } from "../kb/codes.mjs";
import { AMBIGUOUS_NOTE } from "../kb/atlas-write.mjs";

const OBJECTS = [
  ["ordine", /\b(ordine|order|po)\b/i, ["ordine", "order", "purchase order"]],
  ["contratto", /\b(contratto|contract)\b/i, ["contratto", "contract"]],
  ["richiesta", /\b(richiesta|requisition|rda)\b/i, ["richiesta", "requisition"]],
  ["fornitore", /\b(fornitore|supplier|vendor)\b/i, ["fornitore", "supplier", "vendor"]],
  ["evento", /\b(evento|event)\b/i, ["evento", "event"]],
];
const CREATE = /(crea|nuov|new|create)/i;
const SAVE = /\b(salva|save)\b/i;
const DRAFT = /(bozza|draft)/i;
const SUBMIT = /\b(invia|submit|conferma|place order)\b/i;
// revisione finale (C2): un pulsante che salva E invia/conferma/approva/pubblica non è mai il SAVE (ACT-CREATE, senza "sì")
const SEND = /\b(invia|inoltra|trasmetti|submit|send|conferma|confirm|approva|approve|pubblica|publish|place order)\b/i;
const RUN_OUT = /^runs\/(RUN\.[A-Z0-9]{4}\.\d{8}\.\d{4}\.[A-Z0-9]{3})\/plan\.json$/;
const pathOf = (sig) => String(sig ?? "").split("#")[0];

function items(ws, customer, scope, dir) {
  const d = join(ws, "customers", customer, "kb", "scopes", scope, dir);
  if (!existsSync(d)) return [];
  return readdirSync(d).filter((f) => f.endsWith(".yaml")).map((f) => { try { return YAML.parse(readFileSync(join(d, f), "utf8")); } catch { return null; } }).filter(Boolean);
}

export function composePlan({ ws, customer, scope, env, goal, data = {}, until = "bozza", planId }) {
  // revisione finale (C1): cliente e scope diventano percorsi: mai senza validazione
  if (!/^[A-Z0-9]{4}$/.test(String(customer ?? ""))) throw new Error(`cliente non valido: ${customer}`);
  if (!SCOPES.has(scope)) throw new Error(`scope non valido: ${scope}`);
  const obj = OBJECTS.find(([, re]) => re.test(goal));
  if (!obj) return { gaps: [{ kind: "no-form", what: goal, hint: "obiettivo non riconosciuto: ordine, contratto, richiesta, fornitore, evento" }] };
  const [object, , syn] = obj;
  const flds = items(ws, customer, scope, "fields");
  const sels = items(ws, customer, scope, "selectors");
  const flws = items(ws, customer, scope, "flows");
  const gaps = [];
  const dataKeys = Object.keys(data ?? {});
  const selsForField = (id) => sels.filter((s) => s.field === id);
  const has = (text) => syn.some((w) => normLabel(text).includes(w));
  const proc = flws.find((f) => !String(f.title).startsWith("Percorso:") && CREATE.test(f.title) && has(f.title));
  const pageFields = proc
    ? flds.filter((f) => (proc.steps ?? []).some((s) => selsForField(f.id).some((x) => x.id === s.target)))
    : flds.filter((f) => CREATE.test(f.document ?? "") && has(f.document ?? ""));
  if (!pageFields.length) return { gaps: [{ kind: "no-form", what: object, hint: `nessuna pagina "nuovo ${object}" nella mappa: esplora il modulo` }] };
  const keyFor = (f) => dataKeys.find((k) => normLabel(k) === normLabel(f.label?.it));
  for (const k of dataKeys) if (!pageFields.some((f) => normLabel(f.label?.it) === normLabel(k))) gaps.push({ kind: "unknown-field", what: k, hint: "nessun campo con questa etichetta nel modulo" });
  for (const f of pageFields) if (f.mandatory?.kind === "always" && keyFor(f) === undefined) gaps.push({ kind: "missing-data", what: f.label.it, hint: "campo obbligatorio: serve il valore" });
  let steps;
  let saveN = null;
  if (proc) {
    steps = [];
    for (const s of proc.steps ?? []) {
      const out = { verb: s.verb, action_class: s.action_class, ...(s.target !== undefined ? { target: s.target } : {}), expect: s.expect ?? { page_sig: "" } };
      if (s.verb === "FILL" || s.verb === "CHOOSE") {
        const f = pageFields.find((x) => selsForField(x.id).some((y) => y.id === s.target));
        const k = f ? keyFor(f) : undefined;
        if (k === undefined) continue;
        out.data = data[k];
        out.expect = { elements: [{ sel: s.target, value: data[k] }] };
      }
      steps.push(out);
    }
    // revisione finale (I8): "solo bozza" ⇒ la procedura si ferma all'ultimo salvataggio, mai un invio non chiesto
    if (until !== "invio") {
      const last = steps.map((s) => s.verb).lastIndexOf("SAVE");
      steps = last >= 0 ? steps.slice(0, last + 1) : steps.filter((s) => s.verb !== "SUBMIT");
    }
    const i = steps.findIndex((s) => s.verb === "SAVE");
    saveN = i >= 0 ? i + 1 : null;
  } else {
    const document = pageFields[0].document;
    const route = flws.find((f) => f.title === `Percorso: ${document}`);
    if (!route) gaps.push({ kind: "no-route", what: document, hint: `percorso verso "${document}" non ancora visto: esplora dal menu` });
    const fills = [];
    for (const f of pageFields) {
      const k = keyFor(f);
      if (k === undefined) continue;
      if (String(f.notes ?? "").includes(AMBIGUOUS_NOTE)) { gaps.push({ kind: "ambiguous", what: f.label.it, hint: "l'etichetta compare più volte nella pagina: indica quale campo" }); continue; }
      const cands = selsForField(f.id);
      if (cands.length !== 1) { gaps.push({ kind: cands.length ? "ambiguous" : "unknown-field", what: f.label.it, hint: cands.length ? "più elementi per lo stesso campo: indica quale" : "campo senza elemento nella mappa: esplora la pagina" }); continue; }
      fills.push({ verb: f.field_type === "list" ? "CHOOSE" : "FILL", action_class: "ACT-CREATE", target: cands[0].id, data: data[k], expect: { elements: [{ sel: cands[0].id, value: data[k] }] } });
    }
    const formSig = selsForField(pageFields[0].id)[0]?.page ?? null;
    const onForm = sels.filter((s) => s.page && s.page === formSig);
    const saves = onForm.filter((s) => s.effect === "write" && SAVE.test(s.label) && !SEND.test(s.label));
    const drafts = saves.filter((s) => DRAFT.test(s.label));
    const pick = drafts.length ? drafts : saves;
    const save = pick.length === 1 ? pick[0] : null;
    if (!saves.length) gaps.push({ kind: "no-save", what: document, hint: "pulsante di solo salvataggio non visto nella pagina (quelli che inviano non valgono)" });
    else if (!save) gaps.push({ kind: "ambiguous", what: "salvataggio", hint: `più pulsanti di salvataggio: ${pick.map((s) => s.label).join(", ")}` });
    const submits = until === "invio" ? onForm.filter((s) => s.effect === "write" && SUBMIT.test(s.label) && s.id !== save?.id) : [];
    const submit = submits.length === 1 ? submits[0] : null;
    if (until === "invio" && !submits.length) gaps.push({ kind: "no-submit", what: document, hint: "pulsante d'invio non visto nella pagina" });
    else if (until === "invio" && !submit) gaps.push({ kind: "ambiguous", what: "invio", hint: `più pulsanti d'invio: ${submits.map((s) => s.label).join(", ")}` });
    if (gaps.length) return { gaps };
    steps = [...(route.steps ?? []).map((s) => ({ verb: s.verb, action_class: s.action_class ?? "ACT-OBS", target: s.target, expect: s.expect ?? { page_sig: pathOf(formSig) } })), ...fills,
      { verb: "SAVE", action_class: "ACT-CREATE", target: save.id, expect: { page_sig: pathOf(formSig) } }];
    saveN = steps.length;
    if (submit) steps.push({ verb: "SUBMIT", action_class: "ACT-SUBMIT", target: submit.id, expect: { page_sig: pathOf(formSig) } });
  }
  if (gaps.length) return { gaps };
  steps = steps.map((s, i) => ({ n: i + 1, ...s }));
  const plan = { plan_id: planId, customer, env: env.id, goal, steps,
    ...(saveN ? { compensations: [{ step: saveN, kind: "cancel", entity: object, action: `${object}.cancel` }] } : {}),
    repair_policy: { skip_allowed: [], substitute_allowed: [], abort_on: [] } };
  const v = validatePlan(plan, { env });
  if (!v.ok) throw new Error(`piano composto non valido (bug del compositore): ${v.errors.join("; ")}`);
  return { plan };
}

export const HELP = `uso: compose-plan --goal "<obiettivo>" --data <dati.yaml> --scope <S> --env <id> [--fino-a bozza|invio] --out runs/<RUN>/plan.json [--customer C] [--workspace <dir>] [--json]

Compone il piano di un'attività (crea ordine, contratto, richiesta, fornitore, evento) dalla mappa del cliente:
procedura memorizzata se esiste, altrimenti percorso + un passo per campo (dati per etichetta) + salva (+ invio).
Se manca qualcosa non scrive nessun piano ed elenca le mancanze. Il piano va poi approvato e attivato come sempre.

Exit code: 0 piano scritto · 1 uso · 2 sistema · 3 mancanze.`;

export async function main(argv, env = process.env) {
  const { opts } = parseArgs(argv);
  const asJson = !!opts.json;
  if (opts.help) { console.log(HELP); return 0; }
  const ws = resolve(opts.workspace || env.JVC_WORKSPACE || env.CLAUDE_PROJECT_DIR || process.cwd());
  try {
    if (!opts.goal || !opts.data || !opts.scope || !opts.env || !opts.out) return fail(asJson, 1, "richiesti --goal --data --scope --env --out");
    if (!SCOPES.has(String(opts.scope).toUpperCase())) return fail(asJson, 1, `scope non valido: ${opts.scope}`);
    const m = RUN_OUT.exec(String(opts.out));
    if (!m) return fail(asJson, 1, "--out deve essere runs/<RUN>/plan.json, relativo alla cartella del cliente");
    const bad = confineInputs(opts, ["data"], { env });
    if (bad) return fail(asJson, 1, bad);
    const { resolveSessionId, loadSession } = await import("../admin/session.mjs");
    let session = null;
    try { const sid = resolveSessionId({ workspace: ws, arg: opts.session, env }); session = sid ? loadSession(ws, sid).session : null; } catch { session = null; }
    const customer = opts.customer ?? session?.customer;
    if (!customer) return fail(asJson, 1, "nessun cliente: --customer <C> o una sessione attiva");
    if (session?.customer && customer !== session.customer) return fail(asJson, 3, `--customer ${customer} diverso dal cliente della sessione (${session.customer})`);
    if (!m[1].startsWith(`RUN.${customer}.`)) return fail(asJson, 1, `il RUN di --out non è del cliente ${customer}`);
    const envs = YAML.parse(readFileSync(join(ws, "customers", customer, "config", "environments.yaml"), "utf8"))?.environments ?? [];
    const e = envs.find((x) => x.id === opts.env);
    if (!e) return fail(asJson, 1, `ambiente ${opts.env} non dichiarato in environments.yaml`);
    const data = YAML.parse(readFileSync(opts.data, "utf8")) ?? {};
    if (typeof data !== "object" || Array.isArray(data)) return fail(asJson, 1, "--data: un file YAML con etichetta: valore");
    const planId = `PLAN.${customer}.${m[1].slice(4)}`;
    const r = composePlan({ ws, customer, scope: String(opts.scope).toUpperCase(), env: { id: e.id, type: e.type }, goal: String(opts.goal), data, until: opts["fino-a"] === "invio" ? "invio" : "bozza", planId });
    if (r.gaps) { console.log(JSON.stringify({ ok: false, gaps: r.gaps })); return 3; }
    const file = join(ws, "customers", customer, String(opts.out));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(r.plan, null, 2));
    console.log(JSON.stringify({ ok: true, plan_id: planId, file: String(opts.out), steps: r.plan.steps.length, ...(asJson ? { plan: r.plan } : {}) }));
    return 0;
  } catch (err) {
    return fail(asJson, 2, `errore di sistema: ${err?.message ?? err}`);
  }
}

if (isMain(import.meta.url)) process.exit(await main(process.argv.slice(2)));
