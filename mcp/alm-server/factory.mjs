// Scelta dell'implementazione AlmAdapter (§46.5): customers/<C>/config/xray.yaml `deployment` = cloud | server | mock,
// validato con schemas/xray-config.schema.json. JVC_ALM_ADAPTER=mock (variabile d'ambiente del processo) forza il mock
// (tenant demo, test del server MCP); nessun altro valore dall'ambiente cambia l'implementazione.
// Contesto: workspace (JVC_WORKSPACE > CLAUDE_PROJECT_DIR > cwd) e cliente (JVC_CUSTOMER > sessione corrente).
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { AlmError, assertAdapter } from "./adapter.mjs";
import { XrayCloudAdapter } from "./xray-cloud.mjs";
import { XrayServerAdapter } from "./xray-server.mjs";
import { MockAlmAdapter } from "./mock.mjs";

export const DEFAULTS = Object.freeze({ offline_queue: true, allow_test_issue_creation: false, attachments_cap: 5, statuses: { error_environment: "ABORTED" } });
const CUSTOMER = /^[A-Z0-9]{4}$/;

export const xrayConfigFile = (ws, customer) => join(ws, "customers", customer, "config", "xray.yaml");

export async function loadXrayConfig(ws, customer, { required = true } = {}) {
  if (!CUSTOMER.test(String(customer ?? ""))) throw new AlmError("config", `cliente non valido: ${JSON.stringify(customer)}`);
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

export function createAdapter(config, { env = process.env, fetchImpl, file } = {}) {
  const kind = env.JVC_ALM_ADAPTER === "mock" ? "mock" : config?.deployment;
  let a;
  if (kind === "cloud") a = new XrayCloudAdapter(config, { env, fetchImpl });
  else if (kind === "server") a = new XrayServerAdapter(config, { env, fetchImpl });
  else if (kind === "mock") a = new MockAlmAdapter(config ?? {}, { env, file });
  else throw new AlmError("config", `deployment non valido in config/xray.yaml: ${JSON.stringify(config?.deployment)} (cloud | server | mock)`);
  return assertAdapter(a);
}

export function resolveWorkspace(env = process.env, cwd = process.cwd()) {
  return resolve(env.JVC_WORKSPACE || env.CLAUDE_PROJECT_DIR || cwd);
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
export async function almContext({ env = process.env, cwd = process.cwd(), customer = null, ws = null, fetchImpl, file } = {}) {
  const w = ws ?? resolveWorkspace(env, cwd);
  const c = resolveCustomer(w, env, customer);
  if (!c) {
    if (env.JVC_ALM_ADAPTER === "mock") return { ws: w, customer: null, config: { ...DEFAULTS, deployment: "mock" }, adapter: createAdapter({ ...DEFAULTS, deployment: "mock" }, { env, file }) };
    throw new AlmError("config", "nessun cliente attivo: use customer <ID> (o --customer)");
  }
  let config = await loadXrayConfig(w, c, { required: env.JVC_ALM_ADAPTER !== "mock" });
  if (!config) config = { ...DEFAULTS, deployment: "mock" };
  return { ws: w, customer: c, config, adapter: createAdapter(config, { env, fetchImpl, file }) };
}
