// Righe compatte dello stato di sessione, condivise da session-context,
// precompact-save e stop-integrity.
import { readdirSync, readFileSync, statSync, existsSync, openSync, readSync, fstatSync, closeSync } from "node:fs";
import { join, dirname } from "node:path";
import { redact, truncate } from "./redact.mjs";
import { openFrom, sessionTtlMs } from "./invocations.mjs";

const list = (a, n = 5) => (Array.isArray(a) && a.length ? `${a.length} [${a.slice(0, n).map((x) => (typeof x === "string" ? x : x?.code ?? x?.id ?? JSON.stringify(x))).join(", ")}${a.length > n ? ", …" : ""}]` : "0");

export function stateLine(s) {
  const env = s.env ? (s.env.id ?? s.env.type ?? "dichiarato") + (s.env.verified ? " (verificato)" : " (non verificato)") : "non dichiarato";
  const pct = s.budget.tokens ? Math.round((100 * s.budget.used) / s.budget.tokens) : 0;
  return `Cliente ${s.customer} · ambiente ${env} · scope ${s.scope ?? "— (esegui use scope <ID>)"} · modalità ${s.mode} · budget ${s.budget.used}/${s.budget.tokens} (${pct}%)`;
}

export function pendingLine(p = {}) {
  return `Pendenze: compensazioni ${list(p.compensations)} · approvazioni ${list(p.approvals)} · domande ${list(p.questions)} · esiti attesi ${list(p.expected_outcomes)}`;
}

export function surprisesLine(surprises = [], n = 3) {
  const last = surprises.slice(-n);
  if (!last.length) return "Sorprese recenti: nessuna";
  return `Sorprese recenti: ${last.map((x) => (typeof x === "string" ? x : `${x.item ?? "?"}${x.obs ? ` (${x.obs})` : ""}`)).join(" · ")}`;
}

// Ultimi n rapporti compatti del blackboard (per data di modifica).
export function lastReports(blackboardDir, n = 3) {
  if (!existsSync(blackboardDir)) return [];
  const files = readdirSync(blackboardDir).filter((f) => /\.ya?ml$/.test(f))
    .map((f) => ({ f, t: statSync(join(blackboardDir, f)).mtimeMs })).sort((a, b) => b.t - a.t || (a.f < b.f ? 1 : -1)).slice(0, n);
  return files.map(({ f }) => {
    const text = readFileSync(join(blackboardDir, f), "utf8");
    const get = (k) => new RegExp(`^${k}:\\s*["']?([^"'\\n]*)`, "m").exec(text)?.[1]?.trim() || null;
    return { task_id: get("task_id") ?? f.replace(/\.ya?ml$/, ""), status: get("status_effective") ?? get("status"), lesson: get("lesson") };
  });
}

// Righe JSON di un file .jsonl (tollerante alle righe rotte).
export function readJsonl(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
}

// Invocazioni registrate da guard-budget non ancora chiuse da subagent-trace
// (abbinamento per ordine di dispatch: vedi invocations.mjs).
export function openInvocations(invocationsFile, ledger = {}) {
  return openFrom(readJsonl(invocationsFile), ledger?.invocations ?? [], { ttlMs: sessionTtlMs(dirname(invocationsFile)) });
}

// Ultimo prompt dell'utente nel transcript (lettura della sola coda).
export function lastUserPrompt(transcriptPath, maxBytes = 512 * 1024) {
  if (!transcriptPath || !existsSync(transcriptPath)) return null;
  const fd = openSync(transcriptPath, "r");
  let text;
  try {
    const size = fstatSync(fd).size;
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    text = buf.toString("utf8");
  } finally { closeSync(fd); }
  const lines = text.split("\n").reverse();
  for (const l of lines) {
    let ev;
    try { ev = JSON.parse(l); } catch { continue; }
    if (ev?.type !== "user" || ev.isMeta) continue;
    const c = ev.message?.content;
    const t = typeof c === "string" ? c : Array.isArray(c) ? c.filter((p) => p?.type === "text").map((p) => p.text).join(" ") : "";
    if (t && t.trim() && !/^<(command|local-command|system)/.test(t.trim())) return truncate(redact(t.replace(/\s+/g, " ").trim()), 160);
  }
  return null;
}
