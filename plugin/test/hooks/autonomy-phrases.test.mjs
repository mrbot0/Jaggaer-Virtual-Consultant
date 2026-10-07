// Frasi AUTONOMIA ALTA|MEDIA|BASSA (spec 2026-10-06 §3.2): le scrive solo l'utente, valgono per la sessione.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFileSync, mkdtempSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { runHook, runSessionCli, decisionOf, ROOT } from "../helpers/hook-env.mjs";
import { envWs } from "../helpers/env-fixture.mjs";
import { parseApprovalPrompt, phraseOf, readApprovals, approvalsFile } from "../../scripts/admin/approvals.mjs";

function say(ws, tr, prompt) {
  appendFileSync(tr, `${JSON.stringify({ type: "user", isSidechain: false, userType: "external", message: { role: "user", content: prompt }, timestamp: new Date().toISOString() })}\n`);
  return runHook("approval-capture", { session_id: "sess-1", cwd: ws, hook_event_name: "UserPromptSubmit", prompt, transcript_path: tr }, { JVC_WORKSPACE: ws, CLAUDE_PLUGIN_ROOT: ROOT });
}

test("frasi AUTONOMIA: parse, phraseOf, registrazione, use show; il modello non può scriverle", () => {
  assert.deepEqual(parseApprovalPrompt("AUTONOMIA ALTA"), { kind: "autonomy", level: "alto" });
  assert.deepEqual(parseApprovalPrompt("AUTONOMIA BASSA."), { kind: "autonomy", level: "basso" });
  assert.equal(parseApprovalPrompt("autonomia alta")?.kind, "attempt");
  assert.equal(phraseOf({ kind: "autonomy", level: "medio" }), "AUTONOMIA MEDIA");
  const ws = envWs({ env: "preprod", scope: "P2P", autonomy: null });
  const tr = join(mkdtempSync(join(tmpdir(), "au-")), "t.jsonl"); writeFileSync(tr, "");
  say(ws, tr, "AUTONOMIA MEDIA");
  const reg = readApprovals(approvalsFile(ws, "ACME", "sess-1"));
  assert.ok(reg.ok); assert.equal(reg.records.at(-1).kind, "autonomy"); assert.equal(reg.records.at(-1).level, "medio");
  const show = JSON.parse(runSessionCli(["use", "show", "--session", "sess-1", "--json"], { JVC_WORKSPACE: ws }).stdout);
  assert.deepEqual(show.autonomy, { level: "medio", chosen: "medio", source: "frase", warning: null });
  const g = runHook("guard-phrase", { session_id: "sess-1", cwd: ws, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "echo AUTONOMIA ALTA" } }, { JVC_WORKSPACE: ws, CLAUDE_PLUGIN_ROOT: ROOT });
  assert.equal(decisionOf(g), "deny");
});
