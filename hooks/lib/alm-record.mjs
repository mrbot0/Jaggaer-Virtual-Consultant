// alm-record (PostToolUse sugli strumenti MCP dell'ALM, fail-OPEN) — F0.2. Registra in session.alm.created[] le
// issue, esecuzioni e pagine CREATE dal plugin in questa sessione (solo con risposta riuscita): guard-alm-write consente
// update, transizioni e alm_import_results solo su questi bersagli. Le chiavi si leggono dalla risposta del server
// (campo "key"; altrimenti la prima chiave di issue del testo; per le pagine il campo "id").
import { loadHookState } from "./workspace.mjs";
import { updateSessionFile } from "./session-state.mjs";
import { classifyAlm } from "./alm.mjs";
import { responseState, textOfResponse } from "./browser-origin.mjs";

const MAX = 500;

export function createdFrom(c, text) {
  const out = [];
  const keys = [...String(text).matchAll(/"key"\s*:\s*"([A-Z][A-Z0-9_]{0,30}-\d{1,9})"/g)].map((m) => m[1]);
  if (keys.length) out.push(...keys);
  else { const m = /\b([A-Z][A-Z0-9_]{0,30}-\d{1,9})\b/.exec(String(text)); if (m) out.push(m[1]); }
  if (c.object === "page") { const m = /"id"\s*:\s*"?(\d{1,20})"?/.exec(String(text)); if (m) out.push(m[1]); }
  return [...new Set(out)];
}

export function record(input, env = process.env) {
  const c = classifyAlm(input.tool_name);
  if (!c || c.category !== "create") return null;
  const st = loadHookState(input, env);
  if (!st.jvc || !st.sessionFile || !st.session) return null;
  if (responseState(input.tool_response) !== "ok") return null;
  const keys = createdFrom(c, textOfResponse(input.tool_response));
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
