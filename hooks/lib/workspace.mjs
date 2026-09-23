// Dove sono le cose: radice del workspace (il repository di conoscenza),
// radice del plugin, puntatore di sessione e session.json. Gli hook leggono
// un solo file di stato (§49.2): niente DB, niente moduli pesanti.
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileAtomic } from "./fsx.mjs";

export const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const CUSTOMER_RE = /^[A-Z0-9]{4}$/;

export const isSafeSessionId = (s) => typeof s === "string" && SESSION_ID_RE.test(s) && !s.includes("..");

// JVC_WORKSPACE (override esplicito) > CLAUDE_PROJECT_DIR (radice del progetto,
// stabile anche se la shell cambia cartella) > cwd dell'hook > cwd del processo.
export function workspaceRoot(input = {}, env = process.env) {
  return resolve(env.JVC_WORKSPACE || env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd());
}

export function pluginRoot(env = process.env) {
  return resolve(env.CLAUDE_PLUGIN_ROOT || join(dirname(fileURLToPath(import.meta.url)), "..", ".."));
}

// Un workspace è "JVC" se contiene almeno una delle cartelle del plugin: fuori
// da un workspace JVC gli hook non esprimono opinioni (il plugin può essere
// abilitato a livello utente e non deve interferire con altri progetti).
export function isJvcWorkspace(ws) {
  return existsSync(join(ws, ".jvc")) || existsSync(join(ws, "customers")) || existsSync(join(ws, "product"));
}

export const pointerFile = (ws, sid) => join(ws, ".jvc", "sessions", `${sid}.json`);
export const currentSessionFile = (ws) => join(ws, ".jvc", "current-session");
export const sessionDir = (ws, customer, sid) => join(ws, "customers", customer, ".sessions", sid);
export const sessionFile = (ws, customer, sid) => join(sessionDir(ws, customer, sid), "session.json");
export const sessionRelPath = (customer, sid) => `customers/${customer}/.sessions/${sid}/session.json`;
export const invocationsFile = (ws, customer, sid) => join(sessionDir(ws, customer, sid), "invocations.jsonl");
// Senza cliente il riassunto di compattazione vive accanto al puntatore.
export const compactSummaryFile = (ws, customer, sid) => (customer ? join(sessionDir(ws, customer, sid), "compact-summary.md") : join(ws, ".jvc", "sessions", `${sid}.compact-summary.md`));

export function readCurrentSession(ws) {
  try {
    const s = readFileSync(currentSessionFile(ws), "utf8").trim();
    return isSafeSessionId(s) ? s : null;
  } catch { return null; }
}

// Il puntatore corrotto è un errore (i guard lo trasformano in deny); il
// puntatore assente è "nessun cliente".
export function readPointer(ws, sid) {
  if (!isSafeSessionId(sid)) return null;
  let text;
  try { text = readFileSync(pointerFile(ws, sid), "utf8"); } catch (err) { if (err.code === "ENOENT") return null; throw err; }
  const p = JSON.parse(text);
  if (p.customer != null && !CUSTOMER_RE.test(p.customer)) throw new Error(`puntatore di sessione con cliente non valido: ${p.customer}`);
  return p;
}

export function writePointer(ws, sid, customer) {
  mkdirSync(join(ws, ".jvc", "sessions"), { recursive: true });
  const ptr = { session_id: sid, customer: customer ?? null, path: customer ? sessionRelPath(customer, sid) : null, updated_at: new Date().toISOString() };
  writeFileAtomic(pointerFile(ws, sid), JSON.stringify(ptr, null, 2) + "\n");
  return ptr;
}

export function writeCurrentSession(ws, sid) {
  mkdirSync(join(ws, ".jvc"), { recursive: true });
  writeFileAtomic(currentSessionFile(ws), sid + "\n");
}

// Stato letto da un hook: session_id dall'input (o current-session), cliente
// dal puntatore, session.json calcolato (mai dal campo `path` del puntatore).
export function loadHookState(input = {}, env = process.env) {
  const ws = workspaceRoot(input, env);
  const jvc = isJvcWorkspace(ws);
  const sid = isSafeSessionId(input.session_id) ? input.session_id : readCurrentSession(ws);
  const state = { ws, jvc, sid, pointer: null, customer: null, session: null, sessionFile: null };
  if (!jvc || !sid) return state;
  state.pointer = readPointer(ws, sid);
  const customer = state.pointer?.customer ?? null;
  if (!customer) return state;
  state.customer = customer;
  state.sessionFile = sessionFile(ws, customer, sid);
  let text = null;
  try { text = readFileSync(state.sessionFile, "utf8"); } catch (err) { if (err.code !== "ENOENT") throw err; }
  if (text != null) {
    state.session = JSON.parse(text);
    if (state.session.customer !== customer) throw new Error("session.json e puntatore indicano clienti diversi");
  }
  return state;
}

// Il nome base di un agent_type: i sub-agenti di plugin possono arrivare come
// "jaggaer-virtual-consultant:scope-expert".
export const baseAgentType = (t) => (typeof t === "string" && t ? t.slice(t.lastIndexOf(":") + 1) : null);
