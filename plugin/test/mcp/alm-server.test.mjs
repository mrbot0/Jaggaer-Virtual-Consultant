// WP09c — server MCP ALM (§44.6): processo stdio reale con JVC_ALM_ADAPTER=mock. initialize → tools/list (ESATTAMENTE
// 7 strumenti, nessuno di cancellazione) → tools/call alm_create_execution → alm_import_results; errori come isError;
// JSON-RPC: ping, metodo ignoto, strumento ignoto, riga non JSON, notifiche senza risposta. .mcp.json del plugin.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import YAML from "yaml";
import { mkWs, seedSession, ROOT } from "../helpers/hook-env.mjs";
import { startMcp, initialized } from "../helpers/mcp-client.mjs";
import { isBrowserTool, classify } from "../../hooks/lib/browser-tools.mjs";

const SEVEN = ["alm_create_defect", "alm_create_execution", "alm_find_tests", "alm_get_test", "alm_import_results", "alm_link", "alm_queue_status"];
const RUN = "RUN.ACME.20260929.1000.P2P";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9]);

function ws() {
  const w = mkWs();
  seedSession(w, { scope: "P2P" });
  const dir = join(w, "customers/ACME/runs", RUN, "cases/NRT.ACME.P2P.NEG.0031/evidence");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "04.png"), PNG);
  writeFileSync(join(dir, "04.yaml"), YAML.stringify({ id: "EV-04", type: "EVD", step: 2, kind: "failure", profile: "strict", publishable: true, sha256: createHash("sha256").update(PNG).digest("hex") }));
  return w;
}

test("server MCP ALM: initialize, 7 strumenti esatti con schemi, create_execution → import_results (evidenza sul passo), stato della coda", async () => {
  const w = ws();
  const mockFile = join(w, "alm-mock.json");
  const c = startMcp({ JVC_WORKSPACE: w, JVC_ALM_ADAPTER: "mock", JVC_ALM_MOCK_FILE: mockFile });
  try {
    const init = await initialized(c);
    assert.equal(init.result.protocolVersion, "2025-06-18");
    assert.deepEqual(init.result.capabilities, { tools: {} });
    assert.equal(init.result.serverInfo.name, "jvc-alm");
    assert.deepEqual(await c.request("ping").then((r) => r.result), {});
    const list = (await c.request("tools/list")).result.tools;
    assert.deepEqual(list.map((t) => t.name).sort(), SEVEN);
    assert.ok(!list.some((t) => /delete|remove|archive|incident|update/i.test(t.name)), "nessuno strumento di cancellazione");
    for (const t of list) { assert.equal(t.inputSchema.type, "object"); assert.equal(typeof t.description, "string"); }
    const ex = await c.call("alm_create_execution", { summary: `${RUN} — scope P2P`, scope: "P2P", run: RUN });
    assert.equal(ex.isError, false, ex.text);
    assert.match(ex.data.key, /^DEMO-\d+$/);
    assert.deepEqual(JSON.parse(ex.text), { key: ex.data.key }, "risposta JSON con key al primo livello (alm-record)");
    const file = `customers/ACME/runs/${RUN}/cases/NRT.ACME.P2P.NEG.0031/evidence/04.png`;
    const imp = await c.call("alm_import_results", { executionKey: ex.data.key, results: { tests: [{ testKey: "DEMO-1", status: "FAILED", steps: [{ status: "PASSED" }, { status: "FAILED", evidence: [{ file }] }] }] } });
    assert.equal(imp.isError, false, imp.text);
    assert.deepEqual(imp.data, { key: ex.data.key, tests: 1, evidence: 1 });
    const state = JSON.parse(readFileSync(mockFile, "utf8"));
    const stored = state.executions[ex.data.key].results[0].tests[0];
    assert.deepEqual(stored.steps.map((s) => s.evidence.length), [0, 1], "evidenza sul passo 2");
    assert.equal(stored.steps[1].evidence[0].bytes, PNG.length);
    assert.deepEqual(state.executions[ex.data.key].labels, ["scope:P2P", `run:${RUN}`]);
    assert.deepEqual((await c.call("alm_queue_status")).data, { customer: "ACME", pending: 0, sent: 0, failed: 0, items: [] });
    assert.equal((await c.call("alm_get_test", { key: "DEMO-404" })).data.test, null);
    assert.deepEqual((await c.call("alm_find_tests", { labels: ["scope:P2P"] })).data, { tests: [] });
    const link = await c.call("alm_link", { from: ex.data.key, to: "DEMO-1", kind: "tests" });
    assert.equal(link.isError, false, link.text);
  } finally { await c.close(); }
});

test("server MCP ALM: difesa in profondità — Incident/Test rifiutati, import solo su esecuzioni del plugin, evidenze inline o fuori dal dossier rifiutate, argomenti estranei", async () => {
  const w = ws();
  const c = startMcp({ JVC_WORKSPACE: w, JVC_ALM_ADAPTER: "mock" });
  try {
    await initialized(c);
    for (const t of ["Incident", "IT Incident", "Test"]) {
      const r = await c.call("alm_create_defect", { summary: "x", scope: "P2P", issue_type: t });
      assert.equal(r.isError, true, t);
      assert.match(r.text, /ADR-2[17]/);
    }
    const human = await c.call("alm_import_results", { executionKey: "DEMO-9999", results: { tests: [] } });
    assert.equal(human.isError, true);
    assert.match(human.text, /create dal plugin/);
    const ex = (await c.call("alm_create_execution", { summary: "x", scope: "P2P" })).data;
    const inline = await c.call("alm_import_results", { executionKey: ex.key, results: { tests: [{ testKey: "DEMO-1", status: "PASSED", steps: [{ status: "PASSED", evidence: [{ file: "customers/ACME/config/environments.yaml" }] }] }] } });
    assert.equal(inline.isError, true);
    const extra = await c.call("alm_create_execution", { summary: "x", scope: "P2P", delete: true });
    assert.equal(extra.isError, true);
    assert.match(extra.text, /non previsti/);
    const missing = await c.call("alm_link", { from: ex.key });
    assert.equal(missing.isError, true);
    const d = await c.call("alm_create_defect", { summary: "Totale errato", scope: "P2P", precedent: { key: "DEMO-7", fixed_in: "R25.2" } });
    assert.equal(d.isError, false, d.text);
    assert.match(d.data.key, /^DEMO-\d+$/);
  } finally { await c.close(); }
});

test("server MCP ALM: rete giù (mock offline) ⇒ alm_import_results e alm_create_defect { queued: true }, visibili in alm_queue_status", async () => {
  const w = ws();
  const file = `customers/ACME/runs/${RUN}/cases/NRT.ACME.P2P.NEG.0031/evidence/04.png`;
  const c = startMcp({ JVC_WORKSPACE: w, JVC_ALM_ADAPTER: "mock" });
  const c2 = startMcp({ JVC_WORKSPACE: w, JVC_ALM_ADAPTER: "mock", JVC_ALM_MOCK_OFFLINE: "1" });
  try {
    await initialized(c); await initialized(c2);
    // l'esecuzione esiste (creata dal plugin in questa sessione: session.alm.created, come la scrive alm-record)
    const ex = (await c.call("alm_create_execution", { summary: "x", scope: "P2P", run: RUN })).data;
    const sf = join(w, "customers/ACME/.sessions/sess-1/session.json");
    const s = JSON.parse(readFileSync(sf, "utf8"));
    writeFileSync(sf, JSON.stringify({ ...s, alm: { created: [{ key: ex.key, kind: "execution" }] } }));
    const r = await c2.call("alm_import_results", { executionKey: ex.key, run: RUN, scope: "P2P", results: { tests: [{ testKey: "DEMO-1", status: "FAILED", steps: [{ status: "FAILED", evidence: [{ file }] }] }] } });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.data.queued, true);
    assert.ok(existsSync(join(w, "customers/ACME/runs", RUN, "xray-payload.json")), "payload nel dossier");
    const d = await c2.call("alm_create_defect", { summary: "Totale errato", scope: "P2P", run: RUN });
    assert.equal(d.data.queued, true);
    const st = (await c2.call("alm_queue_status")).data;
    assert.equal(st.pending, 2);
  } finally { await c.close(); await c2.close(); }
});

test("JSON-RPC: riga non JSON ⇒ -32700; metodo ignoto ⇒ -32601; strumento ignoto ⇒ -32602; le notifiche non hanno risposta", async () => {
  const c = startMcp({ JVC_WORKSPACE: mkWs(), JVC_ALM_ADAPTER: "mock" });
  try {
    await initialized(c);
    c.raw("{ non json");
    c.notify("notifications/whatever");
    assert.equal((await c.request("resources/list")).error.code, -32601);
    assert.equal((await c.request("tools/call", { name: "alm_delete_execution", arguments: { key: "DEMO-1" } })).error.code, -32602);
    const parsed = c.lines.map((l) => JSON.parse(l));
    assert.ok(parsed.some((m) => m.id === null && m.error?.code === -32700));
    assert.ok(parsed.every((m) => m.jsonrpc === "2.0" && "id" in m), "nessuna risposta alle notifiche, stdout solo JSON-RPC");
  } finally { await c.close(); }
});

test(".mcp.json: alm (server del plugin), chrome-devtools pinnato a chrome-devtools-mcp@1.9.0 e playwright pinnato, entrambi facoltativi; nomi riconosciuti da allow-list e browser-tools", () => {
  const m = JSON.parse(readFileSync(join(ROOT, ".mcp.json"), "utf8")).mcpServers;
  assert.deepEqual(Object.keys(m).sort(), ["alm", "chrome-devtools", "playwright"]);
  assert.deepEqual([m.alm.type, m.alm.command, m.alm.args], ["stdio", "node", ["${CLAUDE_PLUGIN_ROOT}/mcp/alm-server/server.mjs"]]);
  assert.deepEqual(m["chrome-devtools"].args, ["-y", "chrome-devtools-mcp@1.9.0"]);
  assert.match(m.playwright.args.join(" "), /@playwright\/mcp@\d+\.\d+\.\d+$/);
  for (const k of ["chrome-devtools", "playwright"]) assert.equal(m[k].env?.JVC_MCP_OPTIONAL, "1", `${k} facoltativo`);
  const allow = JSON.parse(readFileSync(join(ROOT, "hooks/lib/mcp-allowlist.json"), "utf8")).servers;
  assert.ok(allow.includes("alm") && allow.includes("plugin_jaggaer-virtual-consultant_alm"));
  const hooks = JSON.parse(readFileSync(join(ROOT, "hooks/hooks.json"), "utf8")).hooks.PreToolUse;
  const almMatcher = hooks.find((h) => h.hooks.some((x) => /guard-alm-write/.test(x.command))).matcher;
  for (const p of ["mcp__alm__", "mcp__plugin_jaggaer-virtual-consultant_alm__"]) for (const t of SEVEN) assert.ok(new RegExp(`^(?:${almMatcher})$`).test(p + t), p + t);
  for (const p of ["mcp__chrome-devtools__", "mcp__plugin_jaggaer-virtual-consultant_chrome-devtools__"]) { assert.ok(isBrowserTool(`${p}take_snapshot`)); assert.equal(classify(`${p}take_snapshot`, {}).family, "chrome-devtools"); }
  for (const p of ["mcp__playwright__", "mcp__plugin_jaggaer-virtual-consultant_playwright__"]) { assert.ok(isBrowserTool(`${p}browser_snapshot`)); assert.equal(classify(`${p}browser_snapshot`, {}).family, "playwright"); }
  for (const p of ["mcp__alm__", "mcp__plugin_jaggaer-virtual-consultant_alm__"]) assert.equal(isBrowserTool(`${p}alm_get_test`), false);
});
