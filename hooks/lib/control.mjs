// Registro di controllo dell'utente sugli agenti (WP10d D8, D2): customers/<C>/.sessions/<sid>/control.jsonl,
// append-only con catena di hash come l'audit e le approvazioni. Lo scrivono SOLO approval-capture (dalle frasi
// dell'utente) e gli hook del plugin (record `confirm`, dopo la conferma nel transcript); è protetto in scrittura da
// guard-scope e guard-config-scope per sessione principale e sub-agenti.
//
// Frasi (parole chiave maiuscole, l'intero prompt, spazi tolleranti):
//   PAUSA AGENTE <task_id> · PAUSA TUTTI              → pause   (aumenta la protezione: vale dal prompt catturato)
//   FERMA AGENTE <task_id> · FERMA TUTTI              → stop    (aumenta; terminale per quel task_id; TUTTI = i compiti
//                                                               dei dispatch aperti alla cattura, registrati in `tasks`)
//   PASSO PASSO <task_id> · PASSO PASSO TUTTI         → step    (aumenta)
//   RIPRENDI AGENTE <task_id> · RIPRENDI TUTTI        → resume  (RIDUCE: vale solo confermata nel transcript)
//   PASSO PASSO OFF                                   → step-off (RIDUCE)
//   SBLOCCA SCOPE <S>                                 → unlock  (RIDUCE: azzera la vigilanza dello scope)
//   LIMITI DISPATCH <chiamate> <minuti>               → limits  (RIDUCE o no: si conferma sempre)
// Un record che riduce la protezione vale solo con un record `confirm` (ref = il suo hash), che un hook appende dopo
// confirmInTranscript (stesse regole della 3A, scripts/admin/approvals.mjs) entro CONFIRM_WINDOW_MS dal record.
// Solo moduli built-in e librerie leggere: lo importa il guard che gira su ogni chiamata dei sub-agenti.
import { readFileSync, appendFileSync, mkdirSync, existsSync, openSync, readSync, fstatSync, closeSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { GENESIS, hashEvent } from "./audit.mjs";
import { withFileLock, writeFileAtomic } from "./fsx.mjs";
import { sessionDir } from "./workspace.mjs";
import { confirmInText } from "../../scripts/admin/approvals.mjs";

// Transcript in cui cercare il prompt dell'utente: quello dell'input e, se è il transcript di un sub-agente
// (<dir>/<session_id>/subagents/agent-<id>.jsonl), quello della sessione principale (<dir>/<session_id>.jsonl).
export function transcriptCandidates(input = {}) {
  const out = [];
  const tp = typeof input.transcript_path === "string" ? input.transcript_path : null;
  if (tp) {
    out.push(tp);
    const m = /^(.*)[\\/]([^\\/]+)[\\/]subagents[\\/][^\\/]+\.jsonl$/.exec(tp);
    if (m) out.push(join(m[1], `${m[2]}.jsonl`));
  }
  return out;
}

export const ALL = "*";
export const DEFAULT_LIMITS = Object.freeze({ calls: 200, minutes: 30 });
export const REDUCING = new Set(["resume", "step-off", "unlock", "limits"]);
export const CONFIRM_WINDOW_MS = 60 * 60000;
export const controlFile = (ws, customer, sid) => join(sessionDir(ws, customer, sid), "control.jsonl");
export const agentsDir = (ws, customer, sid) => join(sessionDir(ws, customer, sid), "agents");
export const safeName = (s) => String(s ?? "").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "_";
export const agentStateFile = (ws, customer, sid, agentId) => join(agentsDir(ws, customer, sid), `${safeName(agentId)}.json`);

// ---- frasi ----
const TASK = "([A-Za-z0-9][A-Za-z0-9._:-]{0,127})";
const SCOPE = "(CAT|SRC|VEN|CON|P2P|INV|QLT|ANL|ADM|XSC)";
const RES = [
  ["pause", new RegExp(`^PAUSA (?:AGENTE ${TASK}|(TUTTI))$`)],
  ["resume", new RegExp(`^RIPRENDI (?:AGENTE ${TASK}|(TUTTI))$`)],
  ["stop", new RegExp(`^FERMA (?:AGENTE ${TASK}|(TUTTI))$`)],
];
const RE_STEP_OFF = /^PASSO PASSO OFF$/;
const RE_STEP = new RegExp(`^PASSO PASSO (?:(TUTTI)|${TASK})$`);
const RE_UNLOCK = new RegExp(`^SBLOCCA SCOPE ${SCOPE}$`);
const RE_LIMITS = /^LIMITI DISPATCH ([1-9]\d{0,4}) ([1-9]\d{0,3})$/;
const RE_ATTEMPT = /^(PAUSA|RIPRENDI|FERMA|PASSO PASSO|SBLOCCA|LIMITI)(?=$|[\s,.;:!?])/;
export const CONTROL_SYNTAX = ["PAUSA AGENTE <task_id>", "PAUSA TUTTI", "RIPRENDI AGENTE <task_id>", "RIPRENDI TUTTI", "FERMA AGENTE <task_id>", "FERMA TUTTI",
  "PASSO PASSO <task_id|TUTTI>", "PASSO PASSO OFF", "SBLOCCA SCOPE <S>", "LIMITI DISPATCH <chiamate> <minuti>"];
// Nei guard le frasi sono cercate da hooks/lib/guards/phrase.mjs (CONTROL_PHRASES).

// → { kind, target?, scope?, calls?, minutes? } | { kind: "attempt" } | null
export function parseControlPrompt(prompt) {
  if (typeof prompt !== "string") return null;
  const s = prompt.replace(/\s+/gu, " ").trim().replace(/[.!]$/u, "");
  if (s.length > 160) return null;
  for (const [kind, re] of RES) {
    const m = re.exec(s);
    if (m) return { kind, target: m[1] ?? ALL };
  }
  if (RE_STEP_OFF.test(s)) return { kind: "step-off", target: ALL };
  let m;
  if ((m = RE_STEP.exec(s))) return { kind: "step", target: m[1] ? ALL : m[2] };
  if ((m = RE_UNLOCK.exec(s))) return { kind: "unlock", scope: m[1] };
  if ((m = RE_LIMITS.exec(s))) return { kind: "limits", calls: Number(m[1]), minutes: Number(m[2]) };
  if (RE_ATTEMPT.test(s)) return { kind: "attempt" };
  return null;
}

export const controlPhraseOf = (r) => ({
  pause: `PAUSA ${r.target === ALL ? "TUTTI" : `AGENTE ${r.target}`}`, resume: `RIPRENDI ${r.target === ALL ? "TUTTI" : `AGENTE ${r.target}`}`,
  stop: `FERMA ${r.target === ALL ? "TUTTI" : `AGENTE ${r.target}`}`, step: `PASSO PASSO ${r.target === ALL ? "TUTTI" : r.target}`, "step-off": "PASSO PASSO OFF",
  unlock: `SBLOCCA SCOPE ${r.scope}`, limits: `LIMITI DISPATCH ${r.calls} ${r.minutes}`,
}[r.kind] ?? "");

// ---- registro ----
export function readControl(file) {
  let text;
  try { text = readFileSync(file, "utf8"); } catch (err) { if (err.code === "ENOENT") return { ok: true, records: [], exists: false }; return { ok: false, reason: `registro illeggibile (${err.code ?? err.message})`, records: [] }; }
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
  return { ok: true, records, exists: true };
}

function appendLocked(file, rec, date) {
  const cur = readControl(file);
  if (!cur.ok) throw new Error(`registro di controllo corrotto: ${cur.reason}`);
  const ev = { ts: date.toISOString(), ...rec, prev_hash: cur.records.at(-1)?.hash ?? GENESIS };
  for (const k of Object.keys(ev)) if (ev[k] === undefined) delete ev[k];
  ev.hash = hashEvent(ev);
  appendFileSync(file, `${JSON.stringify(ev)}\n`);
  return ev;
}

export function appendControl(file, rec, { date = new Date() } = {}) {
  mkdirSync(dirname(file), { recursive: true });
  return withFileLock(`${file}.lock`, () => appendLocked(file, rec, date));
}

// Record che riducono la protezione ancora da confermare (entro la finestra).
export function unconfirmed(records, now = Date.now()) {
  const conf = new Set(records.filter((r) => r.kind === "confirm").map((r) => r.ref));
  return records.filter((r) => REDUCING.has(r.kind) && !conf.has(r.hash) && typeof r.prompt_sha256 === "string" && now - Date.parse(r.ts) <= CONFIRM_WINDOW_MS);
}

// Conferma nel transcript dell'utente i record che riducono la protezione e non sono ancora confermati; per ognuno
// confermato appende un record `confirm` (una lettura del transcript per tutti). → records aggiornati.
// WP10d giro 1 (minore 4): scansione INCREMENTALE del transcript — si leggono solo le righe nuove. Ogni record che
// riduce la protezione porta tx_offset (dimensione del transcript alla cattura meno TX_MARGIN); control-scan.json
// (protetto, accanto al registro) tiene per ogni transcript l'offset già letto e l'ora della lettura: una lettura
// fatta dopo la cattura del record copre le righe fino a quell'offset. Al più MAX_SCAN byte per chiamata (righe
// complete); le regole di conferma sono quelle di confirmInText (approvals.mjs).
export const TX_MARGIN = 64 * 1024;
export const MAX_SCAN = 16 * 1024 * 1024;
export const scanFile = (file) => join(dirname(file), "control-scan.json");
function readSlice(p, start) {
  let fd;
  try { fd = openSync(p, "r"); } catch { return null; }
  try {
    const size = fstatSync(fd).size;
    const from = start > size ? 0 : start;
    const len = Math.min(size - from, MAX_SCAN);
    if (len <= 0) return { text: "", end: from };
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, from);
    const last = buf.lastIndexOf(0x0a);
    if (last < 0) return { text: "", end: from };
    return { text: buf.subarray(0, last + 1).toString("utf8"), end: from + last + 1 };
  } finally { closeSync(fd); }
}
export function confirmPending(file, records, transcriptPaths, { now = Date.now() } = {}) {
  const todo = unconfirmed(records, now);
  if (!todo.length) return records;
  const paths = [...new Set((Array.isArray(transcriptPaths) ? transcriptPaths : [transcriptPaths]).filter((p) => typeof p === "string" && p && existsSync(p)))];
  if (!paths.length) return records;
  const sf = scanFile(file);
  let cache;
  try { cache = JSON.parse(readFileSync(sf, "utf8")); } catch { cache = {}; }
  if (!cache || typeof cache !== "object" || Array.isArray(cache)) cache = {};
  const ok = new Set();
  for (const p of paths) {
    const key = resolve(p);
    const c = cache[key];
    const startOf = (r) => (c && Number.isInteger(c.offset) && Date.parse(c.at) >= Date.parse(r.ts) ? c.offset : Number.isInteger(r.tx_offset) ? r.tx_offset : 0);
    const pending = todo.filter((r) => !ok.has(r));
    if (!pending.length) break;
    const start = Math.min(...pending.map(startOf));
    const slice = readSlice(p, start);
    if (!slice) continue;
    for (const r of pending) if (confirmInText(slice.text, [r]).ok) ok.add(r);
    cache[key] = { offset: slice.end, at: new Date(now).toISOString() };
  }
  try { writeFileAtomic(sf, JSON.stringify(cache)); } catch { /* la cache è un'ottimizzazione */ }
  if (!ok.size) return records;
  withFileLock(`${file}.lock`, () => {
    const cur = readControl(file);
    if (!cur.ok) return;
    const have = new Set(cur.records.filter((x) => x.kind === "confirm").map((x) => x.ref));
    for (const r of ok) if (!have.has(r.hash)) appendLocked(file, { kind: "confirm", ref: r.hash, confirmed_kind: r.kind }, new Date());
  });
  return readControl(file).records;
}

// ---- stato ----
// Per i task_id di un agente (uno, o più candidati se l'identità è ambigua) → { paused, stopped, step, by }.
// Ordine temporale dei record (l'ordine del registro): pause(T|*) → in pausa; resume(T) confermato → riprende solo T;
// resume(*) confermato → riprendono tutti; stop(T|*) → fermato (terminale). step(T|*) → passo-passo; step-off
// confermato → spento per tutti.
export function controlState(records) {
  const conf = new Set(records.filter((r) => r.kind === "confirm").map((r) => r.ref));
  const valid = records.filter((r) => r.kind !== "confirm" && (!REDUCING.has(r.kind) || conf.has(r.hash)));
  const of = (task) => {
    let paused = null;
    let stopped = null;
    let step = null;
    for (const r of valid) {
      // WP10d giro 1 (I1): FERMA TUTTI vale per i dispatch esistenti alla cattura (r.tasks), non per quelli successivi
      const hit = r.target === ALL ? !(r.kind === "stop" && Array.isArray(r.tasks)) || (task != null && r.tasks.includes(task)) : task != null && r.target === task;
      if (r.kind === "pause" && hit) paused = r;
      else if (r.kind === "resume" && hit) paused = null;
      else if (r.kind === "stop" && hit) stopped ??= r;
      else if (r.kind === "step" && hit) step = r;
      else if (r.kind === "step-off") step = null;
    }
    return { paused, stopped, step };
  };
  const forTasks = (tasks) => {
    const list = tasks?.length ? tasks : [null];
    const st = list.map(of);
    return { paused: st.find((x) => x.paused)?.paused ?? null, stopped: st.find((x) => x.stopped)?.stopped ?? null, step: st.find((x) => x.step)?.step ?? null, ambiguous: list.length > 1 };
  };
  const unlockAt = (scope) => valid.filter((r) => r.kind === "unlock" && r.scope === scope).map((r) => r.ts).at(-1) ?? null;
  const lim = valid.filter((r) => r.kind === "limits").at(-1);
  const limits = lim ? { calls: lim.calls, minutes: lim.minutes, set_at: lim.ts } : { ...DEFAULT_LIMITS, set_at: null };
  const allPaused = of(null).paused;
  return { forTasks, unlockAt, limits, allPaused, records: valid };
}
