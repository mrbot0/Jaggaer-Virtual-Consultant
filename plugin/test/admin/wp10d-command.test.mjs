// WP10d D4 — /vc agents (famiglia vc, §44.1: stato della sessione): il comando reso con argomenti di esempio esegue
// la console; il frontmatter annuncia il sottocomando; il manuale indica `watch` da un terminale separato.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { cleanEnv, ROOT } from "../helpers/hook-env.mjs";
import { agentsFixture, SID } from "../helpers/agents-fixture.mjs";

const body = readFileSync(join(ROOT, "commands/vc.md"), "utf8");

test("commands/vc.md: sottocomando agents (status | show <task_id> | history) annunciato e documentato; watch da terminale", () => {
  const fm = /^---\n([\s\S]*?)\n---/.exec(body.replace(/\r\n/g, "\n"))[1];
  assert.match(fm, /argument-hint: .*agents \[show <task_id> \| history/);
  assert.match(fm, /description: .*agenti/);
  assert.match(body, /node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/admin\/agents\.mjs" status --session "\$\{CLAUDE_SESSION_ID\}" --json/);
  assert.match(body, /agents\.mjs" watch --session <SES/);
  for (const p of ["PAUSA AGENTE <task_id>", "RIPRENDI AGENTE <task_id>", "FERMA AGENTE <task_id>", "PASSO PASSO <task_id|TUTTI>", "SBLOCCA SCOPE <S>", "LIMITI DISPATCH <chiamate> <minuti>"]) assert.ok(body.includes(p), p);
  assert.match(body, /non scrivere mai tu queste frasi/);
});

test("/vc agents: la riga di comando resa (status, show, history) funziona sulla sessione di esempio", () => {
  const { ws } = agentsFixture();
  const lines = [...body.matchAll(/node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/admin\/agents\.mjs" ([^\n`]*)/g)].map((m) => m[1].trim()).filter((x) => !x.startsWith("watch"));
  assert.ok(lines.length >= 3, lines.join(" | "));
  for (const l of lines) {
    const args = l.replace(/"\$\{CLAUDE_SESSION_ID\}"/, SID).replace("<task_id>", "T-A").replace(/\s*\(.*$/, "").split(/\s+/).filter(Boolean);
    const r = spawnSync(process.execPath, [join(ROOT, "scripts/admin/agents.mjs"), ...args, "--workspace", ws], { env: cleanEnv(), encoding: "utf8" });
    assert.equal(r.status, 0, `${l}: ${r.stderr}${r.stdout}`);
    assert.equal(JSON.parse(r.stdout).ok, true, l);
  }
});

test("D5 docs/orchestration.md: contratto per la skill agent-manager allineato al codice (messaggi, limiti, frasi, tre livelli)", async () => {
  const doc = readFileSync(join(ROOT, "docs/orchestration.md"), "utf8");
  const { VIGILANCE_MESSAGE } = await import("../../hooks/lib/invocations.mjs");
  const { ESCALATION_MESSAGE } = await import("../../hooks/lib/guards/orchestration.mjs");
  const { DEFAULT_LIMITS, CONTROL_SYNTAX } = await import("../../hooks/lib/control.mjs");
  assert.ok(doc.includes(VIGILANCE_MESSAGE));
  assert.ok(doc.includes(ESCALATION_MESSAGE));
  assert.ok(doc.includes(`${DEFAULT_LIMITS.calls} chiamate di strumento e ${DEFAULT_LIMITS.minutes} minuti`));
  for (const p of CONTROL_SYNTAX) for (const part of p.split(/ <|\|/)[0].split(" ")) assert.ok(doc.includes(part), p);
  for (const s of ["Prima di instradare", "Dopo ogni ritorno", "Prima di rispondere all'utente", "Regole applicate dal codice", "Resta istruzione della skill", "Manager", "Regole di orchestrazione", "Monitor"]) assert.ok(doc.includes(s), s);
});
