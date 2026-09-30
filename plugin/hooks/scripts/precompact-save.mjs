// PreCompact (fail-OPEN): scrive compact-summary.md (≤ 20 righe: cliente,
// scope, modalità, compito in corso, ultimi tre rapporti del blackboard,
// pendenze, sorprese) e tocca session.json (updated_at, last_compact_summary).
// SessionStart con source=compact lo reinietta (§45.7).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runHook } from "../lib/io.mjs";
import { loadHookState, sessionDir, invocationsFile, compactSummaryFile } from "../lib/workspace.mjs";
import { stateLine, pendingLine, surprisesLine, lastReports, openInvocations, lastUserPrompt } from "../lib/state-summary.mjs";
import { updateSession } from "../../scripts/admin/session.mjs";
import { isMain } from "../../scripts/lib/is-main.mjs";
import { contextBrief } from "../lib/agents-model.mjs";

export const MAX_LINES = 20;

export function buildSummary(st, input) {
  const s = st.session;
  const lines = [`# Riassunto pre-compattazione — sessione ${st.sid} — ${new Date().toISOString()}`];
  if (!s) {
    lines.push("Nessun cliente attivo: esegui use customer <ID>.");
  } else {
    lines.push(stateLine(s));
    const open = openInvocations(invocationsFile(st.ws, st.customer, st.sid), s.ledger);
    lines.push(`Compito in corso: ${open.length ? open.slice(-3).map((i) => `${i.task_id} (${i.subagent_type ?? "?"})`).join(" · ") : "nessun sub-agente aperto"}`);
  }
  const prompt = lastUserPrompt(input.transcript_path);
  if (prompt) lines.push(`Ultima richiesta dell'utente: "${prompt}"`);
  if (s) {
    const bb = join(sessionDir(st.ws, st.customer, st.sid), "blackboard");
    const reps = lastReports(bb, 3);
    lines.push(`Ultimi rapporti: ${reps.length ? reps.map((r) => `${r.task_id} ${r.status ?? "?"}${r.lesson ? ` ${r.lesson}` : ""}`).join(" · ") : "nessuno"}`);
    lines.push(pendingLine(s.pending), surprisesLine(s.surprises));
    // WP10d (D3): sintesi della console degli agenti (≤ 5 righe)
    try { lines.push(...contextBrief(st.ws, st.customer, st.sid, s)); } catch { lines.push("Agenti: sintesi non disponibile"); }
    lines.push(`Blackboard: ${s.customer ? `customers/${s.customer}/` : ""}${s.blackboard_dir}`);
  }
  return lines.slice(0, MAX_LINES).join("\n") + "\n";
}

export function handle(input, env = process.env) {
  const st = loadHookState(input, env);
  if (!st.jvc || !st.sid) return null;
  const text = buildSummary(st, input);
  const f = compactSummaryFile(st.ws, st.customer, st.sid);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, text);
  if (st.session) updateSession(st.sessionFile, (s) => { s.last_compact_summary = `.sessions/${st.sid}/compact-summary.md`; });
  return null;
}

if (isMain(import.meta.url)) runHook((input) => handle(input), { name: "precompact-save", failClosed: false });
