// Origine del browser a consuntivo (K5 giro 2, N1): hook PostToolUse sugli
// strumenti MCP del browser. È l'UNICO punto che rende noto
// session.browser.current_url, e solo dopo un navigate RIUSCITO (marcatore positivo
// della famiglia) con l'URL su cui la scheda è arrivata (giro 3). Il resto lo azzera:
//  - cambi di scheda/pagina/browser (switches) ⇒ ignoto;
//  - navigate/back/forward/reload senza marcatore o senza URL effettivo ⇒ ignoto;
//  - risposta d'errore o non interpretabile di qualunque strumento ⇒ ignoto;
//  - letture e azioni riuscite ⇒ invariato (mai promuovere un URL ignoto).
// Non è un guard: su guasto consente con avviso (fail-open per disponibilità),
// ma prima prova ad azzerare l'URL, così il guasto non lascia un'origine falsa.
import { loadHookState } from "./workspace.mjs";
import { classify, isBrowserTool } from "./browser-tools.mjs";
import { updateSessionFile } from "./session-state.mjs";
import { devtoolsPageUrl, claudeTabContext, playwrightPageUrl, hasDialog, hasModal, RECONNECT } from "./origin-markers.mjs";
import { callKey, markPending, pendingFile, loadPending, savePending } from "./ref-history.mjs";
import { withFileLock } from "./fsx.mjs";
import { join } from "node:path";

// WP08 (decisione del controllore su WP07): la voce "in attesa di observe-append" va anche nel file del cliente
// (customers/<C>/.sessions/ref-pending.json), come la storia dei ref: una sessione nuova sulla stessa scheda la ritrova.
function markCustomerPending(st, key, family, tab, ts) {
  if (!st.customer) return;
  const f = pendingFile(join(st.ws, "customers", st.customer, ".sessions"));
  withFileLock(`${f}.lock`, () => {
    const p = loadPending(f);
    savePending(f, markPending(p.corrupt ? { obs_pending: {}, obs_done: [] } : p, key, family, tab, ts));
  });
}

const ERROR_TEXT = /^\s*(error\b|errore\b|failed\b|timeout\b|timed out\b)|net::ERR_|navigation (failed|timeout)|timeout of \d+ ?ms exceeded|protocol error|target closed|no page selected|leave site\?/i;
const textOf = (blocks) => blocks.filter((b) => b && typeof b === "object" && b.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n");

// → "ok" | "error" | "unknown"
export function responseState(resp) {
  if (typeof resp === "string") return !resp.trim() ? "unknown" : ERROR_TEXT.test(resp) ? "error" : "ok";
  if (Array.isArray(resp)) {
    if (!resp.length || !resp.every((b) => b && typeof b === "object" && typeof b.type === "string")) return "unknown";
    return ERROR_TEXT.test(textOf(resp)) ? "error" : "ok";
  }
  if (resp && typeof resp === "object") {
    if (resp.isError === true || resp.is_error === true || resp.error != null || resp.success === false) return "error";
    if (Array.isArray(resp.content)) return responseState(resp.content);
    return "unknown";
  }
  return "unknown";
}


// K5 giro 3 (Minor A+B), WP07 giro 1 (C1, I2): un navigate conta come riuscito solo con il MARCATORE
// POSITIVO della sua famiglia, e si registra l'URL su cui la scheda è ARRIVATA come lo riporta la risposta
// (redirect compresi), non quello chiesto — letto SOLO da posizioni controllate dal server
// (hooks/lib/origin-markers.mjs): uscita strutturata se c'è; altrimenti marcatore unico, ancorato dopo
// l'intestazione del server, senza separatori di riga Unicode. Tutto ciò che non si interpreta con certezza ⇒ ignoto.
//  - chrome-devtools: "Successfully navigated …" / "Successfully reloaded …", nessun "# Open dialog" né avviso di
//    riconnessione; URL della riga dell'id chiesto (pageId) o dell'unica "[selected]" nell'unico "## Pages";
//  - Claude browser / Claude in Chrome: "Navigated to …", URL della scheda "Executed on tabId: N" nel Tab Context
//    finale e unico;
//  - Playwright: l'unico "- Page URL:" subito dopo l'unico "### Page" / "### Page state".
export function landedUrl(family, text, { asked = null, resp = null } = {}) {
  if (typeof text !== "string" || !text) return null;
  if (family === "chrome-devtools") {
    if (!/^Successfully (navigated|reloaded)\b/im.test(text) || /Unable to navigate/i.test(text) || hasDialog(text) || RECONNECT.test(text)) return null;
    return devtoolsPageUrl(text, { asked, resp });
  }
  if (family === "claude-browser") {
    if (!/^Navigated to\b/im.test(text)) return null;
    const c = claudeTabContext(text);
    if (!c || (asked != null && String(asked) !== String(c.tab))) return null;
    return c.url;
  }
  if (family === "playwright") return playwrightPageUrl(text);
  return null;
}

// Compatibilità: la pagina "[selected]" di un elenco "## Pages" (stesse regole di devtoolsPageUrl).
export function selectedPageUrl(pages) { return devtoolsPageUrl(String(pages)); }

export const textOfResponse = (resp) => (typeof resp === "string" ? resp : Array.isArray(resp) ? textOf(resp) : resp && typeof resp === "object" && Array.isArray(resp.content) ? textOf(resp.content) : "");

// Azioni che possono cambiare la pagina senza che la risposta lo dica: click, invio, dialog accettato.
export const mayNavigate = (a) => a.kind === "click" || a.submits === true || (a.kind === "dialog" && a.submits);

// Nuovo stato { url, tab } dopo la chiamata, dato lo stato precedente e la risposta.
// Solo un navigate (o una storia) riuscito con l'URL effettivo rende noto l'URL; i cambi di scheda, i click,
// gli invii e i dialog accettati lo azzerano (WP07 giro 1, I3: qui, nell'hook leggero, non solo in observe-append,
// che può riportarlo noto solo con un marcatore positivo); dialog aperti e riconnessioni del server DevTools lo
// azzerano; le letture e gli input senza invio lo lasciano com'è.
export function nextOrigin(prev, call, state, resp) {
  const reset = { url: null, tab: null };
  if (state !== "ok") return reset;
  const text = textOfResponse(resp);
  if (call.family === "chrome-devtools" && (hasDialog(text) || RECONNECT.test(text))) return reset;
  if (call.family === "playwright" && hasModal(text)) return reset;   // WP07 giro 2 (C-1): dialog della pagina
  let st = { ...prev };
  let navigated = null;
  for (const a of call.actions ?? [call]) {
    if (a.kind === "other" || a.kind === "script") return reset;
    if (a.switches) { st = { ...reset }; navigated = null; continue; }
    if (a.kind === "navigate") navigated = a;
    else if (mayNavigate(a)) st = { ...reset };
  }
  if (!navigated) return st;
  const landed = landedUrl(call.family, text, { asked: navigated.tab ?? null, resp });
  return landed ? { url: landed, tab: navigated.tab ?? null } : reset;
}

// WP07 giro 5 (I-A', regola 5): scheda della voce obs_pending — quella nominata dalla chiamata; più schede o una
// azione che non la nomina ⇒ ignota (blocca tutte le schede della famiglia, fail-closed).
function pendingTab(call) {
  const tabs = (call.actions ?? [call]).map((a) => (a.tab == null ? null : String(a.tab)));
  return tabs.length && tabs.every((t) => t != null && t === tabs[0]) ? tabs[0] : null;
}

export function record(input, env = process.env) {
  const tool = String(input.tool_name ?? "");
  if (!isBrowserTool(tool)) return null;
  const st = loadHookState(input, env);
  if (!st.jvc || !st.session?.env || !st.sessionFile) return null;
  const b = st.session.browser ?? {};
  const prev = { url: typeof b.current_url === "string" && b.current_url ? b.current_url : null, tab: b.tab ?? null };
  let call = null;
  let next;
  try { call = classify(tool, input.tool_input); next = nextOrigin(prev, call, responseState(input.tool_response), input.tool_response); } catch { next = { url: null, tab: null }; }
  const moved = !(next.url === prev.url && (next.tab ?? null) === (prev.tab ?? null));
  // ogni chiamata del browser resta "in attesa di observe-append" finché observe-append non la registra (regola 5)
  const key = callKey(input);
  const ts = new Date().toISOString();
  markCustomerPending(st, key, call?.family ?? "unknown", call ? pendingTab(call) : null, ts);
  updateSessionFile(st.sessionFile, (s) => {
    let nb = markPending(s.browser ?? {}, key, call?.family ?? "unknown", call ? pendingTab(call) : null, ts);
    if (moved) nb = { ...nb, current_url: next.url, tab: next.tab, updated_by: "browser-origin" };
    s.browser = nb;
  });
  return null;
}

// In caso di guasto: azzera (mai lasciare un'origine non confermata) e lascia la chiamata in attesa di observe-append.
export function resetOnFailure(input, env = process.env) {
  try {
    const st = loadHookState(input, env);
    if (st.jvc && st.sessionFile && st.session?.env) {
      let call = null;
      try { call = classify(String(input.tool_name ?? ""), input.tool_input); } catch { /* scheda ignota */ }
      try { markCustomerPending(st, callKey(input), call?.family ?? "unknown", call ? pendingTab(call) : null, new Date().toISOString()); } catch { /* resta il marcatore di sessione */ }
      updateSessionFile(st.sessionFile, (s) => {
        const nb = markPending(s.browser ?? {}, callKey(input), call?.family ?? "unknown", call ? pendingTab(call) : null, new Date().toISOString());
        s.browser = { ...nb, current_url: null, tab: null, updated_by: "browser-origin" };
      });
    }
  } catch { /* stato illeggibile: i guard negano comunque */ }
}
