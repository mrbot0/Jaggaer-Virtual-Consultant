// guard-scope (FAIL-CLOSED): cella dello scope (§1.2, §31.4, §32).
//  - percorsi governati (celle kb, handoff, _inbox, tests) ⇒ solo se in
//    session.allowed_paths; altrimenti deny con suggerimento di handoff;
//  - handoff nominati per codice: Read consentita se lo YAML dichiara lo scope
//    attivo in from_scope / to_scope / scopes[] (file ≤ 64 KB; YAML rotto ⇒ deny);
//  - scrittura negata a tutti su product/**, customers/*/kb/** (§29.6: solo gli
//    script scrivono la conoscenza), audit, blackboard, stato di sessione,
//    session.json ovunque, e su decision-tables/ strategies/ clusters/ del plugin (T9);
//  - weekly-digest: lettura di customers/*/{lessons,decisions,outcomes,observations,kb};
//  - WP10b: lettura trasversale di session.cross_read[<tipo>] (process-mapper, weekly-digest) solo per
//    quel tipo, solo Read/Glob/Grep, fino alla scadenza (crossReadPaths);
//  - Bash/PowerShell dei sub-agenti: ogni token-percorso (anche senza '/', anche
//    dopo un cd) il cui sottoalbero tocca una cella governata deve stare dentro
//    allowed_paths (niente `grep -r` su un antenato della cella);
//  - percorsi assoluti fuori dal workspace: valutati sui suffissi customers/… product/…;
//  - scritture via shell (redirezioni, tee, Out-File/Set-Content, cp/mv, rm…):
//    sub-agenti ⇒ tutte le aree di WRITE_DENY; sessione principale ⇒ stato di
//    sessione (session.json, invocations.jsonl, .jvc/**) — fix round 2 F5 — e
//    product/**, customers/*/kb/** come per Write (revisione finale).
import { statSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { intersects, subset, resolveTarget, PathPolicyError } from "../paths.mjs";
import { pluginAgentType } from "../workspace.mjs";
import { guarded, denyAudited, targetsOf, allRels, shellPaths, shellWriteTargets, subtree, PATH_TOOLS, WRITE_TOOLS, READ_TOOLS, SHELL_TOOLS } from "./common.mjs";

const G = "guard-scope";
export const GOVERNED = [
  "customers/*/kb/scopes/**", "product/kb/scopes/**", "customers/*/_inbox/**", "customers/*/tests/**",
  "customers/*/kb/handoffs/**", "product/kb/handoffs/**",
];
export const WEEKLY_READ = ["lessons", "decisions", "outcomes", "observations", "kb"].map((d) => `customers/*/${d}/**`);

// 28/10/2026 (decisione dell'utente: «gli agenti devono poter esplorare e imparare senza limiti»): niente celle di scope
//  - in esplorazione, per tutta la conoscenza del cliente attivo (tutti gli scope: l'esplorazione li attraversa);
//  - per gli agenti di manutenzione (workspace-manager, health-keeper), su tutto il workspace.
// L'isolamento fra clienti resta (guard-customer) e le aree protette sopra (WRITE_DENY) valgono come prima.
export const KEEPER_AGENTS = new Set(["workspace-manager", "health-keeper"]);
function freeCell(ctx, p) {
  // agenti di manutenzione: il cliente attivo e product/ (senza cliente attivo: tutto il workspace, per generarlo)
  if (KEEPER_AGENTS.has(pluginAgentType(ctx.input?.agent_type))) return !ctx.customerLc || p === `customers/${ctx.customerLc}` || p.startsWith(`customers/${ctx.customerLc}/`) || p === "product" || p.startsWith("product/");
  return ctx.session?.mode === "esplorazione" && !!ctx.customerLc && (p === `customers/${ctx.customerLc}` || p.startsWith(`customers/${ctx.customerLc}/`));
}

// WP10b (ruling del controller 2): lettura trasversale concessa dalla sessione principale in session.cross_read
// (`session.mjs use paths --agent <tipo> --grant`, tolta con --restore). Vale solo per il tipo di agente nominato,
// solo per Read/Glob/Grep, fino a expires_at; mai analysis/; per process-mapper mai altri clienti (anche se il
// file dicesse altro: difesa in profondità, session.json è comunque protetto in scrittura).
export const CROSS_READ_AGENTS = ["process-mapper", "weekly-digest"];
const ANALYSIS_SEG = /(^|\/)analysis(\/|$)/i;
export function crossReadPaths(ctx) {
  // giro 1 (minore 3): solo il tipo del plugin (senza prefisso o "jaggaer-virtual-consultant:"), non un omonimo
  const t = pluginAgentType(ctx.input?.agent_type);
  if (!t || t !== ctx.agentType || !CROSS_READ_AGENTS.includes(t) || !READ_TOOLS.has(ctx.tool)) return [];
  const g = ctx.session?.cross_read?.[t];
  if (!g || typeof g !== "object" || g.mode !== "read" || !Array.isArray(g.allowed_paths)) return [];
  if (!(Date.parse(g.expires_at) > Date.now())) return [];
  const own = ctx.customerLc ? `customers/${ctx.customerLc}/**` : null;
  return g.allowed_paths.filter((q) => typeof q === "string" && q && !ANALYSIS_SEG.test(q)
    && (t === "weekly-digest" || !intersects(q, "customers/**") || (own && subset(q, own))));
}
const SETTINGS_WHY = "le impostazioni di Claude Code (.claude/**, .mcp.json) le modifica solo l'utente, a mano, fuori sessione: possono spegnere i guard del plugin";
const WRITE_DENY = [
  ["product/**", "product/ è in sola lettura: si scrive solo con gli script dopo validazione (§29.6)"],
  ["customers/*/kb/**", "kb/ si scrive solo con gli script dopo validazione, mai con gli strumenti (§29.6)"],
  ["customers/*/audit/**", "l'audit è append-only e lo scrive solo l'hook audit-append (T8)"],
  ["customers/*/.sessions/**/blackboard/**", "il blackboard lo scrive solo l'hook subagent-trace"],
  ["customers/*/.sessions/*/invocations.jsonl", "le invocazioni le registra solo guard-budget"],
  ["customers/*/.sessions/*/approvals.jsonl", "il registro delle approvazioni lo scrive solo l'hook approval-capture (K5, §52.2)"],
  ["customers/*/.sessions/*/compact-summary.md", "il riassunto lo scrive solo precompact-save"],
  // WP10d: registro di controllo dell'utente e file del monitor degli agenti (li scrivono solo hook e script del plugin)
  ["customers/*/.sessions/*/control.jsonl", "il registro di controllo degli agenti lo scrive solo approval-capture, dalle frasi dell'utente"],
  ["customers/*/.sessions/*/agents/**", "lo stato degli agenti (legame, chiamate) lo scrive solo guard-control"],
  ["customers/*/.sessions/*/control-scan.json", "l'offset di scansione del transcript lo scrivono solo gli hook del plugin (conferma dei controlli dell'utente)"],
  ["customers/*/.sessions/*/workflow.jsonl", "il workflow lo scrive solo workflow.mjs (script del plugin)"],
  ["customers/*/.sessions/*/observations.jsonl", "le osservazioni le registra solo l'hook observe-append"],
  ["customers/*/.sessions/*/atlas/**", "il registro dell'esplorazione lo scrive solo l'hook observe-append (soluzione A)"],
  ["customers/*/.sessions/*/snapshots/**", "gli snapshot su file li scrive solo lo strumento del browser (take_snapshot con filePath): observe-append li legge come letture della pagina"],
  ["customers/*/.sessions/*/manager-usage.json", "l'uso di token del manager lo registra solo l'hook stop-integrity"],
  [".jvc/**", "lo stato di sessione si modifica solo con /use e con gli hook del plugin"],
  ["**/session.json", "session.json si modifica solo con /use e con gli hook del plugin"],
  // K5 giro 2: le impostazioni di progetto possono spegnere i guard (env JVC_WORKSPACE, hook, agenti, server MCP)
  [".claude/**", SETTINGS_WHY],
  [".mcp.json", SETTINGS_WHY],
];
// Impostazioni di Claude Code fuori dal workspace (es. ~/.claude/settings.json): negate ovunque.
const CLAUDE_SETTINGS_ABS = /(^|\/)\.claude\/(settings[^/]*\.json|hooks|agents|commands|skills)(\/|$)/;
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
// scrive con node, mai con una redirezione della shell) e — revisione finale —
// anche product/** e customers/*/kb/**, come per lo strumento Write: la
// conoscenza la scrivono solo gli script del plugin dopo validazione (§29.6) e
// la promozione a S vuole APPROVO PROMOZIONE (T9, §22.2). Gli script del plugin
// (node <plugin>/scripts/…) non sono bersagli di scrittura della shell.
const MAIN_SHELL_DENY = WRITE_DENY.filter(([a]) => ["product/**", "customers/*/kb/**", ".jvc/**", "**/session.json", "customers/*/.sessions/*/invocations.jsonl", "customers/*/.sessions/*/approvals.jsonl", ".claude/**", ".mcp.json",
  "customers/*/.sessions/*/control.jsonl", "customers/*/.sessions/*/control-scan.json", "customers/*/.sessions/*/agents/**", "customers/*/.sessions/*/workflow.jsonl", "customers/*/.sessions/*/observations.jsonl", "customers/*/.sessions/*/atlas/**", "customers/*/.sessions/*/snapshots/**", "customers/*/.sessions/*/manager-usage.json", "customers/*/audit/**", "customers/*/.sessions/**/blackboard/**"].includes(a));
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
      for (const a of T.abs) if (CLAUDE_SETTINGS_ABS.test(a) || (tree && /(^|\/)\.claude$/.test(a))) return denyAudited(ctx, G, `scrittura via shell negata — ${SETTINGS_WHY}: ${a}`);
    }
  }
  return null;
}

// Correzione mirata finale: le opzioni di uscita (--out, --out-dir, --output) di qualunque comando, script del plugin
// compresi (i parser scrivono il documento normalizzato dove dice --out), non puntano nella conoscenza: product/** e
// customers/*/kb/** si scrivono solo con gli script che validano (ingest, promote, reindex) nelle loro cartelle.
const OUT_OPT = /(?:^|\s)--(?:out|out-dir|output)(?:=|\s+)("[^"]*"|'[^']*'|[^\s;&|]+)/g;
const KB_AREAS = ["product/**", "customers/*/kb/**"];
function outRefusal(ctx, cmd) {
  for (const m of cmd.matchAll(OUT_OPT)) {
    const tok = m[1].replace(/^["']|["']$/g, "");
    let T;
    try { T = resolveTarget(tok, { cwd: ctx.cwd, ws: ctx.ws }); } catch (err) { if (err instanceof PathPolicyError) continue; throw err; }
    for (const p of allRels(T)) for (const a of KB_AREAS) if (intersects(p, a)) return denyAudited(ctx, G, `uscita di uno script (${m[0].trim().split(/[=\s]/)[0]}) nella conoscenza — la scrivono solo gli script del plugin dopo validazione, nelle loro cartelle (§29.6): ${p}`);
  }
  return null;
}

function checkShell(ctx) {
  const cmd = ctx.ti.command;
  if (typeof cmd !== "string" || !cmd.trim()) return null;
  if (cmd.includes("\0")) throw new PathPolicyError("comando con byte NUL");
  const o = outRefusal(ctx, cmd);
  if (o) return o;
  const w = checkShellWrites(ctx, cmd);
  if (w || !ctx.agentId) return w;
  const allowed = Array.isArray(ctx.session?.allowed_paths) ? ctx.session.allowed_paths : [];
  const weekly = ctx.agentType === "weekly-digest";
  for (const v of new Set([cmd, cmd.replace(/\\(?=[^\s\\/])/g, "")])) {
    for (const { rels, cd } of shellPaths(ctx, v, { bareWords: true })) {
      for (const p of rels) {
        const sp = subtree(p);
        if (!GOVERNED.some((a) => intersects(sp, a))) continue;
        if (freeCell(ctx, sp)) continue;
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
    for (const a of T.abs) if (CLAUDE_SETTINGS_ABS.test(a)) return denyAudited(ctx, G, `${SETTINGS_WHY}: ${a}`);
    for (const p of T.plugin) {
      if (PLUGIN_RO.some((a) => intersects(p, a))) return denyAudited(ctx, G, `tabelle di decisione, strategie e cluster del plugin non si modificano in sessione (T9): ${p}`);
    }
  }
  const allowed = Array.isArray(session?.allowed_paths) ? session.allowed_paths : [];
  const weekly = ctx.agentType === "weekly-digest" && READ_TOOLS.has(tool);
  const cross = crossReadPaths(ctx);
  const handoffAreas = ctx.customerLc ? [`customers/${ctx.customerLc}/kb/handoffs/**`, "product/kb/handoffs/**"] : ["product/kb/handoffs/**"];
  let handoff;
  for (const p of rels) {
    if (!GOVERNED.some((a) => intersects(p, a))) continue;
    if (freeCell(ctx, p)) continue;
    if (weekly && WEEKLY_READ.some((q) => subset(p, q))) continue;
    if (allowed.some((q) => subset(p, q))) continue;
    if (cross.some((q) => subset(p, q))) continue;
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
