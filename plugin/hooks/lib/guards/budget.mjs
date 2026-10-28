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
import { invocationsFile, pluginAgentType } from "../workspace.mjs";
import { KEEPER_AGENTS } from "./scope.mjs";
import { skeleton } from "../paths.mjs";
import { openInvocations } from "../state-summary.mjs";
import { parsePromptHeader } from "../../../scripts/admin/agent-prompt.mjs";
import { guarded, denyAudited, sameFile, SHELL_TOOLS } from "./common.mjs";
import { checkRemaining, enforceClass, estimateTask } from "../../../scripts/decide/budget.mjs";
import { withFileLock } from "../fsx.mjs";
import { planFilePath } from "../../../scripts/admin/approvals.mjs";
import YAML from "yaml";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { redact } from "../redact.mjs";
import { dispatchRefusal, tierRefusal, tierOf, tierInfo, taskKeyOf } from "./orchestration.mjs";
import { readJsonl } from "../state-summary.mjs";

// Il file del piano attivo (relativo alla cartella del cliente) → oggetto | null.
function readPlan(ctx, rel) {
  const f = planFilePath(ctx.ws, ctx.session.customer, rel);
  if (!f) return null;
  // WP07 giro 2 (N-2): con l'impronta del testo, confrontata con active_plan.plan_sha256 come negli altri guard
  try { const t = readFileSync(f, "utf8"); const plan = t.trimStart().startsWith("{") ? JSON.parse(t) : YAML.parse(t); return { plan, sha256: createHash("sha256").update(t).digest("hex") }; } catch { return null; }
}

const G = "guard-budget";
const AGENT_TOOLS = new Set(["Agent", "Task"]);

// WP10d: tier e compito del dispatch, regole di orchestrazione (hooks/lib/guards/orchestration.mjs).
export { TIER_RANK, tierOf, taskKeyOf } from "./orchestration.mjs";
const cut = (s, n) => (typeof s === "string" && s.length > n ? `${s.slice(0, n - 1)}…` : s);
export function headerSummary(h, ti) {
  const red = (s) => redact(String(s));
  return {
    // WP10d giro 1 (I2): tier effettivo (modello che gira), più l'etichetta dell'header e il tier del modello richiesto
    tier: tierOf(h, ti), tier_declared: tierInfo(h, ti).declared, model_tier: tierInfo(h, ti).model, task_key: taskKeyOf(h), kind: typeof h.kind === "string" ? h.kind : "task", reply_to: h.reply_to != null ? String(h.reply_to) : null,
    mode: h.mode ?? null, depth: h.depth ?? null, minutes: typeof h.budget?.minutes === "number" ? h.budget.minutes : null,
    task: h.task != null ? cut(red(h.task), 200) : null, allowed_paths: (Array.isArray(h.allowed_paths) ? h.allowed_paths : []).slice(0, 30).map((p) => cut(String(p), 160)),
    expected_output: h.expected_output != null ? cut(red(JSON.stringify(h.expected_output)), 300) : null,
    contract: h.contract != null ? String(h.contract) : null,
  };
}
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
  // 28/10/2026: gli agenti di manutenzione generano il workspace (use customer --new, use env, show); il budget resta
  // solo dell'utente
  if (KEEPER_AGENTS.has(pluginAgentType(ctx.input?.agent_type))) return /\buse\s+budget\b|\bbudget\b/i.test(refs.flat) ? no("il budget lo alza solo l'utente") : null;
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
  // 28/10/2026 (decisione dell'utente): gli agenti di manutenzione del workspace e della KB (workspace-manager,
  // health-keeper) partono anche senza cliente attivo né header del dispatch: generano e riparano il workspace
  if (KEEPER_AGENTS.has(pluginAgentType(ti?.subagent_type))) return null;
  if (!session) return denyAudited(ctx, G, "nessuna sessione con cliente attivo: esegui /jaggaer-virtual-consultant:use customer <ID> prima di invocare sub-agenti");
  const h = parsePromptHeader(ti.prompt);
  if (!h) return denyAudited(ctx, G, "prompt senza header agent-prompt (§46.1): servono task_id, customer, scope, allowed_paths — componi il prompt da templates/agent-prompt.md");
  const missing = REQUIRED.filter((k) => h[k] == null || h[k] === "" || (k === "allowed_paths" && !Array.isArray(h[k])));
  if (missing.length) return denyAudited(ctx, G, `header agent-prompt incompleto: mancano ${missing.join(", ")}`);
  if (String(h.customer) !== session.customer) return denyAudited(ctx, G, `il prompt è per il cliente ${h.customer} ma la sessione è sul cliente ${session.customer}`);
  // 28/10/2026: in esplorazione un dispatch può lavorare su uno scope diverso da quello di sessione (l'esplorazione li attraversa)
  if (String(h.scope) !== session.scope && session.mode !== "esplorazione") return denyAudited(ctx, G, `scope del prompt ${h.scope} ≠ scope di sessione ${session.scope ?? "—"}: esegui use scope ${h.scope} prima del dispatch (i guard leggono session.json)`);
  // WP10d (D2, D8): regole di orchestrazione applicate dal codice — sub-agente che invoca Agent, controllo
  // dell'utente (pausa/stop), vigilanza cognitiva per scope, handoff via agent-manager con contratto HND
  const orch = dispatchRefusal(ctx, h);
  if (orch) return denyAudited(ctx, G, orch);
  const { tokens, used } = session.budget;
  if (used >= tokens) return denyAudited(ctx, G, `budget di sessione esaurito (${used}/${tokens}): nessuna nuova invocazione; chiudi con report e pendenze. Solo l'utente può alzarlo con /jaggaer-virtual-consultant:use budget <n>`);
  const taskBudget = h.budget?.tokens;
  if (taskBudget != null && !(Number.isInteger(taskBudget) && taskBudget > 0)) return denyAudited(ctx, G, `budget del compito non valido: ${JSON.stringify(taskBudget)}`);
  // WP07 giro 1 (budget rigidi, spec I7 e revisione di sicurezza):
  //  - le classi d'azione vengono dal piano ATTIVO (validato da step-check) quando c'è, non dall'header;
  //  - senza budget.tokens vale il limite delle classi, che si prenota; senza budget e senza classi ⇒ deny;
  //  - lettura delle invocazioni aperte, verifica del residuo e registrazione sotto lo stesso lock (niente
  //    doppia prenotazione con dispatch paralleli).
  let classes = [...new Set([...(h.action_class ? [h.action_class] : []), ...(Array.isArray(h.actions) ? h.actions : [])])];
  let limit = null;
  let source = "header";
  const ap = session.active_plan;
  if (ap) {
    const info = readPlan(ctx, ap.file);
    const plan = info?.plan;
    if (!plan || plan.plan_id !== ap.plan_id) return denyAudited(ctx, G, `piano attivo ${ap.plan_id} illeggibile: le classi d'azione del compito non si possono verificare`);
    if (typeof ap.plan_sha256 !== "string" || ap.plan_sha256 !== info.sha256) return denyAudited(ctx, G, `il piano ${ap.plan_id} è stato modificato dopo l'attivazione (impronta diversa): le sue classi d'azione non valgono per il budget; riattivalo con step-check`);
    classes = [...new Set((plan.steps ?? []).map((x) => x?.action_class).filter(Boolean))];
    limit = estimateTask(plan, session.env).tokens;
    source = "piano";
  }
  if (!classes.length && taskBudget == null) return denyAudited(ctx, G, "budget del compito non dichiarato e nessuna classe d'azione (header action_class/actions o piano attivo): il budget si deduce dalla classe (§29.10)");
  if (classes.length && limit == null) {
    const c = enforceClass({ actions: classes, level: h.level }, session.env);
    if (!c.ok) return denyAudited(ctx, G, `budget per classe: ${c.reason}`);
    limit = c.limit;
    source = "classe";
  }
  if (taskBudget != null && limit != null && taskBudget > limit) return denyAudited(ctx, G, `budget per classe: budget ${taskBudget} oltre il limite di ${classes.join(" + ")} dal ${source === "piano" ? "piano attivo" : "catalogo"}: ${limit} (§29.10: si ridisegna il compito, non si finanzia)`);
  const effective = taskBudget ?? limit;
  const downgrade = used >= HAIKU_THRESHOLD * tokens;
  const model = downgrade ? "haiku" : ti.model ?? null;
  const file = invocationsFile(ctx.ws, session.customer, session.session_id);
  mkdirSync(dirname(file), { recursive: true });
  const refused = withFileLock(`${file}.lock`, () => {
    // WP10d (D2): una sola escalation di tier per compito, sotto lo stesso lock della registrazione
    const esc = tierRefusal(readJsonl(file), h, ti);
    if (esc) return { raw: esc };
    const open = openInvocations(file, session.ledger);
    const rem = checkRemaining(session, effective, { open });
    if (!rem.ok) return rem.reason;
    appendFileSync(file, `${JSON.stringify({
      ts: new Date().toISOString(), task_id: String(h.task_id), subagent_type: ti.subagent_type ?? null,
      model_requested: ti.model ?? null, model, budget_tokens: effective, budget_source: taskBudget != null ? "header" : source, classes, scope: h.scope, parent_agent_id: ctx.agentId,
      // WP10d (D1, D7): l'header del dispatch, riassunto e redatto, per la console degli agenti (mai contenuti di file)
      ...headerSummary(h, ti),
    })}\n`);
    return null;
  }, { timeoutMs: 4000 });
  if (refused?.raw) return denyAudited(ctx, G, refused.raw);
  if (refused) return denyAudited(ctx, G, `${refused}: ridisegna il compito (meno passi, più STR-REPLAY) o chiedi all'utente di alzare il budget`);
  if (downgrade) {
    return allowWithInput(`[${G}] budget di sessione ≥ 80% (${used}/${tokens}): tier forzato a haiku; chiedi all'utente se continuare (§29.10)`, { ...ti, model: "haiku" });
  }
  return null;
});
