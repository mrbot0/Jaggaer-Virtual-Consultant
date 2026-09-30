// Parti comuni dei guard di partizione (FAIL-CLOSED): contesto letto da
// session.json, bersagli normalizzati dello strumento, deny con audit.
import { resolve, join } from "node:path";
import { realpathSync } from "node:fs";
import { deny } from "../io.mjs";
import { loadHookState, pluginRoot, baseAgentType } from "../workspace.mjs";
import { resolveTarget, resolvePattern, PathPolicyError } from "../paths.mjs";
import { appendAudit } from "../audit.mjs";
import { summarizeInput } from "../tool-summary.mjs";
import { scriptWriteTargets } from "./script-writes.mjs";
import { simpleArgv } from "../exact-argv.mjs";

export { PathPolicyError };
export const FILE_TOOLS = new Set(["Read", "Write", "Edit", "MultiEdit", "NotebookEdit"]);
export const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
export const SEARCH_TOOLS = new Set(["Glob", "Grep"]);
export const READ_TOOLS = new Set(["Read", "Glob", "Grep"]);
export const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);
export const PATH_TOOLS = new Set([...FILE_TOOLS, ...SEARCH_TOOLS]);

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
// (minuscoli), più i suffissi governati di percorsi assoluti fuori dal
// workspace (`outside`). File: il percorso. Glob: path + pattern (senza '/'
// vale a ogni profondità). Grep: path/** (il filtro `glob` non restringe).
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
  return { ws: new Set(), plugin: new Set(), abs: new Set(), outside: new Set() };
}

// Tutti i relativi da valutare con le regole del workspace: dentro + fuori.
export const allRels = (T) => [...T.ws, ...(T.outside ?? [])];

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

// ---- lo session.mjs del plugin ----

const norm = (p) => p.replace(/\\/g, "/").toLowerCase();
export function sameFile(a, b) {
  const forms = (p) => { const s = new Set([norm(resolve(p))]); try { s.add(norm(realpathSync.native(p))); } catch { /* inesistente */ } return s; };
  const fb = forms(b);
  return [...forms(a)].some((x) => fb.has(x));
}

// Riconosce ESATTAMENTE `node <CLAUDE_PLUGIN_ROOT>/scripts/admin/session.mjs <argomenti>`
// senza concatenazioni né espansioni di shell → { action, what, args } o null.
// WP08 giro 1 (C1): stesso tokenizzatore delle altre eccezioni a forma esatta (hooks/lib/exact-argv.mjs).
export function pluginSessionCommand(cmd, { cwd, plugin }) {
  const tokens = simpleArgv(cmd);
  if (!tokens || !/^node(\.exe)?$/i.test(tokens[0] ?? "") || !tokens[1]) return null;
  if (!sameFile(resolve(cwd, tokens[1]), join(plugin, "scripts", "admin", "session.mjs"))) return null;
  const pos = [];
  for (let i = 2; i < tokens.length; i++) {
    if (tokens[i].startsWith("--")) { if (/^--(session|workspace)$/.test(tokens[i])) i++; continue; }
    pos.push(tokens[i]);
  }
  const [a, b] = pos;
  if (a === "show" || (a === "use" && b === "show")) return { action: "show", what: null, args: pos };
  if (a === "use") return { action: "use", what: b ?? null, args: pos };
  return { action: a ?? null, what: b ?? null, args: pos };
}

// Il comando di riparazione passa anche con stato corrotto (fix round 1 #16):
// `use customer <ID>` ricrea session.json/puntatore, `show` li diagnostica.
// Solo per la sessione principale: un sub-agente (agent_id) non ripara nulla
// (fix round 2 F2 — altrimenti con stato corrotto cambierebbe cliente).
function isRepairCommand(input, env) {
  if (input.agent_id) return false;
  const tool = String(input.tool_name ?? "");
  if (!SHELL_TOOLS.has(tool)) return false;
  const c = pluginSessionCommand(input.tool_input?.command, { cwd: input.cwd ? resolve(String(input.cwd)) : process.cwd(), plugin: pluginRoot(env) });
  return !!c && (c.action === "show" || (c.action === "use" && c.what === "customer"));
}

// Esegue la decisione trasformando le violazioni di normalizzazione in deny
// motivati (le altre eccezioni risalgono a runHook ⇒ deny fail-closed).
// `tools`: strumenti che il guard valuta (gli altri: nessuna opinione, senza
// nemmeno leggere lo stato).
export function guarded(guard, fn, { tools } = {}) {
  return (input, env = process.env) => {
    if (tools && !tools.has(String(input.tool_name ?? ""))) return null;
    let ctx;
    try { ctx = guardContext(input, env); } catch (err) {
      if (isRepairCommand(input, env)) return null;
      throw err;
    }
    if (!ctx.jvc) return null;
    try { return fn(ctx); } catch (err) {
      if (err instanceof PathPolicyError) return denyAudited(ctx, guard, err.message);
      throw err;
    }
  };
}

// ---- percorsi citati da un comando di shell ----
// Relativi al workspace, seguendo i cambi di cartella dentro il comando
// (`cd customers/ACME && cd .. && cat BETA/x`): si tiene l'insieme di tutte le
// cwd possibili (un cd può fallire) e si risolve ogni token rispetto a ciascuna.
// `bareWords`: anche le parole senza '/' (non opzioni, non il nome del comando)
// sono trattate come percorsi. Oltre `maxTokens` token ⇒ deny (fail-closed:
// un comando gonfiato non deve scavalcare l'analisi). Restituisce
// [{ rels: Set<rel>, cd: boolean }]. Euristica: variabili, sostituzioni di
// comando e script restano fuori (rischio residuo documentato).
const CD = /^(cd|pushd|chdir|set-location|sl|push-location)$/i;
export function shellPaths(ctx, cmd, { bareWords = false, maxTokens = 256 } = {}) {
  const out = [];
  const add = (raw, cwd, cd) => {
    try { out.push({ rels: resolveTarget(raw, { cwd, ws: ctx.ws }).ws, cd }); } catch (err) { if (err instanceof PathPolicyError) throw err; }
  };
  const unq = cmd.replace(/["'`]/g, "");
  let cwds = [ctx.cwd];
  let budget = maxTokens;
  const spend = () => { if (--budget < 0) throw new PathPolicyError(`comando troppo lungo per l'analisi del guard (oltre ${maxTokens} percorsi)`); };
  for (const seg of unq.split(/&&|\|\||[;|\r\n]/)) {
    const words = seg.trim().split(/\s+/).filter(Boolean);
    if (!words.length) continue;
    if (CD.test(words[0])) {
      const arg = words.slice(1).find((w) => !w.startsWith("-"));
      if (!arg) continue;
      const next = cwds.map((d) => resolve(d, arg.replace(/\\/g, "/")));
      for (const n of next) { spend(); add(n, ctx.cwd, true); }
      cwds = [...new Set([...cwds, ...next])].slice(0, 16);
      continue;
    }
    words.forEach((w, wi) => {
      for (const tok of w.split(/[=,<>()]+/)) {
        if (!tok) continue;
        const pathLike = /[/\\]|^\.\.?$/.test(tok);
        if (!pathLike && !(bareWords && wi > 0 && !tok.startsWith("-"))) continue;
        for (const d of cwds) { spend(); add(tok, d, false); }
      }
    });
  }
  return out;
}

export const subtree = (p) => (p ? `${p}/**` : "**");

// ---- bersagli di scrittura di un comando di shell (fix round 2 F5, round 3, round 4) ----
// Redirezioni (`>`, `>>`, `>|`, `n>`, `&>`; non `n>&m`) e comandi che scrivono,
// spostano o cancellano file (bash e PowerShell). Si seguono i `cd` come in
// shellPaths. → [{ tok, cwds, tree }]: tok grezzo, da risolvere con resolveTarget
// rispetto a ciascuna cwd; `tree` = il bersaglio può essere una cartella (rm/mv
// di una cartella, cp/mv dentro una cartella), quindi conta anche tutto ciò che
// contiene. sed/perl/ruby (-i, `w` di sed, codice -e) li analizza
// script-writes.mjs (round 4), con le virgolette: i suoi bersagli possono
// essere `soft` (candidati euristici). Euristica come shellPaths: variabili e
// script in file che scrivono restano fuori (rischio residuo).
const REDIR = /(?:\d*|&)>>?[ \t]*([^\s;|&<>()]+)/g;
const WRITE_FILE = /^(tee|out-file|set-content|add-content|clear-content|sc|ac|clc|new-item|ni|touch|truncate)$/i;
const WRITE_TREE = /^(mv|move|move-item|mi|ren|rename|rename-item|rni|rm|del|erase|rd|rmdir|remove-item|ri|unlink|shred)$/i;
const WRITE_LAST = /^(cp|copy|copy-item|cpi|install|rsync|scp|ln|mklink|xcopy|robocopy)$/i;
const DEST_PARAM = /^-(destination|path|literalpath|filepath|target)$/i;
export function shellWriteTargets(ctx, cmd) {
  const out = scriptWriteTargets(ctx.cwd, cmd);
  let cwds = [ctx.cwd];
  // `>|` (noclobber forzato) è una redirezione: va riconosciuta prima di spezzare sui `|`.
  const unq = cmd.replace(/["'`]/g, "").replace(/>\|/g, ">");
  for (const seg of unq.split(/&&|\|\||[;|\r\n]/)) {
    const s = seg.trim();
    if (!s) continue;
    for (const m of s.matchAll(REDIR)) out.push({ tok: m[1], cwds, tree: false });
    const words = s.replace(REDIR, " ").split(/\s+/).filter(Boolean);
    const head = (words[0] ?? "").replace(/^.*[\\/]/, "").replace(/\.exe$/i, "");
    if (CD.test(head)) {
      const arg = words.slice(1).find((w) => !w.startsWith("-"));
      if (arg) cwds = [...new Set([...cwds, ...cwds.map((d) => resolve(d, arg.replace(/\\/g, "/")))])].slice(0, 16);
      continue;
    }
    if (/^dd$/i.test(head)) { for (const w of words) if (/^of=/i.test(w)) out.push({ tok: w.slice(3), cwds, tree: false }); continue; }
    const args = words.slice(1);
    const pos = args.filter((w) => !w.startsWith("-"));
    if (WRITE_FILE.test(head)) for (const w of pos) out.push({ tok: w, cwds, tree: false });
    else if (WRITE_TREE.test(head)) for (const w of pos) out.push({ tok: w, cwds, tree: true });
    else if (WRITE_LAST.test(head)) {
      args.forEach((w, i) => { if (DEST_PARAM.test(w) && args[i + 1]) out.push({ tok: args[i + 1], cwds, tree: true }); });
      if (pos.length) out.push({ tok: pos.at(-1), cwds, tree: true });
    }
  }
  return out;
}
