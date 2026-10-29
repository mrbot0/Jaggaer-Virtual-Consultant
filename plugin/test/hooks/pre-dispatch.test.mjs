// 29/10/2026 (punto 5): un solo processo per chiamata. hooks.json registra in PreToolUse solo pre-dispatch; il dispatcher
// esegue i guard della tabella (stessi matcher di prima) e decide come i guard eseguiti separatamente: un deny qualunque
// vince, guard-config-scope gira per ultimo.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, runHook, decisionOf } from "../helpers/hook-env.mjs";
import { envWs } from "../helpers/env-fixture.mjs";
import { guardsFor, dispatch } from "../../hooks/lib/dispatch.mjs";

const E = (ws) => ({ JVC_WORKSPACE: ws, CLAUDE_PLUGIN_ROOT: ROOT });

test("hooks.json: in PreToolUse un solo hook, pre-dispatch su ogni strumento", () => {
  const h = JSON.parse(readFileSync(join(ROOT, "hooks/hooks.json"), "utf8"));
  assert.equal(h.hooks.PreToolUse.length, 1);
  assert.equal(h.hooks.PreToolUse[0].matcher, ".*");
  assert.deepEqual(h.hooks.PreToolUse[0].hooks.map((x) => /scripts\/([a-z-]+)\.mjs/.exec(x.command)[1]), ["pre-dispatch"]);
});

test("guardsFor: i guard dei matcher di prima, senza doppioni, guard-config-scope per ultimo", () => {
  const click = guardsFor("mcp__chrome-devtools__click");
  for (const g of ["guard-phrase", "guard-control", "guard-environment", "guard-production", "guard-destructive", "guard-config-scope"]) assert.ok(click.includes(g), g);
  assert.equal(click.at(-1), "guard-config-scope");
  assert.equal(new Set(click).size, click.length);
  assert.deepEqual(new Set(guardsFor("Read")), new Set(["guard-phrase", "guard-control", "guard-domain-boundary", "guard-scope", "guard-customer"]));
  const bash = guardsFor("Bash");
  for (const g of ["guard-customer", "guard-budget", "guard-scope", "guard-config-scope", "guard-destructive"]) assert.ok(bash.includes(g), g);
  assert.ok(guardsFor("mcp__alm__alm_create_defect").includes("guard-alm-write"));
});

test("equivalenza: la decisione del dispatcher è quella dei guard eseguiti uno per uno", () => {
  const ws = envWs({ env: "sandbox", scope: "ADM" });
  const cases = [
    ["Read", { file_path: join(ws, "customers/ACME/kb/x.yaml") }],
    ["Write", { file_path: join(ws, "customers/ACME/.sessions/sess-1/approvals.jsonl"), content: "x" }],
    ["Bash", { command: "git status" }],
    ["Agent", { subagent_type: "jaggaer-virtual-consultant:scope-expert", prompt: "senza header" }],
    ["mcp__chrome-devtools__click", { uid: "1_2" }],
    ["mcp__chrome-devtools__take_snapshot", {}],
  ];
  for (const [tool, ti] of cases) {
    const input = { session_id: "sess-1", cwd: ws, hook_event_name: "PreToolUse", tool_name: tool, tool_input: ti };
    const single = guardsFor(tool).map((g) => decisionOf(runHook(g, input, E(ws))));
    const expected = single.includes("deny") ? "deny" : null;
    const got = decisionOf(runHook("pre-dispatch", input, E(ws)));
    assert.equal(got === "deny" ? "deny" : null, expected, `${tool}: ${single.join(",")} → ${got}`);
  }
});

test("giro 2: guard-control e guard-config-scope per ultimi (token monouso); oltre il tempo massimo si nega", async () => {
  const click = guardsFor("mcp__chrome-devtools__click");
  assert.deepEqual(click.slice(-2), ["guard-control", "guard-config-scope"]);
  const r = await dispatch({ tool_name: "Read" }, { budgetMs: 20, runner: () => new Promise(() => {}) });
  assert.equal(decisionOf({ json: r }), "deny");
});

test("giro 2: lo script avvia runHook sempre (nessun controllo isMain che spegnerebbe i guard)", () => {
  const src = readFileSync(join(ROOT, "hooks/scripts/pre-dispatch.mjs"), "utf8");
  assert.doesNotMatch(src, /import[^\n]*isMain/);
  assert.match(src, /^runHook\(/m);
});
