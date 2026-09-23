// Helper dei test K5: workspace con environments.yaml (esempio di §51.1), sessione
// con ambiente dichiarato (come `use env`) e verificato (come env-check), piani e
// voci dell'Atlas (SEL) per i guard del browser.
import { mkdirSync, writeFileSync, readFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { mkWs, seedSession, runHook, ROOT } from "./hook-env.mjs";
import { normalizeEnvironment, sha256 } from "../../scripts/kb/validate-env.mjs";

export const ENV_FIXTURE = join(ROOT, "test/fixtures/env/environments.yaml");
const DOC = YAML.parse(readFileSync(ENV_FIXTURE, "utf8"));

// Voce session.env come la scrive `use env` (+ verifica come env-check).
export function envEntry(id, { verified = true, doc = DOC, text = readFileSync(ENV_FIXTURE, "utf8"), remediation = null, remediationText = null } = {}) {
  const n = normalizeEnvironment(doc.environments.find((e) => e.id === id));
  return {
    id: n.id, type: n.type, label: n.label ?? null, base_url: n.base_url, allowed_hosts: n.allowed_hosts, policy: n.policy,
    source_sha256: sha256(text), remediation, remediation_sha256: remediationText ? sha256(remediationText) : null,
    declared_at: new Date().toISOString(), verified, verified_at: verified ? new Date().toISOString() : null, signals: {},
  };
}

// ws con cliente ACME, scope ADM, environments.yaml e (opzionale) session.env.
export function envWs({ env = "sandbox", verified = true, extra = {}, scope = "ADM", remediation = null } = {}) {
  const ws = mkWs();
  mkdirSync(join(ws, "customers/ACME/config"), { recursive: true });
  copyFileSync(ENV_FIXTURE, join(ws, "customers/ACME/config/environments.yaml"));
  let remediationText = null;
  if (remediation) { remediationText = YAML.stringify(remediation); writeFileSync(join(ws, "customers/ACME/config/remediation-scope.yaml"), remediationText); }
  seedSession(ws, { scope, extra: { env: env ? envEntry(env, { verified, remediation, remediationText }) : null, ...extra } });
  return ws;
}

export const sessionPath = (ws) => join(ws, "customers/ACME/.sessions/sess-1/session.json");
export const readSession = (ws) => JSON.parse(readFileSync(sessionPath(ws), "utf8"));
export function patchSession(ws, fn) { const s = readSession(ws); fn(s); writeFileSync(sessionPath(ws), JSON.stringify(s, null, 2)); return s; }

// Chiamata di un guard del browser come PreToolUse.
export const browserCall = (guard, ws, tool, tool_input, extra = {}, env = {}) =>
  runHook(guard, { session_id: "sess-1", cwd: ws, hook_event_name: "PreToolUse", tool_name: tool, tool_input, ...extra }, { JVC_WORKSPACE: ws, CLAUDE_PLUGIN_ROOT: ROOT, ...env });

// Voce dell'Atlas (SEL) con role/effect in kb/scopes/<scope>/selectors/<code>.yaml.
export function writeSel(ws, code, { role = "button", effect = "read", label = "x" } = {}) {
  const [level, cust, scope] = code.split(".");
  const base = level === "S" ? join(ws, "product/kb") : join(ws, "customers", cust, "kb");
  const dir = join(base, "scopes", scope, "selectors");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${code}.yaml`), YAML.stringify({
    id: code, type: "SEL", title: `Selettore ${label}`, summary: `Voce dell'Atlas: ${label}.`, role, ...(effect == null ? {} : { effect }),
    strategies: [{ kind: "role", value: role, name: label }],
    facets: { F1: "osservazione-chrome", F4: "comportamento-ui", F5: "saas-core", F6: [], F7: "nessuno", F8: "specifica", F9: "ripetitiva", F10: "R0", F11: "deterministico", F12: "validato", F13: { verified_at: "2026-09-01", release: "R25.2" }, F15: "empirica" },
    sources: [{ obs: "L.ACME.ADM.OBS.0001" }],
  }));
}

// Piano (JSON) in customers/ACME/runs/<run>/plan.json → percorso relativo alla cartella del cliente.
export function writePlan(ws, plan, run = "RUN.0001") {
  const dir = join(ws, "customers/ACME/runs", run);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "plan.json"), JSON.stringify(plan, null, 2));
  return `runs/${run}/plan.json`;
}

export { mkWs, seedSession, ROOT };
