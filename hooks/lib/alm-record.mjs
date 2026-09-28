// alm-record (PostToolUse sugli strumenti MCP dell'ALM, fail-OPEN) — F0.2. Registra in session.alm.created[] le
// issue, esecuzioni e pagine CREATE dal plugin in questa sessione (solo con risposta riuscita): guard-alm-write consente
// update, transizioni e alm_import_results solo su questi bersagli. Le chiavi si leggono dalla risposta del server
// (campo "key"; altrimenti la prima chiave di issue del testo; per le pagine il campo "id").
import { loadHookState } from "./workspace.mjs";
import { updateSessionFile } from "./session-state.mjs";
import { classifyAlm, ISSUE_KEY } from "./alm.mjs";
import { responseState, textOfResponse } from "./browser-origin.mjs";

const MAX = 500;

// WP08 giro 1 (I5): SOLO la chiave dell'entità creata, dal campo strutturato di primo livello della risposta JSON
// ("key" per le issue, "id" per le pagine); risposta non JSON, elenchi, chiavi annidate (parent, link) o testo libero ⇒
// nulla (il modello controlla parent, link e summary: mai registrare una chiave umana come creata dal plugin).
export function createdFrom(c, text, structured = null) {
  let obj = structured && typeof structured === "object" && !Array.isArray(structured) ? structured : null;
  if (!obj) { try { obj = JSON.parse(String(text).trim()); } catch { return []; } }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return [];
  if (typeof obj.key === "string" && ISSUE_KEY.test(obj.key)) return [obj.key];
  if (c.object === "page" && (typeof obj.id === "string" || typeof obj.id === "number") && /^d{1,20}$/.test(String(obj.id))) return [String(obj.id)];
  return [];
}

export function record(input, env = process.env) {
  const c = classifyAlm(input.tool_name);
  if (!c || c.category !== "create") return null;
  const st = loadHookState(input, env);
  if (!st.jvc || !st.sessionFile || !st.session) return null;
  if (responseState(input.tool_response) !== "ok") return null;
  const resp = input.tool_response;
  const keys = createdFrom(c, textOfResponse(resp), resp && typeof resp === "object" && !Array.isArray(resp) ? resp.structuredContent ?? null : null);
  if (!keys.length) return null;
  const ts = new Date().toISOString();
  updateSessionFile(st.sessionFile, (s) => {
    const alm = s.alm && typeof s.alm === "object" && !Array.isArray(s.alm) ? { ...s.alm } : {};
    const cur = Array.isArray(alm.created) ? alm.created : [];
    const have = new Set(cur.map((x) => String(typeof x === "string" ? x : x?.key).toUpperCase()));
    alm.created = [...cur, ...keys.filter((k) => !have.has(k.toUpperCase())).map((key) => ({ key, kind: c.object, tool: c.op, ts }))].slice(-MAX);
    s.alm = alm;
  });
  return null;
}
