// WP10d D6 — indipendenza del monitor: `agents watch` è un processo autonomo in sola lettura; lo stato viene solo dalle
// registrazioni degli hook (un rapporto che dichiara ok con sorprese registrate da step-check è `incoerente`); il
// manager è sorvegliato (quota di token R5 dal transcript della sessione principale, scritta da stop-integrity;
// comandi di dominio senza dispatch); i file del monitor non si alterano da manager né da sub-agenti; una catena di
// audit interrotta è segnalata.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync, writeFileSync, readdirSync, statSync, appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import YAML from "yaml";
import { runHook, decisionOf, cleanEnv, ROOT } from "../helpers/hook-env.mjs";
import { agentsFixture, SID } from "../helpers/agents-fixture.mjs";
import { appendAudit } from "../../hooks/lib/audit.mjs";
import { buildConsole, resolveMonitorSession } from "../../scripts/admin/agents.mjs";

const E = (ws) => ({ JVC_WORKSPACE: ws, CLAUDE_PLUGIN_ROOT: ROOT });
const CLI = join(ROOT, "scripts/admin/agents.mjs");
const view = (ws) => buildConsole(ws, "ACME", SID, resolveMonitorSession(ws, SID).session);
function snapshot(dir) {
  const out = {};
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else out[p] = `${statSync(p).mtimeMs}:${statSync(p).size}`; } };
  walk(dir);
  return out;
}

test("agents watch: processo autonomo che aggiorna la console ogni N secondi senza scrivere nulla (anche da un'altra cartella, per codice di sessione)", () => {
  const { ws } = agentsFixture();
  const before = snapshot(ws);
  const r = spawnSync(process.execPath, [CLI, "watch", "--interval", "1", "--count", "2", "--session", "SES.ACME.20260929.001", "--workspace", ws], { env: cleanEnv(), encoding: "utf8", timeout: 20000, cwd: tmpdir() });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.match(/AGENTI {2}SES\.ACME\.20260929\.001/g)?.length, 2);
  assert.match(r.stdout, /ogni 1s · Ctrl\+C per uscire/);
  assert.deepEqual(snapshot(ws), before, "nessun file creato o modificato");
});

test("incoerente: il rapporto dichiara ok e 0 sorprese, step-check ne ha registrate (audit)", () => {
  const { ws, sdir } = agentsFixture();
  // T-B chiude con un rapporto ok senza sorprese; l'audit ha una sorpresa di step-check attribuita a b1
  const s = JSON.parse(readFileSync(join(sdir, "session.json"), "utf8"));
  s.ledger.invocations.push({ agent_id: "b1", agent_type: "scope-expert", inv_seq: 1, task_id: "T-B", enforced: true, tokens: 900, tokens_by_model: { haiku: 900 }, usage_source: "transcript", scope: "CAT", surprises: 0, status: "ok", status_effective: "ok", reclassified: [], completed_at: new Date().toISOString() });
  writeFileSync(join(sdir, "session.json"), JSON.stringify(s));
  writeFileSync(join(sdir, "blackboard", "T-B.yaml"), YAML.stringify({ task_id: "T-B", agent_id: "b1", status: "ok", status_effective: "ok", output: {}, cognitive_trace: { surprises: 0, decisions: [] }, open_questions: [] }));
  const b = view(ws).rows.find((x) => x.task_id === "T-B");
  assert.equal(b.state, "ok");
  assert.equal(b.flag, "incoerente");
  assert.match(b.coherence.flags.join(" · "), /dichiara ok con 1 sorprese registrate da step-check/);
  assert.match(b.coherence.flags.join(" · "), /dichiara 0 sorprese, step-check ne registra 1/);
});

test("sorveglianza del manager: stop-integrity misura i token della sessione principale dal transcript (incrementale, senza sidechain); la console calcola R5 e segnala i comandi di dominio senza dispatch", () => {
  const { ws, sdir } = agentsFixture();
  const tr = join(mkdtempSync(join(tmpdir(), "tr-")), `${SID}.jsonl`);
  const asst = (id, n, extra = {}) => JSON.stringify({ type: "assistant", message: { id, model: "claude-opus-x", role: "assistant", content: [{ type: "text", text: "…" }], usage: { input_tokens: n, output_tokens: 0, cache_creation_input_tokens: 0 } }, ...extra });
  writeFileSync(tr, [asst("m1", 3000), asst("m1", 3000), asst("s1", 50000, { isSidechain: true }), asst("m2", 2000)].join("\n") + "\n");
  runHook("stop-integrity", { session_id: SID, cwd: ws, hook_event_name: "Stop", transcript_path: tr }, E(ws));
  let u = JSON.parse(readFileSync(join(sdir, "manager-usage.json"), "utf8"));
  assert.equal(u.tokens, 5000, "dedup per message.id, niente sidechain");
  appendFileSync(tr, `${asst("m3", 1000)}\n`);
  runHook("stop-integrity", { session_id: SID, cwd: ws, hook_event_name: "Stop", transcript_path: tr }, E(ws));
  u = JSON.parse(readFileSync(join(sdir, "manager-usage.json"), "utf8"));
  assert.equal(u.tokens, 6000, "incrementale");
  const c = view(ws);
  assert.equal(c.manager.tokens_manager, 6000);
  assert.equal(Math.round(c.manager.share * 100), 21);   // 6000 / (6000 + 22000)
  assert.match(c.manager.warnings.join(" "), /quota di token del manager 21% > 15% \(R5\)/);
  // il manager risponde nel merito: kb find senza un Agent() dopo
  appendAudit(ws, { session: SID, customer: "ACME", scope: "CAT", kind: "tool", actor: "manager", payload: { tool: "Bash", input_summary: "{\"command\":\"node scripts/kb/kb.mjs find --text fornitore\"}", ok: true } });
  const d = view(ws).manager;
  assert.equal(d.domain_count, 1);
  assert.match(d.warnings.join(" "), /1 comandi di dominio .* senza un dispatch successivo/);
  const ev = readFileSync(join(ws, "customers/ACME/audit", `${new Date().toISOString().slice(0, 7)}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(ev.some((e) => e.kind === "budget" && e.actor === "hook:stop-integrity" && e.payload.subject === "manager" && e.payload.tokens === 6000));
});

test("i file del monitor non si alterano: né la sessione principale né un sub-agente scrivono audit, invocations, workflow, blackboard, controllo, stato degli agenti (strumenti e shell)", () => {
  const { ws, sdir } = agentsFixture();
  const month = `${new Date().toISOString().slice(0, 7)}.jsonl`;
  const files = [join(ws, "customers/ACME/audit", month), join(sdir, "invocations.jsonl"), join(sdir, "workflow.jsonl"), join(sdir, "blackboard", "T-A.yaml"),
    join(sdir, "control.jsonl"), join(sdir, "agents", "b1.json"), join(sdir, "observations.jsonl"), join(sdir, "manager-usage.json")];
  const guards = ["guard-scope", "guard-config-scope"];
  const denied = (tool, ti, who) => guards.some((g) => decisionOf(runHook(g, { session_id: SID, cwd: ws, hook_event_name: "PreToolUse", tool_name: tool, tool_input: ti, ...who }, E(ws))) === "deny");
  for (const who of [{}, { agent_id: "b1", agent_type: "jaggaer-virtual-consultant:scope-expert" }]) {
    for (const f of files) {
      const rel = f.slice(ws.length + 1).replace(/\\/g, "/");
      assert.ok(denied("Write", { file_path: f, content: "{}" }, who), `Write ${rel} ${who.agent_id ?? "manager"}`);
      assert.ok(denied("Edit", { file_path: f, old_string: "a", new_string: "b" }, who), `Edit ${rel} ${who.agent_id ?? "manager"}`);
      assert.ok(denied("Bash", { command: `echo {} >> ${rel}` }, who), `Bash >> ${rel} ${who.agent_id ?? "manager"}`);
    }
  }
});

test("catena di audit interrotta: la console lo segnala (verifyChain) con file e riga", () => {
  const { ws } = agentsFixture();
  const f = join(ws, "customers/ACME/audit", `${new Date().toISOString().slice(0, 7)}.jsonl`);
  const lines = readFileSync(f, "utf8").trim().split("\n");
  const ev = JSON.parse(lines[2]); ev.payload.tool = "Write"; lines[2] = JSON.stringify(ev);
  writeFileSync(f, `${lines.join("\n")}\n`);
  const c = view(ws);
  assert.equal(c.audit_chain.ok, false);
  const r = spawnSync(process.execPath, [CLI, "status", "--workspace", ws, "--session", SID], { env: cleanEnv(), encoding: "utf8" });
  assert.match(r.stdout, /CATENA INTERROTTA \(customers\/ACME\/audit\/.* riga 3: hash non coincide/);
});
