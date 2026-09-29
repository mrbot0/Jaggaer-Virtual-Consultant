// WP09d: helper condivisi — workspace con sessione, approvazioni create DAVVERO dall'hook approval-capture (frase
// dell'utente nel prompt), esecuzione delle CLI del plugin come processi separati.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, appendFileSync, realpathSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { runHook, cleanEnv, ROOT, seedSession } from "./hook-env.mjs";
import { readApprovals, approvalsFile } from "../../scripts/admin/approvals.mjs";

export { ROOT };
export const SALT = "salt-di-prova-wp09d-0123456789";
export const script = (rel) => join(ROOT, ...rel.split("/"));

export function ws09d(prefix = "jvc-wp09d-") {
  const ws = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  mkdirSync(join(ws, "product", "kb"), { recursive: true });
  mkdirSync(join(ws, "customers", "ACME", "kb"), { recursive: true });
  return ws;
}

export function withSession(ws, opts = {}) { return seedSession(ws, { sid: "sess-1", customer: "ACME", scope: "CAT", ...opts }); }

// Frase dell'utente → approval-capture (processo separato, come UserPromptSubmit) → record nel registro.
// transcript: un transcript esistente a cui aggiungere il prompt (fix round 1: i guard confermano le approvazioni lì).
export function say(ws, prompt, { sid = "sess-1", customer = "ACME", transcript = null } = {}) {
  const tr = transcript ?? join(mkdtempSync(join(tmpdir(), "tr-")), `${sid}.jsonl`);
  if (!transcript) writeFileSync(tr, "");
  appendFileSync(tr, JSON.stringify({ type: "user", isSidechain: false, userType: "external", message: { role: "user", content: prompt }, timestamp: new Date().toISOString() }) + "\n");
  const r = runHook("approval-capture", { session_id: sid, cwd: ws, hook_event_name: "UserPromptSubmit", prompt, transcript_path: tr }, { JVC_WORKSPACE: ws, CLAUDE_PLUGIN_ROOT: ROOT });
  const reg = readApprovals(approvalsFile(ws, customer, sid));
  return { hook: r, context: r.json?.hookSpecificOutput?.additionalContext ?? "", records: reg.records, last: reg.records.at(-1) ?? null, transcript: tr };
}

// CLI del plugin: node <script> …args, con l'ambiente pulito del test.
export function cli(rel, args, { ws, env = {}, cwd } = {}) {
  const r = spawnSync(process.execPath, [script(rel), ...args], {
    cwd: cwd ?? ws, encoding: "utf8", timeout: 60000,
    env: cleanEnv({ ...(ws ? { JVC_WORKSPACE: ws } : {}), CLAUDE_PLUGIN_ROOT: ROOT, ...env }),
  });
  let json = null;
  const lines = r.stdout.trim().split("\n").filter(Boolean);
  try { json = JSON.parse(lines.at(-1)); } catch { json = null; }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
}
