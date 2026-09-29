// Workflow visibile (K6.5, §29.5, §51.3, §52.4, §57.3): il blocco a formato fisso che il manager riscrive a
// ogni evento. Rendering DETERMINISTICO dagli eventi di customers/<C>/.sessions/<id>/workflow.jsonl e dallo
// stato di sessione (banner di ambiente, budget): stessi eventi ⇒ stesso testo, byte per byte.
//
// Eventi: task_start { steps: [{ n, agent, class, desc }] } · step_start { n } · step_end { n, status:
// ok|failed|stopped, note?, evidence?, compensation?, reason?, resume?, errors? } · surprise { n, kind } ·
// question { n?, text } · approval { n, state: pending|granted|denied, text? } · outcome { status } ·
// report { code }.
// Stati per riga: ▶ in corso · ✓ fatto · ⏸ attende · ✗ fermato · · pianificato. Una riga ⏸ è sempre seguita
// dalla domanda (sotto il blocco); una riga ✗ dal motivo e da cosa serve per riprendere.
//
// CLI: workflow event --kind <k> --payload <json> · workflow render [--session <id>] · workflow watch <SES>
// (sola lettura, anche da un'altra sessione: per /vc watch).
import { readFileSync, readdirSync, appendFileSync, mkdirSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { parseArgs, fail } from "../lib/args.mjs";
import { isMain } from "../lib/is-main.mjs";
import { withFileLock } from "../../hooks/lib/fsx.mjs";
import { sessionDir } from "../../hooks/lib/workspace.mjs";

export const EVENT_KINDS = ["task_start", "step_start", "step_end", "surprise", "question", "approval", "outcome", "report"];
const MODE_LABEL = { ops: "operativa", config: "configurazione", nrt: "nrt", diag: "diagnosi", esplorazione: "esplorazione" };
const W = { agent: 12, cls: 14, desc: 44 };
const pad = (s, n) => { const t = String(s ?? ""); return t.length > n ? `${t.slice(0, n - 1)}…` : t.padEnd(n); };
const k = (n) => (Number.isFinite(n) ? `${Math.round(n / 1000)}k` : "?");
const hhmm = (ts) => (typeof ts === "string" && ts.length >= 16 ? ts.slice(11, 16) : "--:--");

// Banner dell'ambiente (templates/workflow.md, §51.3).
export function banner(env) {
  if (!env) return "⚠ AMBIENTE NON DICHIARATO — nessuna azione sul browser: /use env <id>";
  if (!env.verified) return `${env.label ?? env.id} (${env.id}) — NON VERIFICATO: solo navigazione e lettura finché env-check non riconosce ≥ 2 segnali`;
  if (env.type === "prod") return "⚠ PRODUZIONE — sola lettura sui dati";
  if (env.type === "preprod") return "PRE-PROD";
  return "SANDBOX";
}
// Stato 3A in una riga (§52.4): { a1, a2, step, of, a3 } dal registro delle approvazioni.
export function threeALine(t) {
  if (!t) return "";
  const parts = [t.a1 ? `A1 ✓ ${hhmm(t.a1.ts)}` : "A1 ⏸"];
  parts.push(t.a2 ? `A2 ✓ ${hhmm(t.a2.ts)}${t.a2.approver_declared ? ` (${t.a2.approver_declared})` : ""}` : "A2 ⏸");
  if (t.step) parts.push(`A3 passo ${t.step}/${t.of ?? "?"} ${t.a3 ? "✓" : "⏸"}`);
  return ` · configurazione 3A: ${parts.join(" · ")}`;
}

// Stato del workflow dagli eventi (in ordine di seq).
export function reduce(events) {
  const st = { steps: new Map(), surprises: 0, errors: 0, evidence: 0, questions: [], outcome: null, report: null, task: null };
  const step = (n) => { if (!st.steps.has(n)) st.steps.set(n, { n, agent: "", cls: "", desc: "", state: "·", note: "", extra: [] }); return st.steps.get(n); };
  for (const e of [...events].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))) {
    const p = e.payload ?? {};
    if (e.kind === "task_start") {
      st.task = p.task ?? null;
      for (const s of p.steps ?? []) Object.assign(step(s.n), { agent: s.agent ?? "", cls: s.class ?? "", desc: s.desc ?? "" });
    } else if (e.kind === "step_start") step(p.n).state = "▶";
    else if (e.kind === "step_end") {
      const s = step(p.n);
      s.state = p.status === "ok" ? "✓" : "✗";
      s.note = [p.note, ...(p.evidence ?? [])].filter(Boolean).join(" · ");
      st.evidence += (p.evidence ?? []).length;
      st.errors += Number.isInteger(p.errors) ? p.errors : 0;
      s.extra = [];
      if (p.compensation) s.extra.push(`compensazione registrata: ${p.compensation}`);
      if (s.state === "✗") s.extra.push(`motivo: ${p.reason ?? "non indicato"}`, `per riprendere: ${p.resume ?? "da definire con l'utente"}`);
      st.questions = st.questions.filter((q) => q.n !== p.n);
    } else if (e.kind === "surprise") st.surprises++;
    else if (e.kind === "question" || (e.kind === "approval" && p.state === "pending")) {
      if (p.n != null) { const s = step(p.n); s.state = "⏸"; s.note = e.kind === "approval" ? `${s.cls === "ACT-CFG-CHANGE" ? "" : "R2 — "}attende la tua conferma`.trim() : "attende una risposta"; }
      if (p.text) st.questions.push({ n: p.n ?? null, text: p.text });
    } else if (e.kind === "approval") {
      const s = p.n != null ? step(p.n) : null;
      if (s && s.state === "⏸") { s.state = p.state === "granted" ? "▶" : "✗"; s.note = p.state === "granted" ? "approvato" : ""; if (p.state === "denied") s.extra = ["motivo: approvazione negata dall'utente", "per riprendere: nuovo piano o nuova richiesta di conferma"]; }
      st.questions = st.questions.filter((q) => q.n !== p.n);
    } else if (e.kind === "outcome") st.outcome = p.status ?? null;
    else if (e.kind === "report") st.report = p.code ?? null;
  }
  return st;
}

export function render(events, session, { threeA = null } = {}) {
  const st = reduce(events);
  const s = session ?? {};
  const b = s.budget ?? {};
  const head = `WORKFLOW  ${s.session_code ?? s.session_id ?? "—"} · ${s.customer ?? "—"} · ${banner(s.env)}${threeA ? threeALine(threeA) : ""} · ${s.scope ?? "—"} · ${MODE_LABEL[s.mode] ?? s.mode ?? "—"} · budget ${k(b.tokens)} (usati ${k(b.used)})`;
  const rows = [];
  for (const x of [...st.steps.values()].sort((a, c) => a.n - c.n)) {
    rows.push(`${x.state} ${String(x.n).padEnd(2)}${pad(x.agent, W.agent)} ${pad(x.cls, W.cls)} ${pad(x.desc, W.desc)} ${x.note}`.trimEnd());
    for (const e of x.extra) rows.push(`${" ".repeat(4 + W.agent + 1 + W.cls + 1)}${e}`);
  }
  rows.push(`sorprese: ${st.surprises} · errori: ${st.errors} · evidenze: ${st.evidence} · report: ${st.report ?? "al termine (RPT)"}${st.outcome ? ` · esito: ${st.outcome}` : ""}`);
  const width = Math.max(head.length + 2, ...rows.map((r) => r.length + 2));
  const out = [`┌ ${head} ${"─".repeat(Math.max(0, width - head.length - 2))}┐`];
  for (const r of rows) out.push(`│ ${r.padEnd(width - 1)}│`);
  out.push(`└${"─".repeat(width)}┘`);
  for (const q of st.questions) out.push(q.text);
  return `${out.join("\n")}\n`;
}

export const workflowFile = (ws, customer, sid) => join(sessionDir(ws, customer, sid), "workflow.jsonl");
export function readEvents(file) {
  try { return readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }); } catch { return []; }
}
export function appendEvent(file, kind, payload, { now = new Date() } = {}) {
  if (!EVENT_KINDS.includes(kind)) throw Object.assign(new Error(`kind non valido: ${kind} (${EVENT_KINDS.join(" · ")})`), { code: 1 });
  mkdirSync(join(file, ".."), { recursive: true });
  return withFileLock(`${file}.lock`, () => {
    const seq = readEvents(file).reduce((m, e) => Math.max(m, e.seq ?? 0), 0) + 1;
    const ev = { seq, ts: now.toISOString(), kind, payload };
    appendFileSync(file, `${JSON.stringify(ev)}\n`);
    return ev;
  });
}

// Stato 3A dell'intestazione in produzione: dal registro delle approvazioni (sola lettura).
async function threeAFor(ws, session) {
  if (session?.env?.type !== "prod" || !session.active_plan) return null;
  try {
    const { approvalsFile, readApprovals, windowState, loadPlanFile } = await import("./approvals.mjs");
    const info = await loadPlanFile(ws, session.customer, session.active_plan.file);
    if (!info || !(info.plan.steps ?? []).some((x) => x.action_class === "ACT-CFG-CHANGE")) return null;
    const reg = readApprovals(approvalsFile(ws, session.customer, session.session_id));
    const w = windowState(null, session.active_plan.plan_id, { ...session.env.policy, second_approver_required: true }, Date.now(), { records: reg.records });
    return { a1: w.a1, a2: w.a2, step: session.active_plan.step, of: info.plan.steps.length, a3: w.validForStep(session.active_plan.step) };
  } catch { return null; }
}

function findByCode(ws, code) {
  let custs = [];
  try { custs = readdirSync(join(ws, "customers")).filter((c) => /^[A-Z0-9]{4}$/.test(c)); } catch { return null; }
  for (const c of custs) {
    let dirs = [];
    try { dirs = readdirSync(join(ws, "customers", c, ".sessions"), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { continue; }
    for (const d of dirs) {
      try {
        const s = JSON.parse(readFileSync(join(ws, "customers", c, ".sessions", d, "session.json"), "utf8"));
        if (s.session_code === code || s.session_id === code) return s;
      } catch { /* illeggibile: si salta */ }
    }
  }
  return null;
}

const HELP = `uso: node scripts/admin/workflow.mjs event --kind <${EVENT_KINDS.join("|")}> --payload <json> [--session <id>]
       node scripts/admin/workflow.mjs render [--session <id>]
       node scripts/admin/workflow.mjs watch <SES.C.AAAAMMGG.NNN>        (sola lettura, anche da un'altra sessione)
       Opzioni: [--workspace <dir>] [--json] [--help]

Il blocco del workflow (§29.5) dagli eventi della sessione: banner di ambiente (§51.3), budget, una riga
per passo (▶ ✓ ⏸ ✗ ·), totali; ⏸ seguito dalla domanda, ✗ dal motivo. Exit: 0 · 1 argomenti · 2 sistema.`;

export async function run(argv, env = process.env) {
  const { opts, positional } = parseArgs(argv);
  const asJson = !!opts.json;
  if (opts.help) { console.log(HELP); return 0; }
  const ws = resolvePath(opts.workspace || env.JVC_WORKSPACE || env.CLAUDE_PROJECT_DIR || process.cwd());
  try {
    const [cmd, arg] = positional;
    if (cmd === "watch") {
      if (!arg) return fail(asJson, 1, "watch richiede il codice di sessione (SES.…)");
      const s = findByCode(ws, arg);
      if (!s) return fail(asJson, 1, `sessione ${arg} non trovata`);
      let text = render(readEvents(workflowFile(ws, s.customer, s.session_id)), s, { threeA: await threeAFor(ws, s) });
      // WP10d (D3): anche la sezione agenti della console (monitor indipendente, sola lettura)
      try {
        const { buildConsole, renderStatus } = await import("./agents.mjs");
        text += `\n${renderStatus(buildConsole(ws, s.customer, s.session_id, s))}`;
      } catch (err) { text += `\nAGENTI: console non disponibile (${String(err?.message ?? err).slice(0, 160)})\n`; }
      if (asJson) console.log(JSON.stringify({ ok: true, text })); else process.stdout.write(text);
      return 0;
    }
    if (cmd !== "event" && cmd !== "render") { console.log(HELP); return 1; }
    const { resolveSessionId, loadSession } = await import("./session.mjs");
    const sid = resolveSessionId({ workspace: ws, arg: opts.session, env });
    if (!sid) return fail(asJson, 1, "nessuna sessione risolvibile: --session <id>");
    const { session } = loadSession(ws, sid);
    if (!session) return fail(asJson, 1, "nessuna sessione con cliente attivo");
    const file = workflowFile(ws, session.customer, sid);
    if (cmd === "event") {
      let payload;
      try { payload = JSON.parse(opts.payload ?? "{}"); } catch { return fail(asJson, 1, "payload non JSON"); }
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) return fail(asJson, 1, "payload: oggetto JSON");
      let ev;
      try { ev = appendEvent(file, opts.kind, payload); } catch (err) { if (err.code === 1) return fail(asJson, 1, err.message); throw err; }
      console.log(asJson ? JSON.stringify({ ok: true, event: ev }) : `evento ${ev.seq} ${ev.kind}`);
      return 0;
    }
    const text = render(readEvents(file), session, { threeA: await threeAFor(ws, session) });
    if (asJson) console.log(JSON.stringify({ ok: true, text })); else process.stdout.write(text);
    return 0;
  } catch (err) { return fail(asJson, 2, `errore di sistema: ${err?.message ?? err}`); }
}

if (isMain(import.meta.url)) run(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(e); process.exit(2); });
