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

function hrefOf(url) { try { return new URL(String(url).trim()).href; } catch { return null; } }

// K5 giro 3 (Minor A+B): un navigate conta come riuscito solo con il MARCATORE
// POSITIVO della sua famiglia, e si registra l'URL su cui la scheda è ARRIVATA come
// lo riporta la risposta (redirect compresi), non quello chiesto. Tutto ciò che non
// si interpreta con certezza ⇒ ignoto.
//  - chrome-devtools: "Successfully navigated …" / "Successfully reloaded …", URL
//    della pagina "[selected]" nell'ultimo elenco "## Pages";
//  - Claude browser / Claude in Chrome: "Navigated to …", URL della scheda
//    "Executed on tabId: N" nell'ultimo "Tab Context";
//  - Playwright: ultimo "- Page URL: …".
const lastMatch = (re, text) => { let m; let last = null; const g = new RegExp(re.source, `${re.flags.replace("g", "")}g`); while ((m = g.exec(text))) last = m; return last; };
export function landedUrl(family, text) {
  if (typeof text !== "string" || !text) return null;
  if (family === "chrome-devtools") {
    if (!/Successfully (navigated|reloaded)\b/i.test(text) || /Unable to navigate/i.test(text)) return null;
    const pages = text.slice(text.lastIndexOf("## Pages"));
    if (!pages.startsWith("## Pages")) return null;
    return selectedPageUrl(pages);
  }
  if (family === "claude-browser") {
    if (!/\bNavigated to\b/i.test(text)) return null;
    const ex = lastMatch(/Executed on tabId:\s*(\S+)/, text);
    if (!ex) return null;
    const tail = text.slice(ex.index);
    const tab = new RegExp(`tabId\\s+${ex[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:.*\\((\\S+)\\)\\s*$`, "m").exec(tail);
    return tab ? hrefOf(tab[1]) : null;
  }
  if (family === "playwright") {
    const m = lastMatch(/^-\s*Page URL:\s*(\S+)\s*$/m, text);
    return m ? hrefOf(m[1]) : null;
  }
  return null;
}

// Pagina "[selected]" dell'elenco "## Pages" di Chrome DevTools, nei due formati del server:
// `N: <url> [selected]` e (versioni recenti, verificato il 2026-09-23) `N: <titolo> (<url>) [selected]`.
// Il titolo è della pagina: l'URL si prende SOLO dall'ultimo gruppo fra parentesi ancorato a
// "[selected]" in fondo alla riga; esattamente una riga selezionata, altrimenti ignoto (K6).
export function selectedPageUrl(pages) {
  const sel = String(pages).split(/\r?\n/).filter((l) => /^\s*\d+:.*\s\[selected\]\s*$/.test(l));
  if (sel.length !== 1) return null;
  const m = /\((\S+)\)\s+\[selected\]\s*$/.exec(sel[0]) ?? /^\s*\d+:\s*(\S+)\s+\[selected\]\s*$/.exec(sel[0]);
  return m ? hrefOf(m[1]) : null;
}

export const textOfResponse = (resp) => (typeof resp === "string" ? resp : Array.isArray(resp) ? textOf(resp) : resp && typeof resp === "object" && Array.isArray(resp.content) ? textOf(resp.content) : "");

// Nuovo stato { url, tab } dopo la chiamata, dato lo stato precedente e la risposta.
// Solo un navigate (o una storia) riuscito con l'URL effettivo rende noto l'URL;
// i cambi di scheda lo azzerano; le letture e le azioni lo lasciano com'è.
export function nextOrigin(prev, call, state, resp) {
  const reset = { url: null, tab: null };
  if (state !== "ok") return reset;
  let st = { ...prev };
  let navigated = null;
  for (const a of call.actions ?? [call]) {
    if (a.kind === "other" || a.kind === "script") return reset;
    if (a.switches) { st = { ...reset }; navigated = null; continue; }
    if (a.kind === "navigate") navigated = a;
  }
  if (!navigated) return st;
  const landed = landedUrl(call.family, textOfResponse(resp));
  return landed ? { url: landed, tab: navigated.tab ?? null } : reset;
}

export function record(input, env = process.env) {
  const tool = String(input.tool_name ?? "");
  if (!isBrowserTool(tool)) return null;
  const st = loadHookState(input, env);
  if (!st.jvc || !st.session?.env || !st.sessionFile) return null;
  const b = st.session.browser ?? {};
  const prev = { url: typeof b.current_url === "string" && b.current_url ? b.current_url : null, tab: b.tab ?? null };
  let next;
  try { next = nextOrigin(prev, classify(tool, input.tool_input), responseState(input.tool_response), input.tool_response); } catch { next = { url: null, tab: null }; }
  if (next.url === prev.url && (next.tab ?? null) === (prev.tab ?? null)) return null;
  updateSessionFile(st.sessionFile, (s) => { s.browser = { ...(s.browser ?? {}), current_url: next.url, tab: next.tab, updated_by: "browser-origin" }; });
  return null;
}

// In caso di guasto: azzera (mai lasciare un'origine non confermata).
export function resetOnFailure(input, env = process.env) {
  try {
    const st = loadHookState(input, env);
    if (st.jvc && st.sessionFile && st.session?.browser?.current_url != null) {
      updateSessionFile(st.sessionFile, (s) => { s.browser = { ...(s.browser ?? {}), current_url: null, tab: null, updated_by: "browser-origin" }; });
    }
  } catch { /* stato illeggibile: i guard negano comunque */ }
}
