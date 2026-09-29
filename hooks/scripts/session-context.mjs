// SessionStart (fail-OPEN, < 2 s): scrive il puntatore di sessione e
// .jvc/current-session, espone JVC_SESSION_ID via CLAUDE_ENV_FILE (se il
// runtime lo fornisce), registra gli eventi di audit persi, ricarica
// session.json e inietta lo stato compatto + l'istruzione di caricare la skill
// agent-manager (§42 M1, §45.2). Con source=compact reinietta il riassunto
// scritto da precompact-save (§45.7, ruling del controller).
import { appendFileSync, existsSync, readFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { runHook, context, warning } from "../lib/io.mjs";
import {
  workspaceRoot, isJvcWorkspace, isSafeSessionId, readPointer, writePointer, writeCurrentSession, sessionFile, compactSummaryFile, pluginRoot,
} from "../lib/workspace.mjs";
import { verifyPackage, devMode } from "../lib/integrity.mjs";
import { writeFileAtomic } from "../lib/fsx.mjs";
import { updateSessionFile } from "../lib/session-state.mjs";
import { appendAudit } from "../lib/audit.mjs";
import { stateLine, pendingLine, surprisesLine } from "../lib/state-summary.mjs";
import { checkSessionText } from "../lib/session-state.mjs";
import { isMain } from "../../scripts/lib/is-main.mjs";
import { contextBrief } from "../lib/agents-model.mjs";

const PLUGIN = "jaggaer-virtual-consultant";

// F0.3 (§53.1): verifica dell'integrità del pacchetto a ogni avvio di sessione (cache sugli mtime/ctime/dimensione in
// <workspace>/.jvc/integrity-cache.json, < 2 s). Lo stato va in <workspace>/.jvc/integrity.json e, con un cliente, in
// session.integrity: i guard FAIL-CLOSED lo consultano (hooks/lib/integrity-gate.mjs). Un guasto della verifica
// registra ok: false (mai un "ok" non verificato).
export function checkIntegrity(ws, sid, file, env = process.env) {
  const plugin = pluginRoot(env);
  const cacheFile = join(ws, ".jvc", "integrity-cache.json");
  let rec;
  try {
    let cache = {};
    try { const c = JSON.parse(readFileSync(cacheFile, "utf8")); if (c && c.plugin_root === plugin && c.files && typeof c.files === "object") cache = c.files; } catch { /* nessuna cache */ }
    const v = verifyPackage(plugin, { cache });
    try { writeFileAtomic(cacheFile, JSON.stringify({ plugin_root: plugin, files: cache })); } catch { /* la cache è un'ottimizzazione */ }
    rec = { ok: v.ok, status: v.status, signature: v.signature, version: v.version, mismatched: v.mismatched.slice(0, 20), missing: v.missing.slice(0, 20), extra: v.extra.slice(0, 20), ...(v.reason ? { reason: v.reason } : {}) };
  } catch (err) {
    rec = { ok: false, status: "error", reason: `verifica non riuscita: ${String(err?.message ?? err).slice(0, 200)}` };
  }
  rec = { ...rec, checked_at: new Date().toISOString(), plugin_root: plugin, session: sid, ...(devMode(env) ? { dev: true } : {}) };
  mkdirSync(join(ws, ".jvc"), { recursive: true });
  writeFileAtomic(join(ws, ".jvc", "integrity.json"), `${JSON.stringify(rec, null, 2)}
`);
  if (file && existsSync(file)) {
    try { updateSessionFile(file, (s) => { s.integrity = { ok: rec.ok, status: rec.status, checked_at: rec.checked_at, plugin_root: plugin, ...(rec.mismatched?.length ? { mismatched: rec.mismatched.slice(0, 5) } : {}) }; }); } catch { /* stato illeggibile: vale il file del workspace */ }
  }
  return rec;
}

function integrityLine(rec) {
  // WP08 giro 1 (I8): con JVC_DEV=1 l'avviso è sempre visibile, anche con integrità ok
  if (rec.ok) return rec.dev ? "JVC_DEV=1 attivo: gate d'integrità dei guard e protezione del codice del plugin disattivati (solo sviluppo del plugin; mai presso un cliente)." : null;
  const what = [rec.reason, rec.mismatched?.length ? `alterati: ${rec.mismatched.slice(0, 5).join(", ")}` : null, rec.missing?.length ? `mancanti: ${rec.missing.slice(0, 5).join(", ")}` : null,
    rec.extra?.length ? `in più: ${rec.extra.slice(0, 5).join(", ")}` : null, rec.signature === "invalid" || (rec.signature === "absent" && rec.status === "fail") ? `firma: ${rec.signature}` : null].filter(Boolean).join(" · ");
  return rec.dev
    ? `Integrità del pacchetto non verificata (${what || rec.status}); JVC_DEV attivo: gate dei guard saltato (solo sviluppo del plugin).`
    : `Integrità del pacchetto fallita (${what || rec.status}): reinstallare dalla release firmata e non operare (§58). I guard negano tutto tranne Read/Glob/Grep e /vc doctor.`;
}

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
  if (!isJvcWorkspace(ws, env) && !env.JVC_WORKSPACE) return null;
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

  const integrity = checkIntegrity(ws, sid, pointer.customer ? sessionFile(ws, pointer.customer, sid) : null, env);
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
        // WP10d (D3): sintesi della console degli agenti (≤ 5 righe), dalle sole registrazioni degli hook
        try { lines.push(...contextBrief(ws, pointer.customer, sid, s)); } catch (err) { lines.push(`Agenti: sintesi non disponibile (${String(err?.message ?? err).slice(0, 120)})`); }
        if (s.budget.used >= 0.8 * s.budget.tokens) lines.push("Budget ≥ 80%: le nuove invocazioni vanno su haiku; chiedi all'utente se continuare (§29.10).");
      }
    }
  }
  const il = integrityLine(integrity);
  if (il) lines.splice(1, 0, il);
  lines.push(...notes);
  if (input.source === "compact") {
    const f = compactSummaryFile(ws, pointer.customer, sid);
    if (existsSync(f)) lines.push("", "--- riassunto pre-compattazione (precompact-save) ---", readFileSync(f, "utf8").trim(), "Riparti dal blackboard: i sub-agenti hanno già scritto su disco.");
  }
  return context("SessionStart", lines.join("\n"));
}

if (isMain(import.meta.url)) runHook((input) => handle(input), { name: "session-context", failClosed: false });
