// Origine del browser a consuntivo (K5 giro 2, N1): hook PostToolUse sugli
// strumenti MCP del browser. È l'UNICO punto che rende noto
// session.browser.current_url, e solo dopo un navigate RIUSCITO (risposta
// interpretabile e senza errore). Tutto il resto può solo azzerarlo:
//  - cambi di scheda/pagina/browser (switches) ⇒ ignoto;
//  - back/forward riusciti ⇒ ignoto (destinazione non nota); reload ⇒ invariato;
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

// Nuovo stato { url, tab } dopo la chiamata, dato lo stato precedente.
export function nextOrigin(prev, call, state) {
  const reset = { url: null, tab: null };
  if (state !== "ok") return reset;
  let st = { ...prev };
  for (const a of call.actions ?? [call]) {
    if (a.kind === "other" || a.kind === "script") return reset;
    if (a.switches) { st = { ...reset }; continue; }
    if (a.kind === "navigate") {
      if (a.history) { if (a.historyKind !== "reload") st = { ...reset }; continue; }
      const u = hrefOf(a.url);
      st = u ? { url: u, tab: a.tab ?? null } : { ...reset };
    }
  }
  return st;
}

export function record(input, env = process.env) {
  const tool = String(input.tool_name ?? "");
  if (!isBrowserTool(tool)) return null;
  const st = loadHookState(input, env);
  if (!st.jvc || !st.session?.env || !st.sessionFile) return null;
  const b = st.session.browser ?? {};
  const prev = { url: typeof b.current_url === "string" && b.current_url ? b.current_url : null, tab: b.tab ?? null };
  let next;
  try { next = nextOrigin(prev, classify(tool, input.tool_input), responseState(input.tool_response)); } catch { next = { url: null, tab: null }; }
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
