// Parti comuni dei guard di partizione (FAIL-CLOSED): contesto letto da
// session.json, bersagli normalizzati dello strumento, deny con audit.
import { resolve } from "node:path";
import { deny } from "../io.mjs";
import { loadHookState, pluginRoot, baseAgentType } from "../workspace.mjs";
import { resolveTarget, resolvePattern, PathPolicyError } from "../paths.mjs";
import { appendAudit } from "../audit.mjs";
import { summarizeInput } from "../tool-summary.mjs";

export { PathPolicyError };
export const FILE_TOOLS = new Set(["Read", "Write", "Edit", "MultiEdit", "NotebookEdit"]);
export const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
export const SEARCH_TOOLS = new Set(["Glob", "Grep"]);
export const READ_TOOLS = new Set(["Read", "Glob", "Grep"]);
export const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);

export function guardContext(input, env = process.env) {
  const st = loadHookState(input, env);
  return {
    ...st,
    input,
    plugin: pluginRoot(env),
    tool: String(input.tool_name ?? ""),
    ti: input.tool_input && typeof input.tool_input === "object" ? input.tool_input : {},
    agentType: baseAgentType(input.agent_type),
    agentId: input.agent_id ? String(input.agent_id) : null,
    cwd: input.cwd ? resolve(String(input.cwd)) : st.ws,
    customerLc: st.customer ? st.customer.toLowerCase() : null,
  };
}

// Bersagli dello strumento come pattern relativi al workspace e al plugin
// (minuscoli). File: il percorso. Glob: path + pattern (senza '/' vale a ogni
// profondità). Grep: path/** (il filtro `glob` non restringe: prudenza).
export function targetsOf(ctx) {
  const { tool, ti, cwd, ws, plugin } = ctx;
  const opts = { cwd, ws, plugin };
  if (FILE_TOOLS.has(tool)) {
    const p = ti.file_path ?? ti.notebook_path;
    if (typeof p !== "string" || !p) throw new PathPolicyError(`${tool} senza file_path`);
    return resolveTarget(p, opts);
  }
  const base = typeof ti.path === "string" && ti.path ? ti.path : cwd;
  if (tool === "Glob") return resolvePattern(base, ti.pattern, { ...opts, unanchoredBasename: true });
  if (tool === "Grep") return resolvePattern(base, "**", opts);
  return { ws: new Set(), plugin: new Set(), abs: new Set() };
}

export function denyAudited(ctx, guard, reason) {
  try {
    if (ctx.jvc) {
      appendAudit(ctx.ws, {
        session: ctx.sid, customer: ctx.customer, scope: ctx.session?.scope ?? null, kind: "guard", actor: `hook:${guard}`,
        payload: { decision: "deny", tool: ctx.tool, reason, input_summary: summarizeInput(ctx.tool, ctx.ti), agent_type: ctx.agentType, agent_id: ctx.agentId },
      });
    }
  } catch { /* l'audit non cambia la decisione: si nega comunque */ }
  return deny(`[${guard}] ${reason}`);
}

// Esegue la decisione trasformando le violazioni di normalizzazione in deny
// motivati (le altre eccezioni risalgono a runHook ⇒ deny fail-closed).
export function guarded(guard, fn) {
  return (input, env = process.env) => {
    const ctx = guardContext(input, env);
    if (!ctx.jvc) return null;
    try { return fn(ctx); } catch (err) {
      if (err instanceof PathPolicyError) return denyAudited(ctx, guard, err.message);
      throw err;
    }
  };
}
