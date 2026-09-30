// Generatori del pacchetto (integrity build, build-deny-rules, build-session-validator, build-error-patterns): scrivono
// integrity.json o hooks/lib/generated/ e si eseguono SOLO nel repository del plugin, per una release (WP08 giro 1, I1).
// Rifiutano (exit 3) quando girano dentro un workspace JVC attivo: JVC_WORKSPACE, CLAUDE_PROJECT_DIR, la cartella corrente
// o uno dei suoi antenati è un workspace JVC (la radice del plugin non lo è mai). I guard negano comunque queste
// chiamate da una sessione (guard-config-scope); questo è il secondo strato.
import { resolve, dirname, join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { isJvcWorkspace } from "../../hooks/lib/workspace.mjs";

function ancestors(dir) {
  const out = [];
  let cur = resolve(dir);
  for (;;) { out.push(cur); const up = dirname(cur); if (up === cur) return out; cur = up; }
}

// → percorso del workspace JVC che contiene l'esecuzione, o null.
export function activeWorkspace(pluginRoot, { env = process.env, cwd = process.cwd() } = {}) {
  const e = { ...env, CLAUDE_PLUGIN_ROOT: pluginRoot };
  const cands = [env.JVC_WORKSPACE, env.CLAUDE_PROJECT_DIR].filter(Boolean).map((p) => resolve(p));
  // un checkout del plugin (plugin.json del plugin, senza customers/ né .jvc/) non è un workspace di conoscenza
  const checkout = (d) => isPluginDir(d) && !existsSync(join(d, "customers")) && !existsSync(join(d, ".jvc"));
  for (const c of [...cands, ...ancestors(cwd)]) if (isJvcWorkspace(c, e) && !checkout(c)) return c;
  return null;
}

// Una radice di plugin: .claude-plugin/plugin.json con name jaggaer-virtual-consultant, fuori da ogni workspace JVC.
export function isPluginDir(dir) {
  try { return JSON.parse(readFileSync(join(dir, ".claude-plugin", "plugin.json"), "utf8")).name === "jaggaer-virtual-consultant"; } catch { return false; }
}
export function insideWorkspace(dir, pluginRoot, env = process.env) {
  const e = { ...env, CLAUDE_PLUGIN_ROOT: pluginRoot };
  return ancestors(dir).some((d) => isJvcWorkspace(d, e));
}
