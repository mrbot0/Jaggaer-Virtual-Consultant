// 28/10/2026: i sub-agenti non riuscivano a eseguire gli script del plugin (installato sotto ~/.claude/plugins) con la forma
// abituale `cd <cartella> && node <plugin>/scripts/… 2>&1 | head -50` o con $CLAUDE_PLUGIN_ROOT: non era una chiamata
// "semplice" e cadeva nei divieti sul testo `.claude` / sul plugin citato con un interprete.
import { test } from "node:test";
import assert from "node:assert/strict";
import { envWs } from "../helpers/env-fixture.mjs";
import { runHook, decisionOf, ROOT } from "../helpers/hook-env.mjs";

const E = (ws) => ({ JVC_WORKSPACE: ws, CLAUDE_PLUGIN_ROOT: ROOT });
const g = (ws, command) => runHook("guard-config-scope", { session_id: "sess-1", cwd: ws, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } }, E(ws));
const R = ROOT.replace(/\\/g, "/");

test("forme composte di una chiamata a uno script del plugin: consentite", () => {
  const ws = envWs({ env: "sandbox", scope: "ADM" });
  for (const c of [
    `node "${R}/scripts/admin/approvals.mjs" status --session sess-1`,
    `node "${R}/scripts/admin/approvals.mjs" status --session sess-1 2>&1`,
    `node "${R}/scripts/admin/approvals.mjs" status --session sess-1 2>&1 | head -50`,
    `node "${R}/scripts/admin/approvals.mjs" status --session sess-1 | tail -n 20`,
    `cd "${ws}" && node "${R}/scripts/admin/approvals.mjs" status --session sess-1 2>&1 | head -50`,
    `node "$CLAUDE_PLUGIN_ROOT/scripts/admin/approvals.mjs" status --session sess-1`,
    `node "\${CLAUDE_PLUGIN_ROOT}/scripts/admin/approvals.mjs" status --session sess-1 | grep -i plan`,
  ]) assert.notEqual(decisionOf(g(ws, c)), "deny", c);
});

test("restano negate le forme pericolose", () => {
  const ws = envWs({ env: "sandbox", scope: "ADM" });
  for (const c of [
    `node "${R}/scripts/admin/approvals.mjs" status > "${ws}/customers/ACME/.sessions/sess-1/approvals.jsonl"`,
    `node "${R}/scripts/admin/approvals.mjs" status && node -e "require('fs').writeFileSync('x','y')"`,
    `node "${R}/scripts/admin/approvals.mjs" status | tee "${ws}/customers/ACME/.sessions/sess-1/session.json"`,
    `node "${R}/scripts/admin/approvals.mjs" status --db .claude/settings.json 2>&1 | head`,
    `node -e "1" 2>&1 | head -5 # ${R}/hooks`,
  ]) assert.equal(decisionOf(g(ws, c)), "deny", c);
});
