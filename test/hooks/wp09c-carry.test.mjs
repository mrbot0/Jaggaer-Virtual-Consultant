// WP09c — riporti obbligatori sugli hook:
//  1. alm-record: l'id di una pagina Confluence creata dal plugin si registra (regex /^\d{1,20}$/, prima /^d{1,20}$/);
//  5. guard-config-scope (riporto di sicurezza WP09b): pathlib write_text/write_bytes sono primitive di scrittura per
//     l'analisi degli script eseguiti; /results/ costruito da una variabile di cartella con interprete + primitiva di
//     scrittura ⇒ deny (come per session.json). Sonde del revisore, solo come input degli hook.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFileSync, readFileSync } from "node:fs";
import { mkWs, seedSession, runHook, decisionOf, ROOT } from "../helpers/hook-env.mjs";
import { envWs } from "../helpers/env-fixture.mjs";
import { createdFrom } from "../../hooks/lib/alm-record.mjs";
import { classifyAlm } from "../../hooks/lib/alm.mjs";

test("riporto 1 — alm-record: la pagina Confluence creata dal plugin (id numerico) finisce in session.alm.created", () => {
  const c = classifyAlm("mcp__claude_ai_Atlassian__createConfluencePage");
  assert.equal(c.category, "create");
  assert.equal(c.object, "page");
  assert.deepEqual(createdFrom(c, JSON.stringify({ id: "123456", title: "Esito NRT" })), ["123456"]);
  assert.deepEqual(createdFrom(c, JSON.stringify({ id: 987654321 })), ["987654321"]);
  assert.deepEqual(createdFrom(c, JSON.stringify({ id: "ddd" })), [], "la sola lettera d non è un id");
  assert.deepEqual(createdFrom(c, JSON.stringify({ id: "12a" })), []);
  const ws = mkWs();
  seedSession(ws);
  const r = runHook("alm-record", { session_id: "sess-1", cwd: ws, hook_event_name: "PostToolUse", tool_name: "mcp__claude_ai_Atlassian__createConfluencePage",
    tool_input: { spaceId: "1", title: "Esito NRT" }, tool_response: [{ type: "text", text: JSON.stringify({ id: "445566", title: "Esito NRT" }) }] }, { JVC_WORKSPACE: ws, CLAUDE_PLUGIN_ROOT: ROOT });
  assert.equal(r.status, 0, r.stderr);
  const s = JSON.parse(readFileSync(join(ws, "customers/ACME/.sessions/sess-1/session.json"), "utf8"));
  assert.deepEqual(s.alm.created.map((x) => [x.key, x.kind]), [["445566", "page"]]);
});

test("riporto 5 — guard-config-scope: script eseguito che scrive session.json o gli esiti solo con pathlib write_text/write_bytes ⇒ deny", () => {
  const ws = envWs({ env: "sandbox" });
  const call = (command, extra = {}) => runHook("guard-config-scope", { session_id: "sess-1", cwd: ws, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, ...extra }, { JVC_WORKSPACE: ws, CLAUDE_PLUGIN_ROOT: ROOT });
  const probes = [
    ["p1.py", `import pathlib\npathlib.Path("customers/ACME/.sessions/sess-1/session.json").write_text("{}")\n`],
    ["p2.py", `from pathlib import Path\nPath("customers/ACME/.sessions/sess-1/session.json").write_bytes(b"{}")\n`],
    ["p3.py", `from pathlib import Path\nPath("customers/ACME/runs/RUN.ACME.20260929.1000.ADM/result.yaml").write_text("status: green")\n`],
  ];
  for (const extra of [{}, { agent_id: "a1", agent_type: "scope-expert" }]) {
    for (const [f, body] of probes) {
      writeFileSync(join(ws, f), body);
      assert.equal(decisionOf(call(`python ${f}`, extra)), "deny", `${f} ${JSON.stringify(extra)}`);
    }
  }
});

test("riporto 5 — guard-config-scope: /results/ costruito da una variabile di cartella con interprete e primitiva di scrittura ⇒ deny", () => {
  const ws = envWs({ env: "sandbox" });
  const call = (command) => runHook("guard-config-scope", { session_id: "sess-1", cwd: ws, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } }, { JVC_WORKSPACE: ws, CLAUDE_PLUGIN_ROOT: ROOT });
  // sonda del revisore (WP09b giro 3): d = "customers/ACME/runs/RUN.X" e open(d + "/results/P.yaml", "w")
  writeFileSync(join(ws, "r1.py"), `d = "customers/ACME/runs/RUN.ACME.20260929.1000.ADM"\nf = open(d + "/results/P.yaml", "w")\nf.write("status: green")\n`);
  assert.equal(decisionOf(call("python r1.py")), "deny", "script");
  writeFileSync(join(ws, "r2.py"), `from pathlib import Path\nd = "customers/ACME/runs/RUN.ACME.20260929.1000.ADM"\nPath(d + "/results/P.yaml").write_text("status: green")\n`);
  assert.equal(decisionOf(call("python r2.py")), "deny", "script pathlib");
  assert.equal(decisionOf(call(`python -c "d='customers/ACME/runs/RUN.ACME.20260929.1000.ADM'; open(d + '/results/P.yaml','w').write('x')"`)), "deny", "one-liner");
  assert.equal(decisionOf(call(`node -e "const d='customers/ACME/runs/RUN.X'; require('fs').writeFileSync(d + '/results/P.yaml','x')"`)), "deny", "one-liner node");
  // controlli: citare /results/ senza scrivere, o scrivere senza citarlo, resta ammesso
  writeFileSync(join(ws, "r3.py"), `d = "customers/ACME/runs/RUN.ACME.20260929.1000.ADM"\nprint(d + "/results/P.yaml")\n`);
  assert.notEqual(decisionOf(call("python r3.py")), "deny", "nessuna primitiva di scrittura");
  writeFileSync(join(ws, "r4.py"), `from pathlib import Path\nPath("tmp/out.txt").write_text("x")\n`);
  assert.notEqual(decisionOf(call("python r4.py")), "deny", "scrittura altrove");
});
