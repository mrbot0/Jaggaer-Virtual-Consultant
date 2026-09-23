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

// Percorsi citati da un comando di shell, relativi al workspace, seguendo i
// cambi di cartella dentro il comando (`cd customers/ACME && cd .. && cat BETA/x`).
// Per prudenza si tiene l'insieme di tutte le cwd possibili (un cd può fallire)
// e si risolve ogni token con aspetto di percorso rispetto a ciascuna. Restituisce
// [{ rels: Set<rel>, cd: boolean }]. Euristica: variabili, sostituzioni di comando
// e script restano fuori (rischio residuo documentato).
const CD = /^(cd|pushd|chdir|set-location|sl|push-location)$/i;
export function shellPaths(ctx, cmd, { maxTokens = 64 } = {}) {
  const out = [];
  const add = (raw, cwd, cd) => {
    try { out.push({ rels: resolveTarget(raw, { cwd, ws: ctx.ws }).ws, cd }); } catch (err) { if (err instanceof PathPolicyError) throw err; }
  };
  const unq = cmd.replace(/["'`]/g, "");
  let cwds = [ctx.cwd];
  let budget = maxTokens;
  for (const seg of unq.split(/&&|\|\||[;|\r\n]/)) {
    const words = seg.trim().split(/\s+/).filter(Boolean);
    if (!words.length) continue;
    if (CD.test(words[0])) {
      const arg = words.slice(1).find((w) => !w.startsWith("-"));
      if (!arg) continue;
      const next = cwds.map((d) => resolve(d, arg.replace(/\\/g, "/")));
      for (const n of next) add(n, ctx.cwd, true);
      cwds = [...new Set([...cwds, ...next])].slice(0, 16);
      continue;
    }
    for (const tok of words.flatMap((w) => w.split(/[=,<>()]+/))) {
      if (!tok || !/[/\\]|^\.\.?$/.test(tok) || budget-- <= 0) continue;
      for (const d of cwds) add(tok, d, false);
    }
  }
  return out;
}
