// Stato di sessione (§45.1, §56.2): risoluzione della sessione, lettura,
// scrittura atomica validata, cella consentita (§31.4) e CLI `use`.
// Nessun import pesante in testa: gli hook importano questo modulo e non
// devono caricare better-sqlite3 (solo `use customer --new` apre il DB).
import { existsSync, readFileSync, mkdirSync, writeFileSync, readdirSync, copyFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs, fail } from "../lib/args.mjs";
import { isMain } from "../lib/is-main.mjs";
import { validateWith } from "../lib/schemas.mjs";
import { writeFileAtomic, withFileLock } from "../../hooks/lib/fsx.mjs";
import {
  isSafeSessionId, readCurrentSession, readPointer, writePointer, writeCurrentSession,
  sessionDir, sessionFile, pointerFile, invocationsFile, CUSTOMER_RE,
} from "../../hooks/lib/workspace.mjs";
import { appendAudit } from "../../hooks/lib/audit.mjs";
import { readJsonl } from "../../hooks/lib/state-summary.mjs";
import { openFrom, closeOpen, OPEN_TTL_MS } from "../../hooks/lib/invocations.mjs";
import { checkSessionText, parseSessionText } from "../../hooks/lib/session-state.mjs";

const REGISTRY = JSON.parse(readFileSync(new URL("../../schemas/registry.json", import.meta.url), "utf8"));
export const SCOPES = REGISTRY.scopes;
export const MODES = ["nrt", "config", "ops", "diag"];
const MODE_ALIASES = { configurazione: "config", configuration: "config", operativa: "ops", operations: "ops", diagnosi: "diag", diagnosis: "diag", collaudo: "nrt" };
export const DEFAULT_BUDGET = 200000;
const CUSTOMER_DIRS = ["lessons", "decisions", "outcomes", "observations", "epistemic", "contradictions", "runs", "reports", "evidence"];

export function pluginVersion() {
  try { return JSON.parse(readFileSync(new URL("../../.claude-plugin/plugin.json", import.meta.url), "utf8")).version; } catch { return "0.0.0"; }
}

// --session > JVC_SESSION_ID > <workspace>/.jvc/current-session. Un valore
// "${CLAUDE_SESSION_ID}" non sostituito dal comando vale come assente.
export function resolveSessionId({ workspace, arg, env = process.env } = {}) {
  const pick = (v) => (typeof v === "string" && !/^\$\{.*\}$/.test(v) && v.trim() !== "" ? v.trim() : null);
  const explicit = pick(arg) ?? pick(env.JVC_SESSION_ID);
  if (explicit) return isSafeSessionId(explicit) ? explicit : null;
  return workspace ? readCurrentSession(workspace) : null;
}

export function validateSession(obj) { return validateWith("session.schema.json", obj); }

export function loadSession(ws, sid) {
  const pointer = readPointer(ws, sid);
  if (!pointer?.customer) return { pointer, session: null, file: null };
  const file = sessionFile(ws, pointer.customer, sid);
  if (!existsSync(file)) return { pointer, session: null, file };
  // Stesso predicato degli hook (F1): JSON + schema + coerenza col puntatore.
  return { pointer, session: parseSessionText(readFileSync(file, "utf8"), { customer: pointer.customer, sid }), file };
}

// Valida PRIMA di scrivere; poi tmp + rename nella stessa cartella.
export function saveSession(file, session) {
  const obj = { ...session, updated_at: new Date().toISOString() };
  const v = validateSession(obj);
  if (!v.ok) throw new Error(`session.json non valido: ${v.errors.join("; ")}`);
  writeFileAtomic(file, `${JSON.stringify(obj, null, 2)}\n`);
  return obj;
}

// Read-modify-write sotto lock (hook e CLI possono scrivere in parallelo).
export function updateSession(file, mutate) {
  return withFileLock(`${file}.lock`, () => {
    const s = JSON.parse(readFileSync(file, "utf8"));
    const r = mutate(s);
    return saveSession(file, r && typeof r === "object" ? r : s);
  });
}

// La cella di §31.4: scope del cliente (C, L) + prodotto (S) in lettura, handoff
// in cui lo scope compare, INT possedute (XSC/integrations, lettura), cartelle
// di lavoro del cliente, test dello scope, inbox dello scope, la sessione.
export function computeAllowedPaths(customer, scope, { sessionId } = {}) {
  if (!customer) return [];
  const C = customer;
  const out = [];
  if (scope) {
    const S = scope;
    out.push(
      `product/kb/scopes/${S}/**`, `product/kb/handoffs/*${S}*`,
      `customers/${C}/kb/scopes/${S}/**`, `customers/${C}/kb/handoffs/*${S}*`,
      `customers/${C}/kb/scopes/XSC/integrations/**`,
      `customers/${C}/tests/**/${S}/**`, `customers/${C}/_inbox/${S}/**`,
    );
  }
  for (const d of CUSTOMER_DIRS) out.push(`customers/${C}/${d}/**`);
  if (sessionId) out.push(`customers/${C}/.sessions/${sessionId}/**`);
  return [...new Set(out)];
}

export function newSession({ sid, customer, scope = null, mode = "nrt", pluginVersion: pv = pluginVersion(), knowledgeVersion = null, budget } = {}) {
  return {
    session_id: sid,
    customer,
    scope,
    mode,
    env: null,
    budget: budget ? structuredClone(budget) : { tokens: DEFAULT_BUDGET, used: 0, by_model: { haiku: 0, sonnet: 0, opus: 0 } },
    allowed_paths: computeAllowedPaths(customer, scope, { sessionId: sid }),
    pending: { compensations: [], approvals: [], questions: [], expected_outcomes: [] },
    surprises: [],
    ledger: { invocations: [], trace_blocks: {} },
    hypotheses_file: `.sessions/${sid}/hypotheses.yaml`,
    blackboard_dir: `.sessions/${sid}/blackboard/`,
    last_compact_summary: null,
    knowledge_version: knowledgeVersion,
    plugin_version: pv,
    updated_at: new Date().toISOString(),
  };
}

// Struttura cliente di §8.2 (idempotente: non sovrascrive nulla).
function createCustomerSkeleton(custDir) {
  const leaves = [
    "profile", "kb/handoffs", ...SCOPES.map((s) => `kb/scopes/${s}`),
    "analysis/patterns", "analysis/playbooks", "analysis/briefings", "analysis/rules",
    "observations", "lessons", "decisions", "outcomes", "epistemic", "contradictions",
    "clusters", "tests", "runs", "evidence", "reports", "audit", "config", "_inbox",
  ];
  for (const d of leaves) {
    mkdirSync(join(custDir, d), { recursive: true });
    const keep = join(custDir, d, ".gitkeep");
    if (!existsSync(keep)) writeFileSync(keep, "");
  }
  mkdirSync(join(custDir, ".sessions"), { recursive: true });
  const gi = join(custDir, ".gitignore");
  if (!existsSync(gi)) writeFileSync(gi, ".sessions/\n.auth/\nknowledge.db-wal\nknowledge.db-shm\n");
}

async function readKnowledgeVersion(dbPath, { create }) {
  if (!create && !existsSync(dbPath)) return null;
  if (create) {
    const { openDb } = await import("../kb/db.mjs");
    const db = openDb(dbPath);
    try { return db.prepare("select value from meta where key='knowledge_version'").get()?.value ?? null; } finally { db.close(); }
  }
  try {
    const { default: Database } = await import("better-sqlite3");
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try { return db.prepare("select value from meta where key='knowledge_version'").get()?.value ?? null; } finally { db.close(); }
  } catch { return null; }
}

class CliError extends Error { constructor(code, msg, extra = {}) { super(msg); this.code = code; this.extra = extra; } }

function parseBudget(v) {
  const m = /^(\d+)(k)?$/i.exec(String(v ?? "").trim());
  if (!m) throw new CliError(1, `budget non valido: ${v} (intero positivo, es. 200000 o 200k)`);
  const n = Number(m[1]) * (m[2] ? 1000 : 1);
  if (!Number.isSafeInteger(n) || n < 1) throw new CliError(1, `budget non valido: ${v}`);
  return n;
}

// Chi ha eseguito la CLI (fix round 1 #4): la sessione principale di Claude
// Code (CLAUDECODE=1 nell'ambiente dei suoi comandi) o un terminale. La CLI non
// sa se a chiamarla è "il manager": l'audit registra solo ciò che può sapere.
export const actorOf = (env = process.env) => (env.CLAUDECODE === "1" ? "main-session" : "cli");

// Stato illeggibile ⇒ errore utente (exit 1) con la via di riparazione (#16).
function loadOrExplain(ws, sid) {
  try { return loadSession(ws, sid); } catch (err) {
    throw new CliError(1, `stato di sessione illeggibile (${err.message}): riparalo con \`use customer <ID>\` (ne resta una copia .corrupt-<data>)`);
  }
}

function requireActive(ws, sid) {
  const { pointer, session, file } = loadOrExplain(ws, sid);
  if (!pointer?.customer) throw new CliError(1, "nessun cliente attivo: esegui prima `use customer <ID>`");
  if (!session) throw new CliError(1, `session.json assente per il cliente ${pointer.customer}: riesegui \`use customer ${pointer.customer}\``);
  return { pointer, session, file };
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");
function backupCorrupt(file) {
  const to = `${file}.corrupt-${stamp()}`;
  copyFileSync(file, to);
  return to;
}

// session.json di questa sessione presso ogni cliente, giudicati con il
// predicato condiviso (F1): { customer, file, session } oppure
// { customer, file, corrupt: true, reason, parsed }.
function sessionsOf(ws, sid) {
  let dirs = [];
  try { dirs = readdirSync(join(ws, "customers")).filter((c) => CUSTOMER_RE.test(c)); } catch { return []; }
  const out = [];
  for (const c of dirs) {
    const file = sessionFile(ws, c, sid);
    if (!existsSync(file)) continue;
    let text;
    try { text = readFileSync(file, "utf8"); } catch (err) { out.push({ customer: c, file, corrupt: true, reason: err.message, parsed: null }); continue; }
    const r = checkSessionText(text, { customer: c, sid });
    out.push(r.ok ? { customer: c, file, session: r.session } : { customer: c, file, corrupt: true, reason: r.reason, parsed: r.parsed });
  }
  return out;
}

// Sotto-compiti dispatchati da guard-budget e non ancora chiusi da subagent-trace (#8).
function openTasks(ws, customer, sid, session) {
  return openFrom(readJsonl(invocationsFile(ws, customer, sid)), session?.ledger?.invocations ?? []).map((i) => i.task_id ?? `#${i.seq}`);
}
function refuseOpenTasks(open, what) {
  if (open.length) throw new CliError(3, `${open.length} sotto-compiti aperti (${open.join(", ")}): attendi la chiusura dei sotto-compiti aperti prima di cambiare ${what}`, { open_tasks: open });
}

// Il budget è della sessione, non del cliente (#9): tokens dallo stato vivo
// (la sessione che si lascia, poi il puntatore, poi la sessione aggiornata più
// di recente); used e by_model = il massimo noto fra puntatore e session.json.
function mergedBudget(candidates, live) {
  const ok = candidates.filter((b) => b && Number.isInteger(b.used) && Number.isInteger(b.tokens));
  const base = live ?? ok[0];
  if (!base) return null;
  const by_model = { haiku: 0, sonnet: 0, opus: 0 };
  for (const b of ok) for (const [k, n] of Object.entries(b.by_model ?? {})) if (Number.isInteger(n) && n > (by_model[k] ?? 0)) by_model[k] = n;
  return { tokens: base.tokens, used: Math.max(0, ...ok.map((b) => b.used)), by_model };
}

async function useCustomer(ws, sid, id, { create, actor }) {
  if (typeof id !== "string" || !CUSTOMER_RE.test(id)) throw new CliError(1, `codice cliente non valido: ${id} (4 caratteri A-Z 0-9)`);
  const custDir = join(ws, "customers", id);
  if (!existsSync(custDir) && !create) throw new CliError(1, `cliente inesistente: ${id} (usa --new per crearlo)`);
  // Puntatore corrotto (#16): se ne tiene una copia e il cliente precedente è
  // sconosciuto; allora (come senza cliente nel puntatore) si controllano TUTTI
  // gli altri clienti che hanno uno stato per questa sessione.
  let pointer = null;
  let pointerBackup = null;
  try { pointer = readPointer(ws, sid); } catch { pointerBackup = backupCorrupt(pointerFile(ws, sid)); }
  const prev = pointer?.customer ?? null;
  const all = sessionsOf(ws, sid);
  const toCheck = prev ? (prev !== id ? all.filter((x) => x.customer === prev) : []) : all.filter((x) => x.customer !== id);
  const comps = [];
  const open = [];
  for (const x of toCheck) {
    if (x.corrupt) throw new CliError(3, `session.json del cliente ${x.customer} illeggibile: non si sa se ha compensazioni pendenti. Riparalo con \`use customer ${x.customer}\` prima di cambiare cliente`, { unreadable: [x.customer] });
    comps.push(...(x.session.pending?.compensations ?? []));
    open.push(...openTasks(ws, x.customer, sid, x.session));
  }
  if (comps.length) {
    const from = toCheck.map((x) => x.customer).join(", ");
    throw new CliError(3, `il cliente ${from} ha ${comps.length} compensazioni pendenti: chiudile prima di cambiare cliente`, { pending_compensations: comps });
  }
  refuseOpenTasks(open, "cliente");
  if (create) createCustomerSkeleton(custDir);
  const knowledgeVersion = await readKnowledgeVersion(join(custDir, "knowledge.db"), { create });
  const file = sessionFile(ws, id, sid);
  const dir = sessionDir(ws, id, sid);
  mkdirSync(join(dir, "blackboard"), { recursive: true });
  if (!existsSync(join(dir, "hypotheses.yaml"))) writeFileSync(join(dir, "hypotheses.yaml"), "hypotheses: []\n");
  // session.json del cliente scelto corrotto (#16): copia di backup, poi stato nuovo.
  const target = all.find((x) => x.customer === id);
  const sessionBackup = target?.corrupt ? backupCorrupt(file) : null;
  const readable = all.filter((x) => !x.corrupt);
  const prevLive = prev ? readable.find((x) => x.customer === prev)?.session.budget : null;
  const newest = [...readable].sort((a, b) => String(b.session.updated_at).localeCompare(String(a.session.updated_at)))[0]?.session.budget;
  // Anche i budget leggibili di stati corrotti contano per il massimo di `used` (F1).
  const salvaged = all.filter((x) => x.corrupt && x.parsed?.budget).map((x) => x.parsed.budget);
  const budget = mergedBudget([pointer?.budget, ...readable.map((x) => x.session.budget), ...salvaged], prevLive ?? pointer?.budget ?? newest ?? null);
  let session;
  if (target && !target.corrupt) {
    session = updateSession(file, (s) => {
      s.knowledge_version = knowledgeVersion ?? s.knowledge_version;
      s.plugin_version = pluginVersion();
      if (budget) s.budget = budget;
    });
  } else {
    session = saveSession(file, newSession({ sid, customer: id, knowledgeVersion, budget: budget ?? undefined }));
  }
  writePointer(ws, sid, id, { budget: session.budget });
  writeCurrentSession(ws, sid);
  // Successo solo se il risultato passa il predicato che useranno gli hook (F1).
  try { loadSession(ws, sid); } catch (err) { throw new CliError(2, `riparazione non riuscita: ${err.message}`); }
  const backups = [pointerBackup, sessionBackup].filter(Boolean);
  appendAudit(ws, { session: sid, customer: id, scope: session.scope, kind: "session", actor, payload: { action: "use-customer", from: prev, to: id, created: !!create, repaired: backups.length ? { pointer: !!pointerBackup, session: !!sessionBackup } : null } });
  return { session, previous: prev, ...(backups.length ? { backups } : {}) };
}

function useScope(ws, sid, raw, { actor }) {
  const S = String(raw ?? "").toUpperCase();
  if (!SCOPES.includes(S)) throw new CliError(1, `scope non valido: ${raw} (${SCOPES.join(" · ")})`);
  const { session: before, file } = requireActive(ws, sid);
  if (before.scope !== S) refuseOpenTasks(openTasks(ws, before.customer, sid, before), "scope");
  const session = updateSession(file, (s) => { s.scope = S; s.allowed_paths = computeAllowedPaths(s.customer, S, { sessionId: sid }); });
  appendAudit(ws, { session: sid, customer: session.customer, scope: S, kind: "session", actor, payload: { action: "use-scope", from: before.scope, to: S } });
  return { session };
}

function useMode(ws, sid, raw, { actor }) {
  const m = MODE_ALIASES[String(raw ?? "").toLowerCase()] ?? String(raw ?? "").toLowerCase();
  if (!MODES.includes(m)) throw new CliError(1, `modalità non valida: ${raw} (${MODES.join(" · ")})`);
  const { session: before, file } = requireActive(ws, sid);
  const session = updateSession(file, (s) => { s.mode = m; });
  appendAudit(ws, { session: sid, customer: session.customer, scope: session.scope, kind: "session", actor, payload: { action: "use-mode", from: before.mode, to: m } });
  return { session };
}

function useBudget(ws, sid, raw, { actor }) {
  const n = parseBudget(raw);
  const { pointer, session: before, file } = requireActive(ws, sid);
  const session = updateSession(file, (s) => { s.budget.tokens = n; });
  writePointer(ws, sid, session.customer, { budget: pointer?.budget && pointer.budget.used > session.budget.used ? { ...session.budget, used: pointer.budget.used } : session.budget });
  appendAudit(ws, { session: sid, customer: session.customer, scope: session.scope, kind: "budget", actor, payload: { action: "use-budget", from: before.budget.tokens, to: n, used: before.budget.used } });
  return { session };
}

// Chiusura manuale dei sotto-compiti rimasti aperti (fix round 2 F4): un
// dispatch che non arriverà mai a SubagentStop. Solo sessione principale
// (i sub-agenti sono negati da guard-budget su ogni `session.mjs use`); in audit.
function useCloseStale(ws, sid, { actor }) {
  const { session: before, file } = requireActive(ws, sid);
  const invs = readJsonl(invocationsFile(ws, before.customer, sid));
  let closed = [];
  const session = updateSession(file, (s) => { closed = closeOpen(invs, s.ledger.invocations); });
  appendAudit(ws, { session: sid, customer: session.customer, scope: session.scope, kind: "session", actor, payload: { action: "close-stale", closed } });
  return { session, closed };
}

const HELP = `uso: node scripts/admin/session.mjs <azione> [opzioni]

Azioni (§56.2):
  use customer <ID> [--new]   attiva un cliente (4 caratteri A-Z0-9); --new crea la
                              struttura §8.2, config/, knowledge.db e .gitignore.
                              Rifiuta il cambio se il cliente precedente ha
                              compensazioni pendenti (exit 3, le elenca).
  use scope <ID>              cella attiva (${SCOPES.join(" ")}); ricalcola allowed_paths
  use mode <m>                nrt | config | ops | diag
  use budget <n>              budget di sessione in token (es. 200000 o 200k); in audit
  use close-stale             chiude a mano i sotto-compiti rimasti aperti (dispatch
                              mai arrivati a SubagentStop); in audit. Senza, un
                              dispatch aperto scade dopo ${OPEN_TTL_MS / 3600000} h.
  show | use show             stato corrente

Opzioni: --session <id> (default: $JVC_SESSION_ID, poi .jvc/current-session)
         --workspace <dir> (default: $JVC_WORKSPACE, poi $CLAUDE_PROJECT_DIR, poi la cartella corrente)
         --json --help

Exit code: 0 ok · 1 errore utente · 2 errore di sistema · 3 violazione di policy.`;

function summary(session) {
  if (!session) return "nessun cliente attivo";
  return `cliente ${session.customer} · scope ${session.scope ?? "—"} · modalità ${session.mode} · budget ${session.budget.used}/${session.budget.tokens}`;
}

export async function run(argv, env = process.env) {
  const { opts, positional } = parseArgs(argv, { flags: ["new"] });
  const asJson = !!opts.json;
  if (opts.help || positional.length === 0) { console.log(HELP); return positional.length === 0 && !opts.help ? 1 : 0; }
  // Come gli hook (workspaceRoot): JVC_WORKSPACE > CLAUDE_PROJECT_DIR > cwd (#15).
  const ws = resolve(opts.workspace || env.JVC_WORKSPACE || env.CLAUDE_PROJECT_DIR || process.cwd());
  const actor = actorOf(env);
  try {
    const sid = resolveSessionId({ workspace: ws, arg: opts.session, env });
    if (!sid) throw new CliError(1, "nessuna sessione risolvibile: passa --session <id> o avvia la sessione nel workspace (SessionStart scrive .jvc/current-session)");
    const [action, what, value] = positional;
    let result;
    // `use show`: commands/use.md antepone sempre `use` agli argomenti (#10).
    if (action === "show" || (action === "use" && what === "show")) {
      const { pointer, session } = loadOrExplain(ws, sid);
      result = { session_id: sid, pointer, session };
    } else if (action === "use" && what === "customer") result = await useCustomer(ws, sid, value, { create: !!opts.new, actor });
    else if (action === "use" && what === "scope") result = useScope(ws, sid, value, { actor });
    else if (action === "use" && what === "mode") result = useMode(ws, sid, value, { actor });
    else if (action === "use" && what === "budget") result = useBudget(ws, sid, value, { actor });
    else if (action === "use" && what === "close-stale") result = useCloseStale(ws, sid, { actor });
    else throw new CliError(1, `azione sconosciuta: ${positional.join(" ")}`);
    if (asJson) console.log(JSON.stringify({ ok: true, ...result }));
    else console.log(summary(result.session));
    return 0;
  } catch (err) {
    if (err instanceof CliError) return fail(asJson, err.code, err.message, err.extra);
    return fail(asJson, 2, `errore di sistema: ${err?.message ?? err}`);
  }
}

if (isMain(import.meta.url)) {
  run(process.argv.slice(2)).then((code) => process.exit(code), (err) => { console.error(err); process.exit(2); });
}
