// Giro di correzioni della revisione finale (FINAL): guard e hook. Solo input di hook, nessun comando reale.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkWs, seedSession, runHook, decisionOf, reasonOf, ROOT } from "../helpers/hook-env.mjs";

const env = (ws) => ({ CLAUDE_PROJECT_DIR: ws, CLAUDE_PLUGIN_ROOT: ROOT });
const pre = (guard, ws, tool, tool_input, extra = {}, e = {}) =>
  runHook(guard, { session_id: "sess-1", cwd: ws, hook_event_name: "PreToolUse", tool_name: tool, tool_input, ...extra }, { ...env(ws), ...e });
const denied = (r) => decisionOf(r) === "deny";
const silent = (r) => r.status === 0 && r.stdout.trim() === "";

// ---------- MUST FIX in:33 — scritture via shell della sessione principale in product/** e customers/*/kb/** ----------

test("sessione principale: scritture via shell in product/** e customers/*/kb/** negate come con Write (§29.6, T9)", () => {
  const ws = mkWs(); seedSession(ws);
  // la stessa scrittura con Write è negata (riferimento)
  assert.ok(denied(pre("guard-scope", ws, "Write", { file_path: join(ws, "product/kb/scopes/CAT/x.yaml"), content: "x" })));
  for (const [tool, c] of [
    ["Bash", "echo x > product/kb/scopes/CAT/x.yaml"],
    ["Bash", "echo x >> customers/ACME/kb/scopes/CAT/flows/C.ACME.CAT.FLW.0001.yaml"],
    ["Bash", "printf 'id: S.STD.CAT.FLW.0009' | tee product/kb/scopes/CAT/S.STD.CAT.FLW.0009.yaml"],
    ["Bash", "cp customers/ACME/lessons/x.md product/kb/scopes/CAT/"],
    ["Bash", "mv customers/ACME/_inbox/CAT/x.yaml customers/ACME/kb/scopes/CAT/flows/x.yaml"],
    ["Bash", "rm -rf product/kb"],
    ["Bash", "cd product/kb/scopes/CAT && echo x > y.yaml"],
    ["Bash", "sed -i s/a/b/ customers/ACME/kb/scopes/CAT/flows/C.ACME.CAT.FLW.0001.yaml"],
    ["Bash", `echo x > "${join(ws, "product/kb/scopes/CAT/abs.yaml").replace(/\\/g, "/")}"`],
    ["PowerShell", "Set-Content -Path product\\kb\\scopes\\CAT\\x.yaml -Value x"],
    ["PowerShell", "Copy-Item x.yaml -Destination customers\\ACME\\kb\\scopes\\CAT\\flows\\"],
  ]) {
    const r = pre("guard-scope", ws, tool, { command: c });
    assert.ok(denied(r), `${tool}: ${c}`);
    assert.match(reasonOf(r), /§29\.6|script/, c);
  }
});

test("sessione principale: gli script del plugin, le letture e le scritture fuori da kb/product restano consentiti", () => {
  const ws = mkWs(); seedSession(ws);
  const kb = join(ROOT, "scripts/kb/kb.mjs").replace(/\\/g, "/");
  const life = join(ROOT, "scripts/kb/lifecycle.mjs").replace(/\\/g, "/");
  for (const c of [
    `node "${kb}" reindex --db product/knowledge.db --json`,
    `node "${life}" promote C.ACME.CAT.FLW.0001 --json`,
    `node "${kb}" find --scope CAT --json > customers/ACME/reports/find.json`,
    "cat product/kb/scopes/CAT/x.yaml",
    "grep -r fornitore customers/ACME/kb/scopes/CAT",
    "echo x > customers/ACME/lessons/x.md",
    "ls product/kb > customers/ACME/reports/ls.txt",
  ]) assert.ok(silent(pre("guard-scope", ws, "Bash", { command: c })), c);
});
