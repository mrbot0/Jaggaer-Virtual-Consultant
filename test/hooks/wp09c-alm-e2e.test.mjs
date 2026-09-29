// WP09c riporto 2 — end-to-end server MCP ALM del plugin + guard-alm-write + alm-record: il server reale (processo
// stdio, JVC_ALM_ADAPTER=mock) espone i sette strumenti; per ciascuno, con i nomi come li vede Claude Code
// (mcp__plugin_jaggaer-virtual-consultant_alm__<tool> e mcp__alm__<tool>), il guard lascia passare le letture
// dell'allow-list (alm_get_test, alm_find_tests, alm_queue_status) e tratta le scritture con tutti i divieti:
// import solo su esecuzioni create dal plugin in questa sessione (registrate da alm-record dalla risposta REALE del
// server), mai Incident, mai Test senza deroga, mai cancellazioni, confine di dominio.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { mkWs, seedSession, runHook, decisionOf, reasonOf, ROOT } from "../helpers/hook-env.mjs";
import { startMcp, initialized } from "../helpers/mcp-client.mjs";
import { classifyAlm } from "../../hooks/lib/alm.mjs";

const PREFIXES = ["mcp__plugin_jaggaer-virtual-consultant_alm__", "mcp__alm__"];
const READS = ["alm_get_test", "alm_find_tests", "alm_queue_status"];

test("server MCP ALM (mock) + guard-alm-write + alm-record sui nomi mcp__ reali dei sette strumenti", async () => {
  const ws = mkWs();
  seedSession(ws, { scope: "P2P" });
  const env = { JVC_WORKSPACE: ws, CLAUDE_PLUGIN_ROOT: ROOT };
  const guard = (tool, tool_input) => runHook("guard-alm-write", { session_id: "sess-1", cwd: ws, hook_event_name: "PreToolUse", tool_name: tool, tool_input }, env);
  const record = (tool, tool_input, r) => runHook("alm-record", { session_id: "sess-1", cwd: ws, hook_event_name: "PostToolUse", tool_name: tool, tool_input, tool_response: r.result }, env);
  const allowed = (r) => r.status === 0 && r.stdout.trim() === "";
  const c = startMcp({ JVC_WORKSPACE: ws, JVC_ALM_ADAPTER: "mock" });
  try {
    await initialized(c);
    const names = (await c.request("tools/list")).result.tools.map((t) => t.name);
    assert.equal(names.length, 7);
    for (const p of PREFIXES) {
      // letture: nessuna opinione del guard (allow-list esplicita, deny-by-default per il resto)
      for (const t of names) assert.equal(classifyAlm(p + t).category === "read", READS.includes(t), `${p}${t}`);
      for (const [t, ti] of [["alm_get_test", { key: "DEMO-1" }], ["alm_find_tests", { labels: ["scope:P2P"] }], ["alm_queue_status", {}]]) assert.ok(allowed(guard(p + t, ti)), `${p}${t}`);
    }
    const P = PREFIXES[0];
    // create_execution: consentita; la risposta reale del server registrata da alm-record
    const exIn = { summary: "RUN.ACME.20260929.1000.P2P — scope P2P", scope: "P2P", run: "RUN.ACME.20260929.1000.P2P" };
    assert.ok(allowed(guard(P + "alm_create_execution", exIn)));
    const ex = await c.call("alm_create_execution", exIn);
    // import su un'esecuzione NON ancora registrata come creata in sessione ⇒ deny
    const impIn = { executionKey: ex.data.key, results: { tests: [{ testKey: "DEMO-1", status: "PASSED" }] } };
    assert.equal(decisionOf(guard(P + "alm_import_results", impIn)), "deny");
    assert.equal(record(P + "alm_create_execution", exIn, ex).status, 0);
    const s = JSON.parse(readFileSync(join(ws, "customers/ACME/.sessions/sess-1/session.json"), "utf8"));
    assert.deepEqual(s.alm.created.map((x) => [x.key, x.kind]), [[ex.data.key, "execution"]]);
    for (const p of PREFIXES) assert.ok(allowed(guard(p + "alm_import_results", impIn)), `${p} import sull'esecuzione del plugin`);
    assert.equal((await c.call("alm_import_results", impIn)).isError, false);
    // import su un'esecuzione umana ⇒ deny (anche se il server la rifiuterebbe comunque)
    for (const p of PREFIXES) assert.match(reasonOf(guard(p + "alm_import_results", { executionKey: "PROJ-1", results: { tests: [] } })), /create dal plugin/);
    // Defect: consentito Bug/Defect; Incident mai; Test senza deroga mai
    for (const p of PREFIXES) {
      assert.ok(allowed(guard(p + "alm_create_defect", { summary: "Totale errato", scope: "P2P", issue_type: "Bug" })));
      assert.ok(allowed(guard(p + "alm_create_defect", { summary: "Totale errato", scope: "P2P" })));
      assert.match(reasonOf(guard(p + "alm_create_defect", { summary: "x", scope: "P2P", issue_type: "Incident" })), /ADR-27/);
      assert.match(reasonOf(guard(p + "alm_create_defect", { summary: "x", scope: "P2P", issue_type: "Test" })), /ADR-21/);
      // confine di dominio: il payload non cita il dominio analitico
      assert.equal(decisionOf(guard(p + "alm_create_defect", { summary: "vedi C.ACME.P2P.PAT.0003", scope: "P2P" })), "deny");
      // link: aggiunta consentita
      assert.ok(allowed(guard(p + "alm_link", { from: ex.data.key, to: "PROJ-1", kind: "tests" })));
      // nessuno strumento di cancellazione: anche un nome inventato è negato dal guard
      assert.equal(decisionOf(guard(p + "alm_delete_execution", { key: ex.data.key })), "deny");
    }
    const d = await c.call("alm_create_defect", { summary: "Totale errato", scope: "P2P", issue_type: "Bug" });
    record(P + "alm_create_defect", { summary: "Totale errato", scope: "P2P" }, d);
    const kinds = JSON.parse(readFileSync(join(ws, "customers/ACME/.sessions/sess-1/session.json"), "utf8")).alm.created.map((x) => x.kind);
    assert.deepEqual(kinds, ["execution", "defect"]);
    // deroga ADR-21 del cliente: Test issue ammessa dal guard (il server comunque non le crea da createDefect)
    mkdirSync(join(ws, "customers/ACME/config"), { recursive: true });
    writeFileSync(join(ws, "customers/ACME/config/xray.yaml"), "deployment: mock\nallow_test_issue_creation: true\n");
    assert.ok(allowed(guard(P + "alm_create_defect", { summary: "x", scope: "P2P", issue_type: "Test" })));
    assert.equal((await c.call("alm_create_defect", { summary: "x", scope: "P2P", issue_type: "Test" })).isError, true, "il server non crea Test da createDefect");
  } finally { await c.close(); }
});
