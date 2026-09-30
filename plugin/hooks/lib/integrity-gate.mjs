// Gate di integrità dei guard FAIL-CLOSED (F0.3, §53.1). Lo consulta runHook di io.mjs prima della logica di ogni
// guard di sicurezza. Legge lo stato che session-context ha registrato a SessionStart (session.integrity, oppure
// <workspace>/.jvc/integrity.json senza cliente) per QUESTO pacchetto (plugin_root):
//  - integrità non ok ⇒ deny di ogni strumento ("Integrità del pacchetto fallita: reinstallare dalla release
//    firmata"), in audit, tranne gli strumenti di sola lettura del workspace (Read, Glob, Grep) e la chiamata Bash /
//    PowerShell esatta a `node <plugin>/scripts/admin/doctor.mjs …` o `node <plugin>/scripts/admin/integrity.mjs verify …`;
//  - nessuno stato registrato (SessionStart non eseguito) ⇒ nessun effetto: la verifica è di SessionStart;
//  - JVC_DEV=1 (sviluppo del plugin, variabile del processo di Claude Code) ⇒ gate saltato.
// Inerte fuori da un workspace JVC e nella radice del plugin. Stato illeggibile ⇒ si ignora qui (gli altri guard lo
// negano già con il loro motivo).
import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { deny } from "./io.mjs";
import { devMode } from "./integrity.mjs";
import { simpleNodeCall, argsRefusal } from "./exact-argv.mjs";

export const INTEGRITY_DENY = "Integrità del pacchetto fallita: reinstallare dalla release firmata (§58); non operare. Consentiti solo Read/Glob/Grep e `doctor` / `integrity verify`";
const READ_ONLY = new Set(["Read", "Glob", "Grep"]);

const canon = (p) => {
  let r;
  try { r = realpathSync.native(p); } catch { r = resolve(p); }
  r = r.replace(/[\\/]+$/, "");
  return process.platform === "win32" ? r.replace(/\//g, "\\").toLowerCase() : r;
};
const readJson = (f) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return null; } };

export function recordedIntegrity(st, plugin) {
  const mine = (r) => r && typeof r === "object" && typeof r.ok === "boolean" && (!r.plugin_root || canon(r.plugin_root) === canon(plugin));
  if (st.sessionFile) { const s = readJson(st.sessionFile); if (mine(s?.integrity)) return s.integrity; }
  const w = readJson(resolve(st.ws, ".jvc", "integrity.json"));
  return mine(w) ? w : null;
}

// `node <plugin>/scripts/admin/doctor.mjs [--network] [--json] [--session <id>]` o
// `node <plugin>/scripts/admin/integrity.mjs verify [--json]`: UNA invocazione semplice (tokenizzatore condiviso,
// hooks/lib/exact-argv.mjs — WP08 giro 1, C1), ogni argomento validato per forma.
const SID = "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$";
export function isRepairCall(command, cwd, plugin) {
  const call = simpleNodeCall(command, cwd);
  if (!call) return false;
  const script = canon(call.script);
  if (script === canon(resolve(plugin, "scripts/admin/doctor.mjs"))) return !argsRefusal(call.args, { positional: [], flags: { "--network": null, "--json": null, "--session": SID } });
  if (script === canon(resolve(plugin, "scripts/admin/integrity.mjs"))) return !argsRefusal(call.args, { positional: ["^verify$"], flags: { "--json": null } });
  return false;
}

// → output di deny | null
export async function integrityGate(input, env = process.env) {
  if (devMode(env)) return null;
  const { loadHookState, pluginRoot } = await import("./workspace.mjs");
  const plugin = pluginRoot(env);
  let st;
  try { st = loadHookState(input, env); } catch {
    // stato di sessione illeggibile: solo la registrazione del workspace
    const { workspaceRoot, isJvcWorkspace } = await import("./workspace.mjs");
    const ws = workspaceRoot(input, env);
    st = { ws, jvc: isJvcWorkspace(ws, env), sessionFile: null, customer: null, sid: null };
  }
  if (!st.jvc) return null;
  const rec = recordedIntegrity(st, plugin);
  if (!rec || rec.ok !== false) return null;
  const tool = String(input.tool_name ?? "");
  if (READ_ONLY.has(tool)) return null;
  if ((tool === "Bash" || tool === "PowerShell") && isRepairCall(input.tool_input?.command, input.cwd ? resolve(String(input.cwd)) : st.ws, plugin)) return null;
  const detail = [rec.status, ...(rec.mismatched ?? []).slice(0, 3)].filter(Boolean).join(": ");
  try {
    const { appendAudit } = await import("./audit.mjs");
    appendAudit(st.ws, { session: st.sid, customer: st.customer, scope: null, kind: "guard", actor: "hook:integrity-gate",
      payload: { decision: "deny", tool, reason: INTEGRITY_DENY, integrity: { status: rec.status ?? null, checked_at: rec.checked_at ?? null } } });
  } catch { /* l'audit non cambia la decisione */ }
  return deny(`[integrity-gate] ${INTEGRITY_DENY}${detail ? ` (${detail})` : ""}`);
}
