// guard-scope (FAIL-CLOSED): cella dello scope (§1.2, §31.4, §32).
//  - percorsi governati (celle kb, handoff, _inbox, tests) ⇒ solo se in
//    session.allowed_paths; altrimenti deny con suggerimento di handoff;
//  - scrittura negata a tutti su product/**, sulle decision-tables/,
//    strategies/, clusters/ del plugin (§29.6, T9) e sullo stato di sessione;
//  - INT possedute (kb/scopes/XSC/**) in sola lettura fuori da XSC;
//  - weekly-digest: lettura di customers/*/{lessons,decisions,outcomes,observations,kb}.
import { intersects, subset, PathPolicyError } from "../paths.mjs";
import { guarded, denyAudited, targetsOf, shellPaths, FILE_TOOLS, SEARCH_TOOLS, WRITE_TOOLS, READ_TOOLS, SHELL_TOOLS } from "./common.mjs";

const G = "guard-scope";
export const GOVERNED = [
  "customers/*/kb/scopes/**", "product/kb/scopes/**", "customers/*/_inbox/**", "customers/*/tests/**",
  "customers/*/kb/handoffs/**", "product/kb/handoffs/**",
];
export const WEEKLY_READ = ["lessons", "decisions", "outcomes", "observations", "kb"].map((d) => `customers/*/${d}/**`);
const SESSION_STATE = [".jvc/**", "customers/*/.sessions/*/session.json", "customers/*/.sessions/*/invocations.jsonl"];
const PLUGIN_RO = ["decision-tables/**", "strategies/**", "clusters/**"];

// Shell (solo sub-agenti, agent_id presente): i percorsi citati dal comando che
// cadono in una cella governata devono essere in allowed_paths. La sessione
// principale e gli script (`node scripts/…`) non citano celle altrui: non
// vengono toccati. Euristica (vedi shellPaths): complementa, non sostituisce,
// i guard sugli strumenti di file.
function checkShell(ctx) {
  const cmd = ctx.ti.command;
  if (!ctx.agentId || typeof cmd !== "string" || !cmd.trim()) return null;
  if (cmd.includes("\0")) throw new PathPolicyError("comando con byte NUL");
  const allowed = Array.isArray(ctx.session?.allowed_paths) ? ctx.session.allowed_paths : [];
  const variants = new Set([cmd, cmd.replace(/\\(?=[^\s\\/])/g, "")]);
  for (const v of variants) {
    for (const { rels } of shellPaths(ctx, v)) {
      for (const p of rels) {
        if (!GOVERNED.some((a) => intersects(p, a))) continue;
        if (ctx.agentType === "weekly-digest" && WEEKLY_READ.some((q) => subset(p, q))) continue;
        if (allowed.some((q) => subset(p, q))) continue;
        return denyAudited(ctx, G, `comando fuori cella (${ctx.session?.scope ? `${ctx.session.customer}×${ctx.session.scope}` : "nessuno scope attivo"}): ${p} non è in allowed_paths. Chiedi un handoff tramite il manager.`);
      }
    }
  }
  return null;
}

export const decide = guarded(G, (ctx) => {
  const { tool, session } = ctx;
  if (SHELL_TOOLS.has(tool)) return checkShell(ctx);
  if (!FILE_TOOLS.has(tool) && !SEARCH_TOOLS.has(tool)) return null;
  const T = targetsOf(ctx);
  const write = WRITE_TOOLS.has(tool);
  if (write) {
    for (const p of T.ws) {
      if (intersects(p, "product/**")) return denyAudited(ctx, G, `product/ è in sola lettura: si scrive solo con gli script dopo validazione (§29.6). Percorso: ${p}`);
      if (SESSION_STATE.some((a) => intersects(p, a))) return denyAudited(ctx, G, `lo stato di sessione si modifica solo con /use e con gli hook del plugin: ${p}`);
      if (session?.scope !== "XSC" && intersects(p, "customers/*/kb/scopes/xsc/**")) return denyAudited(ctx, G, `le INT possedute sono in sola lettura fuori dallo scope XSC: ${p}`);
    }
    for (const p of T.plugin) {
      if (PLUGIN_RO.some((a) => intersects(p, a))) return denyAudited(ctx, G, `tabelle di decisione, strategie e cluster del plugin non si modificano in sessione (T9): ${p}`);
    }
  }
  const allowed = Array.isArray(session?.allowed_paths) ? session.allowed_paths : [];
  const weekly = ctx.agentType === "weekly-digest" && READ_TOOLS.has(tool);
  for (const p of T.ws) {
    if (!GOVERNED.some((a) => intersects(p, a))) continue;
    if (weekly && WEEKLY_READ.some((q) => subset(p, q))) continue;
    if (allowed.some((q) => subset(p, q))) continue;
    const cell = session?.scope ? `cella ${session.customer}×${session.scope}` : "nessuno scope attivo (use scope <ID>)";
    return denyAudited(ctx, G, `fuori cella (${cell}): ${p} non è in allowed_paths. Se serve un altro scope, chiedi un handoff tramite il manager.`);
  }
  return null;
});

