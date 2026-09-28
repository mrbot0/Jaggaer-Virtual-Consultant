// guard-destructive (PreToolUse Bash|PowerShell|Write|Edit|MultiEdit|NotebookEdit|strumenti MCP del browser, FAIL-CLOSED)
// — F0.1, §32, §44.4, §48.3 T1 T7 T9. Interprete di policy/deny-rules.yaml: il codice non contiene la deny-list.
//  - shell: ogni vista del comando (grezza, senza virgolette/escape/^/backtick, concatenazioni unite, variabili
//    semplici sostituite, \xNN decodificati, token base64 decodificati, scheletro Unicode, contenuto degli script locali
//    eseguiti) è spezzata in sotto-comandi (; && || | & a capo ( ) { } $( ) backtick) e ogni sotto-comando è valutato
//    da OGNI sua parola in poi (prefissi come sudo, env, FOO=1, xargs, bash -c, cmd /c, powershell -Command, eval non
//    nascondono il comando); le regole `text` vedono il comando intero. Unica eccezione: le operazioni `sanctioned`
//    (node <plugin>/scripts/admin/purge.mjs con le due approvazioni), riconosciute solo nella forma esatta;
//  - scrittura: percorso (audit, .env*, .auth/**, codice del plugin senza JVC_DEV) e contenuto (JVC_DEV);
//  - browser: click e input il cui bersaglio (element, selettore, testo digitato, nome dell'elemento nell'ultimo
//    snapshot osservato, nomi della voce dell'Atlas legata al ref) corrisponde a un verbo di cancellazione ⇒ deny che
//    nomina ACT-DELETE; condizioni sul passo attivo del piano (when/unless_step_class). Il testo della pagina è un
//    dato: il guard non legge mai tool_response né il contenuto della pagina come istruzione.
// hard-deny ⇒ deny (in audit) · confirm ⇒ ask (in audit). Nessun output quando nessuna regola scatta.
import { readFileSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { guarded, guardContext, denyAudited, sameFile, PathPolicyError } from "./common.mjs";
import { resolveTarget, intersects, skeleton, bases } from "../paths.mjs";
import { classify, isBrowserTool } from "../browser-tools.mjs";
import { ask } from "../io.mjs";
import { appendAudit } from "../audit.mjs";
import { summarizeInput } from "../tool-summary.mjs";
import { loadRules } from "../deny-rules.mjs";

const G = "guard-destructive";
export const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);
export const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const MAX_COMMAND = 100_000;
const MAX_VIEWS = 256;
const SCRIPT_MAX = 256 * 1024;

// ---------------- viste di un comando di shell ----------------
const noQuotes = (s) => s.replace(/["']/g, "");
const noBackslash = (s) => s.replace(/\\(?=[^\s\\/])/g, "").replace(/\\\r?\n/g, " ");
const joinConcat = (s) => s.replace(/(['"])\s*\+\s*(['"])/g, "");
const noCaret = (s) => s.replace(/\^(?=\S)/g, "");
const noTick = (s) => s.replace(/`(?=[^\s`])/g, "");
const ifs = (s) => s.replace(/\$\{IFS\}|\$IFS\b/g, " ").replace(/\$\{?[@*]\}?/g, "").replace(/\$''|\$""|\$\(\s*\)|``/g, "");
// $(echo rm) / `printf rm` ⇒ rm
const echoSubst = (s) => s.replace(/\$\(\s*(?:echo|printf|write-output|write-host)\s+([^()]*)\)|`\s*(?:echo|printf)\s+([^`]*)`/gi, (_, a, b) => (a ?? b ?? "").replace(/["']/g, "").replace(/%s\s*/g, ""));
const eqSpace = (s) => s.replace(/=/g, " ");
const escapes = (s) => s.replace(/\\x([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
  .replace(/\\u\{?([0-9a-f]{4,6})\}?/gi, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ""; } })
  .replace(/\\([0-7]{1,3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));
function substVars(s) {
  const vars = new Map();
  for (const m of noQuotes(s).matchAll(/(?:^|[;&|\s(])(?:set\s+|export\s+|local\s+)?\$?([A-Za-z_]\w*)\s*=\s*([^\s;&|()]*)/g)) if (!vars.has(m[1])) vars.set(m[1], m[2]);
  if (!vars.size) return s;
  return s.replace(/\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)|%([A-Za-z_]\w*)%|!([A-Za-z_]\w*)!/g, (all, a, b, c, d) => { const k = a ?? b ?? c ?? d; return vars.has(k) ? vars.get(k) : all; });
}
const CHAIN = [joinConcat, noCaret, ifs, escapes, substVars, echoSubst, noTick, noQuotes];

const printable = (t) => t.length >= 4 && [...t].filter((c) => /[\x20-\x7e\t\r\n]/.test(c)).length / t.length >= 0.9;
function decodedPayloads(s) {
  const out = [];
  for (const m of s.matchAll(/[A-Za-z0-9+/_-]{12,}={0,2}/g)) {
    const tok = m[0].replace(/-/g, "+").replace(/_/g, "/");
    let buf;
    try { buf = Buffer.from(tok, "base64"); } catch { continue; }
    for (const enc of ["utf8", "utf16le"]) {
      const t = buf.toString(enc).replace(/\0/g, "");
      if (printable(t) && /[a-z]{2}/i.test(t)) out.push(t);
    }
    if (out.length > 32) break;
  }
  return out;
}

// Script locali eseguiti da un interprete o da `source`: il loro contenuto è una vista del comando. Gli script del
// plugin (codice verificato dall'integrità) non si rileggono.
const SCRIPT_FILE = /(?:^|[\s'"=])([^\s'"=]+\.(?:mjs|cjs|js|ts|py|ps1|psm1|sh|bash|zsh|rb|pl|php|cmd|bat))(?=$|[\s'"])/gi;
const RUNS_SCRIPT = /(^|[\s;&|(`'"\\/])(node|nodejs|deno|bun|python3?|py|perl|ruby|php|pwsh|powershell|bash|sh|zsh|dash|ksh|cmd|source|call|start)(\.exe)?(?=$|[\s;&|)`'"])|(^|[\s;&|])\.\s|(^|[\s;&|])\.[\\/]/i;
function scriptContents(ctx, s) {
  if (!RUNS_SCRIPT.test(s)) return [];
  const out = [];
  const plugin = bases(ctx.plugin);
  for (const m of s.matchAll(SCRIPT_FILE)) {
    const f = resolve(ctx.cwd, m[1]);
    const abs = f.replace(/\\/g, "/").toLowerCase();
    if (plugin.some((b) => abs.startsWith(`${b}/`))) continue;
    let st;
    try { st = statSync(f); } catch { continue; }
    if (!st.isFile()) continue;
    if (st.size > SCRIPT_MAX) throw new PathPolicyError(`script troppo grande per l'analisi del guard (> ${SCRIPT_MAX / 1024} KB): ${m[1]}`);
    out.push(readFileSync(f, "utf8"));
  }
  return out;
}

export function shellViews(cmd, ctx = null, depth = 0, out = new Set()) {
  const add = (v) => {
    if (typeof v !== "string" || !v || out.has(v)) return;
    out.add(v);
    if (out.size > MAX_VIEWS) throw new PathPolicyError("comando troppo complesso per l'analisi del guard (viste oltre il limite)");
  };
  const starts = [cmd, noBackslash(cmd)];
  for (const s0 of starts) {
    add(s0);
    add(noQuotes(s0));
    let s = s0;
    for (const f of CHAIN) { s = f(s); add(s); }
    add(s.replace(/`/g, " ; "));
    add(eqSpace(s));
  }
  for (const v of [...out]) add(skeleton(v));
  if (depth < 3) {
    const base = [...out];
    for (const v of base) for (const p of decodedPayloads(v)) shellViews(p, ctx, depth + 1, out);
    if (ctx) for (const text of scriptContents(ctx, cmd)) shellViews(text, ctx, depth + 1, out);
  }
  return out;
}

const SPLIT = /\r?\n|;|&&|\|\||\||&|`/;
// nome del comando: senza @ & . $( ( { [ iniziali, ) } ] finali, cartella ed estensione
const headOf = (t) => t.replace(/^[@&.$({[]+/, "").replace(/[)}\]]+$/, "").replace(/^.*[\\/]/, "").replace(/\.(exe|cmd|bat|com|ps1)$/i, "").toLowerCase();
// Ogni sotto-comando, da ogni parola in poi: "sudo -u x rm -rf y" vale anche come "rm -rf y".
export function* commandSuffixes(view) {
  for (const seg of view.split(SPLIT)) {
    const tokens = seg.trim().split(/\s+/).filter(Boolean);
    for (let i = 0; i < tokens.length; i++) yield [headOf(tokens[i]), ...tokens.slice(i + 1)].join(" ");
  }
}

const hitOf = (rule, text) => ({ rule, text: String(text).replace(/\s+/g, " ").trim().slice(0, 100) });
function testPatterns(rule, text) {
  for (const p of rule.compiled) {
    if (!p.re) continue;
    p.re.lastIndex = 0;
    const m = p.re.exec(text);
    if (!m) continue;
    if (p.unless && p.unless.test(m[0])) continue;
    return m[0] || text;
  }
  return null;
}

// ---------------- operazioni ammesse (forma esatta) ----------------
function tokensOf(s) { return [...s.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]); }
function sanctionedDecision(ctx, cmd, list) {
  for (const s of list) {
    const target = join(ctx.plugin, ...s.script.split("/"));
    const c = cmd.trim().replace(/\$\{CLAUDE_PLUGIN_ROOT\}|\$CLAUDE_PLUGIN_ROOT\b/g, ctx.plugin);
    if (/[;&|`<>\r\n$\0]/.test(c)) continue;
    const t = tokensOf(c);
    if (!/^node(\.exe)?$/i.test(t[0] ?? "") || !t[1] || !sameFile(resolve(ctx.cwd, t[1]), target)) continue;
    const args = t.slice(2);
    const ok = s.require_args.every((flag) => {
      const i = args.findIndex((a) => a === flag || a.startsWith(`${flag}=`));
      if (i < 0) return false;
      const v = args[i].includes("=") ? args[i].slice(flag.length + 1) : args[i + 1];
      return typeof v === "string" && v.trim() !== "" && !v.startsWith("--");
    });
    return ok ? { allow: s } : { deny: s };
  }
  return null;
}

function shellMatches(ctx, rules) {
  const cmd = ctx.ti.command;
  if (typeof cmd !== "string" || !cmd.trim()) return { hits: [] };
  if (cmd.includes("\0")) throw new PathPolicyError("comando con byte NUL");
  if (cmd.length > MAX_COMMAND) throw new PathPolicyError(`comando troppo lungo per l'analisi del guard (oltre ${MAX_COMMAND} caratteri)`);
  const s = sanctionedDecision(ctx, cmd, rules.sanctioned);
  if (s?.allow) return { hits: [], sanctioned: s.allow };
  if (s?.deny) return { hits: [hitOf({ id: s.deny.id, severity: "hard-deny", reason: `${s.deny.reason}: mancano ${s.deny.require_args.join(" e ")}` }, cmd)] };
  const views = [...shellViews(cmd, ctx)];
  const hits = [];
  const shellRules = rules.rules.filter((r) => r.applies_to.includes("shell"));
  for (const r of shellRules) {
    let found = null;
    if (r.on === "text") {
      for (const v of views) { const m = testPatterns(r, v); if (m) { found = m; break; } }
    } else {
      outer: for (const v of views) for (const suffix of commandSuffixes(v)) { const m = testPatterns(r, suffix); if (m) { found = m; break outer; } }
    }
    if (found) hits.push(hitOf(r, found));
  }
  return { hits };
}

// ---------------- scrittura ----------------
function writtenTexts(tool, ti) {
  if (tool === "Write") return [ti.content];
  if (tool === "Edit") return [ti.new_string];
  if (tool === "MultiEdit") return Array.isArray(ti.edits) ? ti.edits.map((e) => e?.new_string) : [];
  if (tool === "NotebookEdit") return [ti.new_source];
  return [];
}
function writeMatches(ctx, rules, env) {
  const p = ctx.ti.file_path ?? ctx.ti.notebook_path;
  if (typeof p !== "string" || !p) throw new PathPolicyError(`${ctx.tool} senza file_path`);
  const T = resolveTarget(p, { cwd: ctx.cwd, ws: ctx.ws, plugin: ctx.plugin });
  const rels = [...T.ws, ...(T.outside ?? [])];
  const abs = [...T.abs].map((a) => a.replace(/^\/+/, ""));
  const plugin = [...T.plugin];
  const texts = writtenTexts(ctx.tool, ctx.ti).filter((t) => typeof t === "string" && t);
  const hits = [];
  for (const r of rules.rules.filter((x) => x.applies_to.includes("write"))) {
    if (r.unless_env && env[r.unless_env]) continue;
    let found = null;
    if (r.on === "path") {
      for (const q of r.compiled) {
        if (q.glob) found = rels.find((x) => intersects(x, q.glob)) ?? (q.glob.startsWith("**/") ? abs.find((x) => intersects(x, q.glob)) : undefined) ?? null;
        else if (q.plugin_glob) found = plugin.find((x) => intersects(x, q.plugin_glob)) ?? null;
        if (found != null) { found = found || p; break; }
      }
    } else {
      for (const t of texts) { const m = testPatterns(r, t) ?? testPatterns(r, skeleton(t)); if (m) { found = m; break; } }
    }
    if (found != null) hits.push(hitOf(r, found));
  }
  return { hits };
}

// ---------------- browser ----------------
const SEL_RE = /^([SCL])\.([A-Z0-9]{3,4})\.([A-Z0-9]{3})\.SEL\.\d{4}(\.v\d+)?$/;
// Nomi della voce dell'Atlas (strategies[].name, label, name, text): lettura leggera, senza il modulo yaml.
function selNames(ctx, code) {
  const m = typeof code === "string" ? SEL_RE.exec(code) : null;
  if (!m) return [];
  const [, level, cust, scope] = m;
  if (level !== "S" && cust !== ctx.customer) return [];
  const base = level === "S" ? join(ctx.ws, "product", "kb") : join(ctx.ws, "customers", ctx.customer, "kb");
  let text;
  try { text = readFileSync(join(base, "scopes", scope, "selectors", `${code}.yaml`), "utf8"); } catch { return []; }
  return [...text.matchAll(/^\s*(?:-\s+)?(?:name|label|text|aria_label|button_text):\s*(.+?)\s*$/gm)].map((x) => x[1].replace(/^(["'])(.*)\1$/, "$2"));
}
const isKeyPress = (a) => a.action === "key" || /(^|_)press_key$/.test(String(a.op ?? ""));
function labelTexts(ctx, a) {
  const texts = [];
  if (typeof a.text === "string") texts.push(...a.text.split("\n"));
  for (const k of ["element", "selector"]) if (typeof a.target?.[k] === "string") texts.push(a.target[k]);
  const snap = ctx.session?.browser?.snapshot;
  for (const ref of a.targets ?? []) {
    const n = snap?.names && Object.hasOwn(snap.names, ref) ? snap.names[ref] : null;
    if (typeof n === "string") texts.push(n);
    const sel = snap?.refs && Object.hasOwn(snap.refs, ref) ? snap.refs[ref] : null;
    if (sel) texts.push(...selNames(ctx, sel));
  }
  return texts.filter((t) => typeof t === "string" && t.trim());
}

async function browserMatches(ctx, rules) {
  const call = classify(ctx.tool, ctx.ti);
  const actions = (call.actions ?? [call]).filter((a) => a.kind === "click" || a.kind === "input");
  if (!actions.length) return { hits: [] };
  const browserRules = rules.rules.filter((r) => r.applies_to.includes("browser"));
  let cls;
  const stepClass = async () => {
    if (cls !== undefined) return cls;
    if (!ctx.session?.active_plan) return (cls = null);
    const { activeStep } = await import("./plan-step.mjs");
    const st = await activeStep(ctx);
    return (cls = st.step?.action_class ?? null);
  };
  const hits = [];
  for (const a of actions) {
    const key = isKeyPress(a);
    const labels = key ? [] : labelTexts(ctx, a);
    const keys = key && typeof a.text === "string" ? [a.text] : [];
    let local = [];
    for (const r of browserRules) {
      const src = r.on === "key" ? keys : labels;
      let found = null;
      for (const t of src) { found = testPatterns(r, t) ?? testPatterns(r, skeleton(t)); if (found) { found = t; break; } }
      if (!found) continue;
      if (r.when_step_class && !r.when_step_class.includes(await stepClass())) continue;
      if (r.unless_step_class && r.unless_step_class.includes(await stepClass())) continue;
      local.push(hitOf(r, found));
    }
    const superseded = new Set(local.flatMap((h) => h.rule.supersedes ?? []));
    local = local.filter((h) => !superseded.has(h.rule.id));
    hits.push(...local);
  }
  return { hits };
}

// ---------------- decisione ----------------
function decision(ctx, hits) {
  if (!hits.length) return null;
  const hard = hits.find((h) => h.rule.severity === "hard-deny");
  if (hard) return denyAudited(ctx, G, `${hard.rule.id}: ${hard.rule.reason} (${hard.text})`);
  const c = hits[0];
  const reason = `${c.rule.id}: ${c.rule.reason} (${c.text})`;
  try {
    appendAudit(ctx.ws, { session: ctx.sid, customer: ctx.customer, scope: ctx.session?.scope ?? null, kind: "guard", actor: `hook:${G}`,
      payload: { decision: "ask", tool: ctx.tool, reason, input_summary: summarizeInput(ctx.tool, ctx.ti), agent_type: ctx.agentType, agent_id: ctx.agentId } });
  } catch { /* l'audit non cambia la decisione */ }
  return ask(`[${G}] ${reason}`);
}

const FILE_SHELL = new Set([...SHELL_TOOLS, ...WRITE_TOOLS]);

export async function decide(input, env = process.env) {
  const tool = String(input.tool_name ?? "");
  if (FILE_SHELL.has(tool)) {
    const rules = await loadRules();
    // guarded(): workspace non JVC ⇒ nessuna opinione; PathPolicyError ⇒ deny motivato in audit; comando di riparazione
    // dello stato (use customer / show) con stato corrotto ⇒ nessuna opinione; le altre eccezioni ⇒ deny (runHook).
    return guarded(G, (ctx) => decision(ctx, (SHELL_TOOLS.has(tool) ? shellMatches(ctx, rules) : writeMatches(ctx, rules, env)).hits), { tools: FILE_SHELL })(input, env);
  }
  if (!isBrowserTool(tool)) return null;
  const ctx = guardContext(input, env);
  if (!ctx.jvc) return null;
  const rules = await loadRules();
  const { hits } = await browserMatches(ctx, rules);
  return decision(ctx, hits);
}
