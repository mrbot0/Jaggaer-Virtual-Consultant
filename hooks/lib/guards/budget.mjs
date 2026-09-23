// guard-budget (PreToolUse Agent|Task, FAIL-CLOSED) — §29.10, §42 M3.
//  - nessuna sessione con cliente ⇒ deny;
//  - prompt senza header agent-prompt (task_id, customer, scope, allowed_paths) ⇒ deny;
//  - header con cliente/scope diversi da session.json ⇒ deny (i guard usano il file);
//  - budget.used ≥ budget.tokens ⇒ deny; budget del compito > residuo ⇒ deny;
//  - used ≥ 80% ⇒ allow con updatedInput = input originale + model: haiku;
//  - ogni invocazione consentita è registrata in <sessione>/invocations.jsonl
//    (subagent-trace la chiude a consuntivo).
// Matcher Bash|PowerShell: un sub-agente (agent_id presente) non esegue
// `session.mjs use …` — il budget non si alza da un agente, mai.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { allowWithInput } from "../io.mjs";
import { invocationsFile } from "../workspace.mjs";
import { skeleton } from "../paths.mjs";
import { parsePromptHeader } from "../../../scripts/admin/agent-prompt.mjs";
import { guarded, denyAudited, SHELL_TOOLS } from "./common.mjs";

const G = "guard-budget";
const AGENT_TOOLS = new Set(["Agent", "Task"]);
export const HAIKU_THRESHOLD = 0.8;
const REQUIRED = ["task_id", "customer", "scope", "allowed_paths"];
const SESSION_USE = /session\.mjs\s+use\b/i;

function checkShell(ctx) {
  const cmd = ctx.ti.command;
  if (!ctx.agentId || typeof cmd !== "string") return null;
  const flat = skeleton(cmd.replace(/["'`^]/g, "").replace(/\\(?=[^\s\\/])/g, ""));
  if (SESSION_USE.test(flat) || SESSION_USE.test(cmd)) {
    return denyAudited(ctx, G, "un sub-agente non cambia cliente, scope, modalità né budget: solo l'utente, con /use nella sessione principale (§29.10)");
  }
  return null;
}

export const decide = guarded(G, (ctx) => {
  if (SHELL_TOOLS.has(ctx.tool)) return checkShell(ctx);
  if (!AGENT_TOOLS.has(ctx.tool)) return null;
  const { session, ti } = ctx;
  if (!session) return denyAudited(ctx, G, "nessuna sessione con cliente attivo: esegui /jaggaer-virtual-consultant:use customer <ID> prima di invocare sub-agenti");
  const h = parsePromptHeader(ti.prompt);
  if (!h) return denyAudited(ctx, G, "prompt senza header agent-prompt (§46.1): servono task_id, customer, scope, allowed_paths — componi il prompt da templates/agent-prompt.md");
  const missing = REQUIRED.filter((k) => h[k] == null || h[k] === "" || (k === "allowed_paths" && !Array.isArray(h[k])));
  if (missing.length) return denyAudited(ctx, G, `header agent-prompt incompleto: mancano ${missing.join(", ")}`);
  if (String(h.customer) !== session.customer) return denyAudited(ctx, G, `il prompt è per il cliente ${h.customer} ma la sessione è sul cliente ${session.customer}`);
  if (String(h.scope) !== session.scope) return denyAudited(ctx, G, `scope del prompt ${h.scope} ≠ scope di sessione ${session.scope ?? "—"}: esegui use scope ${h.scope} prima del dispatch (i guard leggono session.json)`);
  const { tokens, used } = session.budget;
  if (used >= tokens) return denyAudited(ctx, G, `budget di sessione esaurito (${used}/${tokens}): nessuna nuova invocazione; chiudi con report e pendenze. Solo l'utente può alzarlo con /jaggaer-virtual-consultant:use budget <n>`);
  const remaining = tokens - used;
  const taskBudget = h.budget?.tokens;
  if (taskBudget != null && !(Number.isInteger(taskBudget) && taskBudget > 0)) return denyAudited(ctx, G, `budget del compito non valido: ${JSON.stringify(taskBudget)}`);
  if (taskBudget != null && taskBudget > remaining) return denyAudited(ctx, G, `budget del compito ${taskBudget} supera il residuo di sessione ${remaining}: ridisegna il compito (meno passi, più STR-REPLAY) o chiedi all'utente di alzare il budget`);
  const downgrade = used >= HAIKU_THRESHOLD * tokens;
  const model = downgrade ? "haiku" : ti.model ?? null;
  const file = invocationsFile(ctx.ws, session.customer, session.session_id);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify({
    ts: new Date().toISOString(), task_id: String(h.task_id), subagent_type: ti.subagent_type ?? null,
    model_requested: ti.model ?? null, model, budget_tokens: taskBudget ?? null, scope: h.scope, parent_agent_id: ctx.agentId,
  })}\n`);
  if (downgrade) {
    return allowWithInput(`[${G}] budget di sessione ≥ 80% (${used}/${tokens}): tier forzato a haiku; chiedi all'utente se continuare (§29.10)`, { ...ti, model: "haiku" });
  }
  return null;
});
