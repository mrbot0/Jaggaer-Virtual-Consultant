// pre-dispatch (PreToolUse su ogni strumento, FAIL-CLOSED) — 29/10/2026, punto 5 del piano approvato dall'utente: un solo
// processo node per chiamata invece di uno per guard (fino a 6 per una chiamata del browser, ~150 ms di avvio ciascuno).
// La tabella hooks/lib/dispatch-table.json ha la stessa struttura dei gruppi di hooks.json (matcher ancorato → script dei
// guard): per lo strumento si raccolgono i guard di tutti i gruppi che corrispondono, senza doppioni, nell'ordine della
// tabella ma con guard-config-scope per ultimo (consuma i token monouso delle approvazioni: non deve consumarli se un altro
// guard nega). Il primo deny vince e ferma gli altri; altrimenti "ask" se un guard lo chiede, altrimenti la prima uscita non
// vuota (ad esempio l'updatedInput di guard-budget). Un errore di un guard nega tutto (runHook failClosed, gate d'integrità
// una volta sola). Gli script dei singoli guard restano (test e diagnosi).
import { readFileSync } from "node:fs";
import { runHook } from "../lib/io.mjs";
import { isMain } from "../../scripts/lib/is-main.mjs";

const TABLE = JSON.parse(readFileSync(new URL("../lib/dispatch-table.json", import.meta.url), "utf8")).PreToolUse;
const MODULE = {
  "guard-phrase": "phrase", "guard-control": "control", "guard-domain-boundary": "domain", "guard-scope": "scope", "guard-customer": "customer",
  "guard-budget": "budget", "guard-environment": "environment", "guard-production": "production", "guard-config-scope": "config-scope",
  "guard-destructive": "destructive", "guard-alm-write": "alm-write",
};
const LAST = new Set(["guard-config-scope"]);

export function guardsFor(tool) {
  const names = [];
  for (const g of TABLE) {
    if (!new RegExp(`^(?:${g.matcher ?? ".*"})$`).test(tool)) continue;
    for (const h of g.hooks) {
      const n = /scripts\/([a-z-]+)\.mjs/.exec(h.command)?.[1];
      if (!n) continue;
      if (!Object.hasOwn(MODULE, n)) throw new Error(`guard senza modulo nella tabella del dispatcher: ${n}`);
      if (!names.includes(n)) names.push(n);
    }
  }
  return [...names.filter((n) => !LAST.has(n)), ...names.filter((n) => LAST.has(n))];
}

export async function dispatch(input) {
  let ask = null;
  let first = null;
  for (const n of guardsFor(String(input?.tool_name ?? ""))) {
    const out = await (await import(`../lib/guards/${MODULE[n]}.mjs`)).decide(input);
    if (!out) continue;
    const d = out.hookSpecificOutput?.permissionDecision;
    if (d === "deny") return out;
    if (d === "ask") ask ??= out;
    else first ??= out;
  }
  return ask ?? first;
}

if (isMain(import.meta.url)) runHook((input) => dispatch(input), { name: "pre-dispatch", failClosed: true });
