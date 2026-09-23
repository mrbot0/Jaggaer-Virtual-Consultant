// SessionStart (fail-OPEN, < 2 s): scrive il puntatore di sessione e
// .jvc/current-session, espone JVC_SESSION_ID via CLAUDE_ENV_FILE (se il
// runtime lo fornisce), registra gli eventi di audit persi, ricarica
// session.json e inietta lo stato compatto + l'istruzione di caricare la skill
// agent-manager (§42 M1, §45.2). Con source=compact reinietta il riassunto
// scritto da precompact-save (§45.7, ruling del controller).
import { appendFileSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { runHook, context, warning } from "../lib/io.mjs";
import {
  workspaceRoot, isJvcWorkspace, isSafeSessionId, readPointer, writePointer, writeCurrentSession, sessionFile, compactSummaryFile,
} from "../lib/workspace.mjs";
import { appendAudit } from "../lib/audit.mjs";
import { stateLine, pendingLine, surprisesLine } from "../lib/state-summary.mjs";
import { checkSessionText } from "../lib/session-state.mjs";
import { isMain } from "../../scripts/lib/is-main.mjs";

const PLUGIN = "jaggaer-virtual-consultant";

function recoverMissedAudit(ws) {
  const f = join(ws, ".jvc", "audit-missed.jsonl");
  if (!existsSync(f)) return 0;
  const lines = readFileSync(f, "utf8").split("\n").filter((l) => l.trim());
  let n = 0;
  for (const l of lines) {
    let ev;
    try { ev = JSON.parse(l); } catch { continue; }
    appendAudit(ws, {
      session: ev.session, customer: ev.customer, scope: ev.scope, kind: ev.kind ?? "tool", actor: ev.actor ?? "manager",
      payload: { ...(ev.payload ?? {}), recovered: true, missed_at: ev.ts, missed_error: ev.error },
    });
    n++;
  }
  unlinkSync(f);
  return n;
}

export function handle(input, env = process.env) {
  const ws = workspaceRoot(input, env);
  if (!isJvcWorkspace(ws) && !env.JVC_WORKSPACE) return null;
  const sid = input.session_id;
  if (!isSafeSessionId(sid)) return warning(`[${PLUGIN}] session_id non valido: stato di sessione non caricato.`);
  const pointer = readPointer(ws, sid) ?? writePointer(ws, sid, null);
  writeCurrentSession(ws, sid);
  if (env.CLAUDE_ENV_FILE) appendFileSync(env.CLAUDE_ENV_FILE, `export JVC_SESSION_ID=${sid}\n`);
  const notes = [];
  try {
    const n = recoverMissedAudit(ws);
    if (n) notes.push(`Audit: ${n} eventi persi registrati ora (recovered).`);
  } catch (err) { notes.push(`Audit: eventi persi non ancora registrati (${err.message}).`); }

  const lines = [`[${PLUGIN}] sessione ${sid} (${input.source ?? "startup"})`,
    "Carica la skill agent-manager: sei il manager (sessione principale). Instradi con Agent verso sub-agenti foglia, non fai lavoro di dominio; lo stato è in session.json e lo cambiano solo /use e gli hook."];
  if (!pointer.customer) {
    lines.push(`Nessun cliente attivo: esegui /${PLUGIN}:use customer <ID> (aggiungi --new per crearlo). Finché non c'è un cliente, customers/** è negato.`);
  } else {
    const file = sessionFile(ws, pointer.customer, sid);
    if (!existsSync(file)) {
      lines.push(`Cliente ${pointer.customer} indicato dal puntatore ma session.json assente: riesegui /${PLUGIN}:use customer ${pointer.customer}.`);
    } else {
      const chk = checkSessionText(readFileSync(file, "utf8"), { customer: pointer.customer, sid });
      if (!chk.ok) {
        lines.push(`Stato di sessione illeggibile (${chk.reason}): i guard negano tutto finché non esegui /${PLUGIN}:use customer ${pointer.customer}, che lo ripara (ne resta una copia .corrupt-<data>).`);
      } else {
        const s = chk.session;
        lines.push(stateLine(s), pendingLine(s.pending), surprisesLine(s.surprises));
        if (s.budget.used >= 0.8 * s.budget.tokens) lines.push("Budget ≥ 80%: le nuove invocazioni vanno su haiku; chiedi all'utente se continuare (§29.10).");
      }
    }
  }
  lines.push(...notes);
  if (input.source === "compact") {
    const f = compactSummaryFile(ws, pointer.customer, sid);
    if (existsSync(f)) lines.push("", "--- riassunto pre-compattazione (precompact-save) ---", readFileSync(f, "utf8").trim(), "Riparti dal blackboard: i sub-agenti hanno già scritto su disco.");
  }
  return context("SessionStart", lines.join("\n"));
}

if (isMain(import.meta.url)) runHook((input) => handle(input), { name: "session-context", failClosed: false });
