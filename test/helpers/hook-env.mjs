// Helper condivisi dai test degli hook e degli script di sessione: workspace
// temporaneo, ambiente pulito (niente variabili della sessione Claude Code
// che esegue i test), esecuzione di un hook come processo con stdin simulato.
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, appendFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("../..", import.meta.url));
export const hookScript = (name) => join(ROOT, "hooks", "scripts", `${name}.mjs`);
export const SESSION_CLI = join(ROOT, "scripts", "admin", "session.mjs");

const INHERITED = ["JVC_WORKSPACE", "CLAUDE_PROJECT_DIR", "CLAUDE_PLUGIN_ROOT", "JVC_SESSION_ID", "CLAUDE_ENV_FILE", "JVC_TEST_THROW"];
export function cleanEnv(extra = {}) {
  const e = { ...process.env };
  for (const k of INHERITED) delete e[k];
  return { ...e, ...extra };
}

// Workspace JVC minimo: product/, customers/ACME e customers/BETA con le celle
// CAT e ADM, analysis/ e un .jvc/ vuoto.
export function mkWs(prefix = "jvc-") {
  const ws = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  for (const d of [
    "product/kb/scopes/CAT", "product/kb/scopes/ADM", "product/analysis/briefings",
    "customers/ACME/kb/scopes/CAT/flows", "customers/ACME/kb/scopes/ADM/configs", "customers/ACME/kb/scopes/XSC/integrations",
    "customers/ACME/kb/handoffs", "customers/ACME/analysis/briefings", "customers/ACME/analysis/patterns",
    "customers/ACME/lessons", "customers/ACME/tests/cases/CAT", "customers/ACME/_inbox/CAT", "customers/ACME/_inbox/ADM",
    "customers/BETA/kb/scopes/CAT", "customers/BETA/lessons", ".jvc/sessions",
  ]) mkdirSync(join(ws, d), { recursive: true });
  writeFileSync(join(ws, "customers/ACME/kb/scopes/CAT/flows/C.ACME.CAT.FLW.0001.yaml"), "id: C.ACME.CAT.FLW.0001\n");
  writeFileSync(join(ws, "customers/ACME/kb/scopes/ADM/configs/C.ACME.ADM.CFG.0019.yaml"), "id: C.ACME.ADM.CFG.0019\n");
  writeFileSync(join(ws, "customers/BETA/kb/scopes/CAT/secret.yaml"), "id: C.BETA.CAT.FLW.0001\n");
  return ws;
}

// Scrive puntatore + session.json per una sessione con cliente/scope/modo dati,
// senza passare dalla CLI (per i test degli hook).
export function seedSession(ws, { sid = "sess-1", customer = "ACME", scope = "CAT", mode = "nrt", budget, allowed_paths, pending, extra = {} } = {}) {
  mkdirSync(join(ws, ".jvc/sessions"), { recursive: true });
  writeFileSync(join(ws, ".jvc/current-session"), sid);
  if (!customer) {
    writeFileSync(join(ws, `.jvc/sessions/${sid}.json`), JSON.stringify({ session_id: sid, customer: null, path: null }));
    return null;
  }
  const dir = join(ws, "customers", customer, ".sessions", sid);
  mkdirSync(join(dir, "blackboard"), { recursive: true });
  const rel = `customers/${customer}/.sessions/${sid}/session.json`;
  writeFileSync(join(ws, `.jvc/sessions/${sid}.json`), JSON.stringify({ session_id: sid, customer, path: rel }));
  const S = scope;
  const session = {
    session_id: sid, customer, scope, mode, env: null,
    budget: budget ?? { tokens: 200000, used: 0, by_model: { haiku: 0, sonnet: 0, opus: 0 } },
    allowed_paths: allowed_paths ?? (S ? [
      `product/kb/scopes/${S}/**`, `product/kb/handoffs/*${S}*`, `customers/${customer}/kb/scopes/${S}/**`, `customers/${customer}/kb/handoffs/*${S}*`,
      `customers/${customer}/kb/scopes/XSC/integrations/**`, `customers/${customer}/tests/**/${S}/**`, `customers/${customer}/_inbox/${S}/**`,
      `customers/${customer}/lessons/**`, `customers/${customer}/.sessions/${sid}/**`,
    ] : []),
    pending: pending ?? { compensations: [], approvals: [], questions: [], expected_outcomes: [] },
    surprises: [], ledger: { invocations: [], trace_blocks: {} },
    hypotheses_file: `.sessions/${sid}/hypotheses.yaml`, blackboard_dir: `.sessions/${sid}/blackboard/`,
    last_compact_summary: null, knowledge_version: "1", plugin_version: "0.1.0",
    updated_at: new Date().toISOString(), ...extra,
  };
  writeFileSync(join(dir, "session.json"), JSON.stringify(session, null, 2));
  return join(dir, "session.json");
}

// Esegue un hook come processo separato con stdin simulato.
export function runHook(name, input, env = {}) {
  const t0 = performance.now();
  const r = spawnSync(process.execPath, [hookScript(name)], {
    input: typeof input === "string" ? input : JSON.stringify(input),
    env: cleanEnv(env), encoding: "utf8", timeout: 15000,
  });
  const ms = performance.now() - t0;
  // test/timing/guards.timing.mjs: registra ogni chiamata (nome, durata).
  if (process.env.JVC_TIMING_LOG) appendFileSync(process.env.JVC_TIMING_LOG, `${JSON.stringify({ name, ms })}
`);
  let json = null;
  try { json = r.stdout.trim() ? JSON.parse(r.stdout) : null; } catch { json = { unparsable: r.stdout }; }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json, ms };
}

export const decisionOf = (r) => r.json?.hookSpecificOutput?.permissionDecision ?? null;
export const reasonOf = (r) => r.json?.hookSpecificOutput?.permissionDecisionReason ?? "";

export function runSessionCli(args, env = {}) {
  const r = spawnSync(process.execPath, [SESSION_CLI, ...args], { env: cleanEnv(env), encoding: "utf8", timeout: 30000 });
  let json = null;
  try { json = JSON.parse(r.stdout.trim().split("\n").pop()); } catch { /* output non JSON */ }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

// WP09c giro 1 (C1 b): config/xray.yaml fissato nella sessione con sha256, come fa `use customer` (assente ⇒ sha256 null).
export function pinXray(ws, { sid = "sess-1", customer = "ACME" } = {}) {
  const f = join(ws, "customers", customer, "config", "xray.yaml");
  let sha = null;
  try { sha = createHash("sha256").update(readFileSync(f)).digest("hex"); } catch { sha = null; }
  const sf = join(ws, "customers", customer, ".sessions", sid, "session.json");
  const s = JSON.parse(readFileSync(sf, "utf8"));
  s.alm = { ...(s.alm ?? {}), config: { file: `customers/${customer}/config/xray.yaml`, sha256: sha, pinned_at: new Date().toISOString() } };
  writeFileSync(sf, JSON.stringify(s, null, 2));
  return sha;
}
