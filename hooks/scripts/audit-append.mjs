// PostToolUse `.*` (fail-OPEN): un evento §46.7 per ogni chiamata di
// strumento, con hash concatenato. Payload: nome dello strumento + riassunto
// redatto e troncato (≤ 500 caratteri) dell'input; mai il contenuto dei file,
// mai la risposta dello strumento. Se l'append fallisce l'evento va in
// .jvc/audit-missed.jsonl e session-context lo registra al riavvio (§47.2 #4).
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { runHook } from "../lib/io.mjs";
import { loadHookState, baseAgentType } from "../lib/workspace.mjs";
import { appendAudit } from "../lib/audit.mjs";
import { redact, truncate } from "../lib/redact.mjs";
import { isMain } from "../../scripts/lib/is-main.mjs";

export { verifyChain } from "../lib/audit.mjs";

const len = (s) => (typeof s === "string" ? s.length : undefined);
const CONTENT_KEYS = /^(content|text|body|data|new_string|old_string|new_source|prompt|edits|input|file_text)$/i;

const PICK = {
  Write: (i) => ({ file_path: i.file_path, content_chars: len(i.content) }),
  Edit: (i) => ({ file_path: i.file_path, old_chars: len(i.old_string), new_chars: len(i.new_string), replace_all: i.replace_all }),
  MultiEdit: (i) => ({ file_path: i.file_path, edits: Array.isArray(i.edits) ? i.edits.length : undefined }),
  NotebookEdit: (i) => ({ notebook_path: i.notebook_path, edit_mode: i.edit_mode, cell_id: i.cell_id }),
  Read: (i) => ({ file_path: i.file_path, offset: i.offset, limit: i.limit }),
  Glob: (i) => ({ pattern: i.pattern, path: i.path }),
  Grep: (i) => ({ pattern: truncate(i.pattern, 120), path: i.path, glob: i.glob, output_mode: i.output_mode }),
  Bash: (i) => ({ command: truncate(i.command, 360), description: truncate(i.description, 80) }),
  PowerShell: (i) => ({ command: truncate(i.command, 360), description: truncate(i.description, 80) }),
  Agent: (i) => ({ subagent_type: i.subagent_type, model: i.model, description: truncate(i.description, 80), task_id: /(?:^|\n)\s*task_id:\s*["']?([^\s"'\n]+)/.exec(i.prompt ?? "")?.[1] }),
  WebFetch: (i) => ({ url: i.url }),
};
PICK.Task = PICK.Agent;

export function summarizeInput(tool, input = {}) {
  let obj;
  if (PICK[tool]) obj = PICK[tool](input ?? {});
  else {
    obj = {};
    for (const [k, v] of Object.entries(input ?? {})) {
      if (CONTENT_KEYS.test(k)) { obj[`${k}_chars`] = typeof v === "string" ? v.length : undefined; continue; }
      if (v == null || typeof v === "boolean" || typeof v === "number") obj[k] = v;
      else if (typeof v === "string") obj[k] = truncate(v, 120);
    }
  }
  return truncate(redact(JSON.stringify(obj)), 500);
}

function toolOk(resp) {
  if (!resp || typeof resp !== "object") return null;
  if (typeof resp.success === "boolean") return resp.success;
  if (resp.is_error === true || resp.error) return false;
  return null;
}

export function handle(input, env = process.env) {
  const st = loadHookState(input, env);
  if (!st.jvc) return null;
  const fields = {
    session: st.sid, customer: st.customer, scope: st.session?.scope ?? null, kind: "tool",
    actor: baseAgentType(input.agent_type) ?? "manager",
    payload: {
      tool: String(input.tool_name ?? "?"),
      input_summary: summarizeInput(input.tool_name, input.tool_input),
      ok: toolOk(input.tool_response),
      ...(input.agent_id ? { agent_id: String(input.agent_id) } : {}),
    },
  };
  try {
    appendAudit(st.ws, fields);
  } catch (err) {
    try {
      mkdirSync(join(st.ws, ".jvc"), { recursive: true });
      appendFileSync(join(st.ws, ".jvc", "audit-missed.jsonl"), `${JSON.stringify({ ts: new Date().toISOString(), error: String(err?.message ?? err), ...fields })}\n`);
    } catch { /* anche il fallback è fallito: resta l'avviso */ }
    throw err;
  }
  return null;
}

if (isMain(import.meta.url)) runHook((input) => handle(input), { name: "audit-append", failClosed: false });
