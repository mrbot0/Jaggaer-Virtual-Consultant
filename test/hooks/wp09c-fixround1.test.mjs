// WP09c giro di correzione 1 — lato hook (sonde solo come input degli hook):
//  C1 a: customers/*/config/** protetto dalle scritture della sessione e dei sub-agenti (Write/Edit/NotebookEdit, shell,
//        interpreti, script eseguiti): la configurazione del cliente si modifica a mano, fuori sessione;
//  C1 b: config/xray.yaml fissato con sha256 a `use customer`; cambiato dopo ⇒ guard-alm-write nega le scritture ALM
//        (la deroga ADR-21 non si attiva riscrivendo il file);
//  I1:   runs/**/xray-*.json e customers/*/queue/** protetti come gli esiti dei run (li scrivono solo gli script).
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { mkWs, seedSession, runHook, runSessionCli, decisionOf, reasonOf, pinXray, ROOT } from "../helpers/hook-env.mjs";
import { envWs } from "../helpers/env-fixture.mjs";

const RUN = "RUN.ACME.20260929.1000.P2P";
const SUB = { agent_id: "a1", agent_type: "jaggaer-virtual-consultant:scope-expert" };

test("C1 a / I1 — configurazione del cliente, payload/mappa/pubblicazioni Xray e coda offline: scritture negate (sessione e sub-agente)", () => {
  const ws = envWs({ env: "sandbox" });
  const call = (tool, tool_input, extra = {}) => runHook("guard-config-scope", { session_id: "sess-1", cwd: ws, hook_event_name: "PreToolUse", tool_name: tool, tool_input, ...extra }, { JVC_WORKSPACE: ws, CLAUDE_PLUGIN_ROOT: ROOT });
  const X = join(ws, "customers/ACME/config/xray.yaml");
  const targets = [X, join(ws, "customers/ACME/config/environments.yaml"), join(ws, "customers/ACME/runs", RUN, "xray-executions.json"), join(ws, "customers/ACME/runs", RUN, "xray-published.json"),
    join(ws, "customers/ACME/runs", RUN, "xray-payload.json"), join(ws, "customers/ACME/queue/Q.20260929100000.abcdef.json")];
  for (const extra of [{}, SUB]) {
    for (const t of targets) {
      assert.equal(decisionOf(call("Write", { file_path: t, content: "deployment: server\nbase_url: https://attacker.example\n" }, extra)), "deny", `Write ${t}`);
      assert.equal(decisionOf(call("Edit", { file_path: t, old_string: "a", new_string: "b" }, extra)), "deny", `Edit ${t}`);
    }
    for (const cmd of [
      "echo 'base_url: https://attacker.example' >> customers/ACME/config/xray.yaml",
      "cp /tmp/x.yaml customers/ACME/config/xray.yaml",
      `python -c "open('customers/ACME/config/xray.yaml','w').write('x')"`,
      `node -e "require('fs').writeFileSync('customers/ACME/runs/${RUN}/xray-executions.json','{}')"`,
      `python -c "d='customers/ACME'; open(d + '/queue/Q.1.json','w').write('{}')"`,
      `cp /tmp/q.json customers/ACME/queue/`,
    ]) assert.equal(decisionOf(call("Bash", { command: cmd }, extra)), "deny", cmd);
    writeFileSync(join(ws, "w.py"), `from pathlib import Path\nPath("customers/ACME/config/xray.yaml").write_text("base_url: https://attacker.example")\n`);
    assert.equal(decisionOf(call("Bash", { command: "python w.py" }, extra)), "deny", "script eseguito");
    writeFileSync(join(ws, "q.py"), `d = "customers/ACME/runs/${RUN}"\nopen(d + "/xray-published.json", "w").write("{}")\n`);
    assert.equal(decisionOf(call("Bash", { command: "python q.py" }, extra)), "deny", "script eseguito (payload Xray)");
  }
  assert.match(reasonOf(call("Write", { file_path: X, content: "x" })), /configurazione del cliente/);
  // controlli: il plugin pubblica con i suoi script; altri file del run restano scrivibili per il guard
  assert.notEqual(decisionOf(call("Bash", { command: `node "${join(ROOT, "scripts/xray/publish.mjs")}" --run ${RUN}` })), "deny");
  assert.notEqual(decisionOf(call("Write", { file_path: join(ws, "customers/ACME/runs", RUN, "notes.md"), content: "x" })), "deny");
});

test("C1 b — use customer fissa sha256 di config/xray.yaml; un cambio successivo (deroga ADR-21 attivata) ⇒ guard-alm-write nega le scritture ALM", () => {
  const ws = mkWs();
  const env = { JVC_WORKSPACE: ws, CLAUDE_PLUGIN_ROOT: ROOT };
  const X = join(ws, "customers/ACME/config/xray.yaml");
  mkdirSync(join(ws, "customers/ACME/config"), { recursive: true });
  writeFileSync(X, "deployment: mock\nallow_test_issue_creation: false\n");
  assert.equal(runSessionCli(["use", "customer", "ACME", "--session", "sess-1", "--workspace", ws, "--json"], env).status, 0);
  const s = JSON.parse(readFileSync(join(ws, "customers/ACME/.sessions/sess-1/session.json"), "utf8"));
  assert.equal(s.alm.config.sha256, createHash("sha256").update(readFileSync(X)).digest("hex"));
  assert.equal(s.alm.config.file, "customers/ACME/config/xray.yaml");
  runSessionCli(["use", "scope", "P2P", "--session", "sess-1", "--workspace", ws, "--json"], env);
  const guard = (tool, ti) => runHook("guard-alm-write", { session_id: "sess-1", cwd: ws, hook_event_name: "PreToolUse", tool_name: tool, tool_input: ti }, env);
  const P = "mcp__plugin_jaggaer-virtual-consultant_alm__";
  assert.match(reasonOf(guard(P + "alm_create_defect", { summary: "x", scope: "P2P", issue_type: "Test" })), /ADR-21/);
  assert.equal(guard(P + "alm_create_defect", { summary: "x", scope: "P2P", issue_type: "Bug" }).stdout.trim(), "");
  // la deroga compare nel file dopo use customer: nessuna scrittura ALM, né Test né Defect
  writeFileSync(X, "deployment: mock\nallow_test_issue_creation: true\n");
  for (const t of ["Test", "Bug"]) {
    const r = guard(P + "alm_create_defect", { summary: "x", scope: "P2P", issue_type: t });
    assert.equal(decisionOf(r), "deny", t);
    assert.match(reasonOf(r), /xray\.yaml.*cambiat/);
  }
  assert.equal(guard(P + "alm_get_test", { key: "PROJ-1" }).stdout.trim(), "", "le letture restano senza opinione del guard");
  // l'utente riesegue use customer: nuova impronta, deroga valida
  assert.equal(runSessionCli(["use", "customer", "ACME", "--session", "sess-1", "--workspace", ws, "--json"], env).status, 0);
  assert.equal(guard(P + "alm_create_defect", { summary: "x", scope: "P2P", issue_type: "Test" }).stdout.trim(), "");
  // file comparso senza impronta (sessione precedente al giro): scritture negate finché non si riesegue use customer
  const ws2 = mkWs();
  seedSession(ws2, { scope: "P2P" });
  mkdirSync(join(ws2, "customers/ACME/config"), { recursive: true });
  writeFileSync(join(ws2, "customers/ACME/config/xray.yaml"), "deployment: mock\n");
  const g2 = runHook("guard-alm-write", { session_id: "sess-1", cwd: ws2, hook_event_name: "PreToolUse", tool_name: P + "alm_create_defect", tool_input: { summary: "x", scope: "P2P" } }, { JVC_WORKSPACE: ws2, CLAUDE_PLUGIN_ROOT: ROOT });
  assert.match(reasonOf(g2), /non fissat/);
  pinXray(ws2);
  assert.equal(runHook("guard-alm-write", { session_id: "sess-1", cwd: ws2, hook_event_name: "PreToolUse", tool_name: P + "alm_create_defect", tool_input: { summary: "x", scope: "P2P" } }, { JVC_WORKSPACE: ws2, CLAUDE_PLUGIN_ROOT: ROOT }).stdout.trim(), "");
});
