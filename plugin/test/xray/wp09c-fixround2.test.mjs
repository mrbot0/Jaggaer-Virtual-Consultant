// WP09c giro di correzione 2 — Important 1 (scorciatoia "senza sessione" scelta con --workspace) e Minor 1 (import in
// coda completabile in una sessione successiva). Sonde come input degli hook; CLI solo contro il mock HTTP locale.
//  (1) customers/*/config/** e customers/*/queue/** protetti a ogni profondità (anche <ws>/tmp/customers/…);
//  (2) script xray: --workspace diverso da quello degli hook (JVC_WORKSPACE > CLAUDE_PROJECT_DIR > cwd) con una sessione
//      attiva ⇒ rifiuto;
//  (3) sessione JVC attiva nel workspace reale ⇒ mai la scorciatoia CI (senza sessione per il cliente ⇒ rifiuto);
//  Minor 1: esecuzione creata dal plugin in una sessione precedente (provenienza nella mappa protetta e nella voce di
//      coda) ⇒ retry-queued e publish la completano, senza registrarla come creata nella nuova sessione.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import YAML from "yaml";
import { mkWs, seedSession, cleanEnv, pinXray, runHook, decisionOf, ROOT } from "../helpers/hook-env.mjs";
import { envWs } from "../helpers/env-fixture.mjs";
import { startAlmMock, almPlugin, CREDS } from "../helpers/alm-http-mock.mjs";

const RUN = "RUN.ACME.20260929.1000.P2P";
const CASE = "NRT.ACME.P2P.NEG.0031";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 5, 5]);
let A; let PLUGIN;
before(async () => { A = await startAlmMock({ tests: [{ key: "PROJ-31", summary: "x", labels: [] }] }); PLUGIN = almPlugin(); });
after(async () => { await A.close(); });

const cli = (name, args, env) => new Promise((resolve) => {
  const ch = spawn(process.execPath, [join(PLUGIN, "scripts/xray", `${name}.mjs`), ...args, "--json"], { env: cleanEnv({ ...CREDS, ...env }) });
  let stdout = ""; let stderr = "";
  ch.stdout.on("data", (d) => { stdout += d; }); ch.stderr.on("data", (d) => { stderr += d; });
  ch.on("close", (status) => { let json = null; try { json = JSON.parse(stdout.trim().split("\n").pop()); } catch { json = null; } resolve({ status, stdout, stderr, json }); });
});
function dossier(root) {
  mkdirSync(join(root, "customers/ACME/config"), { recursive: true });
  writeFileSync(join(root, "customers/ACME/config/xray.yaml"), `deployment: server\nbase_url: ${A.url}\nproject: PROJ\ntest_plan_by_scope: { P2P: PROJ-50 }\nnetwork: { retries: 1, backoff_ms: 0, timeout_ms: 3000 }\n`);
  const dir = join(root, "customers/ACME/runs", RUN, "cases", CASE);
  mkdirSync(join(dir, "evidence"), { recursive: true });
  writeFileSync(join(dir, "plan.json"), JSON.stringify({ plan_id: `PLAN.${CASE}`, steps: [{ n: 1, verb: "NAVIGATE", action_class: "ACT-OBS" }, { n: 2, verb: "SAVE", action_class: "ACT-OBS" }] }));
  writeFileSync(join(dir, "evidence/01.png"), PNG);
  writeFileSync(join(dir, "evidence/01.yaml"), YAML.stringify({ id: "EV-01", type: "EVD", plan: `PLAN.${CASE}`, step: 2, scope: "P2P", kind: "failure", profile: "strict", publishable: true, sha256: createHash("sha256").update(PNG).digest("hex"), file: `customers/ACME/runs/${RUN}/cases/${CASE}/evidence/01.png` }));
  mkdirSync(join(root, "customers/ACME/tests/cases/P2P"), { recursive: true });
  writeFileSync(join(root, "customers/ACME/tests/cases/P2P", `${CASE}.yaml`), YAML.stringify({ id: CASE, alm: { test_key: "PROJ-31" } }));
}

test("(1) protezione a ogni profondità: <ws>/tmp/customers/ACME/config e /queue negati a sessione e sub-agente", () => {
  const ws = envWs({ env: "sandbox" });
  const call = (tool, ti, extra = {}) => runHook("guard-config-scope", { session_id: "sess-1", cwd: ws, hook_event_name: "PreToolUse", tool_name: tool, tool_input: ti, ...extra }, { JVC_WORKSPACE: ws, CLAUDE_PLUGIN_ROOT: ROOT });
  for (const extra of [{}, { agent_id: "a1", agent_type: "jaggaer-virtual-consultant:scope-expert" }]) {
    for (const t of [join(ws, "tmp/customers/ACME/config/xray.yaml"), join(ws, "tmp/customers/ACME/queue/Q.20260929100000.abcdef.json"), join(ws, "a/b/customers/ACME/config/environments.yaml")]) {
      assert.equal(decisionOf(call("Write", { file_path: t, content: "x" }, extra)), "deny", t);
    }
    for (const cmd of ["cp /tmp/q.json tmp/customers/ACME/queue/Q.1.json", "echo 'base_url: https://x.atlassian.net' > tmp/customers/ACME/config/xray.yaml", "mkdir -p tmp/customers/ACME/queue && cp /tmp/q.json tmp/customers/ACME/queue/"]) {
      assert.equal(decisionOf(call("Bash", { command: cmd }, extra)), "deny", cmd);
    }
  }
});

test("(2)(3) sessione attiva: --workspace diverso da quello degli hook ⇒ rifiuto; nessuna scorciatoia CI; nessun import nell'esecuzione umana", async () => {
  const ws = mkWs();
  seedSession(ws, { scope: "P2P" });
  dossier(ws);
  pinXray(ws);
  // workspace "senza sessione" dentro il workspace (le scritture le avrebbe negate il guard: qui le prepara il test)
  const fake = join(ws, "tmp");
  dossier(fake);
  mkdirSync(join(fake, "customers/ACME/queue"), { recursive: true });
  writeFileSync(join(fake, "customers/ACME/queue/Q.20260929100000.aaaaaa.json"), JSON.stringify({ id: "Q.20260929100000.aaaaaa", op: "import", customer: "ACME", run: null, scope: null, status: "pending", attempts: 0, payload: { execution_key: "PROJ-31", results: { tests: [{ testKey: "PROJ-31", status: "PASSED" }] } } }));
  const imports = A.state.imports.length;
  for (const env of [{ JVC_WORKSPACE: ws }, { CLAUDE_PROJECT_DIR: ws }, { JVC_WORKSPACE: ws, JVC_SESSION_ID: "sess-1" }]) {
    for (const [name, args] of [["retry-queued", ["--workspace", fake, "--customer", "ACME"]], ["publish", ["--run", RUN, "--workspace", fake, "--customer", "ACME"]], ["build-payload", ["--run", RUN, "--workspace", fake, "--customer", "ACME"]], ["authenticate", ["--workspace", fake, "--customer", "ACME"]]]) {
      const r = await cli(name, args, env);
      assert.notEqual(r.status, 0, `${name} ${JSON.stringify(env)}: ${r.stdout}`);
      assert.match(r.json?.error ?? "", /workspace/, name);
    }
  }
  assert.equal(A.state.imports.length, imports, "nessun import");
  // stesso workspace, sessione attiva ma senza stato per il cliente BETA ⇒ niente scorciatoia CI
  mkdirSync(join(ws, "customers/BETA/config"), { recursive: true });
  writeFileSync(join(ws, "customers/BETA/config/xray.yaml"), `deployment: server\nbase_url: ${A.url}\nproject: PROJ\n`);
  const b = await cli("authenticate", ["--workspace", ws, "--customer", "BETA"], { JVC_WORKSPACE: ws });
  assert.notEqual(b.status, 0);
  assert.match(b.json.error, /sessione JVC attiva/);
  // il workspace degli hook stesso: ammesso
  assert.equal((await cli("authenticate", ["--workspace", ws], { JVC_WORKSPACE: ws })).status, 0);
});

test("Minor 1 — rete giù dopo la creazione dell'esecuzione: la voce in coda si completa in una sessione successiva (provenienza del plugin), senza registrare la chiave nella nuova sessione", async () => {
  const ws = mkWs();
  seedSession(ws, { scope: "P2P" });
  dossier(ws);
  pinXray(ws);
  const env = { JVC_WORKSPACE: ws };
  A.setFail({ path: /\/rest\/raven\/1\.0\/import\/execution$/, status: 503 });
  let key;
  try {
    const p = await cli("publish", ["--run", RUN, `${CASE}=ERROR-BLOCKING@2`], env);
    assert.equal(p.status, 0, p.stdout + p.stderr);
    assert.equal(p.json.executions[0].status, "in coda");
    key = p.json.executions[0].execution_key;
    assert.match(key, /^PROJ-\d+$/, "esecuzione creata prima della caduta della rete");
  } finally { A.setFail(null); }
  const map = JSON.parse(readFileSync(join(ws, "customers/ACME/runs", RUN, "xray-executions.json"), "utf8")).scopes.P2P;
  assert.deepEqual([map.key, map.created_by_plugin, typeof map.session_code], [key, true, "string"]);
  const q = readdirSync(join(ws, "customers/ACME/queue")).map((f) => JSON.parse(readFileSync(join(ws, "customers/ACME/queue", f), "utf8")))[0];
  assert.deepEqual([q.provenance?.created_by_plugin, q.provenance?.key], [true, key]);
  // nuova sessione (sess-2): session.alm.created vuoto
  seedSession(ws, { sid: "sess-2", scope: "P2P" });
  pinXray(ws, { sid: "sess-2" });
  const r = await cli("retry-queued", [], env);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(r.json.sent.map((s) => [s.key, s.created]), [[key, false]]);
  assert.equal(A.state.imports.at(-1).key, key, "import completato nell'esecuzione del plugin");
  const s2 = JSON.parse(readFileSync(join(ws, "customers/ACME/.sessions/sess-2/session.json"), "utf8"));
  assert.deepEqual(s2.alm?.created ?? [], [], "la chiave non diventa 'creata' nella nuova sessione");
  // publish in una sessione successiva riusa l'esecuzione registrata dal plugin (una sola per run e scope)
  const again = await cli("publish", ["--run", RUN], env);
  assert.equal(again.status, 0, again.stdout);
  assert.equal(again.json.executions[0].execution_key, key);
});
