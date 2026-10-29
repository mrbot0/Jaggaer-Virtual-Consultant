// Contratto non negoziabile (29/10/2026, punto 8): isolamento fra clienti — una sessione sul cliente ACME non legge né
// scrive la conoscenza di un altro cliente, in nessun profilo (anche in esplorazione, dove le celle valgono per tutto il
// cliente attivo), né lo fanno gli agenti di manutenzione.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { envWs, patchSession, ROOT } from "../helpers/env-fixture.mjs";
import { runHook, decisionOf } from "../helpers/hook-env.mjs";

const E = (ws) => ({ JVC_WORKSPACE: ws, CLAUDE_PLUGIN_ROOT: ROOT });
const pre = (ws, tool, ti, extra = {}) => runHook("pre-dispatch", { session_id: "sess-1", cwd: ws, hook_event_name: "PreToolUse", tool_name: tool, tool_input: ti, ...extra }, E(ws));

for (const mode of ["nrt", "esplorazione"]) {
  test(`un altro cliente non si legge né si scrive (modalità ${mode}, sessione e agenti di manutenzione)`, () => {
    const ws = envWs({ env: "sandbox", scope: "ADM" });
    patchSession(ws, (s) => { s.mode = mode; });
    mkdirSync(join(ws, "customers/BETA/kb"), { recursive: true });
    writeFileSync(join(ws, "customers/BETA/kb/x.yaml"), "id: x\n");
    for (const extra of [{}, { agent_id: "k1", agent_type: "jaggaer-virtual-consultant:health-keeper" }]) {
      assert.equal(decisionOf(pre(ws, "Read", { file_path: join(ws, "customers/BETA/kb/x.yaml") }, extra)), "deny", `Read ${JSON.stringify(extra)}`);
      assert.equal(decisionOf(pre(ws, "Write", { file_path: join(ws, "customers/BETA/kb/y.yaml"), content: "x" }, extra)), "deny", `Write ${JSON.stringify(extra)}`);
    }
  });
}
