// kb compensation (§29.6, §47.2 #1, §45.4): registrazione della compensazione PRIMA del passo che crea, modifica o invia.
// Riusa il formato che K6 già scrive (scripts/lib/compensations-store.mjs): runs/<RUN>/compensations.yaml e
// session.pending.compensations { plan, step, kind, entity?, action?, ref?, status, registered_at } — la voce che
// guard-config-scope (a) cerca per plan + step. Mai delete: close · cancel · deactivate · restore.
//
//   addCompensation({ ws, sid, plan?, step, kind, entity?, action?, ref?, run?, now }) → voce
//     il piano di default è quello attivo (e il suo run); un passo già verificato (≤ last_verified_step) ⇒ rifiuto:
//     la compensazione va registrata prima del passo; prima su disco nel run, poi nella sessione
//   listCompensations({ ws, sid, run? }) → { pending (sessione), run: [voci del file] }
//   doneCompensation({ ws, sid, plan, step, run?, now }) → voce   status done nel run, tolta da pending; l'entità
//     creata con lo stesso ref (runs/<RUN>/created.yaml) è marcata compensated
//
// CLI (dati da chiave=valore o --payload-file, mai JSON in linea):
//   node scripts/kb/compensation.mjs add --step 3 kind=cancel entity=requisition action=requisition.cancel-draft [--plan P] [--run R]
//   node scripts/kb/compensation.mjs list [--run R] · done --plan P --step 3 [--run R]
//   (anche: node scripts/kb/kb.mjs compensation …)
// Exit: 0 ok · 1 errore utente · 2 errore di sistema · 3 rifiuto (dopo il passo, tipo non ammesso, azione che cancella).
import { readFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import YAML from "yaml";
import { parseArgs, fail } from "../lib/args.mjs";
import { isMain } from "../lib/is-main.mjs";
import { readDataFileSync, inputBase } from "../lib/text-file.mjs";
import { loadSession, resolveSessionId } from "../admin/session.mjs";
import { sessionFile } from "../../hooks/lib/workspace.mjs";
import { appendAudit } from "../../hooks/lib/audit.mjs";
import { writeCompensations, readRunCompensations, markRunCompensation, addSessionCompensation, removeSessionCompensation, compensationRefusal } from "../lib/compensations-store.mjs";
import { runRefusal } from "../lib/run-code.mjs";
import { markCompensated, kvArgs } from "../run/fixtures.mjs";

export class CompensationError extends Error { constructor(code, msg) { super(msg); this.code = code; } }

function ctx(ws, sid) {
  const { session, pointer } = loadSession(ws, sid);
  if (!session) throw new CompensationError(1, "nessuna sessione con cliente attivo: use customer <ID>");
  return { session, customer: pointer.customer, file: sessionFile(ws, pointer.customer, sid) };
}
function runOf(ws, customer, session, plan, run) {
  const r = run ?? (session.active_plan?.plan_id === plan ? session.active_plan.run : null);
  if (!r) throw new CompensationError(1, `run non determinato per ${plan}: --run <RUN> (o attiva il piano con step-check)`);
  const bad = runRefusal(ws, customer, r);
  if (bad) throw new CompensationError(1, bad);
  return r;
}

export function addCompensation({ ws, sid, plan = null, step, kind, entity = null, action = null, ref = null, run = null, now = new Date() }) {
  const { session, customer, file } = ctx(ws, sid);
  const ap = session.active_plan ?? null;
  const planId = plan ?? ap?.plan_id ?? null;
  const e = { plan: planId, step: Number(step), kind, ...(entity ? { entity } : {}), ...(action ? { action } : {}), ...(ref ? { ref } : {}), status: "pending", registered_at: now.toISOString() };
  const bad = compensationRefusal(e);
  if (bad) throw new CompensationError(e.plan && Number.isInteger(e.step) ? 3 : 1, bad);
  if (ap && ap.plan_id === planId && Number.isInteger(ap.last_verified_step) && e.step <= ap.last_verified_step) {
    throw new CompensationError(3, `il passo ${e.step} del piano ${planId} è già stato eseguito e verificato: la compensazione si registra PRIMA del passo (§29.6)`);
  }
  const r = runOf(ws, customer, session, planId, run);
  writeCompensations(join(ws, "customers", customer, "runs", r), [e]);   // prima su disco nel run (§47.2 #1)
  addSessionCompensation(file, e);
  try { appendAudit(ws, { session: sid, customer, scope: session.scope ?? null, kind: "compensation", actor: "kb-compensation", payload: { action: "add", plan: planId, step: e.step, kind, run: r } }); } catch { /* l'audit non cambia l'esito */ }
  return { ...e, run: r };
}

export function listCompensations({ ws, sid, run = null }) {
  const { session, customer } = ctx(ws, sid);
  const pending = (session.pending?.compensations ?? []).filter((c) => c && typeof c === "object");
  const r = run ?? session.active_plan?.run ?? null;
  if (r) { const bad = runRefusal(ws, customer, r); if (bad) throw new CompensationError(1, bad); }
  return { pending, run: r, run_entries: r ? readRunCompensations(join(ws, "customers", customer, "runs", r)) : [] };
}

export function doneCompensation({ ws, sid, plan, step, run = null, now = new Date(), by = "kb-compensation" }) {
  const { session, customer, file } = ctx(ws, sid);
  if (!plan || !Number.isInteger(Number(step))) throw new CompensationError(1, "richiesti --plan e --step");
  const key = { plan, step: Number(step) };
  const inSession = (session.pending?.compensations ?? []).find((c) => c && typeof c === "object" && c.plan === plan && c.step === key.step);
  const r = run ?? inSession?.run ?? session.active_plan?.run ?? null;
  if (!r) throw new CompensationError(1, "run non determinato: --run <RUN>");
  const bad = runRefusal(ws, customer, r);
  if (bad) throw new CompensationError(1, bad);
  const runDir = join(ws, "customers", customer, "runs", r);
  const e = markRunCompensation(runDir, key, { status: "done", done_at: now.toISOString(), done_by: by });
  if (!e && !inSession) throw new CompensationError(1, `nessuna compensazione registrata per ${plan} passo ${key.step} nel run ${r}`);
  removeSessionCompensation(file, key);
  if (e?.ref) markCompensated(ws, customer, r, e.ref, { now, by });
  try { appendAudit(ws, { session: sid, customer, scope: session.scope ?? null, kind: "compensation", actor: by, payload: { action: "done", plan, step: key.step, run: r } }); } catch { /* audit */ }
  return { ...(e ?? inSession), status: "done", run: r };
}

const HELP = `uso: node scripts/kb/compensation.mjs add --step <n> kind=<close|cancel|deactivate|restore> [entity=…] [action=…] [ref=NRT-…]
                                   [--plan <PLAN>] [--run <RUN>] [--payload-file <yaml>]
       node scripts/kb/compensation.mjs list [--run <RUN>]
       node scripts/kb/compensation.mjs done --plan <PLAN> --step <n> [--run <RUN>]
       Opzioni: [--session <id>] [--workspace <dir>] [--json] [--help]

Registra la compensazione PRIMA del passo che crea, modifica o invia (§29.6): runs/<RUN>/compensations.yaml e
session.pending.compensations, lo stesso formato di step-check, letto da guard-config-scope. Mai delete.

Exit code: 0 ok · 1 errore utente · 2 errore di sistema · 3 rifiuto (passo già eseguito, tipo o azione non ammessi).`;

export function main(argv, env = process.env) {
  const { opts, positional } = parseArgs(argv);
  const asJson = !!opts.json;
  const [cmd, ...rest] = positional;
  if (opts.help || !cmd) { console.log(HELP); return opts.help ? 0 : 1; }
  const ws = resolvePath(opts.workspace || env.JVC_WORKSPACE || env.CLAUDE_PROJECT_DIR || process.cwd());
  const sid = resolveSessionId({ workspace: ws, arg: opts.session, env });
  if (!sid) return fail(asJson, 1, "nessuna sessione risolvibile: --session <id>");
  const out = (o) => console.log(asJson ? JSON.stringify({ ok: true, ...o }) : YAML.stringify(o).trim());
  try {
    if (cmd === "add") {
      // WP10a giro 1 (minore 2): payload confinato al workspace
      let fromFile = {};
      if (opts["payload-file"]) { const d = readDataFileSync(inputBase(env), opts["payload-file"], YAML.parse); if (d.error) return fail(asJson, 1, d.error); fromFile = d.data ?? {}; }
      const p = { ...fromFile, ...kvArgs(rest) };
      out({ compensation: addCompensation({ ws, sid, plan: opts.plan ?? p.plan ?? null, step: opts.step ?? p.step, kind: p.kind, entity: p.entity, action: p.action, ref: p.ref, run: opts.run ?? p.run ?? null }) });
      return 0;
    }
    if (cmd === "list") { out(listCompensations({ ws, sid, run: opts.run ?? null })); return 0; }
    if (cmd === "done") { out({ compensation: doneCompensation({ ws, sid, plan: opts.plan, step: opts.step != null ? Number(opts.step) : null, run: opts.run ?? null }) }); return 0; }
    return fail(asJson, 1, `comando sconosciuto: ${cmd}`);
  } catch (err) {
    if (err instanceof CompensationError) return fail(asJson, err.code, err.message);
    return fail(asJson, 2, `errore di sistema: ${err?.message ?? err}`);
  }
}

if (isMain(import.meta.url)) process.exit(main(process.argv.slice(2)));
