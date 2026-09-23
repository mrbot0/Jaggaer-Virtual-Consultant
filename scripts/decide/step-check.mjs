// step-check (K6.1, §23.5, §46.3, §13, §47.2): dopo ogni passo l'agente gli passa lo snapshot che ha
// salvato dallo strumento MCP del browser; lo script confronta con `expect`, classifica la divergenza
// (DT-016), scrive il checkpoint e mantiene session.active_plan. L'agente non giudica: riceve.
//
//   check({ ws, customer?, sid, planFile, step: n, snapshot, now, run?, why?, result?, elapsedMs?, resume?, close? })
//     → { status: ok|surprise|novelty|approval_required|denied, kind?, compat?, proceed, divergences[],
//         novelties[], checkpoint, observation, next?, escalate?, tier_up?, priority?, stop?, … }
//
// Tre modi:
//  - attivazione (senza snapshot): prepara il passo n PRIMA che l'agente lo esegua — piano validato contro
//    catalogo e ambiente (validate-plan), sequenza, compensazione del piano registrata in
//    session.pending.compensations e runs/<RUN>/compensations.yaml (§29.6, §47.2 #1), approvazioni
//    richieste con la stessa regola di guard-config-scope (pending.approvals, che approval-capture legge);
//    active_plan = { plan_id, file, step: n, run };
//  - verifica (con snapshot): confronto (scripts/chrome/expect-compare.mjs), DT-016 con il rischio del
//    passo, on_divergence, would_change_my_mind (sorpresa prioritaria), contatore di sorprese del compito
//    (2ª ⇒ tier_up, 3ª ⇒ escalate, §13.3), DEC se il DB del cliente esiste, checkpoint atomico; se si
//    procede, attivazione del passo successivo (o piano completato ⇒ active_plan = null);
//  - --resume n: le letture (READ) da fare prima di ripetere i passi con effetto dopo l'ultimo checkpoint.
import { readFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import YAML from "yaml";
import { parseArgs, fail } from "../lib/args.mjs";
import { isMain } from "../lib/is-main.mjs";
import { writeFileAtomic } from "../../hooks/lib/fsx.mjs";
import { updateSessionFile } from "../../hooks/lib/session-state.mjs";
import { sessionFile as sessionFilePath } from "../../hooks/lib/workspace.mjs";
import { appendAudit } from "../../hooks/lib/audit.mjs";
import { ACT, stepLevel, stepRisk } from "../../hooks/lib/act-classes.mjs";
import { requiredApprovals, COMMIT_VERBS } from "../../hooks/lib/guards/config-scope.mjs";
import { loadPlanFile, approvalsFile, readApprovals, windowState } from "../admin/approvals.mjs";
import { loadSession, resolveSessionId } from "../admin/session.mjs";
import { validatePlan } from "./validate-plan.mjs";
import { evaluate, loadTable } from "./dt-eval.mjs";
import { parseSnapshot } from "../chrome/snapshot-parse.mjs";
import { compareExpect } from "../chrome/expect-compare.mjs";
import { resolveSel, atlasIndex } from "../chrome/atlas.mjs";

export const STATUSES = ["ok", "surprise", "novelty", "approval_required", "denied"];
const COMP_CLASSES = new Set(["ACT-CREATE", "ACT-UPDATE", "ACT-SUBMIT"]);
const EFFECT_VERBS = new Set(["SAVE", "SUBMIT", "TOGGLE", "UPLOAD"]);

export class StepCheckError extends Error { constructor(code, msg) { super(msg); this.code = code; } }

const runFromPath = (rel) => /(?:^|\/)runs\/([^/]+)\//.exec(String(rel ?? "").replace(/\\/g, "/"))?.[1] ?? null;
const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, "");
const stepsOf = (plan) => (Array.isArray(plan?.steps) ? [...plan.steps].sort((a, b) => a.n - b.n) : []);

// Frasi che l'utente deve scrivere (§57.2) per le richieste aperte.
function phrase(r, planId, second) {
  const who = second ? " DA <Nome Cognome>" : "";
  if (r.kind === "A1") return `APPROVO PIANO ${planId}${who}`;
  if (r.kind === "A2") return `APPROVO PROVA ${planId}${who}`;
  if (r.kind === "A3") return `APPROVO PASSO ${r.step} ${planId}`;
  return "sì";
}

// Il passo n può partire? Compensazione dichiarata, approvazioni richieste e già date.
export function gateStep({ plan, step, env, records, now, planFile }) {
  const out = { step: step.n, status: "ok", compensation: null, pending: [], ask: null, reason: null };
  const cls = step.action_class;
  const at = `passo ${step.n} (${step.verb}, ${cls ?? "senza classe"})`;
  if (!ACT[cls]) return { ...out, status: "denied", reason: `${at}: classe di azione fuori catalogo` };
  if (COMP_CLASSES.has(cls) && COMMIT_VERBS.has(step.verb)) {
    const c = (Array.isArray(plan.compensations) ? plan.compensations : []).find((x) => x && x.step === step.n);
    if (!c) return { ...out, status: "denied", reason: `${at}: nessuna compensazione dichiarata nel piano (close · cancel · deactivate · restore): va registrata prima del passo che crea, modifica o invia (§29.6)` };
    out.compensation = { plan: plan.plan_id, step: step.n, kind: c.kind, ...(c.entity ? { entity: c.entity } : {}), ...(c.action ? { action: c.action } : {}), ...(c.ref ? { ref: c.ref } : {}), status: "pending" };
  }
  const level = cls === "ACT-CFG-CHANGE" ? stepLevel(step) : null;
  const req = requiredApprovals(cls, step, env, level);
  const second = env.policy?.second_approver_required ?? env.type === "prod";
  const w = windowState(null, plan.plan_id, { ...env.policy, second_approver_required: second }, now.getTime(), { records });
  const need = [];
  if (req.a1 || req.a2 || req.a3) {
    if (!w.a1 || w.expired) need.push({ kind: "A1" });
    else if (req.a2 && !w.a2) need.push({ kind: "A2" });
    if (req.a3 && !w.tokenForStep(step.n)) need.push({ kind: "A3", step: step.n });
  }
  if (req.action && !w.actionFor(step.n)) need.push({ kind: "action", step: step.n });
  if (need.length) {
    out.status = "approval_required";
    out.pending = need.map((r) => ({ kind: r.kind, plan: plan.plan_id, ...(r.step ? { step: r.step } : {}), file: planFile }));
    out.ask = need.map((r) => phrase(r, plan.plan_id, second)).join(" · ");
    out.reason = `${at}: approvazione richiesta (${need.map((r) => r.kind).join(", ")})`;
  }
  return out;
}

function onDivergence(step, d) {
  const od = step?.on_divergence;
  if (!od || typeof od !== "object" || !d) return null;
  const keys = [d.observed == null ? null : String(d.observed).toLowerCase(), d.kind, "other"].filter((k) => k != null);
  for (const k of keys) {
    const hit = Object.entries(od).find(([key]) => String(key).toLowerCase() === k);
    if (hit) {
      const text = String(hit[1]);
      const action = /^\s*stop/i.test(text) ? "stop" : /^\s*(continue|procedi|prosegui|ignora|ok)/i.test(text) ? "continue" : "surprise";
      return { key: hit[0], text, action };
    }
  }
  return null;
}

function writeCompensations(runDir, entries) {
  if (!entries.length) return;
  mkdirSync(runDir, { recursive: true });
  const f = join(runDir, "compensations.yaml");
  let doc = { compensations: [] };
  try { doc = YAML.parse(readFileSync(f, "utf8")) ?? doc; } catch { /* nuovo */ }
  const list = Array.isArray(doc.compensations) ? doc.compensations : [];
  for (const e of entries) if (!list.some((x) => x.plan === e.plan && x.step === e.step)) list.push(e);
  writeFileAtomic(f, YAML.stringify({ compensations: list }));
}

const dedupePending = (cur, add) => {
  const out = [...cur];
  for (const p of add) if (!out.some((x) => x.kind === p.kind && x.plan === p.plan && (x.step ?? null) === (p.step ?? null))) out.push(p);
  return out;
};

function lastCheckpoint(dir) {
  let files = [];
  try { files = readdirSync(dir).filter((f) => /^\d+\.json$/.test(f)); } catch { return null; }
  let best = null;
  for (const f of files) {
    try {
      const cp = JSON.parse(readFileSync(join(dir, f), "utf8"));
      if (cp.proceed && (best == null || cp.step > best)) best = cp.step;
    } catch { /* checkpoint illeggibile: non conta */ }
  }
  return best;
}

async function writeDec(ws, customer, scope, sid, session, cls, now) {
  const dbPath = join(ws, "customers", customer, "knowledge.db");
  if (!existsSync(dbPath)) return null;
  const { openDb } = await import("../kb/db.mjs");
  const { writeDecision } = await import("./dt-eval.mjs");
  const db = openDb(dbPath, { createIfMissing: false });
  try {
    return writeDecision(db, { customer, scope: scope ?? "XSC", root: join(ws, "customers", customer), result: cls.raw, agent: "step-check",
      session: session.session_code ?? session.session_id, at: now.toISOString(), context: { effects: false } });
  } finally { db.close(); }
}

export async function check(opts) {
  const { ws, planFile, step: n = null, snapshot = null, now = new Date(), why = null, result, elapsedMs, resume = null, close = false } = opts;
  const sid = opts.sid;
  const { session, pointer } = loadSession(ws, sid);
  if (!session) throw new StepCheckError(1, "nessuna sessione con cliente attivo: use customer <ID>");
  const customer = opts.customer ?? pointer.customer;
  if (customer !== session.customer) throw new StepCheckError(1, `la sessione è del cliente ${session.customer}`);
  const sFile = sessionFilePath(ws, customer, sid);
  const deny = (reason, extra = {}) => ({ status: "denied", reason, proceed: false, divergences: [], novelties: [], checkpoint: null, observation: null, ...extra });

  if (close) {
    const prev = session.active_plan;
    updateSessionFile(sFile, (s) => { s.active_plan = null; });
    audit(ws, sid, customer, session.scope, { action: "close", plan: prev?.plan_id ?? null, step: prev?.step ?? null });
    return { status: "ok", closed: prev ?? null, proceed: false, divergences: [], novelties: [], checkpoint: null, observation: null };
  }

  const info = await loadPlanFile(ws, customer, planFile);
  if (!info) throw new StepCheckError(1, `piano non trovato o fuori dalla cartella del cliente: ${planFile}`);
  const plan = info.plan;
  if (!session.env) return deny("nessun ambiente dichiarato: /use env <id> prima di eseguire un piano (§51.2)");
  if (plan?.customer !== customer) return deny(`il piano è del cliente ${plan?.customer}, la sessione di ${customer}`);
  const v = validatePlan(plan, { env: { id: session.env.id, type: session.env.type } });
  if (!v.ok) return deny(`piano non valido per l'ambiente ${session.env.id} (${session.env.type}): ${v.errors.join("; ")}`);
  const steps = stepsOf(plan);
  const active = session.active_plan ?? null;
  if (active && active.plan_id !== plan.plan_id) return deny(`un altro piano è attivo: ${active.plan_id} (passo ${active.step}); chiudilo con --close prima di attivarne uno nuovo`);
  const run = opts.run ?? (active?.run ?? null) ?? runFromPath(planFile) ?? runFromPath(plan.checkpoint_dir) ?? `RUN.${customer}.${ymd(now)}.${plan.plan_id.split(".").pop()}`;
  const runDir = join(ws, "customers", customer, "runs", run);
  const cpDir = join(runDir, "checkpoints");
  const reg = readApprovals(approvalsFile(ws, customer, sid));
  if (!reg.ok) return deny(`registro delle approvazioni corrotto (${reg.reason})`);
  const observation = session.ledger?.observe?.last_obs ?? null;

  // attiva il passo s: scrive active_plan, compensazione, richieste di approvazione
  const activate = (s, extraMutate) => {
    const g = gateStep({ plan, step: s, env: session.env, records: reg.records, now, planFile });
    if (g.compensation) g.compensation.registered_at = now.toISOString();
    if (g.compensation) writeCompensations(runDir, [g.compensation]);   // prima su disco nel run (§47.2 #1)
    updateSessionFile(sFile, (x) => {
      x.active_plan = { plan_id: plan.plan_id, file: planFile, step: s.n, run };
      if (g.compensation) {
        const comps = Array.isArray(x.pending.compensations) ? x.pending.compensations : [];
        if (!comps.some((c) => c && typeof c === "object" && c.plan === plan.plan_id && c.step === s.n)) comps.push(g.compensation);
        x.pending.compensations = comps;
      }
      if (g.pending.length) x.pending.approvals = dedupePending(Array.isArray(x.pending.approvals) ? x.pending.approvals : [], g.pending);
      extraMutate?.(x);
    });
    return g;
  };

  if (resume != null) {
    const target = steps.find((s) => s.n === Number(resume));
    if (!target) throw new StepCheckError(1, `il piano ${plan.plan_id} non ha il passo ${resume}`);
    const last = lastCheckpoint(cpDir);
    const from = (last ?? 0) + 1;
    const reads = steps.filter((s) => s.n >= from && s.n <= target.n && EFFECT_VERBS.has(s.verb))
      .map((s) => ({ step: s.n, verb: "READ", target: s.wait_for ?? s.target, expect: s.expect, why: `verifica se il passo ${s.n} (${s.verb}) risulta già eseguito: se sì, saltalo (idempotenza, §47.2 #2)` }));
    const g = activate(target);
    audit(ws, sid, customer, session.scope, { action: "resume", plan: plan.plan_id, step: target.n, last_checkpoint: last });
    return { status: g.status === "ok" ? "ok" : g.status, resume_from: target.n, last_checkpoint: last, reads, gate: g, ask: g.ask, reason: g.reason, proceed: g.status === "ok",
      divergences: [], novelties: [], checkpoint: null, observation, active_plan: { plan_id: plan.plan_id, file: planFile, step: target.n, run } };
  }

  const cur = steps.find((s) => s.n === Number(n));
  if (!cur) throw new StepCheckError(1, `il piano ${plan.plan_id} non ha il passo ${n}`);
  const skippable = (a, b) => steps.filter((s) => s.n >= a && s.n < b).every((s) => (plan.repair_policy?.skip_allowed ?? []).includes(s.n));

  // ---- attivazione ----
  if (snapshot == null) {
    const expected = active ? active.step : steps[0].n;
    if (cur.n !== expected && !(cur.n > expected && skippable(expected, cur.n))) return deny(`passo fuori sequenza: il piano ${plan.plan_id} è al passo ${expected} (saltabili solo i passi in repair_policy.skip_allowed)`);
    const g = activate(cur);
    audit(ws, sid, customer, session.scope, { action: "activate", plan: plan.plan_id, step: cur.n, status: g.status });
    return { status: g.status, reason: g.reason, ask: g.ask, compensation: g.compensation, pending: g.pending, proceed: g.status === "ok",
      divergences: [], novelties: [], checkpoint: null, observation, active_plan: { plan_id: plan.plan_id, file: planFile, step: cur.n, run } };
  }

  // ---- verifica ----
  if (!active) return deny(`piano ${plan.plan_id} non attivo: attivalo con --step ${steps[0].n} senza snapshot`);
  if (active.step !== cur.n) return deny(`passo fuori sequenza: il piano ${plan.plan_id} è al passo ${active.step}, non al ${cur.n}`);
  const page = typeof snapshot === "string" ? parseSnapshot(snapshot) : snapshot;
  const cmp = compareExpect(cur, page, {
    resolve: (code) => resolveSel(ws, code, customer), atlas: atlasIndex(ws, customer, session.scope), why, elapsedMs, result,
  });
  const risk = stepRisk(cur);
  const res = { status: "ok", kind: null, compat: null, proceed: true, divergences: cmp.divergences, novelties: cmp.novelties,
    confirmations: cmp.confirmations, page_signature: cmp.page_signature, observation, risk };
  let surpriseRec = null;
  let finish = false;
  if (cmp.primary) {
    const od = cmp.primary.priority ? null : onDivergence(cur, cmp.primary);
    if (od?.action === "stop") {
      Object.assign(res, { status: "ok", stop: true, on_divergence: od.text, proceed: false, kind: cmp.primary.kind });
      finish = true;
    } else if (od?.action === "continue") {
      Object.assign(res, { status: "ok", on_divergence: od.text, assumption: `divergenza ${cmp.primary.kind} accettata dal piano (${od.text})`, kind: cmp.primary.kind });
    } else {
      const raw = evaluate(loadTable("DT-016"), { divergence: cmp.primary.kind, risk });
      const compat = cmp.primary.priority ? "incompatibile" : raw.outcome;
      Object.assign(res, { status: "surprise", kind: cmp.primary.kind, compat, action: compat === "compatibile" ? "procedi-dichiarando-l-assunzione" : "ferma-il-passo", proceed: compat === "compatibile" });
      if (cmp.primary.priority) Object.assign(res, { priority: true, would_change_my_mind: cmp.primary.expected });
      if (od) res.on_divergence = od.text;
      const prior = (session.surprises ?? []).filter((x) => x && x.plan === plan.plan_id).length;
      res.surprises_in_task = prior + 1;
      if (res.surprises_in_task === 2) res.tier_up = true;
      if (res.surprises_in_task >= 3) { res.escalate = true; res.proceed = false; }
      if (!res.proceed && (plan.repair_policy?.abort_on ?? []).includes(cur.n)) res.abort = true;
      surpriseRec = { at: now.toISOString(), item: typeof cur.target === "string" ? cur.target : null, obs: observation, plan: plan.plan_id, step: cur.n, kind: cmp.primary.kind, compat };
      try { res.dec = await writeDec(ws, customer, session.scope, sid, session, { raw }, now); } catch (err) { throw new StepCheckError(2, `DEC non scritta (§29.6: prima dell'esito): ${err.message}`); }
    }
  } else if (cmp.novelties.length) res.status = "novelty";

  // checkpoint atomico (§29.6)
  mkdirSync(cpDir, { recursive: true });
  const cpFile = join(cpDir, `${cur.n}.json`);
  writeFileAtomic(cpFile, `${JSON.stringify({ plan_id: plan.plan_id, plan_sha256: info.sha256, run, step: cur.n, status: res.status, kind: res.kind, compat: res.compat,
    proceed: res.proceed, stop: !!res.stop, divergences: res.divergences, novelties: res.novelties, confirmations: res.confirmations,
    page_signature: res.page_signature, observation, ts: now.toISOString() }, null, 2)}\n`);
  res.checkpoint = `runs/${run}/checkpoints/${cur.n}.json`;

  const idx = steps.indexOf(cur);
  const nextStep = res.proceed ? steps[idx + 1] ?? null : null;
  const mutate = (x) => { if (surpriseRec) x.surprises = [...(Array.isArray(x.surprises) ? x.surprises : []), surpriseRec]; };
  if (nextStep) {
    const g = activate(nextStep, mutate);
    res.next = { step: nextStep.n, status: g.status, ...(g.reason ? { reason: g.reason } : {}), ...(g.ask ? { ask: g.ask } : {}), ...(g.compensation ? { compensation: g.compensation } : {}) };
  } else if ((res.proceed && idx === steps.length - 1) || finish) {
    updateSessionFile(sFile, (x) => { mutate(x); x.active_plan = null; });
    res.plan_status = finish ? "stopped" : "completed";
  } else {
    updateSessionFile(sFile, mutate);
  }
  audit(ws, sid, customer, session.scope, { action: "check", plan: plan.plan_id, step: cur.n, status: res.status, kind: res.kind, compat: res.compat, proceed: res.proceed, checkpoint: res.checkpoint });
  return res;
}

function audit(ws, sid, customer, scope, payload) {
  try { appendAudit(ws, { session: sid, customer, scope: scope ?? null, kind: "run", actor: "step-check", payload }); } catch { /* l'audit non cambia l'esito */ }
}

const HELP = `uso: node scripts/decide/step-check.mjs --plan <file del piano, relativo alla cartella del cliente>
       --step <n> [--snapshot <file>] [--run <RUN>] [--why <file yaml|json>] [--result pass|fail] [--elapsed-ms <ms>]
       | --plan <file> --resume <n> | --close
       [--session <id>] [--workspace <dir>] [--json] [--help]

Senza --snapshot: attiva il passo n (piano validato, compensazione registrata, approvazioni richieste).
Con --snapshot (il risultato dello strumento MCP salvato in un file): confronta con expect, classifica
(ok · surprise · novelty · approval_required · denied), scrive runs/<RUN>/checkpoints/<n>.json e, se si
procede, attiva il passo successivo. --resume n: le letture da fare prima di ripetere i passi con effetto.
--close: chiude il piano attivo (nessuna azione con effetto sarà più consentita dai guard).

Exit code: 0 esito prodotto (anche surprise o approval_required) · 1 errore utente · 2 errore di sistema · 3 denied.`;

export async function run(argv, env = process.env) {
  const { opts } = parseArgs(argv, { flags: ["close"] });
  const asJson = !!opts.json;
  if (opts.help) { console.log(HELP); return 0; }
  const ws = resolvePath(opts.workspace || env.JVC_WORKSPACE || env.CLAUDE_PROJECT_DIR || process.cwd());
  try {
    if (!opts.close && (!opts.plan || (opts.step == null && opts.resume == null))) return fail(asJson, 1, "richiesti --plan e --step (o --resume), oppure --close");
    const sid = resolveSessionId({ workspace: ws, arg: opts.session, env });
    if (!sid) return fail(asJson, 1, "nessuna sessione risolvibile: --session <id>");
    let snapshot = null;
    if (opts.snapshot) { try { snapshot = readFileSync(resolvePath(opts.snapshot), "utf8"); } catch (err) { return fail(asJson, 1, `snapshot illeggibile: ${err.message}`); } }
    let why = null;
    if (opts.why) { try { const w = YAML.parse(readFileSync(resolvePath(opts.why), "utf8")); why = w?.why ?? w; } catch (err) { return fail(asJson, 1, `why illeggibile: ${err.message}`); } }
    const r = await check({ ws, sid, planFile: opts.plan, step: opts.step != null ? Number(opts.step) : null, snapshot, run: opts.run, why,
      result: opts.result, elapsedMs: opts["elapsed-ms"] != null ? Number(opts["elapsed-ms"]) : undefined, resume: opts.resume != null ? Number(opts.resume) : null, close: !!opts.close });
    if (asJson) console.log(JSON.stringify(r));
    else console.log(`${r.status}${r.kind ? ` (${r.kind}${r.compat ? `, ${r.compat}` : ""})` : ""}${r.reason ? ` — ${r.reason}` : ""}${r.next ? ` · passo ${r.next.step}: ${r.next.status}${r.next.ask ? ` — serve ${r.next.ask}` : ""}` : ""}`);
    return r.status === "denied" ? 3 : 0;
  } catch (err) {
    if (err instanceof StepCheckError) return fail(asJson, err.code, err.message);
    return fail(asJson, 2, `errore di sistema: ${err?.message ?? err}`);
  }
}

if (isMain(import.meta.url)) run(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(e); process.exit(2); });

