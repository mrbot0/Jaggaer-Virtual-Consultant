// Codice di un run (§3, §27.4): RUN.<CLIENTE>.<AAAAMMDD>.<HHMM>.<SCOPE> — la cartella customers/<C>/runs/<RUN>/ di
// manifest, checkpoint, compensazioni, entità create, snapshot ed evidenze. WP09b: forma completa a cinque segmenti
// (WP07 ruling: "stringere quando WP09b genera run reali"); step-check la usa con i controlli di realpath/figlio diretto.
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";

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

// WP07 giro 3 (I-B): il run è UN codice RUN la cui cartella, se esiste, è figlia DIRETTA di customers/<C>/runs/ anche
// dopo realpath: niente sotto-cartelle, risalite, giunzioni, link o percorsi esterni (lo stesso per runs/ e checkpoints/).
// WP09b: forma completa (parseRunCode) e cliente del codice = cliente della sessione. → motivo del rifiuto | null
function realOrNull(p) {
  try { return realpathSync.native(p); } catch (err) { if (err?.code === "ENOENT") return null; throw err; }
}
export function runRefusal(ws, customer, run) {
  const pr = typeof run === "string" ? parseRunCode(run) : null;
  if (!pr) return `nome di run non valido: ${JSON.stringify(run)} (atteso RUN.<CLIENTE>.<AAAAMMDD>.<HHMM>.<SCOPE>, senza separatori di percorso)`;
  if (pr.customer !== customer) return `il run ${run} è del cliente ${pr.customer}, la sessione di ${customer}`;
  const cust = realOrNull(join(ws, "customers", customer));
  const root = realOrNull(join(ws, "customers", customer, "runs"));
  if (cust && root && root !== join(cust, "runs")) return "la cartella runs/ del cliente è un collegamento (giunzione o link): i checkpoint non si leggono";
  const dir = realOrNull(join(ws, "customers", customer, "runs", run));
  if (dir && (!root || dir !== join(root, run))) return `la cartella del run ${run} è un collegamento (giunzione o link) o fuori da runs/: i checkpoint non si leggono`;
  const cps = realOrNull(join(ws, "customers", customer, "runs", run, "checkpoints"));
  if (cps && (!dir || cps !== join(dir, "checkpoints"))) return `la cartella checkpoints/ del run ${run} è un collegamento (giunzione o link): i checkpoint non si leggono`;
  return null;
}

const pad = (n) => String(n).padStart(2, "0");
// Data e ora locali dell'operatore (il nome del run è leggibile da chi apre la cartella).
export function formatRunCode({ customer, scope, date = new Date() }) {
  const code = `RUN.${customer}.${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}.${pad(date.getHours())}${pad(date.getMinutes())}.${scope}`;
  if (!isRunCode(code)) throw new Error(`codice RUN non valido: ${code} (cliente di 4 caratteri, scope del registro)`);
  return code;
}
