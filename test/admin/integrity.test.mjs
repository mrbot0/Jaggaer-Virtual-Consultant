// F0.3 — integrità del pacchetto (§53.1): integrity build/verify, firma Ed25519 facoltativa, verifica a SessionStart
// (session-context, < 2 s, cache sugli mtime), gate dei guard FAIL-CLOSED: integrità non ok ⇒ deny di tutto tranne gli
// strumenti di sola lettura del workspace e la chiamata Bash a doctor / integrity verify; JVC_DEV=1 salta il gate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, unlinkSync, existsSync, appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { copyPlugin } from "../helpers/plugin-copy.mjs";
import { mkWs, seedSession, cleanEnv, decisionOf, reasonOf, ROOT } from "../helpers/hook-env.mjs";

const cli = (plugin, args, env = {}) => {
  const r = spawnSync(process.execPath, [join(plugin, "scripts/admin/integrity.mjs"), ...args], { env: cleanEnv(env), encoding: "utf8", timeout: 60000 });
  let json = null;
  try { json = JSON.parse(r.stdout.trim().split("\n").pop()); } catch { /* testo */ }
  return { ...r, json };
};
// hook del plugin COPIATO (non del repository): processo separato come in Claude Code
const hook = (plugin, name, input, env = {}) => {
  const r = spawnSync(process.execPath, [join(plugin, "hooks/scripts", `${name}.mjs`)], { input: JSON.stringify(input), env: cleanEnv({ CLAUDE_PLUGIN_ROOT: plugin, ...env }), encoding: "utf8", timeout: 30000 });
  let json = null;
  try { json = r.stdout.trim() ? JSON.parse(r.stdout) : null; } catch { json = { unparsable: r.stdout }; }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
};
const pre = (ws, tool, tool_input) => ({ session_id: "sess-1", cwd: ws, hook_event_name: "PreToolUse", tool_name: tool, tool_input });

test("build: sha256 di hooks/ scripts/ decision-tables/ strategies/ policy/ schemas/ + .mcp.json e plugin.json, ordinati, a capo LF; verify ok", () => {
  const p = copyPlugin();
  const b = cli(p, ["build", "--json"]);
  assert.equal(b.status, 0, b.stderr + b.stdout);
  const m = JSON.parse(readFileSync(join(p, "integrity.json"), "utf8"));
  assert.equal(m.algorithm, "sha256");
  assert.equal(m.version, JSON.parse(readFileSync(join(p, ".claude-plugin/plugin.json"), "utf8")).version);
  assert.ok(!Number.isNaN(Date.parse(m.generated_at)));
  const files = Object.keys(m.files);
  assert.deepEqual(files, [...files].sort());
  for (const f of ["hooks/hooks.json", "hooks/lib/io.mjs", "scripts/admin/integrity.mjs", "policy/deny-rules.yaml", "schemas/session.schema.json", ".mcp.json", ".claude-plugin/plugin.json"]) assert.ok(files.includes(f), f);
  assert.ok(files.some((f) => f.startsWith("decision-tables/")) && files.some((f) => f.startsWith("strategies/")));
  assert.ok(!files.some((f) => f.includes("node_modules") || f === "integrity.json" || f.startsWith("templates/")));
  for (const h of Object.values(m.files)) assert.match(h, /^[0-9a-f]{64}$/);
  const v = cli(p, ["verify", "--json"]);
  assert.equal(v.status, 0, v.stdout);
  assert.deepEqual({ ok: v.json.ok, mismatched: v.json.mismatched, missing: v.json.missing, extra: v.json.extra, signature: v.json.signature }, { ok: true, mismatched: [], missing: [], extra: [], signature: "absent" });
  // stesso contenuto con a capo CRLF (checkout Windows) ⇒ stessa impronta
  const f = join(p, "hooks/lib/io.mjs");
  writeFileSync(f, readFileSync(f, "utf8").replace(/\n/g, "\r\n"));
  assert.equal(cli(p, ["verify", "--json"]).json.ok, true);
});

test("verify: file alterato, mancante, in più ⇒ ok false (exit 3) con l'elenco; manifesto assente ⇒ exit 3", () => {
  const p = copyPlugin();
  cli(p, ["build"]);
  appendFileSync(join(p, "scripts/decide/dt-eval.mjs"), "\n// manomesso\n");
  unlinkSync(join(p, "strategies", readFileSync(join(p, "integrity.json"), "utf8").match(/"strategies\/([^"]+)"/)[1]));
  writeFileSync(join(p, "hooks/lib/evil.mjs"), "export default 1;\n");
  const v = cli(p, ["verify", "--json"]);
  assert.equal(v.status, 3);
  assert.equal(v.json.ok, false);
  assert.deepEqual(v.json.mismatched, ["scripts/decide/dt-eval.mjs"]);
  assert.equal(v.json.missing.length, 1);
  assert.deepEqual(v.json.extra, ["hooks/lib/evil.mjs"]);
  unlinkSync(join(p, "integrity.json"));
  const a = cli(p, ["verify", "--json"]);
  assert.equal(a.status, 3);
  assert.equal(a.json.status, "absent");
  assert.equal(cli(p, ["--help"]).status, 0);
  assert.equal(cli(p, ["frobnicate"]).status, 1);
});

test("firma Ed25519 staccata: ok con la chiave pubblica del pacchetto; manifesto cambiato ⇒ invalid; firma rimossa con chiave presente ⇒ absent e ok false", () => {
  const p = copyPlugin();
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const keyDir = mkWs("key-");
  const priv = join(keyDir, "private.pem");
  writeFileSync(priv, privateKey.export({ type: "pkcs8", format: "pem" }));
  writeFileSync(join(p, ".claude-plugin/signing-key.pem"), publicKey.export({ type: "spki", format: "pem" }));
  assert.equal(cli(p, ["build", "--sign-key", priv]).status, 0);
  assert.ok(existsSync(join(p, "integrity.json.sig")));
  let v = cli(p, ["verify", "--json"]);
  assert.equal(v.json.signature, "ok");
  assert.equal(v.json.ok, true);
  const m = JSON.parse(readFileSync(join(p, "integrity.json"), "utf8"));
  m.files["hooks/lib/io.mjs"] = "0".repeat(64);
  writeFileSync(join(p, "integrity.json"), JSON.stringify(m, null, 2) + "\n");
  v = cli(p, ["verify", "--json"]);
  assert.equal(v.json.signature, "invalid");
  assert.equal(v.json.ok, false);
  cli(p, ["build"]);   // manifesto rigenerato senza firma, chiave pubblica ancora nel pacchetto
  if (existsSync(join(p, "integrity.json.sig"))) unlinkSync(join(p, "integrity.json.sig"));
  v = cli(p, ["verify", "--json"]);
  assert.equal(v.json.signature, "absent");
  assert.equal(v.json.ok, false);
});

test("SessionStart: session-context verifica (< 2 s), scrive session.integrity e .jvc/integrity.json; file alterato ⇒ ogni guard nega tutto tranne Read/Glob/Grep e doctor / integrity verify; JVC_DEV=1 salta il gate", () => {
  const p = copyPlugin();
  cli(p, ["build"]);
  const ws = mkWs();
  seedSession(ws);
  const E = { JVC_WORKSPACE: ws };
  const start = { session_id: "sess-1", cwd: ws, hook_event_name: "SessionStart", source: "startup" };
  const t0 = performance.now();
  let r = hook(p, "session-context", start, E);
  const ms = performance.now() - t0;
  assert.equal(r.status, 0, r.stderr);
  assert.ok(ms < 2000, `session-context ${ms.toFixed(0)} ms`);
  const sess = () => JSON.parse(readFileSync(join(ws, "customers/ACME/.sessions/sess-1/session.json"), "utf8"));
  assert.equal(sess().integrity.ok, true);
  assert.equal(JSON.parse(readFileSync(join(ws, ".jvc/integrity.json"), "utf8")).ok, true);
  assert.equal(hook(p, "guard-destructive", pre(ws, "Bash", { command: "ls" }), E).stdout.trim(), "", "integrità ok: nessun effetto");
  // manomissione di un file del pacchetto (anche fuori dai guard: una tabella di decisione)
  appendFileSync(join(p, "scripts/decide/dt-eval.mjs"), "\n// manomesso\n");
  r = hook(p, "session-context", start, E);
  assert.match(r.json.hookSpecificOutput.additionalContext, /Integrità del pacchetto fallita/);
  assert.equal(sess().integrity.ok, false);
  const calls = [
    ["guard-phrase", "TodoWrite", { todos: [] }], ["guard-scope", "Write", { file_path: join(ws, "customers/ACME/lessons/x.md"), content: "x" }],
    ["guard-customer", "Bash", { command: "ls" }], ["guard-budget", "Agent", { subagent_type: "x", prompt: "y" }],
    ["guard-environment", "mcp__chrome-devtools__take_snapshot", {}], ["guard-production", "mcp__chrome-devtools__take_snapshot", {}],
    ["guard-config-scope", "Bash", { command: "echo ciao" }], ["guard-domain-boundary", "Edit", { file_path: join(ws, "notes.md"), old_string: "a", new_string: "b" }],
    ["guard-destructive", "Bash", { command: "ls" }], ["guard-alm-write", "mcp__alm__alm_get_test", { key: "NRT-1" }],
  ];
  for (const [g, tool, ti] of calls) {
    const x = hook(p, g, pre(ws, tool, ti), E);
    assert.equal(decisionOf(x), "deny", `${g} ${tool}: ${x.stdout}`);
    assert.match(reasonOf(x), /Integrità del pacchetto fallita: reinstallare dalla release firmata/);
  }
  const lessons = join(ws, "customers/ACME/lessons");
  for (const [tool, ti] of [["Read", { file_path: join(lessons, "x.md") }], ["Glob", { pattern: "*.md", path: lessons }], ["Grep", { pattern: "x", path: lessons }]]) {
    assert.notEqual(decisionOf(hook(p, "guard-phrase", pre(ws, tool, ti), E)), "deny", tool);
    assert.notEqual(decisionOf(hook(p, "guard-scope", pre(ws, tool, ti), E)), "deny", tool);
  }
  for (const cmd of [`node "${join(p, "scripts/admin/doctor.mjs")}" --json`, `node "${join(p, "scripts/admin/integrity.mjs")}" verify --json`]) {
    for (const g of ["guard-phrase", "guard-destructive", "guard-customer", "guard-config-scope", "guard-scope", "guard-budget"]) {
      assert.notEqual(decisionOf(hook(p, g, pre(ws, "Bash", { command: cmd }), E)), "deny", `${g}: ${cmd}`);
    }
  }
  assert.equal(decisionOf(hook(p, "guard-phrase", pre(ws, "Bash", { command: `node "${join(p, "scripts/admin/integrity.mjs")}" build` }), E)), "deny", "build non è un'eccezione");
  assert.equal(decisionOf(hook(p, "guard-phrase", pre(ws, "Bash", { command: `node "${join(p, "scripts/admin/doctor.mjs")}"; rm x` }), E)), "deny", "catena");
  // ogni deny del gate è in audit
  const audit = readFileSync(join(ws, "customers/ACME/audit", `${new Date().toISOString().slice(0, 7)}.jsonl`), "utf8");
  assert.match(audit, /integrity-gate|Integrità del pacchetto fallita/);
  // JVC_DEV=1 (sviluppo del plugin, documentato): gate saltato
  assert.equal(hook(p, "guard-destructive", pre(ws, "Bash", { command: "ls" }), { ...E, JVC_DEV: "1" }).stdout.trim(), "");
});

test("gate: stato registrato senza cliente in .jvc/integrity.json; nessuna registrazione ⇒ nessun effetto (la verifica è di SessionStart)", () => {
  const ws = mkWs();
  seedSession(ws, { customer: null });
  const E = { JVC_WORKSPACE: ws, CLAUDE_PLUGIN_ROOT: ROOT };
  const run = (g, tool, ti, env = E) => spawnSync(process.execPath, [join(ROOT, "hooks/scripts", `${g}.mjs`)], { input: JSON.stringify(pre(ws, tool, ti)), env: cleanEnv(env), encoding: "utf8" });
  assert.equal(run("guard-phrase", "TodoWrite", {}).stdout.trim(), "");
  mkdirSync(join(ws, ".jvc"), { recursive: true });
  writeFileSync(join(ws, ".jvc/integrity.json"), JSON.stringify({ ok: false, status: "fail", checked_at: new Date().toISOString(), plugin_root: ROOT, mismatched: ["hooks/lib/io.mjs"] }));
  const r = run("guard-phrase", "TodoWrite", {});
  assert.match(r.stdout, /Integrità del pacchetto fallita/);
  // registrazione di un altro pacchetto (plugin reinstallato altrove): non vale
  writeFileSync(join(ws, ".jvc/integrity.json"), JSON.stringify({ ok: false, status: "fail", checked_at: new Date().toISOString(), plugin_root: join(ws, "altro") }));
  assert.equal(run("guard-phrase", "TodoWrite", {}).stdout.trim(), "");
});

test("il manifesto del repository è allineato al codice (come i moduli generati): altrimenti node scripts/admin/integrity.mjs build", async () => {
  const { verifyPackage } = await import("../../hooks/lib/integrity.mjs");
  const v = verifyPackage(ROOT);
  assert.equal(v.ok, true, `integrity.json non allineato — rigenera con: node scripts/admin/integrity.mjs build\n${JSON.stringify({ mismatched: v.mismatched, missing: v.missing, extra: v.extra, status: v.status })}`);
});
