// RPT (K6.6, §29.8, §29.6): report di azione o di test dalla sessione, dal workflow e dal run, con l'esito
// classificato (scripts/report/outcome.mjs, §29.9). Codice RPT.<CLIENTE>.<AAAAMMGG>.<SEQ> assegnato dal DB
// (tabella reports, transazione), file customers/<C>/reports/<codice>.md + .yaml (validato con
// schemas/rpt.schema.json); gli eventi outcome e report si aggiungono al workflow della sessione.
import { readFileSync, mkdirSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { createHash } from "node:crypto";
import YAML from "yaml";
import { parseArgs, fail } from "../lib/args.mjs";
import { isMain } from "../lib/is-main.mjs";
import { validateWith } from "../lib/schemas.mjs";
import { writeFileAtomic } from "../../hooks/lib/fsx.mjs";
import { appendAudit } from "../../hooks/lib/audit.mjs";
import { loadSession, resolveSessionId } from "../admin/session.mjs";
import { loadPlanFile, approvalsFile, readApprovals } from "../admin/approvals.mjs";
import { readEvents, reduce, workflowFile, appendEvent } from "../admin/workflow.mjs";
import { classifyOutcome, matchesExpected } from "./outcome.mjs";
import { openDb } from "../kb/db.mjs";

export class ReportError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const TEMPLATES = new URL("../../templates/", import.meta.url);
const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, "");
const thousands = (n) => String(Math.round(n ?? 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
const hhmm = (ts) => (typeof ts === "string" ? ts.slice(11, 16) : "--:--");

function fill(tpl, values) {
  const body = tpl.replace(/^<!--[\s\S]*?-->\s*/, "");
  return body.replace(/\{\{(\w+)\}\}/g, (_, k) => (values[k] == null || values[k] === "" ? "—" : String(values[k])));
}

function sessionErrors(db, code) {
  try {
    return db.prepare("select code, category, message, sessions from errors_raw").all()
      .filter((r) => { try { return JSON.parse(r.sessions).includes(code); } catch { return false; } })
      .map((r) => ({ code: r.code ?? null, category: r.category, message: r.message }));
  } catch { return []; }
}

export async function buildReport(opts) {
  const { ws, sid, kind, planFile = null, title, intent = null, run = null, release = null, expected = {}, observed = {}, understoodError = false,
    assumption = null, userAbort = false, policyAbort = false, lesson = null, next = [], estimated = null, now = new Date() } = opts;
  if (!["action", "test"].includes(kind)) throw new ReportError(1, `kind non valido: ${kind} (action | test)`);
  if (!title) throw new ReportError(1, "titolo mancante");
  const { session, pointer } = loadSession(ws, sid);
  if (!session) throw new ReportError(1, "nessuna sessione con cliente attivo");
  const C = pointer.customer;
  const sesCode = session.session_code ?? session.session_id;
  const info = planFile ? await loadPlanFile(ws, C, planFile) : null;
  if (planFile && !info) throw new ReportError(1, `piano non trovato: ${planFile}`);
  const plan = info?.plan ?? null;
  const wfFile = workflowFile(ws, C, sid);
  const st = reduce(readEvents(wfFile));
  const steps = [...st.steps.values()].sort((a, b) => a.n - b.n);
  const completed = opts.completed ?? (steps.length > 0 && steps.every((s) => s.state === "✓"));
  const evidence = [...new Set(steps.flatMap((s) => (s.note.match(/\bEV-\d+\b/g) ?? [])))];
  mkdirSync(join(ws, "customers", C), { recursive: true });
  const db = openDb(join(ws, "customers", C, "knowledge.db"));
  try {
    const errors = opts.errors ?? sessionErrors(db, sesCode);
    const cls = classifyOutcome({ expected, observed, errors, policyAbort, userAbort, completed, understoodError, assumption });
    const reg = readApprovals(approvalsFile(ws, C, sid));
    const approvals = (reg.records ?? []).filter((r) => r.kind !== "consume" && (!plan || r.plan === plan.plan_id)).map((r) => ({ kind: r.kind, ts: r.ts, ...(r.step ? { step: r.step } : {}), ...(r.approver_declared ? { approver: r.approver_declared } : {}) }));
    const comps = (session.pending?.compensations ?? []).filter((c) => c && typeof c === "object" && (!plan || c.plan === plan.plan_id));
    const entities = comps.map((c) => {
      const note = st.steps.get(c.step)?.note ?? "";
      return { ref: c.ref ?? /\bNRT-[A-Z0-9-]+\b/.exec(note)?.[0] ?? `${c.entity ?? "entità"} (passo ${c.step})`, compensation: c.action ?? c.kind ?? null, status: c.status ?? "pending" };
    });
    const env = session.env ? { id: session.env.id, type: session.env.type, hosts: session.env.allowed_hosts ?? [], verified_at: session.env.verified_at ?? null } : { id: "—", type: "sandbox" };
    const execution = steps.map((s) => ({ n: s.n, status: s.state === "✓" ? "ok" : s.state === "✗" ? "stopped" : s.state === "⏸" ? "waiting" : s.state === "▶" ? "running" : "planned",
      text: [s.desc, s.note].filter(Boolean).join(" — "), evidence: s.note.match(/\bEV-\d+\b/g) ?? [], ...(s.extra.length ? { notes: s.extra } : {}) }));
    const errList = errors.map((e) => ({ code: e.code ?? null, category: e.category, message: e.message ?? "", expected: matchesExpected(e, expected?.error) }));
    const prefix = `RPT.${C}.${ymd(now)}.`;
    const doc = {
      id: null, kind, title, customer: C, scope: session.scope ?? null, session: sesCode, requested_by: "utente", created_at: now.toISOString(), env,
      outcome: { status: cls.outcome, reason: cls.reason, completion: cls.completion, learning_event: cls.learning_event, expected, defect: cls.defect },
      budget: { used: session.budget?.used ?? 0, estimated, total: session.budget?.tokens, by_model: session.budget?.by_model ?? {} },
      evidence, lesson: cls.lesson ? lesson : null, surprises: st.surprises, novelties: 0, errors: errList,
    };
    // K6.7, spreco a livello di report (§29.10): file dell'Atlas aperti quando il summary bastava.
    if (opts.result) {
      const { filesOpenedUnused } = await import("../decide/budget.mjs");
      const { auditFile } = await import("../../hooks/lib/audit.mjs");
      let events = [];
      try { events = readFileSync(auditFile(ws, C, now), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.session === sid); } catch { events = []; }
      doc.waste = { files_opened_unused: filesOpenedUnused(events, opts.result) };
    }
    if (kind === "action") Object.assign(doc, {
      intent, plan: plan ? { plan_id: plan.plan_id, actions: [...new Set((plan.steps ?? []).map((s) => s.action_class).filter(Boolean))], strategy: plan.strategy ?? null } : null,
      approvals, execution, entities, next,
    });
    else Object.assign(doc, {
      run: run ?? session.active_plan?.run ?? null, release,
      results: { pass: cls.completion ? 1 : 0, fail: cls.outcome === "ERROR-BLOCKING" ? 1 : 0, flaky: 0, inconclusive: cls.completion || cls.outcome === "ERROR-BLOCKING" ? 0 : 1,
        expected_errors_received: errList.filter((e) => e.expected).length, expected_errors_declared: expected?.error ? 1 : 0 },
      failures: cls.completion ? [] : [{ case: plan?.plan_id ?? title, step: steps.find((s) => s.state === "✗")?.n ?? null, class: cls.outcome, defect: cls.defect }],
      coverage: null, xray: { status: cls.xray, defect: cls.defect },
      verdict: { scope: session.scope ?? "—", value: cls.completion ? "GO" : cls.outcome === "ERROR-ENVIRONMENT" ? "GO CON RISERVE" : "NO-GO" },
    });
    const code = db.transaction(() => {
      const row = db.prepare("select max(cast(substr(code, length(?)+1) as integer)) as m from reports where code like ? || '%'").get(prefix, prefix);
      const c = `${prefix}${String((row?.m ?? 0) + 1).padStart(4, "0")}`;
      doc.id = c;
      const v = validateWith("rpt.schema.json", doc);
      if (!v.ok) throw new ReportError(2, `RPT non conforme allo schema: ${v.errors.slice(0, 3).join("; ")}`);
      const dir = join(ws, "customers", C, "reports");
      mkdirSync(dir, { recursive: true });
      const yaml = YAML.stringify(doc);
      const values = {
        id: c, title, run: doc.run, release: release ?? "—",
        env_line: `${env.type} ${C} (${env.id}${env.hosts?.length ? `, host ${env.hosts[0]}` : ""}${env.verified_at ? `, impronta verificata alle ${hhmm(env.verified_at)}` : ""}) · sessione ${sesCode} · richiesto da: utente`,
        intent: intent ? `"${intent}"` : null,
        plan_line: plan ? `${(plan.steps ?? []).length} passi: ${[...new Set((plan.steps ?? []).map((s) => s.action_class).filter(Boolean))].join(" · ")}${plan.strategy ? ` — strategia ${[].concat(plan.strategy).join(" → ")}` : ""}` : null,
        approvals_line: approvals.length ? approvals.map((a) => `${a.kind}${a.step ? ` passo ${a.step}` : ""} ${hhmm(a.ts)}${a.approver ? ` (${a.approver})` : ""}`).join(" · ") : "nessuna",
        execution_lines: execution.map((e) => `  ${e.n} ${e.text}${e.status === "ok" ? "" : ` [${e.status}]`}`).join("\n") || "  —",
        surprises: st.surprises, novelties: 0,
        errors_line: errList.length ? `${errList.length} (${errList.map((e) => `${e.code ?? e.category}${e.expected ? " atteso" : ""}`).join(", ")})` : "0",
        outcome: cls.outcome, outcome_reason: cls.reason,
        entities_line: entities.length ? entities.map((e) => `${e.ref} · compensazione ${e.status === "pending" ? "pendente" : e.status}: ${e.compensation}`).join("; ") : "nessuna",
        budget_line: `${thousands(doc.budget.used)} token${estimated ? ` (stimati ${thousands(estimated)})` : ""} · sessione ${thousands(doc.budget.total)}`,
        lesson: doc.lesson ?? (cls.lesson ? "da scrivere al termine del compito (self-check #9)" : "nessuna: la policy ha funzionato"),
        next_line: next.length ? next.join(" · ") : null,
        evidence_line: `${evidence.length}${evidence.length ? ` (${evidence.join(", ")})` : ""}`,
        verdict_line: doc.verdict ? `scope ${doc.verdict.scope}: ${doc.verdict.value}` : null,
        results_line: doc.results ? `pass ${doc.results.pass} · fail ${doc.results.fail} · flaky ${doc.results.flaky} · inconcludenti ${doc.results.inconclusive} · errori attesi ricevuti come da atteso: ${doc.results.expected_errors_received}/${doc.results.expected_errors_declared}` : null,
        failures_lines: doc.failures?.length ? doc.failures.map((f) => `  ${f.case}  passo ${f.step ?? "—"}  ${f.class}${f.defect ? " → Defect proposto" : ""}`).join("\n") : "  nessuno",
        xray: doc.xray?.status, coverage_line: null,
      };
      const md = fill(readFileSync(new URL(kind === "action" ? "report-action.md" : "report-test.md", TEMPLATES), "utf8"), values);
      writeFileAtomic(join(dir, `${c}.yaml`), yaml);
      writeFileAtomic(join(dir, `${c}.md`), md);
      db.prepare(`insert into reports(code,kind,customer,session,scope,plan,run,outcome,xray,completion,learning_event,path,hash,created_at) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(c, kind, C, sesCode, session.scope ?? null, plan?.plan_id ?? null, doc.run ?? null, cls.outcome, cls.xray, cls.completion ? 1 : 0, cls.learning_event ? 1 : 0,
          `customers/${C}/reports/${c}.yaml`, createHash("sha256").update(yaml).digest("hex"), doc.created_at);
      return c;
    }).immediate();
    try { appendEvent(wfFile, "outcome", { status: cls.outcome }, { now }); appendEvent(wfFile, "report", { code }, { now }); } catch { /* il workflow è informativo */ }
    try { appendAudit(ws, { session: sid, customer: C, scope: session.scope ?? null, kind: "run", actor: "build-report", payload: { report: code, outcome: cls.outcome, kind } }); } catch { /* l'audit non cambia il report */ }
    return { code, outcome: cls.outcome, xray: cls.xray, files: [`customers/${C}/reports/${code}.md`, `customers/${C}/reports/${code}.yaml`], report: doc };
  } finally { db.close(); }
}

const HELP = `uso: node scripts/report/build-report.mjs --kind action|test --title <titolo> [--plan <file>] [--intent <testo>]
       [--run <RUN>] [--release <R>] [--expected <json>] [--observed <json>] [--errors <json>] [--understood] [--assumption <testo>]
       [--user-abort] [--policy-abort] [--lesson <LSN>] [--next <testo>] [--estimated <token>] [--session <id>] [--workspace <dir>] [--json]

Compila il report (RPT) dalla sessione, dal workflow e dal run; esito da scripts/report/outcome.mjs (§29.9).
Exit: 0 report scritto · 1 argomenti · 2 errore di sistema.`;

export async function run(argv, env = process.env) {
  const { opts } = parseArgs(argv, { flags: ["understood", "user-abort", "policy-abort"] });
  const asJson = !!opts.json;
  if (opts.help) { console.log(HELP); return 0; }
  const ws = resolvePath(opts.workspace || env.JVC_WORKSPACE || env.CLAUDE_PROJECT_DIR || process.cwd());
  const j = (v, d) => { if (v == null) return d; try { return JSON.parse(v); } catch { throw new ReportError(1, `JSON non valido: ${v}`); } };
  try {
    if (!["action", "test"].includes(opts.kind)) return fail(asJson, 1, "richiesto --kind action|test");
    const sid = resolveSessionId({ workspace: ws, arg: opts.session, env });
    if (!sid) return fail(asJson, 1, "nessuna sessione risolvibile");
    const r = await buildReport({ ws, sid, kind: opts.kind, planFile: opts.plan ?? null, title: opts.title ?? "Report", intent: opts.intent ?? null, run: opts.run ?? null,
      release: opts.release ?? null, expected: j(opts.expected, {}), observed: j(opts.observed, {}), errors: j(opts.errors, null), understoodError: !!opts.understood,
      assumption: opts.assumption ?? null, userAbort: !!opts["user-abort"], policyAbort: !!opts["policy-abort"], lesson: opts.lesson ?? null,
      next: opts.next ? [opts.next] : [], estimated: opts.estimated ? Number(opts.estimated) : null });
    console.log(asJson ? JSON.stringify({ ok: true, code: r.code, outcome: r.outcome, xray: r.xray, files: r.files }) : `${r.code} · ${r.outcome}`);
    return 0;
  } catch (err) {
    if (err instanceof ReportError) return fail(asJson, err.code, err.message);
    return fail(asJson, 2, `errore di sistema: ${err?.message ?? err}`);
  }
}

if (isMain(import.meta.url)) run(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(e); process.exit(2); });
