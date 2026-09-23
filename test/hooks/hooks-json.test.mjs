import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../helpers/hook-env.mjs";

const HOOKS = JSON.parse(readFileSync(join(ROOT, "hooks/hooks.json"), "utf8"));

// Registrazioni attese: evento → [matcher, script] (le fasi successive aggiungono voci).
const EXPECTED = [
  ["SessionStart", undefined, "session-context"],
  ["PreCompact", undefined, "precompact-save"],
  ["Stop", undefined, "stop-integrity"],
  ["PostToolUse", ".*", "audit-append"],
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
