// Scelta dell'implementazione AlmAdapter (§46.5): customers/<C>/config/xray.yaml `deployment` = cloud | server | mock,
// validato con schemas/xray-config.schema.json. JVC_ALM_ADAPTER=mock (variabile d'ambiente del processo) forza il mock
// (tenant demo, test del server MCP); nessun altro valore dall'ambiente cambia l'implementazione.
// Contesto: workspace (JVC_WORKSPACE > CLAUDE_PROJECT_DIR > cwd) e cliente (JVC_CUSTOMER > sessione corrente).
import { readFileSync, existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { AlmError, assertAdapter } from "./adapter.mjs";
import { XrayCloudAdapter } from "./xray-cloud.mjs";
import { XrayServerAdapter } from "./xray-server.mjs";
import { MockAlmAdapter } from "./mock.mjs";
import { xrayPinRefusal } from "../../hooks/lib/alm.mjs";
import { workspaceRoot, readCurrentSession } from "../../hooks/lib/workspace.mjs";

export const DEFAULTS = Object.freeze({ offline_queue: true, allow_test_issue_creation: false, attachments_cap: 5, statuses: { error_environment: "ABORTED" } });
const CUSTOMER = /^[A-Z0-9]{4}$/;

export const xrayConfigFile = (ws, customer) => join(ws, "customers", customer, "config", "xray.yaml");

// WP09c giro 2 (Important 1): il workspace degli hook (stessa risoluzione: JVC_WORKSPACE > CLAUDE_PROJECT_DIR > cwd) e
// la sua sessione JVC attiva. Con una sessione attiva: (2) il workspace di lavoro (--workspace) deve essere quello degli
// hook; (3) mai la scorciatoia "senza sessione" (CI).
const canonPath = (p) => { let r; try { r = realpathSync.native(p); } catch { r = resolve(p); } return process.platform === "win32" ? r.toLowerCase() : r; };
export function hookWorkspace(env = process.env) { return workspaceRoot({}, env); }
export function activeSessionId(ws, env = process.env) {
  const envSid = env.JVC_SESSION_ID && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(env.JVC_SESSION_ID) ? env.JVC_SESSION_ID : null;
  if (envSid && existsSync(join(ws, ".jvc", "sessions", `${envSid}.json`))) return envSid;
  return readCurrentSession(ws) ?? (existsSync(join(ws, ".jvc", "current-session")) ? "?" : null);
}
export function assertHookWorkspace(ws, env = process.env) {
  const real = hookWorkspace(env);
  const sid = activeSessionId(real, env);
  if (!sid) return null;
  if (canonPath(ws) !== canonPath(real)) throw new AlmError("refused", `workspace ${ws} diverso da quello della sessione JVC attiva (${real}): gli script ALM lavorano solo nel workspace della sessione`);
  return sid;
}

// session.json della sessione corrente PER QUESTO cliente (null: nessuna sessione JVC, es. CI senza Claude).
export function customerSession(ws, customer, env = process.env) {
  const realSid = assertHookWorkspace(ws, env);
  const sid = realSid && realSid !== "?" ? realSid : currentSession(ws, env).sid;
  let s = null;
  if (sid) { try { s = JSON.parse(readFileSync(join(ws, "customers", customer, ".sessions", sid, "session.json"), "utf8")); } catch { s = null; } }
  if (!s && realSid) throw new AlmError("refused", `sessione JVC attiva senza stato per il cliente ${customer}: \`use customer ${customer}\` prima (nessuna scorciatoia "senza sessione")`);
  return s;
}
// WP09c giro 1 (I1): chiavi create dal plugin in questa sessione; null senza sessione (CI: nessun modello).
export function sessionCreatedKeys(ws, customer, env = process.env) {
  const s = customerSession(ws, customer, env);
  if (!s) return null;
  return new Set((Array.isArray(s.alm?.created) ? s.alm.created : []).map((x) => String(typeof x === "string" ? x : x?.key ?? "").toUpperCase()).filter(Boolean));
}
export function ownedExecution(ws, customer, key, env = process.env) {
  const keys = sessionCreatedKeys(ws, customer, env);
  return keys === null || keys.has(String(key).toUpperCase());
}

// WP09c giro 1 (C1 b): con una sessione JVC su questo cliente, xray.yaml deve essere quello fissato a use customer.
export function assertPinned(ws, customer, env = process.env) {
  const session = customerSession(ws, customer, env);
  if (!session) return;
  const why = xrayPinRefusal(ws, customer, session);
  if (why) throw new AlmError("refused", why);
}

export async function loadXrayConfig(ws, customer, { required = true, env = process.env } = {}) {
  if (!CUSTOMER.test(String(customer ?? ""))) throw new AlmError("config", `cliente non valido: ${JSON.stringify(customer)}`);
  assertPinned(ws, customer, env);
  const f = xrayConfigFile(ws, customer);
  if (!existsSync(f)) {
    if (required) throw new AlmError("config", `config/xray.yaml assente per ${customer}: l'ALM non è configurato (schemas/xray-config.schema.json)`);
    return null;
  }
  const YAML = (await import("yaml")).default;
  let doc;
  try { doc = YAML.parse(readFileSync(f, "utf8")) ?? {}; } catch (err) { throw new AlmError("config", `config/xray.yaml non è YAML valido: ${String(err.message).slice(0, 120)}`); }
  const { validateWith } = await import("../../scripts/lib/schemas.mjs");
  const v = validateWith("xray-config.schema.json", doc);
  if (!v.ok) throw new AlmError("config", `config/xray.yaml non conforme: ${v.errors.slice(0, 3).join("; ")}`);
  return { ...DEFAULTS, ...doc, statuses: { ...DEFAULTS.statuses, ...(doc.statuses ?? {}) } };
}

export function createAdapter(config, { env = process.env, fetchImpl, file, networkHosts = null } = {}) {
  const kind = env.JVC_ALM_ADAPTER === "mock" ? "mock" : config?.deployment;
  let a;
  if (kind === "cloud") a = new XrayCloudAdapter(config, { env, fetchImpl, networkHosts });
  else if (kind === "server") a = new XrayServerAdapter(config, { env, fetchImpl, networkHosts });
  else if (kind === "mock") a = new MockAlmAdapter(config ?? {}, { env, file });
  else throw new AlmError("config", `deployment non valido in config/xray.yaml: ${JSON.stringify(config?.deployment)} (cloud | server | mock)`);
  return assertAdapter(a);
}

// giro 2: la stessa risoluzione degli hook (hooks/lib/workspace.mjs workspaceRoot)
export function resolveWorkspace(env = process.env, cwd = process.cwd()) {
  return workspaceRoot({ cwd }, env);
}
// Sessione corrente: .jvc/current-session → .jvc/sessions/<id>.json (cliente) → session.json (sola lettura).
export function currentSession(ws, env = process.env) {
  let sid = env.JVC_SESSION_ID || null;
  try { sid = sid || readFileSync(join(ws, ".jvc", "current-session"), "utf8").trim(); } catch { sid = null; }
  if (!sid || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(sid)) return { sid: null, customer: null, session: null };
  let customer = null;
  try { customer = JSON.parse(readFileSync(join(ws, ".jvc", "sessions", `${sid}.json`), "utf8")).customer ?? null; } catch { customer = null; }
  if (!customer || !CUSTOMER.test(customer)) return { sid, customer: null, session: null };
  let session = null;
  try { session = JSON.parse(readFileSync(join(ws, "customers", customer, ".sessions", sid, "session.json"), "utf8")); } catch { session = null; }
  return { sid, customer, session };
}
export function resolveCustomer(ws, env = process.env, explicit = null) {
  const c = explicit ?? env.JVC_CUSTOMER ?? currentSession(ws, env).customer;
  return c && CUSTOMER.test(c) ? c : null;
}

// Contesto completo per il server MCP e gli script: { ws, customer, config, adapter }.
export async function almContext({ env = process.env, cwd = process.cwd(), customer = null, ws = null, fetchImpl, file, networkHosts = null } = {}) {
  const w = ws ?? resolveWorkspace(env, cwd);
  const c = resolveCustomer(w, env, customer);
  if (!c) {
    if (env.JVC_ALM_ADAPTER === "mock") return { ws: w, customer: null, config: { ...DEFAULTS, deployment: "mock" }, adapter: createAdapter({ ...DEFAULTS, deployment: "mock" }, { env, file }) };
    throw new AlmError("config", "nessun cliente attivo: use customer <ID> (o --customer)");
  }
  let config = await loadXrayConfig(w, c, { required: env.JVC_ALM_ADAPTER !== "mock", env });
  if (!config) config = { ...DEFAULTS, deployment: "mock" };
  return { ws: w, customer: c, config, adapter: createAdapter(config, { env, fetchImpl, file, networkHosts }) };
}
