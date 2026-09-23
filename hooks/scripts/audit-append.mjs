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
import { summarizeInput } from "../lib/tool-summary.mjs";
import { isMain } from "../../scripts/lib/is-main.mjs";

export { verifyChain } from "../lib/audit.mjs";
export { summarizeInput };

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
