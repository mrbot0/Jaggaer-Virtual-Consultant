// Origine OSSERVATA del browser (K6.2; WP07 giro di correzione 1, sicurezza C1, I2, I3): observe-append
// mantiene session.browser.current_url dalla pagina che il risultato dello strumento mostra — snapshot,
// read_page, redirect, click su link, cambi di scheda — con la semantica fail-closed di browser-origin:
//  - un URL diventa noto SOLO con un marcatore positivo letto da posizioni che il server controlla
//    (hooks/lib/origin-markers.mjs: uscita strutturata; marcatore unico e ancorato subito dopo l'intestazione
//    del server; nessun separatore di riga Unicode nella riga);
//  - gli strumenti che restituiscono testo della pagina (console, rete, dialog, script, get_page_text, find,
//    WebMCP, audit) non promuovono MAI: lasciano com'è o azzerano;
//  - navigate/back/forward: esattamente la semantica di browser-origin (nextOrigin, URL di arrivo);
//  - dialog aperto o riconnessione del server DevTools ⇒ ignoto;
//  - cambio di scheda senza marcatore della nuova scheda, click, invio, dialog accettato senza marcatore ⇒ ignoto;
//  - con pageId: la pagina chiesta, non la selezionata; scheda del marcatore diversa da quella chiesta ⇒ ignoto;
//  - letture e input senza invio, senza marcatore ⇒ invariato (mai promuovere un ignoto).
import { nextOrigin, textOfResponse, mayNavigate } from "./browser-origin.mjs";
import { devtoolsPageUrl, devtoolsRootUrl, claudeTabContext, playwrightPageUrl, hasDialog, RECONNECT, isPageTextOp } from "./origin-markers.mjs";

const RESET = { url: null, tab: null };

// → { url, tab? } | null
export function observedLocation(family, text, { asked = null, resp = null } = {}) {
  if (typeof text !== "string" || !text) return null;
  if (family === "chrome-devtools") {
    if (hasDialog(text) || RECONNECT.test(text)) return null;
    const root = devtoolsRootUrl(text);
    const hasPages = /^## Pages$/m.test(text) || Array.isArray(resp?.structuredContent?.pages);
    const listed = hasPages ? devtoolsPageUrl(text, { asked, resp }) : null;
    if (hasPages && !listed) return null;
    if (root && listed && root !== listed) return null;
    const url = listed ?? root;
    return url ? { url } : null;
  }
  if (family === "claude-browser") {
    const c = claudeTabContext(text);
    return c?.url ? c : null;
  }
  if (family === "playwright") {
    const u = playwrightPageUrl(text);
    return u ? { url: u } : null;
  }
  return null;
}

// Nuovo stato { url, tab } dopo la chiamata. state: "ok" | "error" | "unknown" (responseState).
export function nextObserved(prev, call, state, resp) {
  if (state !== "ok") return RESET;
  const actions = call.actions ?? [call];
  if (actions.some((a) => a.kind === "other" || a.kind === "script")) return RESET;
  const text = textOfResponse(resp);
  if (call.family === "chrome-devtools" && (hasDialog(text) || RECONNECT.test(text))) return RESET;
  if (actions.some((a) => a.kind === "navigate")) return nextOrigin(prev, call, state, resp);
  const switches = actions.some((a) => a.switches);
  const effect = actions.some(mayNavigate);
  if (actions.some(isPageTextOp)) return switches || effect ? RESET : { url: prev.url ?? null, tab: prev.tab ?? null };
  const asked = actions.map((a) => a.tab).filter((t) => t != null).at(-1) ?? null;
  const loc = observedLocation(call.family, text, { asked, resp });
  if (loc?.url) {
    if (loc.tab != null && asked != null && String(loc.tab) !== String(asked)) return RESET;
    // scheda come la confronta guard-environment: quella nominata dalla chiamata (null = scheda attiva);
    // si conserva la scheda registrata solo se il marcatore conferma che è la stessa.
    const tab = asked != null ? String(asked) : !switches && prev.tab != null && loc.tab != null && String(loc.tab) === String(prev.tab) ? String(prev.tab) : null;
    return { url: loc.url, tab };
  }
  if (switches || effect) return RESET;
  return { url: prev.url ?? null, tab: prev.tab ?? null };
}
