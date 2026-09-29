// WP10a — struttura dei comandi (§44.1, §56): le 8 famiglie esistono con frontmatter valido; ogni percorso
// ${CLAUDE_PLUGIN_ROOT}/… citato esiste; ogni riga di comando, resa con valori di esempio, è un'invocazione semplice (il
// tokenizzatore dei guard la accetta: niente JSON in linea né caratteri , @ { } ( ) $ …) e lo script risponde a --help;
// gli agenti nominati sono le 15 definizioni foglia (§44.2, WP10b); le frasi dell'utente citate sono quelle del codice.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT, cleanEnv } from "../helpers/hook-env.mjs";
import { simpleArgv } from "../../hooks/lib/exact-argv.mjs";
import { commandFiles, frontmatter, commandLines, renderLine, FAMILIES, LEAF_AGENTS } from "../helpers/commands.mjs";

test("commands/: esattamente le 8 famiglie (vc use kb nrt cfg ops learn admin), frontmatter completo", () => {
  const files = readdirSync(join(ROOT, "commands")).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)).sort();
  assert.deepEqual(files, [...FAMILIES].sort());
  for (const [fam, text] of Object.entries(commandFiles())) {
    const fm = frontmatter(text);
    for (const k of ["description", "argument-hint", "allowed-tools"]) assert.ok(typeof fm[k] === "string" && fm[k].trim(), `${fam}: ${k}`);
    assert.match(fm["allowed-tools"], /Bash\(node \*\)/, fam);
    assert.ok(fm.description.length <= 250, `${fam}: description breve`);
  }
});

test("use.md: argument-hint e corpo citano env (§56.2) insieme a customer, scope, mode, budget, show, close-stale", () => {
  const text = commandFiles().use;
  const fm = frontmatter(text);
  for (const a of ["customer", "env", "scope", "mode", "budget", "show", "close-stale"]) assert.match(fm["argument-hint"], new RegExp(`(^|\\| )${a}\\b`), a);
  assert.match(text, /`env <id>`/);
});

test("ogni ${CLAUDE_PLUGIN_ROOT}/… citato nei comandi esiste nel repository", () => {
  const dangling = [];
  for (const [fam, text] of Object.entries(commandFiles())) {
    for (const m of text.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([\w./-]+)/g)) if (!existsSync(join(ROOT, m[1]))) dangling.push(`${fam}: ${m[1]}`);
  }
  assert.deepEqual(dangling, []);
});

test("ogni riga di comando resa è un'invocazione semplice (tokenizzatore dei guard) senza JSON in linea", () => {
  const bad = [];
  let n = 0;
  for (const [fam, text] of Object.entries(commandFiles())) {
    for (const line of commandLines(text)) {
      n++;
      const r = renderLine(line, "C:/plugin");
      if (!simpleArgv(r)) bad.push(`${fam}: ${line}`);
      if (/--payload\s+['"{]/.test(line)) bad.push(`${fam} (JSON in linea): ${line}`);
    }
  }
  assert.ok(n >= 60, `righe di comando trovate: ${n}`);
  assert.deepEqual(bad, []);
});

test("ogni script citato dai comandi risponde a --help (exit 0)", () => {
  const scripts = new Set();
  for (const text of Object.values(commandFiles())) for (const line of commandLines(text)) scripts.add(/\$\{CLAUDE_PLUGIN_ROOT\}\/([\w./-]+\.mjs)/.exec(line)[1]);
  assert.ok(scripts.size >= 30, `script: ${scripts.size}`);
  const failed = [];
  for (const s of scripts) {
    const r = spawnSync(process.execPath, [join(ROOT, s), "--help"], { encoding: "utf8", env: cleanEnv(), timeout: 30000 });
    if (r.status !== 0) failed.push(`${s}: ${r.status} ${r.stderr.slice(0, 120)}`);
  }
  assert.deepEqual(failed, []);
});

test("gli agenti instradati sono le 15 definizioni foglia (§44.2); nessun comando instrada su agent-manager", () => {
  const unknown = [];
  const used = new Set();
  for (const [fam, text] of Object.entries(commandFiles())) {
    for (const m of text.matchAll(/Agent\(([a-z-]+)/g)) { used.add(m[1]); if (!LEAF_AGENTS.includes(m[1])) unknown.push(`${fam}: ${m[1]}`); }
  }
  assert.deepEqual(unknown, []);
  for (const a of ["scope-expert", "scope-extractor", "scope-digester", "cluster-validator", "customer-profiler", "failure-triage", "root-cause-analyst", "test-mechanic",
    "defect-reporter", "config-designer", "config-auditor", "analytics-learner", "lesson-validator", "weekly-digest"]) assert.ok(used.has(a), `instradato: ${a}`);
});

test("instradamento (§44.1, §56.x): vc e admin solo script diretti; kb review diretto; le frasi di approvazione citate sono quelle del codice", async () => {
  const c = commandFiles();
  assert.doesNotMatch(c.vc, /Agent\(/);
  assert.doesNotMatch(c.admin, /Agent\(/);
  assert.match(c.kb, /scripts\/kb\/review\.mjs" queue/);
  assert.match(c.admin, /APPROVO PURGE <ID> DA <Nome Cognome>/);
  assert.match(c.admin, /APPROVO RETENTION <C>/);
  assert.match(c.learn, /APPROVO PROMOZIONE <codice>/);
  for (const p of ["APPROVO PIANO <PLAN>", "APPROVO PROVA <PLAN>", "APPROVO PASSO <n> <PLAN>"]) assert.ok(c.cfg.includes(p), p);
  const { parseApprovalPrompt } = await import("../../scripts/admin/approvals.mjs");
  assert.equal(parseApprovalPrompt("APPROVO PASSO 4 PLAN.ACME.0042").kind, "A3");
  assert.equal(parseApprovalPrompt("APPROVO PURGE ACME DA Mario Rossi").kind, "purge");
  // ops: rifiuto prima del dispatch in produzione; nrt heal: PR con review umana
  assert.match(c.ops, /prod/);
  assert.match(c.nrt, /review umana/);
});

// Le righe di comando rese con valori realistici passano davvero dai guard (in processo, stessi moduli degli hook): nessuna
// è negata. Le righe con token di approvazione (purge, retention --apply, promote) sono a forma esatta e dipendono dal
// registro della sessione e dal transcript: le coprono i test di WP09d e di WP10a sui guard.
test("le righe di comando rese passano dai guard veri senza deny (config-scope, destructive, customer, scope, phrase)", async () => {
  const { ws09d, withSession } = await import("../helpers/wp09d.mjs");
  const ws = ws09d(); withSession(ws);
  const SAMPLE = { C: "ACME", ID: "ACME", "cliente attivo": "ACME", S: "CAT", RUN: "RUN.ACME.20260923.1000.CAT", codice: "L.ACME.CAT.FLW.0001", sessione: "sess-1",
    PLAN: "PLAN.ACME.0042", CFG: "C.ACME.ADM.CFG.0001", release: "R25.3", documento: "requisition" };
  const render = (l) => l.replaceAll("${CLAUDE_PLUGIN_ROOT}", ROOT).replace(/\$ARGUMENTS/g, "find --scope CAT").replace(/<([^<>]*)>/g, (m, k) => SAMPLE[k] ?? "x1");
  const guards = await Promise.all(["config-scope", "destructive", "customer", "scope", "phrase"].map(async (g) => [g, (await import(`../../hooks/lib/guards/${g}.mjs`)).decide]));
  const env = { ...cleanEnv(), JVC_WORKSPACE: ws, CLAUDE_PLUGIN_ROOT: ROOT };
  const bad = [];
  for (const [fam, text] of Object.entries(commandFiles())) {
    for (const line of commandLines(text)) {
      if (/--approval/.test(line)) continue;
      const input = { session_id: "sess-1", cwd: ws, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: render(line) } };
      for (const [g, decide] of guards) {
        const out = await decide(input, env);
        const d = out?.hookSpecificOutput?.permissionDecision;
        if (d === "deny" || d === "ask") bad.push(`${fam} · ${g}: ${line.slice(28, 110)} — ${String(out.hookSpecificOutput.permissionDecisionReason).slice(0, 140)}`);
      }
    }
  }
  assert.deepEqual(bad, []);
});
