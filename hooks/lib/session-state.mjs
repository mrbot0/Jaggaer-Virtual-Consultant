// Il predicato UNICO "stato di sessione leggibile e coerente" (fix round 2 F1),
// usato sia dagli hook (workspace.mjs → guard fail-closed) sia dalla CLI
// (scripts/admin/session.mjs → show/use e riparazione). Un session.json è
// valido solo se: è JSON, rispetta schemas/session.schema.json (validatore Ajv
// precompilato, vedi scripts/lib/build-session-validator.mjs), il suo
// `customer` coincide con quello atteso (puntatore o cartella) e il suo
// `session_id` con la sessione.
import { readFileSync } from "node:fs";
import validate from "./generated/session-validate.mjs";
import { withFileLock, writeFileAtomic } from "./fsx.mjs";

const fmt = (e) => `${e.instancePath || "/"} ${e.message}${e.params?.missingProperty ? ` (${e.params.missingProperty})` : ""}`;

// → { ok: true, session } | { ok: false, reason, parsed } (parsed: l'oggetto, se il JSON era leggibile)
export function checkSessionText(text, { customer, sid } = {}) {
  let obj;
  try { obj = JSON.parse(text); } catch (err) { return { ok: false, reason: `JSON non valido (${err.message})`, parsed: null }; }
  if (!validate(obj)) return { ok: false, reason: `non conforme allo schema: ${validate.errors.slice(0, 3).map(fmt).join("; ")}`, parsed: obj };
  if (customer != null && obj.customer !== customer) return { ok: false, reason: `session.json è del cliente ${obj.customer}, il puntatore indica ${customer}`, parsed: obj };
  if (sid != null && obj.session_id !== sid) return { ok: false, reason: `session.json è della sessione ${obj.session_id}, non di ${sid}`, parsed: obj };
  return { ok: true, session: obj };
}

export class SessionStateError extends Error {}

// Come checkSessionText ma lancia: per i chiamanti per cui "illeggibile" è un errore.
export function parseSessionText(text, expect) {
  const r = checkSessionText(text, expect);
  if (!r.ok) throw new SessionStateError(`stato di sessione illeggibile: ${r.reason}`);
  return r.session;
}

// Scrittura di session.json dagli hook sul percorso caldo (guard che registrano
// l'origine del browser o consumano un token): read-modify-write sotto il lock
// di session.json (lo stesso di updateSession della CLI), validato con il
// validatore PRECOMPILATO (niente Ajv a runtime), poi tmp + rename.
export function updateSessionFile(file, mutate) {
  return withFileLock(`${file}.lock`, () => {
    const s = JSON.parse(readFileSync(file, "utf8"));
    const r = mutate(s);
    const obj = { ...(r && typeof r === "object" ? r : s), updated_at: new Date().toISOString() };
    if (!validate(obj)) throw new SessionStateError(`session.json non valido: ${validate.errors.slice(0, 3).map(fmt).join("; ")}`);
    writeFileAtomic(file, `${JSON.stringify(obj, null, 2)}\n`);
    return obj;
  });
}
