// WP09c giro di correzione 1 — lato adattatori, server MCP e script (solo mock locali: node:http e mock in memoria):
//  C1 c: solo host che sono SIA in xray.yaml SIA nella categoria alm di NETWORK.md; altrimenti rifiuto PRIMA di ogni
//        credenziale (nessuna richiesta);
//  C1 b: xray.yaml cambiato dopo use customer ⇒ ALM rifiutato (adattatore, server MCP, CLI): nessuna richiesta verso
//        il nuovo host, nessuna credenziale;
//  C1 d: doctor --network controlla anche xray_url;
//  I1:   publish/retry-queued rifiutano chiavi di esecuzione non in session.alm.created e non ne aggiungono; evidenze
//        inline rifiutate anche nella coda;
//  I2:   alm_create_execution idempotente per run+scope (runs/<RUN>/xray-executions.json condiviso con publish);
//  I3:   Server/DC: stati PASS/FAIL/…, campo "evidences";
//  minori: testo del Defect in coda redatto; errore di sistema delle CLI redatto; Xray Cloud si riautentica su 401.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import YAML from "yaml";
import { mkWs, seedSession, cleanEnv, pinXray, runHook, ROOT } from "../helpers/hook-env.mjs";
import { startAlmMock, almPlugin, CREDS } from "../helpers/alm-http-mock.mjs";
import { startMcp, initialized } from "../helpers/mcp-client.mjs";
import { XrayCloudAdapter } from "../../mcp/alm-server/xray-cloud.mjs";
import { XrayServerAdapter } from "../../mcp/alm-server/xray-server.mjs";
import { OfflineQueue } from "../../mcp/alm-server/queue.mjs";
import { AlmError } from "../../mcp/alm-server/adapter.mjs";
import { failWith } from "../../scripts/xray/common.mjs";
import { runChecks } from "../../scripts/admin/doctor.mjs";

const RUN = "RUN.ACME.20260929.1000.P2P";
const CASE = "NRT.ACME.P2P.NEG.0031";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7]);
const NET = { retries: 1, backoff_ms: 0, timeout_ms: 3000 };
let A; let B; let PLUGIN;
before(async () => { A = await startAlmMock({ tests: [{ key: "PROJ-31", summary: "x", labels: [] }] }); B = await startAlmMock(); PLUGIN = almPlugin(); });
after(async () => { await A.close(); await B.close(); });

const spyFetch = () => { const calls = []; const f = async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify("tok"), { status: 200 }); }; f.calls = calls; return f; };
const cli = (name, args, ws, env = {}, plugin = PLUGIN) => new Promise((resolve) => {
  const ch = spawn(process.execPath, [join(plugin, "scripts/xray", `${name}.mjs`), ...args, "--workspace", ws, "--json"], { env: cleanEnv({ ...CREDS, ...env }) });
  let stdout = ""; let stderr = "";
  ch.stdout.on("data", (d) => { stdout += d; }); ch.stderr.on("data", (d) => { stderr += d; });
  ch.on("close", (status) => { let json = null; try { json = JSON.parse(stdout.trim().split("\n").pop()); } catch { json = null; } resolve({ status, stdout, stderr, json }); });
});
function ws(base = A.url, extra = "", { pin = true } = {}) {
  const w = mkWs();
  seedSession(w, { scope: "P2P" });
  mkdirSync(join(w, "customers/ACME/config"), { recursive: true });
  writeFileSync(join(w, "customers/ACME/config/xray.yaml"), `deployment: server\nbase_url: ${base}\nproject: PROJ\ntest_plan_by_scope: { P2P: PROJ-50 }\nnetwork: { retries: 1, backoff_ms: 0, timeout_ms: 3000 }\n${extra}`);
  const dir = join(w, "customers/ACME/runs", RUN, "cases", CASE);
  mkdirSync(join(dir, "evidence"), { recursive: true });
  writeFileSync(join(dir, "plan.json"), JSON.stringify({ plan_id: `PLAN.${CASE}`, steps: [{ n: 1, verb: "NAVIGATE", action_class: "ACT-OBS" }, { n: 2, verb: "SAVE", action_class: "ACT-OBS" }] }));
  writeFileSync(join(dir, "evidence/01.png"), PNG);
  writeFileSync(join(dir, "evidence/01.yaml"), YAML.stringify({ id: "EV-01", type: "EVD", plan: `PLAN.${CASE}`, step: 2, scope: "P2P", kind: "failure", profile: "strict", publishable: true, sha256: createHash("sha256").update(PNG).digest("hex"), file: `customers/ACME/runs/${RUN}/cases/${CASE}/evidence/01.png` }));
  mkdirSync(join(w, "customers/ACME/tests/cases/P2P"), { recursive: true });
  writeFileSync(join(w, "customers/ACME/tests/cases/P2P", `${CASE}.yaml`), YAML.stringify({ id: CASE, alm: { test_key: "PROJ-31" } }));
  if (pin) pinXray(w);
  return w;
}
const created = (w) => JSON.parse(readFileSync(join(w, "customers/ACME/.sessions/sess-1/session.json"), "utf8")).alm?.created?.map((c) => c.key) ?? [];

test("C1 c — host in xray.yaml ma fuori dalla categoria alm di NETWORK.md ⇒ rifiuto prima di ogni richiesta (nessuna credenziale inviata)", async () => {
  // [classe, config, operazioni che devono essere rifiutate senza richieste]
  for (const [Cls, cfg, ops] of [
    [XrayServerAdapter, { deployment: "server", base_url: "https://jira.evil-example.com", project: "PROJ" }, ["authenticate", "getTest", "createDefect"]],
    [XrayCloudAdapter, { deployment: "cloud", base_url: "https://acme.atlassian.net", xray_url: "https://xray.cloud.getxray.app.attacker.example", project: "PROJ" }, ["authenticate", "getTest"]],
    [XrayCloudAdapter, { deployment: "cloud", base_url: "https://atlassian.net.attacker.example", project: "PROJ" }, ["createDefect", "createExecution"]],
    [XrayServerAdapter, { deployment: "server", base_url: "http://127.0.0.1:9", project: "PROJ" }, ["authenticate", "getTest", "createDefect"]],
  ]) {
    const f = spyFetch();
    const a = new Cls({ ...cfg, network: NET }, { env: { ...CREDS }, fetchImpl: f });
    const call = { authenticate: () => a.authenticate(), getTest: () => a.getTest("PROJ-1"), createDefect: () => a.createDefect({ summary: "x", scope: "P2P" }), createExecution: () => a.createExecution({ summary: "x", scope: "P2P" }) };
    for (const op of ops) await assert.rejects(call[op](), (e) => e instanceof AlmError && e.code === "refused" && /NETWORK.md/.test(e.message), `${op} ${JSON.stringify(cfg)}`);
    assert.equal(f.calls.length, 0, `nessuna richiesta verso ${cfg.base_url}`);
  }
  // host ammessi da entrambe le fonti: la richiesta parte
  const f = spyFetch();
  await new XrayCloudAdapter({ deployment: "cloud", base_url: "https://acme.atlassian.net", project: "PROJ", network: NET }, { env: { ...CREDS }, fetchImpl: f }).authenticate();
  assert.equal(new URL(f.calls[0].url).hostname, "xray.cloud.getxray.app");
});

test("C1 b — xray.yaml riscritto dopo use customer (base_url verso un altro host) ⇒ CLI e server MCP rifiutano; nessuna richiesta all'altro host, nessuna credenziale", async () => {
  const w = ws(A.url);
  const before = { a: A.state.requests.length, b: B.state.requests.length };
  assert.equal((await cli("authenticate", [], w)).status, 0, "config fissato: autenticazione verso l'host dichiarato");
  writeFileSync(join(w, "customers/ACME/config/xray.yaml"), readFileSync(join(w, "customers/ACME/config/xray.yaml"), "utf8").replace(A.url, B.url));
  for (const [name, args] of [["authenticate", []], ["publish", ["--run", RUN]], ["retry-queued", []], ["build-payload", ["--run", RUN]]]) {
    const r = await cli(name, args, w);
    assert.notEqual(r.status, 0, `${name}: ${r.stdout}`);
    assert.match(r.json?.error ?? "", /xray\.yaml.*cambiat/, name);
  }
  const mcp = startMcp({ JVC_WORKSPACE: w, ...CREDS }, { script: join(PLUGIN, "mcp/alm-server/server.mjs") });
  try {
    await initialized(mcp);
    for (const [t, a] of [["alm_get_test", { key: "PROJ-31" }], ["alm_create_defect", { summary: "x", scope: "P2P" }]]) {
      const r = await mcp.call(t, a);
      assert.equal(r.isError, true, t);
      assert.match(r.text, /xray\.yaml.*cambiat/);
    }
  } finally { await mcp.close(); }
  assert.equal(B.state.requests.length, before.b, "nessuna richiesta all'host riscritto");
  assert.ok(!B.state.requests.some((q) => q.headers.authorization), "nessuna credenziale");
  assert.equal(A.state.requests.length, before.a + 1, "solo l'autenticazione iniziale");
});

test("C1 d — doctor --network: xray_url fuori allow-list ⇒ rosso", async () => {
  const w = mkWs();
  mkdirSync(join(w, "customers/ACME/config"), { recursive: true });
  writeFileSync(join(w, "customers/ACME/config/xray.yaml"), "deployment: cloud\nbase_url: https://acme.atlassian.net\nxray_url: https://xray.evil-example.com\nproject: PROJ\n");
  const c = await runChecks({ ws: w, env: {}, network: true, resolver: async () => ["10.0.0.1"], fetcher: async () => ({ status: 200 }) });
  const al = c.find((x) => x.id === "network-allowlist");
  assert.equal(al.status, "red");
  assert.match(al.detail, /xray\.evil-example\.com/);
});

test("I1 — publish e retry-queued rifiutano chiavi di esecuzione non create dal plugin in sessione (anche da file forgiati) e non le registrano; evidenze inline in coda rifiutate", async () => {
  const w = ws(A.url);
  // mappa run+scope → esecuzione forgiata verso una Test Execution umana
  writeFileSync(join(w, "customers/ACME/runs", RUN, "xray-executions.json"), JSON.stringify({ run: RUN, scopes: { P2P: { key: "PROJ-31" } } }));
  const importsBefore = A.state.imports.length;
  const p = await cli("publish", ["--run", RUN, `${CASE}=ERROR-BLOCKING@2`], w);
  assert.equal(p.status, 3, p.stdout);
  assert.match(p.json.error, /PROJ-31.*non creata dal plugin/);
  assert.equal(A.state.imports.length, importsBefore);
  // voci di coda forgiate: chiave umana; evidenza inline (salta il profilo strict)
  mkdirSync(join(w, "customers/ACME/queue"), { recursive: true });
  const q = (id, payload) => writeFileSync(join(w, "customers/ACME/queue", `${id}.json`), JSON.stringify({ id, op: "import", customer: "ACME", run: null, scope: null, status: "pending", attempts: 0, payload }));
  q("Q.20260929100000.aaaaaa", { execution_key: "PROJ-31", results: { tests: [{ testKey: "PROJ-31", status: "PASSED" }] } });
  q("Q.20260929100001.bbbbbb", { execution: { summary: "x", scope: "P2P" }, results: { tests: [{ testKey: "PROJ-31", status: "PASSED", steps: [{ status: "PASSED", evidence: [{ data: PNG.toString("base64"), filename: "x.png", contentType: "image/png" }] }] }] } });
  const r = await cli("retry-queued", [], w);
  assert.equal(r.status, 3, r.stdout);
  assert.equal(r.json.failed.length, 2);
  assert.match(JSON.stringify(r.json.failed), /non creata dal plugin/);
  assert.match(JSON.stringify(r.json.failed), /inline/);
  assert.equal(A.state.imports.length, importsBefore, "nessun import");
  assert.deepEqual(created(w).filter((k) => k === "PROJ-31"), [], "nessuna chiave umana registrata");
});

test("I2 — alm_create_execution idempotente per run+scope; poi publish riusa la stessa esecuzione (una sola)", async () => {
  const w = ws(A.url, "", { pin: false });
  writeFileSync(join(w, "customers/ACME/config/xray.yaml"), "deployment: mock\nproject: DEMO\n");
  pinXray(w);
  const mockFile = join(w, "alm-mock.json");
  const env = { JVC_WORKSPACE: w, JVC_ALM_MOCK_FILE: mockFile };
  const mcp = startMcp(env);
  let key;
  try {
    await initialized(mcp);
    const args = { summary: `${RUN} — scope P2P`, scope: "P2P", run: RUN };
    const r1 = await mcp.call("alm_create_execution", args);
    assert.equal(r1.isError, false, r1.text);
    key = r1.data.key;
    runHook("alm-record", { session_id: "sess-1", cwd: w, hook_event_name: "PostToolUse", tool_name: "mcp__plugin_jaggaer-virtual-consultant_alm__alm_create_execution", tool_input: args, tool_response: r1.result }, { JVC_WORKSPACE: w, CLAUDE_PLUGIN_ROOT: ROOT });
    const r2 = await mcp.call("alm_create_execution", args);
    assert.equal(r2.data.key, key, "stessa esecuzione per run e scope");
  } finally { await mcp.close(); }
  assert.equal(JSON.parse(readFileSync(join(w, "customers/ACME/runs", RUN, "xray-executions.json"), "utf8")).scopes.P2P.key, key);
  const p = await cli("publish", ["--run", RUN, `${CASE}=ERROR-BLOCKING@2`], w, env, ROOT);
  assert.equal(p.status, 0, p.stdout + p.stderr);
  assert.equal(p.json.executions[0].execution_key, key);
  const state = JSON.parse(readFileSync(mockFile, "utf8"));
  assert.deepEqual(Object.keys(state.executions), [key], "una sola Test Execution");
  assert.equal(state.executions[key].results.length, 1);
});

test("I3 — Server/DC: stati PASS/FAIL/TODO/ABORTED e campo evidences (sul passo); rilettura riportata a PASSED/FAILED", async () => {
  const a = new XrayServerAdapter({ deployment: "server", base_url: A.url, project: "PROJ", network: NET }, { env: { ...CREDS }, networkHosts: ["127.0.0.1"] });
  const ex = await a.createExecution({ summary: "x", scope: "P2P" });
  const start = A.state.requests.length;
  await a.importResults(ex.key, { info: { summary: "x" }, tests: [{ testKey: "PROJ-31", status: "FAILED", evidence: [{ data: PNG.toString("base64"), filename: "t.png", contentType: "image/png" }],
    steps: [{ status: "PASSED" }, { status: "FAILED", evidence: [{ data: PNG.toString("base64"), filename: "EV-01.png", contentType: "image/png" }] }, { status: "TODO" }] }] });
  const body = A.state.requests.slice(start).find((q) => q.path === "/rest/raven/1.0/import/execution").json;
  assert.deepEqual(body.tests[0].steps.map((s) => s.status), ["PASS", "FAIL", "TODO"]);
  assert.equal(body.tests[0].status, "FAIL");
  assert.equal(body.tests[0].steps[1].evidences[0].filename, "EV-01.png");
  assert.equal(body.tests[0].evidences[0].filename, "t.png");
  assert.ok(!("evidence" in body.tests[0].steps[1]) && !("evidence" in body.tests[0]));
  const back = await a.getExecution(ex.key);
  assert.equal(back.tests[0].status, "FAILED");
  assert.deepEqual(back.tests[0].steps.map((s) => [s.status, s.evidence]), [["PASSED", 0], ["FAILED", 1], ["TODO", 0]]);
});

test("minori — Xray Cloud si riautentica una volta su 401; testo del Defect in coda redatto; errore di sistema delle CLI redatto", async () => {
  const a = new XrayCloudAdapter({ deployment: "cloud", base_url: A.url, xray_url: A.url, project: "PROJ", network: NET }, { env: { ...CREDS }, networkHosts: ["127.0.0.1"] });
  await a.authenticate();
  A.expireToken();
  const n = A.state.requests.filter((q) => q.path === "/api/v2/authenticate").length;
  assert.equal((await a.getTest("PROJ-31")).key, "PROJ-31");
  assert.equal(A.state.requests.filter((q) => q.path === "/api/v2/authenticate").length, n + 1, "una nuova autenticazione");
  // coda: il Defect si redige PRIMA di scriverlo su disco
  const w = ws(A.url);
  const qu = new OfflineQueue(w, "ACME", { env: { ...CREDS } });
  qu.enqueue({ op: "defect", run: RUN, payload: { defect: { summary: `Errore per mario.rossi@acme.it ${CREDS.JIRA_API_TOKEN}`, description: `token ${CREDS.XRAY_TOKEN} importo € 1.250,00`, scope: "P2P", attachments: [] } } });
  const text = readdirSync(join(w, "customers/ACME/queue")).map((f) => readFileSync(join(w, "customers/ACME/queue", f), "utf8")).join("\n");
  for (const v of [CREDS.JIRA_API_TOKEN, CREDS.XRAY_TOKEN, "mario.rossi@acme.it", "1.250,00"]) assert.ok(!text.includes(v), v);
  // failWith: un errore non ALM non riporta segreti
  const saved = process.env.XRAY_TOKEN; const log = console.log; let out = "";
  process.env.XRAY_TOKEN = CREDS.XRAY_TOKEN;
  console.log = (s) => { out += s; };
  try { assert.equal(failWith(true, new Error(`boom ${CREDS.XRAY_TOKEN} Bearer abcdefghijklmn`)), 2); } finally { console.log = log; if (saved === undefined) delete process.env.XRAY_TOKEN; else process.env.XRAY_TOKEN = saved; }
  assert.ok(!out.includes(CREDS.XRAY_TOKEN) && !out.includes("abcdefghijklmn"), out);
  assert.ok(existsSync(join(w, "customers/ACME/runs", RUN)));
});
