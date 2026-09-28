// Codice di un run (§3, §27.4): RUN.<CLIENTE>.<AAAAMMDD>.<HHMM>.<SCOPE> — la cartella customers/<C>/runs/<RUN>/ di
// manifest, checkpoint, compensazioni, entità create, snapshot ed evidenze. WP09b: forma completa a cinque segmenti
// (WP07 ruling: "stringere quando WP09b genera run reali"); step-check la usa con i controlli di realpath/figlio diretto.
import { readFileSync } from "node:fs";

const REGISTRY = JSON.parse(readFileSync(new URL("../../schemas/registry.json", import.meta.url), "utf8"));
const SCOPES = new Set(REGISTRY.scopes);
export const RUN_RE = /^RUN\.([A-Z0-9]{4})\.(\d{8})\.(\d{4})\.([A-Z0-9]{3})$/;

// → { customer, date: "AAAAMMDD", time: "HHMM", scope } | null (anche per date/ore impossibili o scope fuori registro)
export function parseRunCode(code) {
  const m = RUN_RE.exec(String(code ?? ""));
  if (!m) return null;
  const [, customer, date, time, scope] = m;
  const y = Number(date.slice(0, 4)); const mo = Number(date.slice(4, 6)); const d = Number(date.slice(6, 8));
  const hh = Number(time.slice(0, 2)); const mm = Number(time.slice(2, 4));
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d || hh > 23 || mm > 59) return null;
  if (!SCOPES.has(scope) || customer === "STD") return null;
  return { customer, date, time, scope };
}
export const isRunCode = (code) => parseRunCode(code) !== null;

const pad = (n) => String(n).padStart(2, "0");
// Data e ora locali dell'operatore (il nome del run è leggibile da chi apre la cartella).
export function formatRunCode({ customer, scope, date = new Date() }) {
  const code = `RUN.${customer}.${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}.${pad(date.getHours())}${pad(date.getMinutes())}.${scope}`;
  if (!isRunCode(code)) throw new Error(`codice RUN non valido: ${code} (cliente di 4 caratteri, scope del registro)`);
  return code;
}
