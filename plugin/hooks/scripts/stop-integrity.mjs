// Stop (fail-OPEN, non blocca MAI): registra in audit lo stato di chiusura e
// mostra una nota con compensazioni pendenti, compiti senza lezione, esiti
// attesi non registrati. Lo stato del browser non è osservabile da un hook
// (nessuna API): si dichiara "sconosciuto" (§32, §44.4).
import { runHook, warning } from "../lib/io.mjs";
import { loadHookState, invocationsFile } from "../lib/workspace.mjs";
import { appendAudit } from "../lib/audit.mjs";
import { openInvocations } from "../lib/state-summary.mjs";
import { isMain } from "../../scripts/lib/is-main.mjs";
import { updateManagerUsage } from "../lib/manager-usage.mjs";

export function handle(input, env = process.env) {
  const st = loadHookState(input, env);
  if (!st.jvc || !st.sid) return null;
  const s = st.session;
  const comps = s?.pending?.compensations ?? [];
  const outcomes = s?.pending?.expected_outcomes ?? [];
  // Solo i sub-agenti del plugin (enforced): gli altri non hanno l'obbligo della lezione.
  const noLesson = (s?.ledger?.invocations ?? []).filter((i) => i.enforced !== false && !i.lesson && !(i.status === "blocked" && i.error_class === "E1")).map((i) => i.task_id ?? i.agent_id);
  const open = s ? openInvocations(invocationsFile(st.ws, st.customer, st.sid), s.ledger).map((i) => i.task_id) : [];
  appendAudit(st.ws, {
    session: st.sid, customer: st.customer, scope: s?.scope ?? null, kind: "session", actor: "hook:stop-integrity",
    payload: { action: "stop", pending_compensations: comps, tasks_without_lesson: noLesson, tasks_without_report: open, expected_outcomes_pending: outcomes, browser: "unknown", stop_hook_active: !!input.stop_hook_active },
  });
  // WP10d (D6): token della sessione principale dal suo transcript (R5 ≤ 15 %: il monitor sorveglia anche il manager)
  if (s && input.transcript_path) { try { updateManagerUsage(st.ws, st.customer, st.sid, input.transcript_path, { scope: s.scope ?? null }); } catch { /* misura non riuscita: la console la mostra assente */ } }
  const notes = [];
  if (comps.length) notes.push(`compensazioni pendenti: ${comps.map(String).join(", ")}`);
  if (noLesson.length) notes.push(`compiti senza lezione: ${noLesson.join(", ")}`);
  if (open.length) notes.push(`sub-agenti senza rapporto: ${open.join(", ")}`);
  if (outcomes.length) notes.push(`esiti attesi non registrati: ${outcomes.map(String).join(", ")}`);
  if (!s) return notes.length ? warning(`[jvc] ${notes.join(" · ")}`) : null;
  notes.push("stato del browser: sconosciuto (nessuna API dal hook) — verifica che non restino operazioni a metà su Chrome");
  return warning(`[jvc] chiusura: ${notes.join(" · ")}`);
}

if (isMain(import.meta.url)) runHook((input) => handle(input), { name: "stop-integrity", failClosed: false });
