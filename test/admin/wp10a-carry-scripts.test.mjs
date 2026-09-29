// WP10a — riporti sugli script (ruling del controller 1b e 7):
//   1b workflow event --payload-file <file> (i guard negano JSON in linea con , @ { } ( ) $ nelle invocazioni degli script
//      del plugin: i corpi dei comandi passano i dati strutturati da file o chiave=valore, mai JSON in linea);
//   7  doctor, controllo plugin-root: Claude Code sostituisce ${CLAUDE_PLUGIN_ROOT} con il percorso letterale nei corpi dei
//      comandi (le eccezioni a forma esatta dei guard ci contano); la prova si legge nell'audit dei comandi eseguiti.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { envWs, patchSession, ROOT } from "../helpers/env-fixture.mjs";
import { cleanEnv } from "../helpers/hook-env.mjs";
import { simpleArgv } from "../../hooks/lib/exact-argv.mjs";
import { appendAudit } from "../../hooks/lib/audit.mjs";
import { checkPluginRoot } from "../../scripts/admin/doctor.mjs";

const wf = (ws, args) => spawnSync(process.execPath, [join(ROOT, "scripts/admin/workflow.mjs"), ...args], { encoding: "utf8", cwd: ws, env: cleanEnv({ JVC_WORKSPACE: ws, JVC_SESSION_ID: "sess-1" }) });

test("1b workflow event --payload-file: JSON o YAML da file del workspace; stessa validazione di --payload; la riga di comando è a forma semplice", () => {
  const ws = envWs({ env: "sandbox", scope: "P2P" });
  patchSession(ws, (s) => { s.session_code = "SES.ACME.20260923.004"; s.mode = "ops"; });
  const dir = join(ws, "customers/ACME/.sessions/sess-1");
  writeFileSync(join(dir, "wf-event.json"), JSON.stringify({ task: "RdA di prova", steps: [{ n: 1, agent: "p2p-expert", class: "ACT-OBS", desc: "lettura, con virgole (e parentesi) {graffe} $dollari" }] }));
  writeFileSync(join(dir, "wf-step.yaml"), "n: 1\nstatus: ok\nnote: 3 articoli\n");
  const args = ["event", "--kind", "task_start", "--payload-file", "customers/ACME/.sessions/sess-1/wf-event.json", "--json"];
  assert.ok(simpleArgv(`node "C:/plugin/scripts/admin/workflow.mjs" ${args.join(" ")}`), "invocazione semplice (nessun carattere negato dai guard)");
  let r = wf(ws, args);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(JSON.parse(r.stdout).event.payload.steps[0].desc, "lettura, con virgole (e parentesi) {graffe} $dollari");
  r = wf(ws, ["event", "--kind", "step_start", "--payload-file", join(dir, "wf-step.yaml"), "--json"]);
  assert.equal(r.status, 0, r.stdout);
  r = wf(ws, ["event", "--kind", "step_end", "--payload-file", "customers/ACME/.sessions/sess-1/wf-step.yaml", "--json"]);
  assert.equal(r.status, 0, r.stdout);
  const lines = readFileSync(join(dir, "workflow.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((e) => e.kind), ["task_start", "step_start", "step_end"]);
  assert.deepEqual(lines[2].payload, { n: 1, status: "ok", note: "3 articoli" });
  // errori: file assente, non un oggetto, entrambe le opzioni, file troppo grande
  assert.equal(wf(ws, ["event", "--kind", "question", "--payload-file", "nessuno.json"]).status, 1);
  writeFileSync(join(dir, "lista.json"), "[1,2]");
  assert.equal(wf(ws, ["event", "--kind", "question", "--payload-file", join(dir, "lista.json")]).status, 1);
  assert.equal(wf(ws, ["event", "--kind", "question", "--payload", "{}", "--payload-file", join(dir, "wf-step.yaml")]).status, 1);
  writeFileSync(join(dir, "grande.json"), JSON.stringify({ text: "x".repeat(300 * 1024) }));
  assert.equal(wf(ws, ["event", "--kind", "question", "--payload-file", join(dir, "grande.json")]).status, 1);
  assert.equal(readFileSync(join(dir, "workflow.jsonl"), "utf8").trim().split("\n").length, 3, "nessun evento in più dagli errori");
  assert.match(wf(ws, ["--help"]).stdout, /--payload-file <file>/);
});

function auditWs() {
  const ws = mkdtempSync(join(tmpdir(), "jvc-wp10a-doc-"));
  mkdirSync(join(ws, ".jvc"), { recursive: true });
  return ws;
}
const bash = (ws, command) => appendAudit(ws, { session: "sess-1", customer: null, scope: null, kind: "tool", actor: "manager", payload: { tool: "Bash", input_summary: JSON.stringify({ command }), ok: true } });

test("7 doctor plugin-root: percorso letterale nell'audit ⇒ verde; segnaposto ${CLAUDE_PLUGIN_ROOT} rimasto ⇒ giallo con la correzione; nessuna prova ⇒ giallo", () => {
  const plugin = "C:\\Users\\x\\plugins\\jaggaer-virtual-consultant";
  let ws = auditWs();
  assert.equal(checkPluginRoot(ws, [], { plugin }).status, "yellow");
  assert.match(checkPluginRoot(ws, [], { plugin }).detail, /nessun comando del plugin/);
  bash(ws, `node "${plugin}\\scripts\\admin\\doctor.mjs" --json`);
  let c = checkPluginRoot(ws, [], { plugin });
  assert.equal(c.status, "green", c.detail);
  ws = auditWs();
  bash(ws, 'node "${CLAUDE_PLUGIN_ROOT}/scripts/admin/status.mjs" --json');
  c = checkPluginRoot(ws, [], { plugin });
  assert.equal(c.status, "yellow");
  assert.match(c.detail, /non sostituito/);
  assert.match(c.fix, /MANUAL/);
});

test("7 doctor: il controllo plugin-root compare nell'esito completo", async () => {
  const { runChecks } = await import("../../scripts/admin/doctor.mjs");
  const ws = auditWs();
  const checks = await runChecks({ ws, env: {}, network: false });
  assert.ok(checks.some((x) => x.id === "plugin-root"));
});

test("1b (estensione) testo libero da file: intent --text-file = --text; kb resolve --text-file; le righe di comando restano semplici", async () => {
  const ws = envWs({ env: "sandbox", scope: "P2P" });
  const dir = join(ws, "customers/ACME/.sessions/sess-1");
  const text = "Su ACME sandbox crea una RdA di prova per 5 sedie da catalogo, CdC IT-0442, lasciala in bozza. Perché?";
  writeFileSync(join(dir, "intento.txt"), `${text}\n`);
  const intent = (args) => spawnSync(process.execPath, [join(ROOT, "scripts/decide/intent.mjs"), ...args, "--json"], { encoding: "utf8", cwd: ws, env: cleanEnv({ JVC_WORKSPACE: ws, JVC_SESSION_ID: "sess-1" }) });
  const a = intent(["--text", text]);
  const b = intent(["--text-file", "customers/ACME/.sessions/sess-1/intento.txt"]);
  assert.equal(b.status, 0, b.stdout + b.stderr);
  assert.deepEqual(JSON.parse(b.stdout), JSON.parse(a.stdout));
  assert.equal(JSON.parse(b.stdout).customer, "ACME");
  assert.equal(intent(["--text-file", "nessuno.txt"]).status, 1);
  assert.equal(intent(["--text", "x", "--text-file", "customers/ACME/.sessions/sess-1/intento.txt"]).status, 1);
  assert.ok(simpleArgv(`node "C:/p/scripts/decide/intent.mjs" --text-file customers/ACME/.sessions/sess-1/intento.txt --json`));
  assert.equal(simpleArgv(`node "C:/p/scripts/decide/intent.mjs" --text "${text}" --json`), null, "il testo in linea non è semplice: i guard lo negano");
  // kb resolve: stessa domanda da file sul DB del cliente
  const { openDb } = await import("../../scripts/kb/db.mjs");
  openDb(join(ws, "customers/ACME/knowledge.db")).close();
  writeFileSync(join(dir, "domanda.txt"), "Quali campi sono obbligatori per inviare una RdA, e perché?");
  const kb = (args) => spawnSync(process.execPath, [join(ROOT, "scripts/kb/kb.mjs"), "resolve", ...args, "--db", "customers/ACME/knowledge.db", "--json"], { encoding: "utf8", cwd: ws, env: cleanEnv({ JVC_WORKSPACE: ws }) });
  const r = kb(["--text-file", "customers/ACME/.sessions/sess-1/domanda.txt"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(JSON.parse(r.stdout).ok, true);
  assert.equal(kb(["--text-file", "manca.txt"]).status, 1);
});
