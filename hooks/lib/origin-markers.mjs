// Marcatori positivi dell'origine del browser (WP07 giro di correzione 1, sicurezza C1 e I2). Condivisi da
// browser-origin (navigate, K5) e observed-origin (observe-append, K6). Regola: l'URL si prende SOLO da una
// posizione che il server controlla e la pagina no.
//  - uscita strutturata (Chrome DevTools structuredContent.pages {id, url, selected}) quando c'è: mai il testo;
//  - altrimenti ogni marcatore deve essere UNICO e ancorato subito dopo l'intestazione del server:
//      DevTools   "## Pages" una sola volta, prima di ogni sezione con testo della pagina; la riga dell'id chiesto
//                 (pageId) o, senza pageId, l'unica "[selected]"; "## Latest page snapshot" una sola volta con la
//                 riga RootWebArea (unica) subito dopo;
//      Claude     "Tab Context:" una sola volta, ultimo blocco, "- Executed on tabId: N" subito dopo, una sola
//                 riga "  • tabId N: …";
//      Playwright "### Page" / "### Page state" una sola volta con "- Page URL:" (unica) subito dopo;
//  - una riga di marcatore con U+2028, U+2029, \r, \v, \f o U+0085 ⇒ ignoto (i titoli sono della pagina);
//  - DevTools: una sezione "# Open dialog" (messaggio della pagina, scritto PRIMA delle altre sezioni) o l'avviso
//    di riconnessione ("Page ids have changed") ⇒ ignoto.
// Tutto ciò che non si interpreta con certezza restituisce null (il chiamante azzera o non promuove).
export const BAD_LINE = /[\u2028\u2029\r\v\f\u0085]/;
export const RECONNECT = /\bPage ids have changed\b/;
export const hasDialog = (text) => /^# Open dialog\s*$/m.test(String(text ?? ""));
const PAGE_DERIVED_HEADER = /^(# Open dialog|## (Latest page snapshot|WebMCP tools|Network requests|Console messages|Heap Snapshot Data|Lighthouse Audit Results|Extensions|Third-party developer tools|Extension Service Workers)|### Response Body|### Request Body)\s*$/;

export function hrefOf(url) { try { return new URL(String(url).trim()).href; } catch { return null; } }
const idx = (L, pred) => L.reduce((a, l, i) => (pred(l) ? [...a, i] : a), []);

// Strumenti il cui risultato è testo derivato dalla pagina (console, rete, dialog, script, WebMCP, audit):
// non promuovono MAI un'origine (al più la lasciano com'è o la azzerano).
const PAGE_TEXT_OPS = {
  "chrome-devtools": new Set(["list_console_messages", "get_console_message", "list_network_requests", "get_network_request", "handle_dialog", "evaluate_script",
    "lighthouse_audit", "take_heapsnapshot", "performance_start_trace", "performance_stop_trace", "performance_analyze_insight"]),
  "claude-browser": new Set(["get_page_text", "read_console_messages", "read_network_requests", "javascript_tool", "find", "shortcuts_execute", "shortcuts_list"]),
  playwright: new Set(["browser_console_messages", "browser_network_requests", "browser_network_request", "browser_evaluate", "browser_handle_dialog", "browser_run_code_unsafe", "browser_find"]),
};
export const isPageTextOp = (a) => !!PAGE_TEXT_OPS[a?.family]?.has(String(a?.op ?? ""));

// ---- Chrome DevTools ----
function structuredPages(resp) {
  const sc = resp && typeof resp === "object" && !Array.isArray(resp) ? resp.structuredContent : null;
  return sc && Array.isArray(sc.pages) ? sc.pages : null;
}
// URL della pagina chiesta (asked = pageId numerico in stringa) o selezionata dall'elenco "## Pages".
export function devtoolsPageUrl(text, { asked = null, resp = null } = {}) {
  const sp = structuredPages(resp);
  if (sp) {
    const cand = asked != null ? sp.filter((p) => p && String(p.id) === String(asked)) : sp.filter((p) => p && p.selected === true);
    if (cand.length !== 1 || cand[0].isolatedContext || typeof cand[0].url !== "string") return null;
    return hrefOf(cand[0].url);
  }
  const L = String(text ?? "").split("\n");
  const h = idx(L, (l) => l === "## Pages");
  if (h.length !== 1) return null;
  const firstDerived = L.findIndex((l) => PAGE_DERIVED_HEADER.test(l));
  if (firstDerived >= 0 && firstDerived < h[0]) return null;
  const rows = [];
  for (let i = h[0] + 1; i < L.length && /^\d+: /.test(L[i]); i++) rows.push(L[i]);
  if (!rows.length || rows.some((r) => BAD_LINE.test(r))) return null;
  const pick = asked != null ? rows.filter((r) => r.startsWith(`${asked}: `)) : rows.filter((r) => / \[selected\]$/.test(r));
  if (pick.length !== 1) return null;
  const body = pick[0].slice(pick[0].indexOf(": ") + 2).replace(/ \[selected\]$/, "");
  if (/ isolatedContext=\S*$/.test(body)) return null;
  const m = /\((\S+)\)$/.exec(body) ?? /^(\S+)$/.exec(body);
  return m ? hrefOf(m[1]) : null;
}
// URL della radice dello snapshot: la riga subito dopo l'unica "## Latest page snapshot", unica RootWebArea.
export function devtoolsRootUrl(text) {
  const L = String(text ?? "").split("\n");
  const h = idx(L, (l) => l === "## Latest page snapshot");
  if (h.length !== 1) return null;
  const roots = idx(L, (l) => /^\s*uid=\S+ RootWebArea\b/.test(l));
  if (roots.length !== 1 || roots[0] !== h[0] + 1) return null;
  const line = L[roots[0]];
  if (BAD_LINE.test(line)) return null;
  const m = /\surl="([^"]*)"\s*$/.exec(line);
  return m ? hrefOf(m[1]) : null;
}

// ---- Claude browser / Claude in Chrome ----
export function claudeTabContext(text) {
  const L = String(text ?? "").replace(/\n+$/, "").split("\n");
  const h = idx(L, (l) => l === "Tab Context:");
  if (h.length !== 1) return null;
  if ((String(text).match(/Executed on tabId:/g) ?? []).length !== 1) return null;
  const ex = /^- Executed on tabId: (\S+)$/.exec(L[h[0] + 1] ?? "");
  if (!ex) return null;
  const block = L.slice(h[0] + 1);
  if (block.some((l) => BAD_LINE.test(l))) return null;
  // ultimo blocco: dopo "Executed" solo "- Available tabs:" e le righe delle schede
  if (!block.slice(1).every((l) => l === "- Available tabs:" || /^ {2}• tabId \S+: /.test(l))) return null;
  const rows = block.filter((l) => l.startsWith(`  • tabId ${ex[1]}: `));
  if (rows.length !== 1) return null;
  const m = /\((\S+)\)$/.exec(rows[0]);
  return m ? { url: hrefOf(m[1]), tab: ex[1] } : null;
}

// ---- Playwright MCP ("### Page" nelle versioni attuali, "### Page state" nelle precedenti) ----
export function playwrightPageUrl(text) {
  const L = String(text ?? "").split("\n");
  const h = idx(L, (l) => l === "### Page" || l === "### Page state");
  const u = idx(L, (l) => l.startsWith("- Page URL:"));
  if (h.length !== 1 || u.length !== 1 || u[0] !== h[0] + 1) return null;
  if (BAD_LINE.test(L[u[0]])) return null;
  const m = /^- Page URL: (\S+)$/.exec(L[u[0]]);
  return m ? hrefOf(m[1]) : null;
}
