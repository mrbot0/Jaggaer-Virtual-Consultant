// guard-budget (PreToolUse Agent|Task, FAIL-CLOSED) — §29.10, §42 M3.
//  - nessuna sessione con cliente ⇒ deny;
//  - prompt senza header agent-prompt (task_id, customer, scope, allowed_paths) ⇒ deny;
//  - header con cliente/scope diversi da session.json ⇒ deny (i guard usano il file);
//  - budget.used ≥ budget.tokens ⇒ deny; budget del compito > residuo ⇒ deny;
//  - used ≥ 80% ⇒ allow con updatedInput = input originale + model: haiku;
//  - ogni invocazione consentita è registrata in <sessione>/invocations.jsonl
//    (subagent-trace la chiude a consuntivo).
// Matcher Bash|PowerShell (fix round 1 #4, #8):
//  - un sub-agente (agent_id presente) non invoca session.mjs in nessuna forma
//    che possa cambiare lo stato: nome con glob, `node -e`/import(), verbo `use`,
//    o il session.mjs del plugin (qualunque percorso, anche dopo un cd) ⇒ deny.
//    Il budget non si alza da un agente, mai;
//  - sessione principale: `use scope` / `use customer` negati finché ci sono
//    sotto-compiti aperti (dispatch senza chiusura di subagent-trace).
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { allowWithInput } from "../io.mjs";
import { invocationsFile } from "../workspace.mjs";
import { skeleton } from "../paths.mjs";
import { openInvocations } from "../state-summary.mjs";
import { parsePromptHeader } from "../../../scripts/admin/agent-prompt.mjs";
import { guarded, denyAudited, sameFile, SHELL_TOOLS } from "./common.mjs";
import { checkRemaining, enforceClass } from "../../../scripts/decide/budget.mjs";

const G = "guard-budget";
const AGENT_TOOLS = new Set(["Agent", "Task"]);
export const HAIKU_THRESHOLD = 0.8;
const REQUIRED = ["task_id", "customer", "scope", "allowed_paths"];
const TARGET = "session.mjs";
const GLOB_CH = /[*?[\]{}]/;
const EVAL = /(^|\s)(-e|-p|--eval|--print|--import|-r|--require|--input-type|--loader|--experimental-loader)(\s|=|$)|\b(import|require)\s*\(/i;
const USE_VERB = /(^|\s)use(\s|$)/i;
// `use [--opzioni [valore]] scope|customer <X>` (i flag possono precedere il verbo).
const USE_SWITCH = /(?:^|\s)use(?:\s+--?\S+(?:\s+[^\s-]\S*)?)*\s+(scope|customer)(?:\s+([^\s-]\S*))?/i;
const CD = /^(cd|pushd|chdir|set-location|sl|push-location)$/i;
const esc = (c) => c.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

// Glob di shell → RegExp (su un solo segmento); pattern non traducibile ⇒ null.
function globRe(g) {
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") re += ".*";
    else if (c === "?") re += ".";
    else if (c === "[") {
      const j = g.indexOf("]", i + 2);
      if (j < 0) { re += "\\["; continue; }
      re += `[${g.slice(i + 1, j).replace(/^!/, "^").replace(/\\/g, "\\\\")}]`;
      i = j;
    } else if (c === "{") {
      const j = g.indexOf("}", i + 1);
      if (j < 0) { re += "\\{"; continue; }
      re += `(?:${g.slice(i + 1, j).split(",").map((a) => a.split("").map((x) => (x === "*" ? ".*" : x === "?" ? "." : esc(x))).join("")).join("|")})`;
      i = j;
    } else re += esc(c);
  }
  try { return new RegExp(`^${re}$`, "i"); } catch { return null; }
}

// Come il comando cita session.mjs: riferimenti letterali (percorsi), nomi con
// glob che possono espandersi in session.mjs, nomi non risolvibili (variabili).
export function sessionRefs(cmd) {
  const unq = cmd.replace(/["'`^]/g, "");
  const flat = skeleton(unq.replace(/\\(?=[^\s\\/])/g, "")).toLowerCase();
  const out = { literal: [], glob: false, opaque: false, flat };
  for (const piece of unq.split(/[\s(),;|&<>=]+/)) {
    if (!piece) continue;
    const base = skeleton(piece.split(/[\\/]/).pop()).toLowerCase();
    if (base.includes(TARGET)) out.literal.push(piece);
    else if (GLOB_CH.test(base)) { const re = globRe(base); if (!re || re.test(TARGET)) out.glob = true; }
    else if (/[$%]/.test(base) && /m?js/.test(base)) out.opaque = true;
  }
  if (!out.literal.length && flat.includes(TARGET)) out.opaque = true;
  return out;
}

// Cartelle da cui un percorso relativo del comando può essere risolto (cwd e ogni cd).
function candidateCwds(ctx, cmd) {
  let cwds = [ctx.cwd];
  for (const seg of cmd.replace(/["'`]/g, "").split(/&&|\|\||[;|\r\n]/)) {
    const w = seg.trim().split(/\s+/);
    if (!CD.test(w[0] ?? "")) continue;
    const arg = w.slice(1).find((x) => !x.startsWith("-"));
    if (arg) cwds = [...new Set([...cwds, ...cwds.map((d) => resolve(d, arg))])].slice(0, 16);
  }
  return cwds;
}

function checkSubAgentShell(ctx, cmd, refs) {
  const no = (why) => denyAudited(ctx, G, `un sub-agente non invoca session.mjs (${why}): cliente, scope, modalità e budget li cambia solo l'utente, con /use nella sessione principale (§29.10)`);
  if (refs.glob) return no("nome con caratteri jolly");
  if (refs.opaque) return no("riferimento non risolvibile");
  if (!refs.literal.length) return null;
  if (EVAL.test(refs.flat)) return no("esecuzione di codice con node -e/import()");
  if (USE_VERB.test(refs.flat)) return no("verbo use");
  const plugin = join(ctx.plugin, "scripts", "admin", TARGET);
  const cwds = candidateCwds(ctx, cmd);
  for (const ref of refs.literal) {
    if (/claude_plugin_root/i.test(ref)) return no("session.mjs del plugin");
    for (const d of cwds) if (sameFile(resolve(d, ref.replace(/\\/g, "/")), plugin)) return no("session.mjs del plugin");
  }
  return null;
}

// Sessione principale: niente cambio di cliente o scope con sotto-compiti aperti (#8).
function checkMainShell(ctx, refs) {
  const m = USE_SWITCH.exec(refs.flat);
  if (!m || !ctx.session) return null;
  const [, what, value] = m;
  if (what.toLowerCase() === "scope" && value && value.toUpperCase() === ctx.session.scope) return null;
  if (what.toLowerCase() === "customer" && value && value.toUpperCase() === ctx.session.customer) return null;
  const open = openInvocations(invocationsFile(ctx.ws, ctx.session.customer, ctx.sid), ctx.session.ledger).map((i) => i.task_id ?? `#${i.seq}`);
  if (!open.length) return null;
  return denyAudited(ctx, G, `${open.length} sotto-compiti aperti (${open.join(", ")}): attendi la chiusura dei sotto-compiti aperti prima di cambiare ${what.toLowerCase() === "scope" ? "scope" : "cliente"} (i sub-agenti in corso lavorano sulla cella attuale)`);
}

function checkShell(ctx) {
  const cmd = ctx.ti.command;
  if (typeof cmd !== "string" || !cmd.trim()) return null;
  const refs = sessionRefs(cmd);
  if (!refs.literal.length && !refs.glob && !refs.opaque) return null;
  return ctx.agentId ? checkSubAgentShell(ctx, cmd, refs) : checkMainShell(ctx, refs);
}

export const decide = guarded(G, (ctx) => {
  if (SHELL_TOOLS.has(ctx.tool)) return checkShell(ctx);
  if (!AGENT_TOOLS.has(ctx.tool)) return null;
  const { session, ti } = ctx;
  if (!session) return denyAudited(ctx, G, "nessuna sessione con cliente attivo: esegui /jaggaer-virtual-consultant:use customer <ID> prima di invocare sub-agenti");
  const h = parsePromptHeader(ti.prompt);
  if (!h) return denyAudited(ctx, G, "prompt senza header agent-prompt (§46.1): servono task_id, customer, scope, allowed_paths — componi il prompt da templates/agent-prompt.md");
  const missing = REQUIRED.filter((k) => h[k] == null || h[k] === "" || (k === "allowed_paths" && !Array.isArray(h[k])));
  if (missing.length) return denyAudited(ctx, G, `header agent-prompt incompleto: mancano ${missing.join(", ")}`);
  if (String(h.customer) !== session.customer) return denyAudited(ctx, G, `il prompt è per il cliente ${h.customer} ma la sessione è sul cliente ${session.customer}`);
  if (String(h.scope) !== session.scope) return denyAudited(ctx, G, `scope del prompt ${h.scope} ≠ scope di sessione ${session.scope ?? "—"}: esegui use scope ${h.scope} prima del dispatch (i guard leggono session.json)`);
  const { tokens, used } = session.budget;
  if (used >= tokens) return denyAudited(ctx, G, `budget di sessione esaurito (${used}/${tokens}): nessuna nuova invocazione; chiudi con report e pendenze. Solo l'utente può alzarlo con /jaggaer-virtual-consultant:use budget <n>`);
  const taskBudget = h.budget?.tokens;
  if (taskBudget != null && !(Number.isInteger(taskBudget) && taskBudget > 0)) return denyAudited(ctx, G, `budget del compito non valido: ${JSON.stringify(taskBudget)}`);
  // K6.7 (debito di WP03): le invocazioni aperte PRENOTANO il loro budget — due compiti paralleli da 40k
  // con 50k di residuo: il secondo è negato.
  const open = openInvocations(invocationsFile(ctx.ws, session.customer, session.session_id), session.ledger);
  const rem = checkRemaining(session, taskBudget ?? undefined, { open });
  if (taskBudget != null && !rem.ok) return denyAudited(ctx, G, `${rem.reason}: ridisegna il compito (meno passi, più STR-REPLAY) o chiedi all'utente di alzare il budget`);
  // K6.7: per classe di azione (§29.10) — il budget del compito non supera quello delle classi dichiarate nell'header.
  const cls = enforceClass({ action_class: h.action_class, actions: h.actions, level: h.level, budget_tokens: taskBudget }, session.env);
  if (!cls.ok) return denyAudited(ctx, G, `budget per classe: ${cls.reason}`);
  const downgrade = used >= HAIKU_THRESHOLD * tokens;
  const model = downgrade ? "haiku" : ti.model ?? null;
  const file = invocationsFile(ctx.ws, session.customer, session.session_id);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify({
    ts: new Date().toISOString(), task_id: String(h.task_id), subagent_type: ti.subagent_type ?? null,
    model_requested: ti.model ?? null, model, budget_tokens: taskBudget ?? null, scope: h.scope, parent_agent_id: ctx.agentId,
  })}\n`);
  if (downgrade) {
    return allowWithInput(`[${G}] budget di sessione ≥ 80% (${used}/${tokens}): tier forzato a haiku; chiedi all'utente se continuare (§29.10)`, { ...ti, model: "haiku" });
  }
  return null;
});
