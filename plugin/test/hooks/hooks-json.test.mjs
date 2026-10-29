import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../helpers/hook-env.mjs";
import { BROWSER_MATCHER } from "../../hooks/lib/browser-tools.mjs";
import { ALM_MATCHER } from "../../hooks/lib/alm.mjs";

import { hooksView } from "../helpers/hooks-view.mjs";
// 29/10/2026 (punto 5): i guard di PreToolUse stanno in hooks/lib/dispatch-table.json, eseguiti da pre-dispatch
const HOOKS = hooksView();

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
  ["PreToolUse", "mcp__.*", "guard-environment"],   // giro di correzione 1 (I5): ogni server MCP
  ["PreToolUse", BROWSER_MATCHER, "guard-production"],
  ["PreToolUse", BROWSER_MATCHER, "guard-config-scope"],
  ["PreToolUse", "Bash|PowerShell|Write|Edit|MultiEdit|NotebookEdit", "guard-config-scope"],
  ["UserPromptSubmit", undefined, "approval-capture"],
  // K5 giro 2: frasi dell'utente negate in ogni input (N5); origine del browser a consuntivo (N1).
  ["PreToolUse", ".*", "guard-phrase"],
  ["PostToolUse", BROWSER_MATCHER, "browser-origin"],
  // K6.2: un'OBS per ogni risultato del browser (fail-open), origine osservata.
  ["PostToolUse", BROWSER_MATCHER, "observe-append"],
  // F0.1: deny-list (policy/deny-rules.yaml) su shell, scritture e browser.
  ["PreToolUse", `Bash|PowerShell|Write|Edit|MultiEdit|NotebookEdit|${BROWSER_MATCHER}`, "guard-destructive"],
  // F0.2: scritture sull'ALM (server del plugin, Jira, Atlassian) e registro di ciò che il plugin crea.
  ["PreToolUse", ALM_MATCHER, "guard-alm-write"],
  ["PostToolUse", ALM_MATCHER, "alm-record"],
  // WP10d D8: controllo dell'utente sugli agenti (pausa, stop, passo-passo, limiti) su ogni strumento.
  ["PreToolUse", ".*", "guard-control"],
];

const entries = () => Object.entries(HOOKS.hooks).flatMap(([event, groups]) => groups.flatMap((g) => g.hooks.map((h) => ({ event, matcher: g.matcher, ...h }))));

test("hooks.json: struttura del formato plugin, comandi node su ${CLAUDE_PLUGIN_ROOT}, timeout 5–10 s (observe-append 60 s)", () => {
  assert.equal(typeof HOOKS.hooks, "object");
  for (const [event, groups] of Object.entries(HOOKS.hooks)) {
    assert.ok(["SessionStart", "PreToolUse", "PostToolUse", "SubagentStop", "PreCompact", "Stop", "UserPromptSubmit"].includes(event), event);
    assert.ok(Array.isArray(groups) && groups.length);
    for (const g of groups) {
      if (g.matcher !== undefined) { assert.equal(typeof g.matcher, "string"); new RegExp(g.matcher); }
      for (const h of g.hooks) {
        assert.equal(h.type, "command");
        assert.match(h.command, /^node "\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/scripts\/[a-z-]+\.mjs"$/);
        // guard sulla grandezza tolto (27/10/2026): observe-append riceve snapshot di decine di MB ⇒ 60 s
        if (h.command.includes("/observe-append.mjs")) assert.equal(h.timeout, 60, h.command);
        else assert.ok(h.timeout >= 5 && h.timeout <= 10, `${h.command} timeout ${h.timeout}`);
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
  assert.deepEqual(g.hooks.map((h) => /scripts\/([a-z-]+)\.mjs/.exec(h.command)[1]), ["guard-production", "guard-config-scope"]);
  // guard-environment su ogni strumento MCP (I5), una sola volta per chiamata
  const all = HOOKS.hooks.PreToolUse.filter((x) => x.hooks.some((h) => h.command.includes("/guard-environment.mjs")));
  assert.deepEqual(all.map((x) => x.matcher), ["mcp__.*"]);
  for (const t of ["mcp__webdriver__click", "mcp__computer-use__left_click", "mcp__stagehand__act", "mcp__chrome-devtools__click"]) assert.ok(new RegExp(all[0].matcher).test(t), t);
});

test("hooks.json F0.1: guard-destructive su Bash, PowerShell, scritture e tre famiglie del browser, una sola volta per chiamata", () => {
  const groups = HOOKS.hooks.PreToolUse.filter((x) => x.hooks.some((h) => h.command.includes("/guard-destructive.mjs")));
  assert.equal(groups.length, 1);
  const re = new RegExp(`^(?:${groups[0].matcher})$`);
  for (const t of ["Bash", "PowerShell", "Write", "Edit", "MultiEdit", "NotebookEdit", "mcp__Claude_Browser__computer", "mcp__claude-in-chrome__form_input",
    "mcp__chrome-devtools__click", "mcp__plugin_playwright_playwright__browser_click"]) assert.ok(re.test(t), t);
  for (const t of ["Read", "Glob", "Grep", "Agent", "mcp__alm__alm_get_test"]) assert.equal(re.test(t), false, t);
});

test("hooks.json F0.2: guard-alm-write e alm-record sui server ALM, Jira e Atlassian (il guard ricontrolla il nome del server)", () => {
  const re = new RegExp(`^(?:${ALM_MATCHER})$`);
  for (const t of ["mcp__alm__alm_create_defect", "mcp__plugin_jaggaer-virtual-consultant_alm__alm_import_results", "mcp__claude_ai_Atlassian__createJiraIssue",
    "mcp__jira__jira_delete_issue", "mcp__plugin_productivity_atlassian__editJiraIssue", "mcp__JIRA__x"]) assert.ok(re.test(t), t);
  for (const t of ["Bash", "mcp__chrome-devtools__click", "mcp__Claude_Browser__computer"]) assert.equal(re.test(t), false, t);
  const g = (ev) => HOOKS.hooks[ev].filter((x) => x.hooks.some((h) => /guard-alm-write|alm-record/.test(h.command)));
  assert.deepEqual(g("PreToolUse").map((x) => x.matcher), [ALM_MATCHER]);
  assert.deepEqual(g("PostToolUse").map((x) => x.matcher), [ALM_MATCHER]);
});
