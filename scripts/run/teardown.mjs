// teardown (F4.4, §29.1, §29.6, §45.5, ADR-06): le compensazioni di un run — close · cancel · deactivate · restore,
// MAI delete — pianificate, eseguite dall'agente sul browser nella corsia guidata, poi marcate fatte; 0 orfani.
// Lo script non tocca il tenant: prepara i piani (ricetta per compensazione), registra l'esito, riporta gli orfani.
//
//   planTeardown(ws, { customer, run, session? }) → { items[], refused[], created_open[] }
//     da runs/<RUN>/compensations.yaml (+ session.pending.compensations dei piani del run); ricetta: la CFP di rollback
//     (ref CFP ⇒ piano compilato con compile-cfp, se i parametri bastano), la compensazione della FLW (ref FLW),
//     altrimenti un passo ASK con l'azione da compiere; una voce che cancella (tipo o azione) è RIFIUTATA
//   markDone(ws, { customer, run, plan, step, sid?, by? }) → voce done (run file, session pending, entità compensated)
//   report(ws, { customer, run }) → { orphans[], pending[] }   orfano = entità NRT-* creata e non compensata
//
// CLI: node scripts/run/teardown.mjs plan --run <RUN> [--json]      → runs/<RUN>/teardown/plan.yaml (+ piani .plan.json)
//      node scripts/run/teardown.mjs done --run <RUN> --plan <PLAN> --step <n> [--evidence <file>]
//      node scripts/run/teardown.mjs report --run <RUN>               exit 3 se orfani o compensazioni pendenti
// Exit: 0 ok · 1 errore utente · 2 errore di sistema · 3 rifiuto (voce che cancella) o orfani presenti.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { parseArgs, fail } from "../lib/args.mjs";
import { isMain } from "../lib/is-main.mjs";
import { writeFileAtomic } from "../../hooks/lib/fsx.mjs";
import { sessionFile } from "../../hooks/lib/workspace.mjs";
import { runRefusal } from "../lib/run-code.mjs";
import { loadItem, typeOf } from "../lib/kb-items.mjs";
import { readRunCompensations, markRunCompensation, removeSessionCompensation, compensationRefusal } from "../lib/compensations-store.mjs";
import { loadSession, resolveSessionId } from "../admin/session.mjs";
import { cfpPlan } from "../compile/compile-cfp.mjs";
import { createdEntities, markCompensated, orphans, workspaceCustomer } from "./fixtures.mjs";

export class TeardownError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const runDirOf = (ws, customer, run) => join(ws, "customers", customer, "runs", run);

function recipe(ws, customer, c) {
  const ref = c.ref ?? null;
  if (ref && typeOf(ref) === "CFP") {
    const cfp = loadItem(ws, ref, customer);
    if (!cfp) return { kind: "ask", ask: `la CFP di rollback ${ref} non è nella knowledge base: ${c.kind} ${c.entity ?? ""} a mano, poi teardown done` };
    try { const p = cfpPlan(ws, cfp, { customer, env: "sandbox" }); return { kind: "cfp", cfp: ref, plan: p.plan }; }
    catch (err) { return { kind: "cfp", cfp: ref, plan: null, note: `piano non compilabile senza parametri (${String(err.message).slice(0, 160)}): compile-cfp --cfp ${ref} con --params` }; }
  }
  if (ref && typeOf(ref) === "FLW") {
    const f = loadItem(ws, ref, customer);
    if (f?.compensation) return { kind: "flw", flw: ref, compensation: f.compensation };
  }
  return { kind: "ask", ask: `${c.kind} ${c.entity ?? "l'entità"}${ref ? ` ${ref}` : ""}${c.action ? ` (${c.action})` : ""} sul browser, poi teardown done --plan ${c.plan} --step ${c.step}` };
}

export function planTeardown(ws, { customer, run, session = null }) {
  const bad = runRefusal(ws, customer, run);
  if (bad) throw new TeardownError(1, bad);
  const fileEntries = readRunCompensations(runDirOf(ws, customer, run));
  const sessionEntries = (session?.pending?.compensations ?? []).filter((c) => c && typeof c === "object" && (c.run === run || fileEntries.some((f) => f.plan === c.plan)));
  const all = [...fileEntries];
  for (const s of sessionEntries) if (!all.some((x) => x.plan === s.plan && x.step === s.step)) all.push({ ...s, status: s.status ?? "pending" });
  const items = [];
  const refused = [];
  for (const c of all.filter((x) => x.status !== "done")) {
    const why = compensationRefusal(c);
    if (why) { refused.push({ plan: c.plan, step: c.step, reason: why }); continue; }
    items.push({ plan: c.plan, step: c.step, kind: c.kind, entity: c.entity ?? null, action: c.action ?? null, ref: c.ref ?? null, status: "pending", recipe: recipe(ws, customer, c) });
  }
  const created_open = createdEntities(ws, customer, { run }).filter((e) => e.status !== "compensated").map((e) => ({ ref: e.ref, entity: e.entity, case: e.case, step: e.step,
    covered: all.some((c) => c.ref === e.ref || (c.entity && c.entity === e.entity && c.status !== "done")) }));
  return { run, items, refused, created_open };
}

export function writeTeardownPlan(ws, customer, t) {
  const dir = join(runDirOf(ws, customer, t.run), "teardown");
  mkdirSync(dir, { recursive: true });
  for (const it of t.items) if (it.recipe?.plan) {
    const f = join(dir, `${it.plan}.${it.step}.plan.json`);
    writeFileAtomic(f, `${JSON.stringify(it.recipe.plan, null, 2)}\n`);
    it.recipe.plan_file = `runs/${t.run}/teardown/${it.plan}.${it.step}.plan.json`;
    delete it.recipe.plan;
  }
  writeFileAtomic(join(dir, "plan.yaml"), YAML.stringify(t));
  return `runs/${t.run}/teardown/plan.yaml`;
}

export function markDone(ws, { customer, run, plan, step, sid = null, by = "teardown", evidence = null, now = new Date() }) {
  const bad = runRefusal(ws, customer, run);
  if (bad) throw new TeardownError(1, bad);
  const key = { plan, step: Number(step) };
  const e = markRunCompensation(runDirOf(ws, customer, run), key, { status: "done", done_at: now.toISOString(), done_by: by, ...(evidence ? { evidence } : {}) });
  if (!e) throw new TeardownError(1, `nessuna compensazione ${plan} passo ${step} nel run ${run}`);
  if (sid) { try { removeSessionCompensation(sessionFile(ws, customer, sid), key); } catch { /* sessione assente: il run è la fonte */ } }
  const created = createdEntities(ws, customer, { run }).filter((x) => x.status !== "compensated" && (x.ref === e.ref || (x.case && `PLAN.${x.case}` === plan && x.step === key.step)));
  for (const c of created) markCompensated(ws, customer, run, c.ref, { now, by });
  return { ...e, compensated_entities: created.map((c) => c.ref) };
}

export function report(ws, { customer, run }) {
  const bad = runRefusal(ws, customer, run);
  if (bad) throw new TeardownError(1, bad);
  const pending = readRunCompensations(runDirOf(ws, customer, run)).filter((c) => c.status !== "done").map((c) => ({ plan: c.plan, step: c.step, kind: c.kind, entity: c.entity ?? null }));
  return { run, orphans: orphans(ws, customer, { run }).map((e) => ({ ref: e.ref, entity: e.entity, case: e.case })), pending };
}

const HELP = `uso: node scripts/run/teardown.mjs plan --run <RUN> [--json]
       node scripts/run/teardown.mjs done --run <RUN> --plan <PLAN> --step <n> [--evidence <file>]
       node scripts/run/teardown.mjs report --run <RUN>
       Opzioni: [--customer C] [--session <id>] [--workspace <dir>] [--json] [--help]

Compensazioni del run (close · cancel · deactivate · restore, mai delete): piano di teardown con la ricetta per voce
(CFP di rollback, FLW, oppure passo da fare sul browser), registrazione dell'esito, orfani (devono essere 0).
Lo script non agisce sul tenant: l'agente esegue i piani sul browser nella corsia guidata.

Exit code: 0 ok · 1 errore utente · 2 errore di sistema · 3 voce che cancella o orfani/pendenti presenti.`;

export function run(argv, env = process.env) {
  const { opts, positional } = parseArgs(argv);
  const asJson = !!opts.json;
  const [cmd] = positional;
  if (opts.help || !cmd) { console.log(HELP); return opts.help ? 0 : 1; }
  const { ws, customer } = workspaceCustomer(opts, env);
  if (!customer) return fail(asJson, 1, "cliente non determinato: --customer <C>");
  if (!opts.run) return fail(asJson, 1, "richiesto --run <RUN>");
  try {
    const sid = resolveSessionId({ workspace: ws, arg: opts.session, env });
    const session = sid ? loadSession(ws, sid).session : null;
    if (cmd === "plan") {
      const t = planTeardown(ws, { customer, run: opts.run, session });
      const file = writeTeardownPlan(ws, customer, t);
      console.log(asJson ? JSON.stringify({ ok: t.refused.length === 0, file, ...t }) : `${t.items.length} compensazioni da eseguire → ${file}${t.refused.length ? ` · RIFIUTATE: ${t.refused.map((r) => `${r.plan}#${r.step} (${r.reason})`).join("; ")}` : ""}`);
      return t.refused.length ? 3 : 0;
    }
    if (cmd === "done") {
      if (!opts.plan || opts.step == null) return fail(asJson, 1, "richiesti --plan e --step");
      const e = markDone(ws, { customer, run: opts.run, plan: opts.plan, step: Number(opts.step), sid: session ? sid : null, evidence: opts.evidence ?? null });
      console.log(asJson ? JSON.stringify({ ok: true, compensation: e }) : `compensazione ${opts.plan}#${opts.step} eseguita`);
      return 0;
    }
    if (cmd === "report") {
      const r = report(ws, { customer, run: opts.run });
      const bad = r.orphans.length + r.pending.length;
      console.log(asJson ? JSON.stringify({ ok: bad === 0, ...r }) : `orfani: ${r.orphans.length} · compensazioni pendenti: ${r.pending.length}`);
      return bad ? 3 : 0;
    }
    return fail(asJson, 1, `comando sconosciuto: ${cmd}`);
  } catch (err) {
    if (err instanceof TeardownError) return fail(asJson, err.code, err.message);
    return fail(asJson, 2, `errore di sistema: ${err?.message ?? err}`);
  }
}

if (isMain(import.meta.url)) process.exit(run(process.argv.slice(2)));
