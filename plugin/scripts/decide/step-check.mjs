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
import { readFileSync, readdirSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join, dirname, sep, resolve as resolvePath } from "node:path";
import YAML from "yaml";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { canonical } from "../../hooks/lib/audit.mjs";
import { parseArgs, fail } from "../lib/args.mjs";
import { isMain } from "../lib/is-main.mjs";
import { writeFileAtomic } from "../../hooks/lib/fsx.mjs";
import { updateSessionFile } from "../../hooks/lib/session-state.mjs";
import { sessionFile as sessionFilePath } from "../../hooks/lib/workspace.mjs";
import { appendAudit } from "../../hooks/lib/audit.mjs";
import { ACT, stepLevel, stepRisk } from "../../hooks/lib/act-classes.mjs";
import { autonomyLevel } from "../../hooks/lib/autonomy.mjs";
import { requiredApprovals, COMMIT_VERBS } from "../../hooks/lib/guards/config-scope.mjs";
import { loadPlanFile, approvalsFile, readApprovals, windowState } from "../admin/approvals.mjs";
import { loadSession, resolveSessionId } from "../admin/session.mjs";
import { validatePlan } from "./validate-plan.mjs";
import { evaluate, loadTable } from "./dt-eval.mjs";
import { parseSnapshot } from "../chrome/snapshot-parse.mjs";
import { compareExpect } from "../chrome/expect-compare.mjs";
import { resolveSel, atlasIndex } from "../chrome/atlas.mjs";
import { profileFor, redact } from "../chrome/redact.mjs";
import { RUN_RE, formatRunCode, runRefusal } from "../lib/run-code.mjs";
import { writeCompensations } from "../lib/compensations-store.mjs";
import { confineInputs } from "../lib/text-file.mjs";

export const STATUSES = ["ok", "surprise", "novelty", "approval_required", "denied"];
const COMP_CLASSES = new Set(["ACT-CREATE", "ACT-UPDATE", "ACT-SUBMIT", "ACT-BULK", "ACT-DELETE"]);
const EFFECT_VERBS = new Set(["SAVE", "SUBMIT", "TOGGLE", "UPLOAD", "DELETE"]);

const fileNotEmpty = (p) => { try { const s = statSync(p); return s.isFile() && s.size > 0; } catch { return false; } };

export class StepCheckError extends Error { constructor(code, msg) { super(msg); this.code = code; } }

const runFromPath = (rel) => /(?:^|\/)runs\/([^/]+)\//.exec(String(rel ?? "").replace(/\\/g, "/"))?.[1] ?? null;

// WP07 giro 3 (I-B): il run è UN codice RUN la cui cartella, se esiste, è figlia DIRETTA di customers/<C>/runs/ anche
// dopo realpath: niente sotto-cartelle, risalite, giunzioni, link o percorsi esterni (lo stesso per runs/ e checkpoints/).
// WP09b (ruling WP07 "stringere quando WP09b genera run reali"): forma completa RUN.<CLIENTE>.<AAAAMMDD>.<HHMM>.<SCOPE>
// (scripts/lib/run-code.mjs: data e ora valide, scope del registro) e cliente del codice = cliente della sessione.
// runRefusal è in scripts/lib/run-code.mjs (lo usano anche kb compensation, kb snapshot e le corsie di run).
export { RUN_RE, runRefusal };
// impronta di un checkpoint (JSON canonico, firma compresa): la registra session.active_plan.checkpoint_sha256
export const checkpointSha = (cp) => createHash("sha256").update(canonical(cp)).digest("hex");
const stepsOf = (plan) => (Array.isArray(plan?.steps) ? [...plan.steps].sort((a, b) => a.n - b.n) : []);

// Ops veloce (spec 2026-10-06 §3.5): serve APPROVO PIANO all'attivazione? Produzione sempre; basso come prima (fuori
// sandbox sì); medio fuori sandbox sì; alto solo se un passo chiede A1/A2/A3 (il "sì" di un passo R2 resta per passo).
export function planNeedsApproval(plan, env, autonomy) {
  const sandbox = ["sandbox", "dev"].includes(env.type);
  if (env.type === "prod") return true;
  if (autonomy === "basso") return !sandbox;
  if (!sandbox && autonomy !== "alto") return true;
  return stepsOf(plan).some((s) => {
    const r = requiredApprovals(s.action_class, s, env, s.action_class === "ACT-CFG-CHANGE" ? stepLevel(s) : null, autonomy);
    return r.a1 || r.a2 || r.a3;
  });
}

// Frasi che l'utente deve scrivere (§57.2) per le richieste aperte.
function phrase(r, planId, second) {
  const who = second ? " DA <Nome Cognome>" : "";
  if (r.kind === "A1") return `APPROVO PIANO ${planId}${who}`;
  if (r.kind === "A2") return `APPROVO PROVA ${planId}${who}`;
  if (r.kind === "A3") return `APPROVO PASSO ${r.step} ${planId}`;
  return "sì";
}

// Il passo n può partire? Compensazione dichiarata, approvazioni richieste e già date.
// custDir: cartella assoluta del cliente (customers/<C>), da cui si risolve il ref della lettura salvata di un passo DELETE;
// assente, si risale di due livelli dal file del piano (customers/<C>/runs/<RUN>/plan.json).
export function gateStep({ plan, step, env, records, now, planFile, autonomy = "basso", custDir: custDirOpt = null }) {
  const out = { step: step.n, status: "ok", compensation: null, pending: [], ask: null, reason: null };
  const cls = step.action_class;
  const at = `passo ${step.n} (${step.verb}, ${cls ?? "senza classe"})`;
  if (!ACT[cls]) return { ...out, status: "denied", reason: `${at}: classe di azione fuori catalogo` };
  if (COMP_CLASSES.has(cls) && COMMIT_VERBS.has(step.verb)) {
    const c = (Array.isArray(plan.compensations) ? plan.compensations : []).find((x) => x && x.step === step.n);
    if (!c) return { ...out, status: "denied", reason: `${at}: nessuna compensazione dichiarata nel piano (close · cancel · deactivate · restore): va registrata prima del passo che crea, modifica o invia (§29.6)` };
    out.compensation = { plan: plan.plan_id, step: step.n, kind: c.kind, ...(c.entity ? { entity: c.entity } : {}), ...(c.action ? { action: c.action } : {}), ...(c.ref ? { ref: c.ref } : {}), status: "pending" };
  }
  // spec 2026-10-06 §3.7: prima di cancellare serve la lettura completa dell'oggetto, salvata nel run (restore con ref
  // a runs/<RUN>/evidence/…, file presente sotto customers/<C>/runs/): è la copia da cui si ricostruisce ciò che si cancella
  if (cls === "ACT-DELETE") {
    const c = (Array.isArray(plan.compensations) ? plan.compensations : []).find((x) => x && x.step === step.n);
    const ref = c?.kind === "restore" && typeof c.ref === "string" ? c.ref : null;
    const custDir = custDirOpt ?? (planFile ? resolvePath(dirname(planFile), "..", "..") : null);
    const abs = ref && custDir ? resolvePath(custDir, ref) : null;
    // il ref è DENTRO evidence/ del run anche dopo la normalizzazione (niente `..`), e punta a un file non vuoto
    const evDir = ref ? join(custDir ?? "", "runs", ref.split("/")[1] ?? "", "evidence") : null;
    const ok = !!abs && /^runs\/RUN\.[A-Z0-9]{4}\.\d{8}\.\d{4}\.[A-Z0-9]{3}\/evidence\/[^\\]+$/.test(ref) && abs.startsWith(`${evDir}${sep}`) && fileNotEmpty(abs);
    if (!ok) return { ...out, status: "denied", reason: `${at}: prima di cancellare serve la lettura completa dell'oggetto in runs/<RUN>/evidence/ (compensazione restore con ref)` };
  }
  const level = cls === "ACT-CFG-CHANGE" ? stepLevel(step) : null;
  const req = requiredApprovals(cls, step, env, level, autonomy);
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

const dedupePending = (cur, add) => {
  const out = [...cur];
  for (const p of add) if (!out.some((x) => x.kind === p.kind && x.plan === p.plan && (x.step ?? null) === (p.step ?? null))) out.push(p);
  return out;
};

// WP07 giro 2 (N-3): i checkpoint sono firmati (HMAC-SHA256 con la chiave del workspace .jvc/checkpoint.key, che solo
// gli script del plugin scrivono: .jvc/** e runs/*/checkpoints/** sono protetti in scrittura da guard-config-scope).
// Scelta: HMAC invece di una catena di sha, perché una catena la ricalcola chiunque possa scrivere i file; la firma
// no, e lega il checkpoint al piano (plan_sha256) e al passo. Firma assente o sbagliata ⇒ il checkpoint non conta.
export function checkpointKey(ws) {
  const f = join(ws, ".jvc", "checkpoint.key");
  try { const k = readFileSync(f, "utf8").trim(); if (/^[0-9a-f]{64}$/.test(k)) return k; } catch { /* assente: si crea */ }
  mkdirSync(join(ws, ".jvc"), { recursive: true });
  const k = randomBytes(32).toString("hex");
  writeFileAtomic(f, `${k}\n`);
  return k;
}
const cpMac = (key, cp) => { const { hmac, ...rest } = cp; return createHmac("sha256", key).update(canonical(rest)).digest("hex"); };
export const signCheckpoint = (key, cp) => ({ ...cp, hmac: cpMac(key, cp) });
export function verifyCheckpoint(key, cp) {
  if (!cp || typeof cp.hmac !== "string" || !/^[0-9a-f]{64}$/.test(cp.hmac)) return false;
  const a = Buffer.from(cp.hmac, "hex"); const b = Buffer.from(cpMac(key, cp), "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

// WP07 giro 3 (I-B): l'AUTORITÀ sull'ultimo passo verificato è session.active_plan (stato protetto: last_verified_step
// + checkpoint_sha256); il file del checkpoint è un dato di supporto e deve corrispondere (impronta, firma, piano, passo).
// Senza riferimento nella sessione nessun passo è verificato: la ripresa non si fida mai di un file non referenziato.
function lastVerified(ap, cpDir, key, planSha) {
  if (!ap || !Number.isInteger(ap.last_verified_step)) return { last: null };
  const n = ap.last_verified_step;
  let cp = null;
  try { cp = JSON.parse(readFileSync(join(cpDir, `${n}.json`), "utf8")); } catch { /* assente o illeggibile */ }
  const ok = !!cp && checkpointSha(cp) === ap.checkpoint_sha256 && verifyCheckpoint(key, cp) && cp.step === n && cp.plan_sha256 === planSha && cp.proceed === true;
  return ok ? { last: n } : { last: null, broken: n };
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
  const active0 = session.active_plan ?? null;
  // WP07 giro 1 (C2 b): il piano attivo è legato alla sua impronta; un file cambiato dopo l'attivazione non vale
  if (active0 && active0.plan_id === plan.plan_id && active0.plan_sha256 !== info.sha256) return deny(`il piano ${plan.plan_id} è stato modificato dopo l'attivazione (impronta diversa): chiudilo con --close e riattivalo${["sandbox", "dev"].includes(session.env.type) ? "" : " con una nuova APPROVO PIANO"}`);
  const v = validatePlan(plan, { env: { id: session.env.id, type: session.env.type } });
  if (!v.ok) return deny(`piano non valido per l'ambiente ${session.env.id} (${session.env.type}): ${v.errors.join("; ")}`);
  const steps = stepsOf(plan);
  const active = session.active_plan ?? null;
  if (active && active.plan_id !== plan.plan_id) return deny(`un altro piano è attivo: ${active.plan_id} (passo ${active.step}); chiudilo con --close prima di attivarne uno nuovo`);
  if (active && opts.run != null && active.run != null && opts.run !== active.run) return deny(`il piano ${plan.plan_id} è attivo nel run ${active.run}, non in ${opts.run}`);
  const run = opts.run ?? (active?.run ?? null) ?? runFromPath(planFile) ?? runFromPath(plan.checkpoint_dir) ?? formatRunCode({ customer, scope: session.scope ?? "XSC", date: now });
  const badRun = runRefusal(ws, customer, run);
  if (badRun) return deny(badRun);
  const runDir = join(ws, "customers", customer, "runs", run);
  const cpDir = join(runDir, "checkpoints");
  const reg = readApprovals(approvalsFile(ws, customer, sid));
  if (!reg.ok) return deny(`registro delle approvazioni corrotto (${reg.reason})`);
  // Ops veloce (spec 2026-10-06 §3.1): il livello di autonomia (frase > cliente > alto, tetto per ambiente) decide le approvazioni dei passi
  const aut = autonomyLevel({ ws, customer, records: reg.records, envType: session.env.type });
  const observation = session.ledger?.observe?.last_obs ?? null;
  const profile = profileFor({ envType: session.env.type });
  const noEffect = { divergences: [], novelties: [], checkpoint: null, observation };

  // WP07 giro 1 (C2 a): fuori sandbox un piano si attiva solo dopo APPROVO PIANO <id> dell'utente (A1 registrato da
  // approval-capture, con l'impronta di QUESTO file). Senza: richiesta aperta in pending.approvals, active_plan intatto.
  const second = session.env.policy?.second_approver_required ?? session.env.type === "prod";
  const planApproved = () => {
    const a1 = reg.records.filter((r) => r.kind === "A1" && r.plan === plan.plan_id).at(-1);
    return !!a1 && a1.plan_sha256 === info.sha256;
  };
  const planApproval = () => {
    if (active || !planNeedsApproval(plan, session.env, aut.level) || planApproved()) return null;
    const req = { kind: "A1", plan: plan.plan_id, file: planFile };
    updateSessionFile(sFile, (x) => { x.pending.approvals = dedupePending(Array.isArray(x.pending.approvals) ? x.pending.approvals : [], [req]); });
    audit(ws, sid, customer, session.scope, { action: "activate", plan: plan.plan_id, status: "approval_required", reason: "plan-approval" });
    return { status: "approval_required", proceed: false, ...noEffect, pending: [req],
      reason: `attivare un piano in ${session.env.type} richiede l'approvazione dell'utente sul piano (§52, §57.2)`, ask: phrase({ kind: "A1" }, plan.plan_id, second) };
  };

  // attiva il passo s: scrive active_plan (con l'impronta), compensazione, richieste di approvazione.
  // Un gate negato non scrive nulla (WP07 giro 1, spec I1): il piano resta dov'era.
  // revisione finale (minore B#7): markDenied — il gate del passo SUCCESSIVO a uno appena verificato è negato: il piano
  // resta sul passo verificato ma marcato gate_denied, così i guard non concedono più azioni legate a quel passo.
  const activate = (s, extraMutate, { markDenied = false } = {}) => {
    const g = gateStep({ plan, step: s, env: session.env, records: reg.records, now, planFile, autonomy: aut.level, custDir: join(ws, "customers", customer) });
    if (g.status === "denied") {
      if (extraMutate || markDenied) updateSessionFile(sFile, (x) => {
        extraMutate?.(x);
        if (markDenied && x.active_plan && x.active_plan.plan_id === plan.plan_id) x.active_plan.gate_denied = { step: s.n, reason: g.reason, at: now.toISOString() };
      });
      return g;
    }
    if (g.compensation) g.compensation.registered_at = now.toISOString();
    if (g.compensation) writeCompensations(runDir, [g.compensation]);   // prima su disco nel run (§47.2 #1)
    updateSessionFile(sFile, (x) => {
      // l'ultimo passo verificato resta con il piano (stesso piano, stessa impronta, stesso run)
      const pa = x.active_plan;
      const keep = pa && pa.plan_id === plan.plan_id && pa.plan_sha256 === info.sha256 && pa.run === run && Number.isInteger(pa.last_verified_step)
        ? { last_verified_step: pa.last_verified_step, checkpoint_sha256: pa.checkpoint_sha256 } : {};
      x.active_plan = { plan_id: plan.plan_id, file: planFile, step: s.n, run, plan_sha256: info.sha256, ...keep };
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
  const skippable = (a, b) => steps.filter((s) => s.n >= a && s.n < b).every((s) => (plan.repair_policy?.skip_allowed ?? []).includes(s.n));
  const cmpOpts = { resolve: (code) => resolveSel(ws, code, customer), atlas: atlasIndex(ws, customer, session.scope), why, elapsedMs, result, profile };

  // ---- ripresa (§47.2): nessun salto di passi non verificati; il passo con effetto chiede prima la lettura ----
  if (resume != null) {
    const target = steps.find((s) => s.n === Number(resume));
    if (!target) throw new StepCheckError(1, `il piano ${plan.plan_id} non ha il passo ${resume}`);
    const lv = lastVerified(active && active.plan_id === plan.plan_id ? active : null, cpDir, checkpointKey(ws), info.sha256);
    if (lv.broken != null) return deny(`ripresa negata: il checkpoint del passo ${lv.broken} registrato nella sessione manca o non corrisponde (impronta, firma o contenuto diversi)`);
    const last = lv.last;
    const lastN = last ?? 0;
    if (!(target.n <= lastN + 1 || skippable(lastN + 1, target.n))) return deny(`ripresa al passo ${target.n} negata: l'ultimo passo verificato è ${last ?? "nessuno"} e i passi intermedi non sono in repair_policy.skip_allowed`);
    const pa = planApproval();
    if (pa) return pa;
    const reads = EFFECT_VERBS.has(target.verb) ? [{ step: target.n, verb: "READ", target: target.wait_for ?? target.target, expect: target.expect, why: `verifica se il passo ${target.n} (${target.verb}) risulta già eseguito: se sì, si salta (idempotenza, §47.2 #2)` }] : [];
    const clearReads = (x) => { x.pending.reads = (Array.isArray(x.pending.reads) ? x.pending.reads : []).filter((r) => r.plan !== plan.plan_id); };
    if (reads.length && snapshot == null) {
      updateSessionFile(sFile, (x) => { clearReads(x); x.pending.reads.push({ plan: plan.plan_id, step: target.n, file: planFile, run, since: now.toISOString() }); });
      audit(ws, sid, customer, session.scope, { action: "resume", plan: plan.plan_id, step: target.n, last_checkpoint: last, awaiting_read: true });
      return { status: "ok", activated: false, resume_from: target.n, last_checkpoint: last, reads, proceed: false, ...noEffect,
        ask: `esegui la lettura (snapshot) e richiama step-check --resume ${target.n} --snapshot <file>: il passo con effetto non si riattiva senza verifica` };
    }
    if (reads.length) {
      const page = typeof snapshot === "string" ? parseSnapshot(snapshot) : snapshot;
      const cmp = compareExpect(target, page, { ...cmpOpts, atlas: null });
      if (!cmp.divergences.length) {
        // già eseguito: checkpoint del passo, poi il successivo (o piano completato)
        mkdirSync(cpDir, { recursive: true });
        const cpDone = signCheckpoint(checkpointKey(ws), { plan_id: plan.plan_id, plan_sha256: info.sha256, run, step: target.n, status: "ok", proceed: true, resumed: "already_done", page_signature: cmp.page_signature, observation, ts: now.toISOString() });
        writeFileAtomic(join(cpDir, `${target.n}.json`), `${JSON.stringify(cpDone, null, 2)}\n`);
        const verified = { last_verified_step: target.n, checkpoint_sha256: checkpointSha(cpDone) };
        const nxt = steps[steps.indexOf(target) + 1] ?? null;
        let g = null;
        if (nxt) g = activate(nxt, (x) => { clearReads(x); if (x.active_plan && x.active_plan.plan_id === plan.plan_id) Object.assign(x.active_plan, verified); });
        else updateSessionFile(sFile, (x) => { clearReads(x); x.active_plan = null; });
        audit(ws, sid, customer, session.scope, { action: "resume", plan: plan.plan_id, step: target.n, already_done: true });
        return { status: "ok", already_done: true, resume_from: target.n, last_checkpoint: last, reads, proceed: true, ...noEffect,
          ...(g ? { next: { step: nxt.n, status: g.status, ...(g.reason ? { reason: g.reason } : {}), ...(g.ask ? { ask: g.ask } : {}) } } : { plan_status: "completed" }) };
      }
    }
    const g = activate(target, (x) => { x.pending.reads = (Array.isArray(x.pending.reads) ? x.pending.reads : []).filter((r) => r.plan !== plan.plan_id); });
    audit(ws, sid, customer, session.scope, { action: "resume", plan: plan.plan_id, step: target.n, last_checkpoint: last, status: g.status });
    return { status: g.status, activated: g.status !== "denied", resume_from: target.n, last_checkpoint: last, reads, gate: g, ask: g.ask, reason: g.reason, proceed: g.status === "ok",
      ...noEffect, active_plan: g.status === "denied" ? active : { plan_id: plan.plan_id, file: planFile, step: target.n, run, plan_sha256: info.sha256 } };
  }

  const cur = steps.find((s) => s.n === Number(n));
  if (!cur) throw new StepCheckError(1, `il piano ${plan.plan_id} non ha il passo ${n}`);

  // ---- attivazione ----
  if (snapshot == null) {
    const expected = active ? active.step : steps[0].n;
    if (cur.n !== expected && !(cur.n > expected && skippable(expected, cur.n))) return deny(`passo fuori sequenza: il piano ${plan.plan_id} è al passo ${expected} (saltabili solo i passi in repair_policy.skip_allowed)`);
    const pa = planApproval();
    if (pa) return pa;
    const g = activate(cur);
    audit(ws, sid, customer, session.scope, { action: "activate", plan: plan.plan_id, step: cur.n, status: g.status });
    return { status: g.status, reason: g.reason, ask: g.ask, compensation: g.compensation, pending: g.pending, proceed: g.status === "ok",
      ...noEffect, active_plan: g.status === "denied" ? active : { plan_id: plan.plan_id, file: planFile, step: cur.n, run, plan_sha256: info.sha256 } };
  }

  // ---- verifica ----
  if (!active) return deny(`piano ${plan.plan_id} non attivo: attivalo con --step ${steps[0].n} senza snapshot`);
  if (active.step !== cur.n) return deny(`passo fuori sequenza: il piano ${plan.plan_id} è al passo ${active.step}, non al ${cur.n}`);
  const page = typeof snapshot === "string" ? parseSnapshot(snapshot) : snapshot;
  const cmp = compareExpect(cur, page, cmpOpts);
  const risk = stepRisk(cur);
  const res = { status: "ok", kind: null, compat: null, proceed: true, divergences: cmp.divergences, novelties: cmp.novelties,
    confirmations: cmp.confirmations, page_signature: cmp.page_signature, observation, risk, ...(cmp.unverified.length ? { unverified: cmp.unverified } : {}) };
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

  // checkpoint atomico (§29.6); i valori delle divergenze redatti come l'OBS (spec I3)
  const red = (v) => (typeof v === "string" ? redact(v, { profile }) : Array.isArray(v) ? v.map(red) : v);
  mkdirSync(cpDir, { recursive: true });
  const cpFile = join(cpDir, `${cur.n}.json`);
  const cpObj = signCheckpoint(checkpointKey(ws), { plan_id: plan.plan_id, plan_sha256: info.sha256, run, step: cur.n, status: res.status, kind: res.kind, compat: res.compat,
    proceed: res.proceed, stop: !!res.stop, divergences: res.divergences.map((d) => ({ ...d, expected: red(d.expected), observed: red(d.observed), ...(d.target ? { target: red(d.target) } : {}) })),
    novelties: res.novelties.map((x) => ({ ...x, label: red(x.label) })), confirmations: res.confirmations,
    page_signature: res.page_signature, observation, ts: now.toISOString() });
  writeFileAtomic(cpFile, `${JSON.stringify(cpObj, null, 2)}\n`);
  const verified = res.proceed ? { last_verified_step: cur.n, checkpoint_sha256: checkpointSha(cpObj) } : null;
  res.checkpoint = `runs/${run}/checkpoints/${cur.n}.json`;

  const idx = steps.indexOf(cur);
  const nextStep = res.proceed ? steps[idx + 1] ?? null : null;
  const mutate = (x) => {
    if (surpriseRec) x.surprises = [...(Array.isArray(x.surprises) ? x.surprises : []), surpriseRec];
    if (verified && x.active_plan && x.active_plan.plan_id === plan.plan_id) Object.assign(x.active_plan, verified);
  };
  if (nextStep) {
    const g = activate(nextStep, mutate, { markDenied: true });
    res.next = { step: nextStep.n, status: g.status, ...(g.reason ? { reason: g.reason } : {}), ...(g.ask ? { ask: g.ask } : {}), ...(g.compensation ? { compensation: g.compensation } : {}) };
  } else if ((res.proceed && idx === steps.length - 1) || finish) {
    updateSessionFile(sFile, (x) => { mutate(x); x.active_plan = null; });
    res.plan_status = finish ? "stopped" : "completed";
    // runs/<RUN>/result.yaml (K6.8): verde = piano completato senza sorprese; lo conta compile-plan (≥ 3 verdi)
    const cps = readdirSync(cpDir).filter((f) => /^\d+\.json$/.test(f)).map((f) => { try { return JSON.parse(readFileSync(join(cpDir, f), "utf8")); } catch { return null; } }).filter((c) => c?.plan_id === plan.plan_id && verifyCheckpoint(checkpointKey(ws), c));
    const status = finish ? "stopped" : cps.every((c) => c.status === "ok" || c.status === "novelty") ? "green" : "yellow";
    const { planHash } = await import("../chrome/compile-plan.mjs");
    const resultDoc = YAML.stringify({ plan_id: plan.plan_id, plan_hash: planHash(plan), fingerprint: plan.fingerprint ?? planHash(plan), plan_file: planFile, run, status, steps: steps.length, completed_at: now.toISOString() });
    writeFileAtomic(join(runDir, "result.yaml"), resultDoc);
    // WP09b: un run di select-suite esegue più casi: l'esito resta anche per piano (runs/<RUN>/results/<plan_id>.yaml),
    // che compile-plan (≥ 3 verdi) e la promozione (3 run coerenti) contano senza che il caso successivo lo sovrascriva
    mkdirSync(join(runDir, "results"), { recursive: true });
    writeFileAtomic(join(runDir, "results", `${plan.plan_id}.yaml`), resultDoc);
    res.result = `runs/${run}/result.yaml`;
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
  { const bad = confineInputs(opts, ["snapshot","why"], { env }); if (bad) return fail(asJson, 1, bad); }
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

