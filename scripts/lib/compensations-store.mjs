// Registro delle compensazioni (§29.6, §47.2 #1) — UN solo formato, quello che K6 già scrive: voce
// { plan, step, kind: close|cancel|deactivate|restore, entity?, action?, ref?, status: pending|done, registered_at }
// in runs/<RUN>/compensations.yaml ({ compensations: [...] }, chiave plan+step) e in session.pending.compensations
// (letto da guard-config-scope: (a) compensazione registrata per il passo). step-check (attivazione del passo),
// kb compensation (scripts/kb/compensation.mjs) e teardown (scripts/run/teardown.mjs) scrivono con queste funzioni.
import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { writeFileAtomic, withFileLock } from "../../hooks/lib/fsx.mjs";
import { updateSessionFile } from "../../hooks/lib/session-state.mjs";

export const COMP_KINDS = new Set(["close", "cancel", "deactivate", "restore"]);
export const DELETE_WORDS = /\b(delete|deletion|remove|purge|drop|elimina\w*|cancella\w*|rimuov\w*)\b/i;
export const sameKey = (a, b) => a && b && a.plan === b.plan && a.step === b.step;

export function readRunCompensations(runDir) {
  const f = join(runDir, "compensations.yaml");
  if (!existsSync(f)) return [];
  const doc = YAML.parse(readFileSync(f, "utf8")) ?? {};
  return Array.isArray(doc.compensations) ? doc.compensations : [];
}

// Aggiunge le voci nuove (per plan+step) al file del run: la scrittura su disco precede quella nella sessione.
export function writeCompensations(runDir, entries) {
  if (!entries.length) return;
  mkdirSync(runDir, { recursive: true });
  const f = join(runDir, "compensations.yaml");
  withFileLock(`${f}.lock`, () => {
    let list = [];
    try { list = readRunCompensations(runDir); } catch { /* illeggibile: si riparte */ }
    for (const e of entries) if (!list.some((x) => sameKey(x, e))) list.push(e);
    writeFileAtomic(f, YAML.stringify({ compensations: list }));
  });
}

export function markRunCompensation(runDir, key, patch) {
  const f = join(runDir, "compensations.yaml");
  if (!existsSync(f)) return null;
  return withFileLock(`${f}.lock`, () => {
    const list = readRunCompensations(runDir);
    const e = list.find((x) => sameKey(x, key));
    if (!e) return null;
    Object.assign(e, patch);
    writeFileAtomic(f, YAML.stringify({ compensations: list }));
    return e;
  });
}

export function addSessionCompensation(sessionFile, entry) {
  updateSessionFile(sessionFile, (x) => {
    x.pending ??= { compensations: [], approvals: [], questions: [], expected_outcomes: [] };
    const comps = Array.isArray(x.pending.compensations) ? x.pending.compensations : [];
    if (!comps.some((c) => c && typeof c === "object" && sameKey(c, entry))) comps.push(entry);
    x.pending.compensations = comps;
  });
}

export function removeSessionCompensation(sessionFile, key) {
  let removed = null;
  updateSessionFile(sessionFile, (x) => {
    const comps = Array.isArray(x.pending?.compensations) ? x.pending.compensations : [];
    removed = comps.find((c) => c && typeof c === "object" && sameKey(c, key)) ?? null;
    if (x.pending) x.pending.compensations = comps.filter((c) => !(c && typeof c === "object" && sameKey(c, key)));
  });
  return removed;
}

// Controllo di una voce: tipo ammesso, azione che non cancella (ADR-06: mai delete).
export function compensationRefusal(e) {
  if (!e || typeof e !== "object") return "compensazione assente";
  if (!Number.isInteger(e.step) || e.step < 1) return "compensazione senza passo (step ≥ 1)";
  if (typeof e.plan !== "string" || !/^PLAN\.[A-Za-z0-9._-]+$/.test(e.plan)) return "compensazione senza piano (PLAN.…)";
  if (!COMP_KINDS.has(e.kind)) return `compensazione ${e.kind}: solo close · cancel · deactivate · restore (mai delete, ADR-06)`;
  for (const k of ["action", "note", "entity"]) if (typeof e[k] === "string" && DELETE_WORDS.test(e[k])) return `compensazione con ${k} "${e[k]}": si chiude, si annulla o si disattiva, mai si cancella`;
  return null;
}
