import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("il manifest esiste ed è valido", () => {
  const m = JSON.parse(readFileSync(new URL("../.claude-plugin/plugin.json", import.meta.url), "utf8"));
  assert.equal(m.name, "jaggaer-virtual-consultant");
  assert.match(m.version, /^\d+\.\d+\.\d+$/);
  assert.equal(m.hooks, "./hooks/hooks.json");
  assert.equal(m.mcpServers, "./.mcp.json");
});
