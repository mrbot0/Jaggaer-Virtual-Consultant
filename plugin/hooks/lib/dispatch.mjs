// Dispatcher dei guard di PreToolUse (29/10/2026, punto 5 del piano approvato dall'utente; logica qui perché lo script
// hooks/scripts/pre-dispatch.mjs chiami runHook SEMPRE — giro 2 di bug fixing: con un controllo isMain una radice del plugin
// raggiunta per giunzione o collegamento avrebbe spento tutti i guard senza errore).
// La tabella hooks/lib/dispatch-table.json ha la stessa struttura dei gruppi di hooks.json (matcher ancorato → script dei
// guard): per lo strumento si raccolgono i guard di tutti i gruppi che corrispondono, senza doppioni, nell'ordine della
// tabella ma con guard-control e guard-config-scope per ultimi (consumano token monouso — il «sì» del PASSO PASSO e le
// approvazioni dei piani — e contano le chiamate: non devono farlo se un altro guard nega). Il primo deny vince e ferma gli
// altri; altrimenti "ask" se un guard lo chiede, altrimenti la prima uscita non vuota (ad esempio l'updatedInput di
// guard-budget). Un errore di un guard nega tutto, con il nome del guard; oltre DISPATCH_BUDGET_MS si nega (prima del
// timeout di Claude Code, che lascerebbe passare la chiamata senza guard).
import { readFileSync } from "node:fs";
import { deny } from "./io.mjs";

const TABLE = JSON.parse(readFileSync(new URL("./dispatch-table.json", import.meta.url), "utf8")).PreToolUse;
export const MODULE = Object.freeze({
  "guard-phrase": "phrase", "guard-control": "control", "guard-domain-boundary": "domain", "guard-scope": "scope", "guard-customer": "customer",
  "guard-budget": "budget", "guard-environment": "environment", "guard-production": "production", "guard-config-scope": "config-scope",
  "guard-destructive": "destructive", "guard-alm-write": "alm-write",
});
const LAST = ["guard-control", "guard-config-scope"];
export const DISPATCH_BUDGET_MS = 8000;

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
  return [...names.filter((n) => !LAST.includes(n)), ...LAST.filter((n) => names.includes(n))];
}

async function run(input) {
  let ask = null;
  let first = null;
  for (const n of guardsFor(String(input?.tool_name ?? ""))) {
    let out;
    try { out = await (await import(`./guards/${MODULE[n]}.mjs`)).decide(input); } catch (err) { throw new Error(`${n}: ${String(err?.message ?? err).slice(0, 240)}`); }
    if (!out) continue;
    const d = out.hookSpecificOutput?.permissionDecision;
    if (d === "deny") return out;
    if (d === "ask") ask ??= out;
    else first ??= out;
  }
  return ask ?? first;
}

export async function dispatch(input, { budgetMs = DISPATCH_BUDGET_MS, runner = run } = {}) {
  let timer;
  const late = new Promise((resolve) => { timer = setTimeout(() => resolve(deny(`[pre-dispatch] guard oltre ${budgetMs} ms: negato per prudenza (riprova; se si ripete, il manager invochi health-keeper)`)), budgetMs); });
  try { return await Promise.race([runner(input), late]); } finally { clearTimeout(timer); }
}
