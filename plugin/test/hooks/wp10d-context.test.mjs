// WP10d D3 — monitoraggio nel contesto: session-context (avvio e dopo compact) e precompact-save includono la sintesi
// della console (≤ 5 righe); approval-capture (UserPromptSubmit) aggiunge una riga quando ci sono agenti in corso o in
// attesa (fail-open, < 100 ms); workflow watch mostra anche la sezione agenti.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { runHook, cleanEnv, ROOT } from "../helpers/hook-env.mjs";
import { agentsFixture, SID } from "../helpers/agents-fixture.mjs";

const E = (ws) => ({ JVC_WORKSPACE: ws, CLAUDE_PLUGIN_ROOT: ROOT });
const ctxOf = (r) => r.json?.hookSpecificOutput?.additionalContext ?? "";
const iso = (min) => new Date(Date.now() - min * 60000).toISOString();
// due chiusure CAT fermate per sorprese dopo T-A (partial, 1 sorpresa): scope CAT bloccato dalla vigilanza
const vig = [4, 3].map((m, i) => ({ agent_id: `v${i}`, agent_type: "scope-expert", inv_seq: null, task_id: `V-${i}`, enforced: true, tokens: 10, tokens_by_model: {}, blocks: 0, scope: "CAT", surprises: 1, status: "escalate", status_effective: "escalate", completed_at: iso(m) }));

test("session-context: sintesi della console nel contesto (agenti in corso, scope bloccati, compensazioni), anche dopo compact", () => {
  const { ws } = agentsFixture({ extraLedger: vig });
  for (const source of ["startup", "compact"]) {
    const r = runHook("session-context", { session_id: SID, cwd: ws, source }, E(ws));
    const c = ctxOf(r);
    assert.match(c, /Agenti: 1 in corso · 0 in attesa dell'utente · token 22000\/200000/, source);
    assert.match(c, /In corso: T-B \(scope-expert, CAT, T0/);
    assert.match(c, /scope bloccati dalla vigilanza: CAT \(3 compiti fermati per sorprese — SBLOCCA SCOPE CAT\)/);
  }
});

test("precompact-save: il riassunto (≤ 20 righe) include la sintesi degli agenti", () => {
  const { ws } = agentsFixture({ extraLedger: vig });
  runHook("precompact-save", { session_id: SID, cwd: ws }, E(ws));
  const text = readFileSync(join(ws, "customers/ACME/.sessions", SID, "compact-summary.md"), "utf8");
  assert.match(text, /Agenti: 1 in corso/);
  assert.match(text, /In corso: T-B/);
  assert.match(text, /scope bloccati dalla vigilanza: CAT/);
  assert.ok(text.trim().split("\n").length <= 20);
});

test("UserPromptSubmit: una riga di stato degli agenti quando ce ne sono in corso o in attesa; niente se non ce ne sono; < 100 ms; avviso sul manager (R5)", async () => {
  const { ws, sdir } = agentsFixture();
  const r = runHook("approval-capture", { session_id: SID, cwd: ws, hook_event_name: "UserPromptSubmit", prompt: "come procede il lavoro?" }, E(ws));
  assert.match(ctxOf(r), /Agenti: 1 in corso/);
  assert.match(ctxOf(r), /T-B/);
  // tempo della funzione dell'hook (dopo il caricamento dei moduli)
  const { capture } = await import("../../scripts/admin/approvals.mjs");
  const input = { session_id: SID, cwd: ws, prompt: "e ora?" };
  await capture(input, E(ws));
  const t0 = performance.now();
  const out = await capture(input, E(ws));
  const ms = performance.now() - t0;
  console.log(`approval-capture (sintesi agenti): ${ms.toFixed(1)} ms`);
  // revisione finale (in:52/in:54): nella suite parallela solo un tetto generoso; la soglia stretta, con riscaldamento e mediana, è in test/timing (npm run test:timing)
  assert.ok(ms < 1000, `${ms} ms`);
  assert.match(out.hookSpecificOutput.additionalContext, /Agenti:/);
  // R5: il manager ha usato più del 15 % dei token della sessione
  writeFileSync(join(sdir, "manager-usage.json"), JSON.stringify({ tokens: 10000, offset: 0 }));
  const w = runHook("approval-capture", { session_id: SID, cwd: ws, hook_event_name: "UserPromptSubmit", prompt: "e ora?" }, E(ws));
  assert.match(ctxOf(w), /Monitor del manager: quota di token del manager 31% > 15% \(R5\)/);
  // nessun agente aperto: nessuna riga
  const s = JSON.parse(readFileSync(join(sdir, "session.json"), "utf8"));
  s.ledger.invocations.push({ agent_id: "b1", inv_seq: 1, task_id: "T-B", status_effective: "ok", status: "ok", surprises: 0, completed_at: new Date().toISOString() },
    { agent_id: null, inv_seq: 2, task_id: "T-C", closed_by: "close-stale", completed_at: new Date().toISOString() });
  writeFileSync(join(sdir, "session.json"), JSON.stringify(s));
  writeFileSync(join(sdir, "manager-usage.json"), JSON.stringify({ tokens: 100, offset: 0 }));
  const n = runHook("approval-capture", { session_id: SID, cwd: ws, hook_event_name: "UserPromptSubmit", prompt: "e ora?" }, E(ws));
  assert.equal(n.stdout.trim(), "");
});

test("workflow watch: il blocco del workflow seguito dalla sezione agenti della console", () => {
  const { ws } = agentsFixture();
  const r = spawnSync(process.execPath, [join(ROOT, "scripts/admin/workflow.mjs"), "watch", "SES.ACME.20260929.001", "--workspace", ws], { env: cleanEnv(), encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /WORKFLOW {2}SES\.ACME\.20260929\.001/);
  assert.match(r.stdout, /AGENTI {2}SES\.ACME\.20260929\.001/);
  assert.match(r.stdout, /T-B .*in-corso/);
});
