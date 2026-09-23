// 3A — la tripla approvazione (§52.2, §57.2). Libreria condivisa da
// approval-capture (UserPromptSubmit), guard-config-scope e guard-production, più
// una CLI in SOLA LETTURA (status | verify): nessun comando crea un token.
//
// I token nascono solo dal prompt dell'utente (decisione del controller): il
// modello non può scriverli (guard-config-scope protegge approvals.jsonl, e il
// guard conferma nel transcript che l'utente ha davvero scritto la frase).
//
// Registro: customers/<C>/.sessions/<sid>/approvals.jsonl, catena di hash come
// l'audit (hash = sha256(prev_hash + JSON canonico)). Record:
//   { ts, kind: A1|A2|A3|action|consume, plan, step?, approver_declared?,
//     prompt_sha256?, plan_sha256?, ref?, prev_hash, hash }
// `consume` marca monouso un token A3/action (ref = hash del token consumato).
//
// Frasi (parole chiave maiuscole, spazi tolleranti, l'intero prompt):
//   APPROVO PIANO <PLAN.id> [DA <Nome Cognome>]          → A1
//   APPROVO PROVA <PLAN.id> [DA <Nome Cognome>]          → A2
//   APPROVO PASSO <n> <PLAN.id> [DA <Nome Cognome>]      → A3
//   sì | si | yes   → approvazione di UNA azione R2 in attesa (sandbox/preprod)
// Finestra: A1..A3 entro config_window_minutes (default 60) dall'ultima A1;
// scaduta ⇒ si riparte da A1. second_approver_required: A1 e A2 con DA <nome>,
// nomi diversi (controllo organizzativo, non tecnico: il plugin registra il nome
// dichiarato e l'orario).
// Solo moduli built-in in testa (YAML solo a richiesta): lo importano gli hook.
import { readFileSync, appendFileSync, mkdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname, resolve, relative, isAbsolute } from "node:path";
import { GENESIS, hashEvent, appendAudit } from "../../hooks/lib/audit.mjs";
import { withFileLock } from "../../hooks/lib/fsx.mjs";
import { sessionDir, loadHookState } from "../../hooks/lib/workspace.mjs";
import { isMain } from "../lib/is-main.mjs";

export const DEFAULT_WINDOW_MINUTES = 60;
export const sha256 = (s) => createHash("sha256").update(String(s)).digest("hex");
export const approvalsFile = (ws, customer, sid) => join(sessionDir(ws, customer, sid), "approvals.jsonl");

// ---- frasi ----
const PLAN_ID = "PLAN\\.[A-Za-z0-9_-]+(?:\\.[A-Za-z0-9_-]+)*";
const NAME = "[\\p{L}][\\p{L}'’.\\-]*(?: [\\p{L}][\\p{L}'’.\\-]*){0,4}";
const RE_A1 = new RegExp(`^APPROVO PIANO (${PLAN_ID})(?: DA (${NAME}))?$`, "u");
const RE_A2 = new RegExp(`^APPROVO PROVA (${PLAN_ID})(?: DA (${NAME}))?$`, "u");
const RE_A3 = new RegExp(`^APPROVO PASSO ([1-9]\\d{0,3}) (${PLAN_ID})(?: DA (${NAME}))?$`, "u");
const RE_YES = /^(sì|si|yes)$/iu;
const ATTEMPT = /^(ok|okay|va bene|vabbene|vabene|approvo|approvato|approvata|confermo|confermato|procedi|autorizzo|d'accordo|certo|sì|si|yes)(?=$|[\s,.;:!?])/iu;
const normSpaces = (s) => s.replace(/\s+/gu, " ").trim();
export const normName = (s) => (typeof s === "string" ? normSpaces(s).toLocaleLowerCase("it") : null);

// → { kind: A1|A2|A3, plan, step?, approver } | { kind: "yes" } | { kind: "attempt" } | null
export function parseApprovalPrompt(prompt) {
  if (typeof prompt !== "string") return null;
  let s = normSpaces(prompt);
  if (s.length > 200) return /APPROV/i.test(s) ? { kind: "attempt" } : null;
  const bare = s.replace(/[.!]$/u, "");
  let m;
  if ((m = RE_A1.exec(bare))) return { kind: "A1", plan: m[1], approver: m[2] ? normSpaces(m[2]) : null };
  if ((m = RE_A2.exec(bare))) return { kind: "A2", plan: m[1], approver: m[2] ? normSpaces(m[2]) : null };
  if ((m = RE_A3.exec(bare))) return { kind: "A3", plan: m[2], step: Number(m[1]), approver: m[3] ? normSpaces(m[3]) : null };
  if (RE_YES.test(bare)) return { kind: "yes" };
  if (/APPROV/iu.test(s) || (ATTEMPT.test(s) && s.length <= 30)) return { kind: "attempt" };
  return null;
}

export const phraseOf = (r) => (r.kind === "A1" ? `APPROVO PIANO ${r.plan}` : r.kind === "A2" ? `APPROVO PROVA ${r.plan}` : r.kind === "A3" ? `APPROVO PASSO ${r.step} ${r.plan}` : r.kind === "action" ? "sì" : "");

// ---- registro ----
// → { ok: true, records } | { ok: false, reason, records: [] }
export function readApprovals(file) {
  let text;
  try { text = readFileSync(file, "utf8"); } catch (err) { if (err.code === "ENOENT") return { ok: true, records: [] }; return { ok: false, reason: `registro illeggibile (${err.code ?? err.message})`, records: [] }; }
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  const records = [];
  let prev = GENESIS;
  for (let i = 0; i < lines.length; i++) {
    let r;
    try { r = JSON.parse(lines[i]); } catch { return { ok: false, reason: `riga ${i + 1} non JSON`, records: [] }; }
    if (r.prev_hash !== prev || hashEvent(r) !== r.hash) return { ok: false, reason: `catena di hash rotta alla riga ${i + 1}`, records: [] };
    prev = r.hash;
    records.push(r);
  }
  return { ok: true, records };
}

function appendLocked(file, rec, date) {
  const cur = readApprovals(file);
  if (!cur.ok) throw new Error(`registro delle approvazioni corrotto: ${cur.reason}`);
  const prev = cur.records.at(-1)?.hash ?? GENESIS;
  const ev = { ts: date.toISOString(), ...rec, prev_hash: prev };
  for (const k of Object.keys(ev)) if (ev[k] === undefined) delete ev[k];
  ev.hash = hashEvent(ev);
  appendFileSync(file, `${JSON.stringify(ev)}\n`);
  return ev;
}

// Appende un record (sotto lock). Solo approval-capture (A1/A2/A3/action) e il
// consumo dei token (consume) lo chiamano.
export function appendApproval(file, rec, { date = new Date() } = {}) {
  mkdirSync(dirname(file), { recursive: true });
  return withFileLock(`${file}.lock`, () => appendLocked(file, rec, date));
}

// ---- finestra ----
// windowState(session, plan, envPolicy, now, { records }) → { a1, a2, a3_steps,
// expired, validForStep(n), tokenForStep(n), actionFor(n), reason }.
// records: dal registro verificato (i guard); default: lo specchio session.approvals.
export function windowState(session, plan, envPolicy = {}, now = Date.now(), { records } = {}) {
  const all = (records ?? session?.approvals ?? []).filter((r) => r && r.plan === plan);
  const consumed = new Set(all.filter((r) => r.kind === "consume").map((r) => r.ref));
  const minutes = Number.isInteger(envPolicy?.config_window_minutes) ? envPolicy.config_window_minutes : DEFAULT_WINDOW_MINUTES;
  const windowMs = minutes * 60000;
  const second = !!envPolicy?.second_approver_required;
  const i1 = all.findLastIndex((r) => r.kind === "A1");
  const actions = all.filter((r) => r.kind === "action" && !consumed.has(r.hash));
  const actionFor = (n) => actions.find((r) => r.step === n) ?? null;
  if (i1 < 0) return { a1: null, a2: null, a3_steps: [], expired: false, validForStep: () => false, tokenForStep: () => null, actionFor, windowMs, reason: "manca A1" };
  const a1 = all[i1];
  const t1 = Date.parse(a1.ts);
  const expired = !(now - t1 <= windowMs);
  const inWin = all.slice(i1 + 1).filter((r) => Date.parse(r.ts) - t1 <= windowMs);
  const a2 = inWin.find((r) => r.kind === "A2" && (!second || (a1.approver_declared && r.approver_declared && normName(r.approver_declared) !== normName(a1.approver_declared)))) ?? null;
  const a3 = inWin.filter((r) => r.kind === "A3" && !consumed.has(r.hash));
  const tokenForStep = (n) => (expired ? null : a3.find((r) => r.step === n) ?? null);
  return {
    a1, a2, a3_steps: [...new Set(a3.map((r) => r.step))].sort((x, y) => x - y), expired,
    validForStep: (n) => !!tokenForStep(n), tokenForStep, actionFor, windowMs, reason: expired ? "finestra scaduta" : null,
  };
}

// Consuma (monouso) il token A3 del passo n — o, con kind "action",
// l'approvazione dell'azione del passo n. Verifica e scrittura sotto lo stesso
// lock (due chiamate parallele non consumano due volte). → token | null.
export function consumeStepToken(file, plan, n, { envPolicy = {}, now = Date.now(), kind = "A3", date = new Date(now) } = {}) {
  if (!existsSync(file)) return null;
  return withFileLock(`${file}.lock`, () => {
    const cur = readApprovals(file);
    if (!cur.ok) return null;
    const w = windowState(null, plan, envPolicy, now, { records: cur.records });
    const tok = kind === "action" ? w.actionFor(n) : w.tokenForStep(n);
    if (!tok) return null;
    appendLocked(file, { kind: "consume", plan, step: n, ref: tok.hash, consumed_kind: tok.kind }, date);
    return tok;
  });
}

// Finestra 3A valida per il passo n (funzione condivisa di guard-production):
// A1 nella finestra, A2 valida (persona diversa se richiesto), A3 del passo n.
// Il token può essere già stato consumato da guard-config-scope nella stessa
// chiamata (gli hook di un evento girano in parallelo): conta se il consumo è
// di al più `graceMs`; il monouso lo garantisce guard-config-scope, che consuma.
// → { ok, reason, used: [record…] }
export function threeAState(records, plan, n, envPolicy = {}, now = Date.now(), { graceMs = 30000 } = {}) {
  const w = windowState(null, plan, envPolicy, now, { records });
  const who = envPolicy?.second_approver_required ? " DA <Nome Cognome>" : "";
  if (!w.a1) return { ok: false, reason: `manca A1: \`APPROVO PIANO ${plan}${who}\``, used: [] };
  if (w.expired) return { ok: false, reason: `finestra 3A scaduta: si riparte da \`APPROVO PIANO ${plan}${who}\``, used: [] };
  if (!w.a2) return { ok: false, reason: `manca A2${envPolicy?.second_approver_required ? " da persona diversa da A1" : ""}: \`APPROVO PROVA ${plan}${who}\``, used: [] };
  let tok = w.tokenForStep(n);
  if (!tok) {
    const all = records.filter((r) => r.plan === plan);
    const t1 = Date.parse(w.a1.ts);
    const recent = new Set(all.filter((r) => r.kind === "consume" && r.step === n && now - Date.parse(r.ts) <= graceMs).map((r) => r.ref));
    tok = all.find((r) => r.kind === "A3" && r.step === n && recent.has(r.hash) && Date.parse(r.ts) >= t1) ?? null;
  }
  if (!tok) return { ok: false, reason: `manca il token del passo: \`APPROVO PASSO ${n} ${plan}\``, used: [] };
  return { ok: true, reason: null, used: [w.a1, w.a2, tok] };
}

// ---- conferma nel transcript (difesa in profondità) ----
// Un record vale solo se nel transcript c'è un PROMPT VERO DELL'UTENTE (giro di
// correzione 1, I3):
//  - riga `type: user`, ruolo user, testo (mai tool_result: una pagina web può
//    contenere la frase), con `timestamp`;
//  - escluse le righe dei sub-agenti (isSidechain: il loro prompt lo scrive il
//    modello), i riassunti di compattazione, le righe solo di visualizzazione, i
//    risultati di strumenti (toolUseResult, sourceToolUseID), le righe meta;
//  - sha256 del prompt UGUALE a prompt_sha256 del record E orario della riga entro
//    CAPTURE_TOLERANCE_MS dal ts del record (approval-capture registra mentre
//    l'utente invia: un "sì" o una frase identica di un altro momento non valgono);
//  - una riga del transcript conferma al più un record.
export const CAPTURE_TOLERANCE_MS = 30000;
const EXCLUDED = ["isSidechain", "isCompactSummary", "isVisibleInTranscriptOnly", "toolUseResult", "sourceToolUseID", "isMeta", "isApiErrorMessage"];
function userPrompt(line) {
  let o;
  try { o = JSON.parse(line); } catch { return null; }
  if (!o || o.type !== "user" || EXCLUDED.some((k) => o[k] != null && o[k] !== false)) return null;
  if (o.userType != null && o.userType !== "external") return null;
  const t = Date.parse(o.timestamp ?? "");
  const msg = o.message;
  if (!Number.isFinite(t) || !msg || msg.role !== "user") return null;
  let texts;
  if (typeof msg.content === "string") texts = [msg.content];
  else if (Array.isArray(msg.content) && msg.content.every((b) => b?.type === "text" && typeof b.text === "string")) texts = [msg.content.map((b) => b.text).join("\n"), ...msg.content.map((b) => b.text)];
  else return null;
  return { t, shas: new Set(texts.map(sha256)) };
}

export function confirmInTranscript(transcriptPath, recs) {
  if (typeof transcriptPath !== "string" || !transcriptPath) return { ok: false, missing: recs.map(phraseOf), reason: "transcript assente" };
  let text;
  try { text = readFileSync(transcriptPath, "utf8"); } catch { return { ok: false, missing: recs.map(phraseOf), reason: "transcript illeggibile" }; }
  const prompts = [];
  for (const l of text.split("\n")) if (l.includes('"user"')) { const p = userPrompt(l); if (p) prompts.push(p); }
  const used = new Set();
  const missing = [];
  for (const r of recs) {
    const t = Date.parse(r?.ts ?? "");
    const k = typeof r?.prompt_sha256 === "string" && Number.isFinite(t)
      ? prompts.findIndex((p, i) => !used.has(i) && p.shas.has(r.prompt_sha256) && Math.abs(p.t - t) <= CAPTURE_TOLERANCE_MS)
      : -1;
    if (k < 0) missing.push(phraseOf(r)); else used.add(k);
  }
  return { ok: missing.length === 0, missing, reason: missing.length ? `prompt dell'utente non trovato nel transcript (sha e orario del record): ${missing.join(" · ")}` : null };
}

// ---- piano ----
// Il file del piano (relativo alla cartella del cliente, dentro di essa) → { text, plan } | null.
export function planFilePath(ws, customer, rel) {
  if (typeof rel !== "string" || !rel || isAbsolute(rel)) return null;
  const base = join(ws, "customers", customer);
  const f = resolve(base, rel);
  const r = relative(base, f);
  if (!r || r.startsWith("..") || isAbsolute(r)) return null;
  return f;
}
export async function loadPlanFile(ws, customer, rel) {
  const f = planFilePath(ws, customer, rel);
  if (!f) return null;
  let text;
  try { text = readFileSync(f, "utf8"); } catch { return null; }
  let plan;
  if (text.trimStart().startsWith("{")) plan = JSON.parse(text);
  else plan = (await import("yaml")).default.parse(text);
  return { file: f, text, sha256: sha256(text), plan };
}

// ---- approval-capture (UserPromptSubmit) ----
const ctxOut = (text, user) => ({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: text }, ...(user ? { systemMessage: user } : {}) });
function invalid(expected, why) {
  const exp = [...new Set(expected)].filter(Boolean);
  const say = exp.length ? exp.map((e) => `\`${e}\``).join(" oppure ") : "la frase richiesta";
  return ctxOut(`Approvazione non valida: scrivi esattamente ${say} — motivo: ${why}. Nessun token registrato (§57.2: un "ok" o un "va bene" non valgono; il manager lo dice all'utente e attende).`, `⚠ Approvazione non valida: ${why}`);
}

export async function capture(input, env = process.env) {
  const st = loadHookState(input, env);
  if (!st.jvc || !st.session) return null;
  const p = parseApprovalPrompt(input.prompt);
  if (!p) return null;
  const s = st.session;
  // Anche i tentativi respinti vanno in audit (§52.2: "tutte registrate in audit"), senza il testo del prompt.
  const reject = (expected, why) => {
    try {
      appendAudit(st.ws, { session: st.sid, customer: st.customer, scope: s.scope ?? null, kind: "decision", actor: "hook:approval-capture",
        payload: { approval: "rejected", parsed: p.kind, plan: p.plan ?? null, step: p.step ?? null, reason: why, prompt_sha256: sha256(input.prompt) } });
    } catch { /* l'audit non cambia l'esito: nessun token */ }
    return invalid(expected, why);
  };
  const pending = Array.isArray(s.pending?.approvals) ? s.pending.approvals : [];
  const active = s.active_plan ?? null;
  const known = new Set([...pending.map((r) => r.plan), ...(active?.plan_id ? [active.plan_id] : [])]);
  const file = approvalsFile(st.ws, st.customer, st.sid);
  const policy = s.env?.policy ?? {};
  const second = policy.second_approver_required ?? s.env?.type === "prod";
  const envPolicy = { ...policy, second_approver_required: second };
  const reg = readApprovals(file);
  const now = Date.now();
  const expectedFor = (plan) => {
    const exp = pending.filter((r) => !plan || r.plan === plan).map((r) => phraseOf({ ...r, kind: r.kind }));
    if (exp.length) return exp;
    const pl = plan ?? active?.plan_id;
    if (!pl) return [];
    const w = reg.ok ? windowState(null, pl, envPolicy, now, { records: reg.records }) : null;
    if (!w?.a1 || w.expired) return [`APPROVO PIANO ${pl}${second ? " DA <Nome Cognome>" : ""}`];
    return [`APPROVO PROVA ${pl}${second ? " DA <Nome Cognome>" : ""}`, `APPROVO PASSO <n> ${pl}`];
  };

  if (p.kind === "attempt") return known.size ? reject(expectedFor(null), "la frase non è quella richiesta") : null;

  let rec;
  let removeMatch;
  if (p.kind === "yes") {
    const acts = pending.filter((r) => r.kind === "action");
    if (!pending.length) return null;
    if (s.env?.type === "prod") return reject(expectedFor(null), "in produzione non si approvano azioni sui dati: non si scrivono dati, mai (§52.1)");
    if (acts.length !== 1) return reject(expectedFor(null), acts.length ? `un sì vale solo con UNA richiesta aperta (ce ne sono ${acts.length})` : "nessuna azione in attesa di un sì");
    rec = { kind: "action", plan: acts[0].plan, step: acts[0].step, approver_declared: null };
    removeMatch = (r) => r.kind === "action" && r.plan === rec.plan && r.step === rec.step;
  } else {
    if (!known.has(p.plan)) return reject(expectedFor(null), `nessun piano ${p.plan} in attesa di approvazione`);
    if (!reg.ok) return reject(expectedFor(p.plan), `registro delle approvazioni corrotto (${reg.reason})`);
    const w = windowState(null, p.plan, envPolicy, now, { records: reg.records });
    const restart = `APPROVO PIANO ${p.plan}${second ? " DA <Nome Cognome>" : ""}`;
    let planInfo = null;
    const pfile = pending.find((r) => r.plan === p.plan && r.file)?.file ?? (active?.plan_id === p.plan ? active.file : null);
    if (pfile) { try { planInfo = await loadPlanFile(st.ws, st.customer, pfile); } catch { planInfo = null; } }
    if (p.kind === "A1") {
      if (second && !p.approver) return reject([restart], "serve DA <Nome Cognome>: in questo ambiente A2 deve venire da una persona diversa da A1");
    } else {
      if (!w.a1) return reject([restart], `manca A1 per ${p.plan}: si comincia da APPROVO PIANO`);
      if (w.expired) return reject([restart], `finestra di ${w.windowMs / 60000} minuti scaduta: si riparte da A1`);
    }
    if (p.kind === "A2") {
      if (second && !p.approver) return reject([`APPROVO PROVA ${p.plan} DA <Nome Cognome>`], "serve DA <Nome Cognome> (secondo approvatore richiesto)");
      if (second && normName(p.approver) === normName(w.a1.approver_declared)) return reject([`APPROVO PROVA ${p.plan} DA <Nome Cognome>`], `A2 deve venire da una persona diversa da A1 (${w.a1.approver_declared})`);
      if (w.a2) return reject([], "A2 già registrata in questa finestra");
    }
    if (p.kind === "A3") {
      const steps = Array.isArray(planInfo?.plan?.steps) ? planInfo.plan.steps.map((x) => x?.n) : null;
      if (steps && !steps.includes(p.step)) return reject(expectedFor(p.plan), `il piano ${p.plan} non ha il passo ${p.step}`);
      const waiting = pending.filter((r) => r.kind === "A3" && r.plan === p.plan).map((r) => r.step);
      if (waiting.length && !waiting.includes(p.step)) return reject(expectedFor(p.plan), `il passo ${p.step} non è in attesa di approvazione (in attesa: ${waiting.join(", ")})`);
      if (w.validForStep(p.step)) return reject([], `il passo ${p.step} ha già un token non usato`);
    }
    rec = { kind: p.kind, plan: p.plan, ...(p.kind === "A3" ? { step: p.step } : {}), approver_declared: p.approver ?? null,
      ...(p.kind === "A1" && planInfo ? { plan_sha256: planInfo.sha256 } : {}) };
    removeMatch = (r) => r.kind === p.kind && r.plan === p.plan && (p.kind !== "A3" || r.step === p.step);
  }
  rec.prompt_sha256 = sha256(input.prompt);
  rec.session = st.sid;
  // Prima il registro (la fonte dei guard); poi lo specchio e l'audit.
  const ev = appendApproval(file, rec);
  const label = `${ev.kind} ${ev.plan}${ev.step ? ` passo ${ev.step}` : ""}${ev.approver_declared ? ` (${ev.approver_declared})` : ""}`;
  let warn = "";
  try {
    const { updateSession } = await import("./session.mjs");
    updateSession(st.sessionFile, (x) => {
      x.approvals = [...(Array.isArray(x.approvals) ? x.approvals : []), { ts: ev.ts, kind: ev.kind, plan: ev.plan, ...(ev.step ? { step: ev.step } : {}), approver_declared: ev.approver_declared ?? null, prompt_sha256: ev.prompt_sha256, hash: ev.hash }];
      const i = (x.pending?.approvals ?? []).findIndex(removeMatch);
      if (i >= 0) x.pending.approvals.splice(i, 1);
    });
  } catch (err) { warn = ` (specchio in session.json non aggiornato: ${String(err.message).slice(0, 120)})`; }
  try {
    appendAudit(st.ws, { session: st.sid, customer: st.customer, scope: s.scope ?? null, kind: "decision", actor: "hook:approval-capture", correlation: { task: null, dec: null, run: null },
      payload: { approval: ev.kind, plan: ev.plan, step: ev.step ?? null, approver_declared: ev.approver_declared ?? null, hash: ev.hash } });
  } catch { /* l'audit non annulla un'approvazione già registrata */ }
  return ctxOut(`Approvazione registrata: ${label} alle ${ev.ts}${warn}. Vale solo per ciò che nomina${ev.kind === "A3" || ev.kind === "action" ? ", una sola volta" : ""}.`, `✓ Approvazione registrata: ${label}`);
}

// ---- CLI (sola lettura) ----
const HELP = `uso: node scripts/admin/approvals.mjs status [--plan <PLAN.id>] [--session <id>] [--workspace <dir>] [--json]
     node scripts/admin/approvals.mjs verify [--session <id>] [--workspace <dir>] [--json]

Sola lettura (§52.2): nessun comando crea o consuma token. I token nascono solo
dalle frasi dell'utente (APPROVO PIANO / PROVA / PASSO), registrate dall'hook
approval-capture in customers/<C>/.sessions/<sid>/approvals.jsonl.
  status   record della sessione e stato della finestra 3A per il piano
  verify   verifica la catena di hash del registro

Exit code: 0 ok · 1 errore d'uso · 2 errore di sistema · 3 registro manomesso (catena rotta).`;

export async function run(argv, env = process.env) {
  const { parseArgs, fail } = await import("../lib/args.mjs");
  const { opts, positional } = parseArgs(argv);
  const asJson = !!opts.json;
  if (opts.help) { console.log(HELP); return 0; }
  const [action] = positional;
  if (action !== "status" && action !== "verify") { if (!asJson) console.log(HELP); return fail(asJson, 1, `azione sconosciuta: ${action ?? "(nessuna)"} (status | verify: la CLI è in sola lettura)`); }
  try {
    const { resolveSessionId, loadSession } = await import("./session.mjs");
    const ws = resolve(opts.workspace || env.JVC_WORKSPACE || env.CLAUDE_PROJECT_DIR || process.cwd());
    const sid = resolveSessionId({ workspace: ws, arg: opts.session, env });
    if (!sid) return fail(asJson, 1, "nessuna sessione risolvibile: --session <id>");
    const { session } = loadSession(ws, sid);
    if (!session) return fail(asJson, 1, "nessun cliente attivo");
    const file = approvalsFile(ws, session.customer, sid);
    const reg = readApprovals(file);
    if (action === "verify") {
      const out = { ok: reg.ok, file, records: reg.records.length, ...(reg.ok ? {} : { reason: reg.reason }) };
      console.log(asJson ? JSON.stringify(out) : reg.ok ? `catena integra: ${out.records} record` : `CATENA ROTTA: ${reg.reason}`);
      return reg.ok ? 0 : 3;
    }
    if (!reg.ok) return fail(asJson, 3, `registro manomesso: ${reg.reason}`);
    const plan = opts.plan ?? session.active_plan?.plan_id ?? null;
    const policy = { ...(session.env?.policy ?? {}), second_approver_required: session.env?.policy?.second_approver_required ?? session.env?.type === "prod" };
    const w = plan ? windowState(null, plan, policy, Date.now(), { records: reg.records }) : null;
    const out = { ok: true, file, plan, env: session.env ? { id: session.env.id, type: session.env.type } : null, records: reg.records,
      window: w ? { a1: w.a1, a2: w.a2, a3_steps: w.a3_steps, expired: w.expired, window_minutes: w.windowMs / 60000 } : null, pending: session.pending?.approvals ?? [] };
    if (asJson) console.log(JSON.stringify(out));
    else console.log(w ? `${plan}: A1 ${w.a1 ? `✓ ${w.a1.ts}${w.a1.approver_declared ? ` (${w.a1.approver_declared})` : ""}` : "—"} · A2 ${w.a2 ? `✓ ${w.a2.ts}${w.a2.approver_declared ? ` (${w.a2.approver_declared})` : ""}` : "—"} · A3 passi ${w.a3_steps.join(", ") || "—"}${w.expired ? " · FINESTRA SCADUTA" : ""}` : `${reg.records.length} record`);
    return 0;
  } catch (err) {
    return fail(asJson, 2, `errore di sistema: ${err?.message ?? err}`);
  }
}

if (isMain(import.meta.url)) run(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(e); process.exit(2); });
