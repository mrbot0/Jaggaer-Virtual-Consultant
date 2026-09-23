// guard-scope (FAIL-CLOSED): cella dello scope (§1.2, §31.4, §32).
//  - percorsi governati (celle kb, handoff, _inbox, tests) ⇒ solo se in
//    session.allowed_paths; altrimenti deny con suggerimento di handoff;
//  - handoff nominati per codice: Read consentita se lo YAML dichiara lo scope
//    attivo in from_scope / to_scope / scopes[] (file ≤ 64 KB; YAML rotto ⇒ deny);
//  - scrittura negata a tutti su product/**, customers/*/kb/** (§29.6: solo gli
//    script scrivono la conoscenza), audit, blackboard, stato di sessione,
//    session.json ovunque, e su decision-tables/ strategies/ clusters/ del plugin (T9);
//  - weekly-digest: lettura di customers/*/{lessons,decisions,outcomes,observations,kb};
//  - Bash/PowerShell dei sub-agenti: ogni token-percorso (anche senza '/', anche
//    dopo un cd) il cui sottoalbero tocca una cella governata deve stare dentro
//    allowed_paths (niente `grep -r` su un antenato della cella);
//  - percorsi assoluti fuori dal workspace: valutati sui suffissi customers/… product/…;
//  - scritture via shell (redirezioni, tee, Out-File/Set-Content, cp/mv, rm…):
//    sub-agenti ⇒ tutte le aree di WRITE_DENY; sessione principale ⇒ stato di
//    sessione (session.json, invocations.jsonl, .jvc/**) — fix round 2 F5.
import { statSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { intersects, subset, resolveTarget, PathPolicyError } from "../paths.mjs";
import { guarded, denyAudited, targetsOf, allRels, shellPaths, shellWriteTargets, subtree, PATH_TOOLS, WRITE_TOOLS, READ_TOOLS, SHELL_TOOLS } from "./common.mjs";

const G = "guard-scope";
export const GOVERNED = [
  "customers/*/kb/scopes/**", "product/kb/scopes/**", "customers/*/_inbox/**", "customers/*/tests/**",
  "customers/*/kb/handoffs/**", "product/kb/handoffs/**",
];
export const WEEKLY_READ = ["lessons", "decisions", "outcomes", "observations", "kb"].map((d) => `customers/*/${d}/**`);
const WRITE_DENY = [
  ["product/**", "product/ è in sola lettura: si scrive solo con gli script dopo validazione (§29.6)"],
  ["customers/*/kb/**", "kb/ si scrive solo con gli script dopo validazione, mai con gli strumenti (§29.6)"],
  ["customers/*/audit/**", "l'audit è append-only e lo scrive solo l'hook audit-append (T8)"],
  ["customers/*/.sessions/**/blackboard/**", "il blackboard lo scrive solo l'hook subagent-trace"],
  ["customers/*/.sessions/*/invocations.jsonl", "le invocazioni le registra solo guard-budget"],
  ["customers/*/.sessions/*/compact-summary.md", "il riassunto lo scrive solo precompact-save"],
  [".jvc/**", "lo stato di sessione si modifica solo con /use e con gli hook del plugin"],
  ["**/session.json", "session.json si modifica solo con /use e con gli hook del plugin"],
];
const PLUGIN_RO = ["decision-tables/**", "strategies/**", "clusters/**"];
const HANDOFF_MAX = 64 * 1024;
const require = createRequire(import.meta.url);

// Lo handoff che Read aprirà dichiara lo scope attivo? null = sì, altrimenti il motivo.
function handoffRefusal(ctx) {
  const scope = ctx.session?.scope;
  if (!scope) return "nessuno scope attivo";
  const f = resolve(ctx.cwd, String(ctx.ti.file_path));
  let st;
  try { st = statSync(f); } catch { return "handoff inesistente"; }
  if (!st.isFile()) return "lo handoff non è un file";
  if (st.size > HANDOFF_MAX) return `handoff oltre ${HANDOFF_MAX / 1024} KB`;
  let doc;
  try { doc = require("yaml").parse(readFileSync(f, "utf8")); } catch { return "handoff con YAML non valido"; }
  const declared = [doc?.from_scope, doc?.to_scope, ...(Array.isArray(doc?.scopes) ? doc.scopes : [])]
    .filter((x) => typeof x === "string").map((x) => x.toUpperCase());
  return declared.includes(scope) ? null : `lo handoff non dichiara lo scope ${scope} in from_scope, to_scope o scopes`;
}

// Scritture via shell (fix round 2 F5): per i sub-agenti valgono tutte le aree
// di WRITE_DENY; per la sessione principale lo stato di sessione (la CLI lo
// scrive con node, mai con una redirezione della shell).
const MAIN_SHELL_DENY = WRITE_DENY.filter(([a]) => [".jvc/**", "**/session.json", "customers/*/.sessions/*/invocations.jsonl"].includes(a));
// Bersagli-cartella (rm/mv di una cartella, cp/mv dentro una cartella — fix
// round 3): conta tutto ciò che la cartella contiene, cioè ogni antenato di un
// file protetto è protetto. `**/session.json` qui diventa il session.json reale
// (customers/*/.sessions/*/session.json): altrimenti ogni cartella del
// workspace risulterebbe "antenata" di un session.json ipotetico.
const TREE_ONLY = (areas) => areas.map(([a, why]) => [a === "**/session.json" ? "customers/*/.sessions/*/session.json" : a, why]);
const SUB_TREE_DENY = TREE_ONLY(WRITE_DENY);
const MAIN_TREE_DENY = TREE_ONLY(MAIN_SHELL_DENY);
function checkShellWrites(ctx, cmd) {
  const areas = ctx.agentId ? WRITE_DENY : MAIN_SHELL_DENY;
  const treeAreas = ctx.agentId ? SUB_TREE_DENY : MAIN_TREE_DENY;
  const no = (why, p) => denyAudited(ctx, G, `scrittura via shell negata (file che scrivono solo /use, gli script e gli hook del plugin) — ${why}: ${p}`);
  for (const { tok, cwds, tree, soft } of shellWriteTargets(ctx, cmd)) {
    for (const cwd of cwds) {
      // `soft`: candidato estratto da testo di script (round 4) — se non è un percorso risolvibile non è un bersaglio.
      let T;
      try { T = resolveTarget(tok, { cwd, ws: ctx.ws }); } catch (err) { if (soft && err instanceof PathPolicyError) continue; throw err; }
      for (const p of allRels(T)) {
        for (const [area, why] of areas) if (intersects(p, area)) return no(why, p);
        if (tree) for (const [area, why] of treeAreas) if (intersects(subtree(p), area)) return no(`${why} (la cartella lo contiene)`, p || ".");
      }
      for (const a of T.abs) if (/(^|\/)session\.json$/.test(a)) return denyAudited(ctx, G, `scrittura via shell negata — session.json si modifica solo con /use e con gli hook del plugin: ${a}`);
    }
  }
  return null;
}

function checkShell(ctx) {
  const cmd = ctx.ti.command;
  if (typeof cmd !== "string" || !cmd.trim()) return null;
  if (cmd.includes("\0")) throw new PathPolicyError("comando con byte NUL");
  const w = checkShellWrites(ctx, cmd);
  if (w || !ctx.agentId) return w;
  const allowed = Array.isArray(ctx.session?.allowed_paths) ? ctx.session.allowed_paths : [];
  const weekly = ctx.agentType === "weekly-digest";
  for (const v of new Set([cmd, cmd.replace(/\\(?=[^\s\\/])/g, "")])) {
    for (const { rels, cd } of shellPaths(ctx, v, { bareWords: true })) {
      for (const p of rels) {
        const sp = subtree(p);
        if (!GOVERNED.some((a) => intersects(sp, a))) continue;
        if (weekly && WEEKLY_READ.some((q) => subset(sp, q))) continue;
        if (allowed.some((q) => subset(sp, q))) continue;
        const cell = ctx.session?.scope ? `${ctx.session.customer}×${ctx.session.scope}` : "nessuno scope attivo";
        return denyAudited(ctx, G, `comando fuori cella (${cell}): ${cd ? "cd verso " : ""}${p || "."} copre percorsi non in allowed_paths. Chiedi un handoff tramite il manager.`);
      }
    }
  }
  return null;
}

export const decide = guarded(G, (ctx) => {
  const { tool, session } = ctx;
  if (SHELL_TOOLS.has(tool)) return checkShell(ctx);
  const T = targetsOf(ctx);
  const rels = allRels(T);
  if (WRITE_TOOLS.has(tool)) {
    for (const p of rels) {
      for (const [area, why] of WRITE_DENY) if (intersects(p, area)) return denyAudited(ctx, G, `${why}: ${p}`);
    }
    for (const a of T.abs) if (/(^|\/)session\.json$/.test(a)) return denyAudited(ctx, G, `session.json si modifica solo con /use e con gli hook del plugin: ${a}`);
    for (const p of T.plugin) {
      if (PLUGIN_RO.some((a) => intersects(p, a))) return denyAudited(ctx, G, `tabelle di decisione, strategie e cluster del plugin non si modificano in sessione (T9): ${p}`);
    }
  }
  const allowed = Array.isArray(session?.allowed_paths) ? session.allowed_paths : [];
  const weekly = ctx.agentType === "weekly-digest" && READ_TOOLS.has(tool);
  const handoffAreas = ctx.customerLc ? [`customers/${ctx.customerLc}/kb/handoffs/**`, "product/kb/handoffs/**"] : ["product/kb/handoffs/**"];
  let handoff;
  for (const p of rels) {
    if (!GOVERNED.some((a) => intersects(p, a))) continue;
    if (weekly && WEEKLY_READ.some((q) => subset(p, q))) continue;
    if (allowed.some((q) => subset(p, q))) continue;
    if (tool === "Read" && handoffAreas.some((q) => subset(p, q))) {
      handoff ??= { why: handoffRefusal(ctx) };
      if (!handoff.why) continue;
      return denyAudited(ctx, G, `${handoff.why}: ${p}`);
    }
    const cell = session?.scope ? `cella ${session.customer}×${session.scope}` : "nessuno scope attivo (use scope <ID>)";
    return denyAudited(ctx, G, `fuori cella (${cell}): ${p} non è in allowed_paths. Se serve un altro scope, chiedi un handoff tramite il manager.`);
  }
  return null;
}, { tools: new Set([...PATH_TOOLS, ...SHELL_TOOLS]) });
