// Vista dei matcher dei guard (29/10/2026, punto 5): hooks.json registra in PreToolUse il solo pre-dispatch, che esegue i
// guard della tabella hooks/lib/dispatch-table.json; i test che controllano matcher e copertura leggono la vista unita.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./hook-env.mjs";

export function hooksView() {
  const h = JSON.parse(readFileSync(join(ROOT, "hooks/hooks.json"), "utf8"));
  const t = JSON.parse(readFileSync(join(ROOT, "hooks/lib/dispatch-table.json"), "utf8"));
  return { ...h, hooks: { ...h.hooks, PreToolUse: t.PreToolUse } };
}
