// Registro di audit append-only con hash concatenato (§46.7, §48.2, T8).
// Una riga = un evento JSON. hash = sha256(prev_hash + JSON canonico
// dell'evento senza `hash`). La prima riga di ogni file mensile parte dal
// genesis (64 zeri). Scrittura sotto lock: gli hook PostToolUse di chiamate
// parallele girano in parallelo.
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { withFileLock, readLastLine } from "./fsx.mjs";

export const GENESIS = "0".repeat(64);
export const AUDIT_KINDS = ["tool", "agent", "decision", "guard", "run", "compensation", "question", "budget", "session"];

export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? "null" : canonical(x))).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

export function hashEvent(ev) {
  const { hash, ...rest } = ev;
  return createHash("sha256").update(String(rest.prev_hash ?? "") + canonical(rest)).digest("hex");
}

export function auditFile(ws, customer, date = new Date()) {
  const ym = date.toISOString().slice(0, 7);
  return customer ? join(ws, "customers", customer, "audit", `${ym}.jsonl`) : join(ws, ".jvc", "audit", `${ym}.jsonl`);
}

// Costruisce e appende un evento. `fields` = { session, customer, scope, kind,
// code, correlation, actor, payload }.
export function appendAudit(ws, fields, { date = new Date() } = {}) {
  if (!AUDIT_KINDS.includes(fields.kind)) throw new Error(`kind di audit non valido: ${fields.kind}`);
  const file = auditFile(ws, fields.customer ?? null, date);
  mkdirSync(dirname(file), { recursive: true });
  return withFileLock(`${file}.lock`, () => {
    const last = readLastLine(file);
    const prev = last ? JSON.parse(last).hash : GENESIS;
    if (typeof prev !== "string" || !/^[0-9a-f]{64}$/.test(prev)) throw new Error(`ultima riga di audit senza hash valido: ${file}`);
    const ev = {
      ts: date.toISOString(),
      session: fields.session ?? null,
      customer: fields.customer ?? null,
      scope: fields.scope ?? null,
      kind: fields.kind,
      code: fields.code ?? null,
      correlation: { task: null, dec: null, run: null, ...(fields.correlation ?? {}) },
      actor: fields.actor ?? "manager",
      payload: fields.payload ?? {},
      prev_hash: prev,
    };
    ev.hash = hashEvent(ev);
    appendFileSync(file, `${JSON.stringify(ev)}\n`);
    return { file, event: ev };
  });
}

// Verifica la catena di un file: ogni riga JSON valida, prev_hash uguale
// all'hash della riga precedente (genesis per la prima), hash ricalcolato.
export function verifyChain(file) {
  let text;
  try { text = readFileSync(file, "utf8"); } catch (err) { return { ok: false, lines: 0, broken_at: 0, reason: `file illeggibile: ${err.code ?? err.message}` }; }
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  let prev = GENESIS;
  for (let i = 0; i < lines.length; i++) {
    let ev;
    try { ev = JSON.parse(lines[i]); } catch { return { ok: false, lines: lines.length, broken_at: i + 1, reason: "riga non JSON" }; }
    if (ev.prev_hash !== prev) return { ok: false, lines: lines.length, broken_at: i + 1, reason: "prev_hash non coincide con la riga precedente" };
    if (hashEvent(ev) !== ev.hash) return { ok: false, lines: lines.length, broken_at: i + 1, reason: "hash non coincide con il contenuto" };
    prev = ev.hash;
  }
  return { ok: true, lines: lines.length };
}
