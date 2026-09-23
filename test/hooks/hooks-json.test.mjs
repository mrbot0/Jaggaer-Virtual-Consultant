import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../helpers/hook-env.mjs";
import { BROWSER_MATCHER } from "../../hooks/lib/browser-tools.mjs";

const HOOKS = JSON.parse(readFileSync(join(ROOT, "hooks/hooks.json"), "utf8"));

// Registrazioni attese: evento → [matcher, script] (le fasi successive aggiungono voci).
const EXPECTED = [
  ["SessionStart", undefined, "session-context"],
  ["PreCompact", undefined, "precompact-save"],
  ["Stop", undefined, "stop-integrity"],
  ["PostToolUse", ".*", "audit-append"],
  ["PreToolUse", "Write|Edit|MultiEdit|NotebookEdit|Read|Glob|Grep", "guard-domain-boundary"],
  ["PreToolUse", "Write|Edit|MultiEdit|NotebookEdit|Read|Glob|Grep", "guard-scope"],
  ["PreToolUse", "Write|Edit|MultiEdit|NotebookEdit|Read|Glob|Grep|Bash|PowerShell", "guard-customer"],
  ["PreToolUse", "Agent|Task", "guard-budget"],
  ["PreToolUse", "Bash|PowerShell", "guard-budget"],
  ["PreToolUse", "Bash|PowerShell", "guard-scope"],
  ["SubagentStop", undefined, "subagent-trace"],
  // K5: guard del browser (matcher condiviso con hooks/lib/browser-tools.mjs), protezione del registro 3A, cattura delle approvazioni.
  ["PreToolUse", BROWSER_MATCHER, "guard-environment"],
  ["PreToolUse", BROWSER_MATCHER, "guard-production"],
  ["PreToolUse", BROWSER_MATCHER, "guard-config-scope"],
  ["PreToolUse", "Bash|PowerShell|Write|Edit|MultiEdit|NotebookEdit", "guard-config-scope"],
  ["UserPromptSubmit", undefined, "approval-capture"],
];

const entries = () => Object.entries(HOOKS.hooks).flatMap(([event, groups]) => groups.flatMap((g) => g.hooks.map((h) => ({ event, matcher: g.matcher, ...h }))));

test("hooks.json: struttura del formato plugin, comandi node su ${CLAUDE_PLUGIN_ROOT}, timeout 5–10 s", () => {
  assert.equal(typeof HOOKS.hooks, "object");
  for (const [event, groups] of Object.entries(HOOKS.hooks)) {
    assert.ok(["SessionStart", "PreToolUse", "PostToolUse", "SubagentStop", "PreCompact", "Stop", "UserPromptSubmit"].includes(event), event);
    assert.ok(Array.isArray(groups) && groups.length);
    for (const g of groups) {
      if (g.matcher !== undefined) { assert.equal(typeof g.matcher, "string"); new RegExp(g.matcher); }
      for (const h of g.hooks) {
        assert.equal(h.type, "command");
        assert.match(h.command, /^node "\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/scripts\/[a-z-]+\.mjs"$/);
        assert.ok(h.timeout >= 5 && h.timeout <= 10, `${h.command} timeout ${h.timeout}`);
      }
    }
  }
});

test("hooks.json: ogni script referenziato esiste; le registrazioni di questa fase sono presenti", () => {
  for (const e of entries()) {
    const rel = /hooks\/scripts\/([a-z-]+\.mjs)/.exec(e.command)[1];
    assert.ok(existsSync(join(ROOT, "hooks/scripts", rel)), `manca ${rel}`);
  }
  for (const [event, matcher, name] of EXPECTED) {
    assert.ok(entries().some((e) => e.event === event && e.matcher === matcher && e.command.includes(`/${name}.mjs`)), `${event} ${matcher ?? ""} → ${name}`);
  }
});

test("hooks.json K5: il matcher del browser cattura le tre famiglie e i server del plugin; ogni guard ricontrolla tool_name", () => {
  const g = HOOKS.hooks.PreToolUse.find((x) => x.matcher === BROWSER_MATCHER);
  assert.ok(g, "gruppo del browser");
  const re = new RegExp(g.matcher);
  for (const t of ["mcp__chrome-devtools__click", "mcp__plugin_chrome-devtools-mcp_chrome-devtools__fill", "mcp__Claude_Browser__computer", "mcp__claude-in-chrome__navigate",
    "mcp__playwright__browser_click", "mcp__plugin_playwright_playwright__browser_type", "mcp__plugin_jaggaer-virtual-consultant_chrome-devtools__click"]) assert.ok(re.test(t), t);
  for (const t of ["Read", "Bash", "mcp__alm__create_issue"]) assert.equal(re.test(t), false, t);
  assert.deepEqual(g.hooks.map((h) => /scripts\/([a-z-]+)\.mjs/.exec(h.command)[1]), ["guard-environment", "guard-production", "guard-config-scope"]);
});
