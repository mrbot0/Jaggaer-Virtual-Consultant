import { readFileSync } from "node:fs";
export const REGISTRY = JSON.parse(readFileSync(new URL("../../schemas/registry.json", import.meta.url), "utf8"));
export const SCOPES = new Set(REGISTRY.scopes);
const RE = /^([SCL])\.([A-Z0-9]{3,4})\.([A-Z0-9]{3})\.([A-Z]{3})\.(\d{4})(?:\.v(\d+))?$/;

export function parseCode(code) {
  const m = RE.exec(code);
  if (!m) return null;
  const [, level, customer, scope, type, seq, ver] = m;
  return { level, customer, scope, type, seq: Number(seq), version: ver ? Number(ver) : 1 };
}

export function isValidCode(code) {
  const p = parseCode(code);
  if (!p) return false;
  if (p.level === "S" && p.customer !== "STD") return false;
  if (p.level !== "S" && (p.customer === "STD" || p.customer.length !== 4)) return false;
  if (!SCOPES.has(p.scope)) return false;
  const levels = REGISTRY.types[p.type];
  return Array.isArray(levels) && levels.includes(p.level);
}
