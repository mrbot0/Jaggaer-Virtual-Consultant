// Origine OSSERVATA del browser (K6.2, prerequisito bloccante della revisione WP06): observe-append
// mantiene session.browser.current_url dalla pagina che il risultato dello strumento mostra — snapshot,
// read_page, redirect, click su link, cambi di scheda — con la semantica fail-closed di browser-origin:
//  - un URL diventa noto SOLO con un marcatore positivo della famiglia, nella posizione che la pagina
//    non controlla: DevTools = la PRIMA riga `uid=… RootWebArea … url="…"` dello snapshot, oppure la sola
//    pagina "[selected]" di "## Pages"; Claude browser / Claude in Chrome = la scheda "Executed on tabId"
//    del Tab Context; Playwright = "- Page URL:" della sezione "### Page state";
//  - navigate/back/forward: esattamente la semantica di browser-origin (nextOrigin, URL di arrivo);
//  - cambio di scheda senza marcatore della nuova scheda, click, invio, dialog accettato senza marcatore
//    ⇒ ignoto (la pagina può essere cambiata); risposta d'errore o non interpretabile ⇒ ignoto;
//  - scheda del marcatore diversa da quella chiesta dalla chiamata ⇒ ignoto;
//  - letture e input senza invio, senza marcatore ⇒ invariato (mai promuovere un ignoto).
import { nextOrigin, selectedPageUrl, textOfResponse } from "./browser-origin.mjs";

const RESET = { url: null, tab: null };
function hrefOf(url) { try { return new URL(String(url).trim()).href; } catch { return null; } }

// → { url, tab? } | null
export function observedLocation(family, text) {
  if (typeof text !== "string" || !text) return null;
  if (family === "chrome-devtools") {
    const first = /^[ \t]*uid=\S+[ \t]+(\S+)(.*)$/m.exec(text);
    if (first && first[1] === "RootWebArea") {
      const u = /\surl="((?:[^"\\]|\\.)*)"\s*$/.exec(first[2]);
      if (u) return { url: hrefOf(u[1].replace(/\\"/g, '"')) };
    }
    const i = text.lastIndexOf("## Pages");
    if (i >= 0) { const u = selectedPageUrl(text.slice(i)); if (u) return { url: u }; }
    return null;
  }
  if (family === "claude-browser") {
    const i = text.lastIndexOf("Tab Context:");
    if (i < 0) return null;
    const tail = text.slice(i);
    const ex = /Executed on tabId:\s*(\S+)/.exec(tail);
    if (!ex) return null;
    const esc = ex[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m = new RegExp(`tabId\\s+${esc}:.*\\((\\S+)\\)\\s*$`, "m").exec(tail);
    return m ? { url: hrefOf(m[1]), tab: ex[1] } : null;
  }
  if (family === "playwright") {
    const i = text.indexOf("### Page state");
    if (i < 0) return null;
    const m = /^-\s*Page URL:\s*(\S+)\s*$/m.exec(text.slice(i));
    return m ? { url: hrefOf(m[1]) } : null;
  }
  return null;
}

// Nuovo stato { url, tab } dopo la chiamata. state: "ok" | "error" | "unknown" (responseState).
export function nextObserved(prev, call, state, resp) {
  if (state !== "ok") return RESET;
  const actions = call.actions ?? [call];
  if (actions.some((a) => a.kind === "other" || a.kind === "script")) return RESET;
  if (actions.some((a) => a.kind === "navigate")) return nextOrigin(prev, call, state, resp);
  const loc = observedLocation(call.family, textOfResponse(resp));
  const asked = actions.map((a) => a.tab).filter((t) => t != null).at(-1) ?? null;
  const switches = actions.some((a) => a.switches);
  if (loc?.url) {
    if (loc.tab != null && asked != null && String(loc.tab) !== String(asked)) return RESET;
    // scheda come la confronta guard-environment: quella nominata dalla chiamata (null = scheda attiva);
    // si conserva la scheda registrata solo se il marcatore conferma che è la stessa.
    const tab = asked != null ? String(asked) : !switches && prev.tab != null && loc.tab != null && String(loc.tab) === String(prev.tab) ? String(prev.tab) : null;
    return { url: loc.url, tab };
  }
  if (switches) return RESET;
  if (actions.some((a) => a.kind === "click" || a.submits || (a.kind === "dialog" && a.submits))) return RESET;
  return { url: prev.url ?? null, tab: prev.tab ?? null };
}
