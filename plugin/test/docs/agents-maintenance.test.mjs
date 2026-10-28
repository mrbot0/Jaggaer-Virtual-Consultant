// 28/10/2026: agenti di manutenzione (workspace-manager, health-keeper) — frontmatter, niente strumenti vietati, script
// citati esistenti, rapporto YAML, e il manager sa quando invocarli.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../helpers/hook-env.mjs";
import { MAINTENANCE_AGENTS, AGENTS_DIR, parseAgent, toolList } from "../helpers/agents-md.mjs";

const FORBIDDEN = ["Agent", "Task", "AskUserQuestion", "WebFetch", "WebSearch"];

for (const name of MAINTENANCE_AGENTS) {
  test(`${name}: frontmatter, strumenti, script citati, rapporto`, () => {
    const text = readFileSync(join(AGENTS_DIR, `${name}.md`), "utf8").replace(/\r\n/g, "\n");
    const { fm, body } = parseAgent(text);
    assert.equal(fm.name, name);
    assert.ok(typeof fm.description === "string" && fm.description.length > 40);
    assert.equal(fm.model, "sonnet");
    const tools = toolList(fm.tools);
    for (const t of FORBIDDEN) assert.ok(!tools.includes(t), `${name}: ${t}`);
    assert.ok(!tools.some((t) => t.startsWith("mcp__")), `${name}: nessuno strumento del browser`);
    for (const m of body.matchAll(/scripts\/([\w/-]+\.mjs)/g)) assert.ok(existsSync(join(ROOT, "scripts", m[1])), `${name}: scripts/${m[1]}`);
    assert.match(body, /agent-report\.schema\.json/);
    assert.match(body, /non tocchi/i);
  });
}

test("il manager sa quando invocare gli agenti di manutenzione", () => {
  const skill = readFileSync(join(ROOT, "skills/agent-manager/SKILL.md"), "utf8");
  for (const name of MAINTENANCE_AGENTS) assert.match(skill, new RegExp(`\`${name}\``));
});
