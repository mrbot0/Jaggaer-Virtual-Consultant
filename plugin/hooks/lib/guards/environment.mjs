// guard-environment (PreToolUse su mcp__.*, FAIL-CLOSED) — §51.2, §44.4.
//  - nessun ambiente dichiarato ⇒ deny di ogni strumento del browser;
//  - environments.yaml cambiato o sparito dopo `use env` ⇒ deny;
//  - navigate: l'host deve essere in allowed_hosts dell'ambiente DICHIARATO
//    (userinfo, suffissi, prefissi, IP, schemi non http(s), porte non dichiarate,
//    redirect SSO verso host non in lista ⇒ deny "host non dichiarato");
//  - dichiarato ma non verificato (env-check) ⇒ solo navigate e letture;
//  - script nella pagina (evaluate_script, javascript_tool, browser_evaluate,
//    initScript, run_code) ⇒ deny in ogni ambiente; `other` ⇒ deny;
//  - file scritti dal server del browser solo nelle cartelle di lavoro;
//  - browser_batch: ogni azione valutata in sequenza, basta un deny.
// Giro di correzione 1 — origine verificata a ogni azione (C3, Minor 3):
//  - ogni navigate consentito registra session.browser.current_url (e la scheda,
//    se la chiamata la nomina); back/forward rendono l'URL ignoto, reload lo tiene;
//  - cambi di scheda/pagina/browser (tabs_select, tabs_create, select_page,
//    new_page, switch_browser, browser_tabs select|new|close, close…) lo azzerano;
//  - azioni con effetto (input, click, upload, dialog, emulazione) e storia
//    (back/forward/reload) richiedono un URL corrente NOTO su un host dichiarato
//    e la stessa scheda della navigazione registrata; ignoto ⇒ deny "naviga prima";
//  - URL corrente noto ma fuori lista ⇒ deny di ogni azione che non sia navigate.
// Server MCP non da browser (I5): con un ambiente dichiarato, ogni mcp__* il cui
// server non è in hooks/lib/mcp-allowlist.json (file del plugin) ⇒ deny.
// Consentito = nessun output (un allow esplicito scavalcherebbe i permessi).
import { readFileSync, statSync, mkdirSync } from "node:fs";
import { isAbsolute, resolve as resolvePath, join as joinPath } from "node:path";
import { callKey } from "../ref-history.mjs";
import { guardContext, denyAudited } from "./common.mjs";
import { browserGuarded, declaredEnv, urlRefusal, outputRefusal, SCRIPT_DENIED, claudeEffectRefusal } from "./browser.mjs";
import { isBrowserTool, mcpServer } from "../browser-tools.mjs";
import { updateSessionFile } from "../session-state.mjs";

const G = "guard-environment";
const ALLOW = new Set(JSON.parse(readFileSync(new URL("../mcp-allowlist.json", import.meta.url), "utf8")).servers);
const NAVIGATE_FIRST = "URL della pagina corrente ignoto (nessuna navigazione registrata, o scheda/pagina cambiata): esegui prima navigate verso un host dichiarato dell'ambiente";

function hrefOf(url) { try { return new URL(url.trim()).href; } catch { return null; } }

// Valuta un'azione sullo stato del browser `st` ({ url, tab }), che aggiorna. → motivo | null
function check(ctx, env, a, st) {
  if (a.kind === "other") return `strumento o parametri del browser non classificati (${a.tool ?? ctx.tool}${a.action ? ` action=${a.action}` : ""}${a.unknownKeys ? ` chiavi: ${a.unknownKeys.join(", ")}` : ""}): negato per default`;
  if (a.kind === "script") return SCRIPT_DENIED;
  const out = outputRefusal(ctx, a.outputs);
  if (out) return out;
  const tab = a.tab ?? null;
  if (a.kind === "navigate" && !a.history) {
    const r = urlRefusal(a.url, env);
    if (r) return r;
    if (a.switches) { st.url = null; st.tab = null; } else { st.url = hrefOf(a.url); st.tab = tab; }
    st.changed = true;
    return null;
  }
  // l'URL corrente, se noto, deve essere di un host dichiarato
  if (st.url) {
    const r = urlRefusal(st.url, env);
    if (r) return `pagina corrente fuori dall'ambiente dichiarato (${r}): torna con navigate su un host dichiarato`;
  }
  if (a.kind === "read") {
    if (a.switches) { st.url = null; st.tab = null; st.changed = true; }
    return null;
  }
  // storia della scheda e azioni con effetto
  if (!env.verified) return `ambiente ${env.id} dichiarato ma non verificato: esegui env-check (impronta a ≥ 2 segnali) prima di azioni diverse da navigazione verso un URL e lettura (§51.2)`;
  // 28/10/2026 (decisione dell'utente: in prep niente blocchi sui click, solo sulle cancellazioni): in esplorazione (sandbox e
  // pre-produzione) un URL corrente ignoto o una scheda diversa non negano più l'azione; se l'URL è noto resta il controllo
  // dell'host dichiarato (sopra). Fuori dall'esplorazione vale la regola di prima.
  if (ctx.session?.mode === "esplorazione" && ["sandbox", "preprod"].includes(env.type)) return null;
  if (!st.url) return NAVIGATE_FIRST;
  if (tab !== (st.tab ?? null)) return `scheda diversa da quella della navigazione registrata (${tab ?? "scheda attiva"} ≠ ${st.tab ?? "scheda attiva"}): naviga prima in questa scheda`;
  if (a.kind === "navigate" && a.history && a.historyKind !== "reload") { st.url = null; st.changed = true; }
  return null;
}

const browser = browserGuarded(G, (ctx, no) => {
  const { env, reason } = declaredEnv(ctx);
  if (!env) return no(reason);
  // WP08 (decisione del controllore su WP07): effetti del browser di Claude solo in sandbox
  const ce = claudeEffectRefusal(ctx, env.type);
  if (ce) return no(ce);
  const b = ctx.session.browser ?? {};
  const st = { url: typeof b.current_url === "string" && b.current_url ? b.current_url : null, tab: b.tab ?? null, changed: false };
  for (const a of ctx.actions) {
    const r = check(ctx, env, a, st);
    if (r) return no(r);
  }
  // Giro 2 (N1): PreToolUse non registra MAI un URL (la chiamata può ancora essere
  // negata da un altro guard, dal permesso o fallire). Può solo AZZERARLO quando la
  // chiamata naviga o cambia scheda: l'URL tornerà noto solo se browser-origin
  // (PostToolUse) vede il navigate riuscito.
  const cur = ctx.session.browser ?? {};
  if (st.changed && (cur.current_url != null || cur.tab != null)) updateSessionFile(ctx.sessionFile, (s) => { s.browser = { ...(s.browser ?? {}), current_url: null, tab: null, updated_by: G }; });
  snapshotFileMarker(ctx);
  return null;
});

// Sicurezza 1 (27/10/2026): take_snapshot di DevTools con filePath assoluto — marcatore della chiamata (tool_use_id) con il
// percorso, l'ora e l'mtime precedente del file: observe-append legge il file solo se lo strumento l'ha scritto DOPO questo
// momento (un file scritto prima, o senza marcatore, non vale). Crea la cartella snapshots/ della sessione. Un guasto qui
// non nega la chiamata: senza marcatore il file semplicemente non si legge (fail-closed per il legame).
const SNAPSHOT_CALLS_MAX = 16;
function snapshotFileMarker(ctx) {
  try {
    const a = ctx.actions.length === 1 ? ctx.actions[0] : null;
    if (!a || (a.family ?? ctx.call?.family) !== "chrome-devtools" || a.op !== "take_snapshot" || !Array.isArray(a.outputs) || a.outputs.length !== 1) return;
    const raw = a.outputs[0];
    if (typeof raw !== "string" || !isAbsolute(raw)) return;
    const path = resolvePath(raw);
    let before = null;
    try { before = statSync(path).mtimeMs; } catch { before = null; }
    try { mkdirSync(joinPath(ctx.ws, "customers", ctx.customer, ".sessions", ctx.sid, "snapshots"), { recursive: true }); } catch { /* lo crea lo strumento */ }
    const key = callKey(ctx.input);
    updateSessionFile(ctx.sessionFile, (s) => {
      const calls = { ...(s.browser?.snapshot_calls ?? {}), [key]: { path, ts: Date.now(), before } };
      s.browser = { ...(s.browser ?? {}), snapshot_calls: Object.fromEntries(Object.entries(calls).slice(-SNAPSHOT_CALLS_MAX)) };
    });
  } catch { /* nessun marcatore */ }
}

function mcpOther(input, env) {
  const ctx = guardContext(input, env);
  if (!ctx.jvc || !ctx.session?.env) return null;
  const server = mcpServer(ctx.tool);
  if (server && ALLOW.has(server)) return null;
  return denyAudited(ctx, G, `server MCP ${server ?? ctx.tool} non ammesso con un ambiente dichiarato: non è una famiglia del browser classificata né è in hooks/lib/mcp-allowlist.json del plugin (uno strumento non classificato può agire sul tenant)`);
}

export function decide(input, env = process.env) {
  const tool = String(input.tool_name ?? "");
  if (isBrowserTool(tool)) return browser(input, env);
  if (tool.startsWith("mcp__")) return mcpOther(input, env);
  return null;
}
