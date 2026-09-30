// Uso di token del manager (WP10d D6, R5 ≤ 15 %): la sessione principale non passa da subagent-trace, quindi i suoi
// token si misurano dal transcript della sessione principale — righe assistant non sidechain, una voce per
// message.id (input + output + cache_creation, come subagent-trace). Incrementale: lo stato (offset, totale, ultimi
// id visti) è in customers/<C>/.sessions/<sid>/manager-usage.json, protetto in scrittura; lo aggiorna stop-integrity
// a ogni fine turno e registra in audit il delta (kind budget, subject manager).
import { readFileSync, openSync, readSync, fstatSync, closeSync } from "node:fs";
import { join } from "node:path";
import { sessionDir } from "./workspace.mjs";
import { writeFileAtomic, withFileLock } from "./fsx.mjs";
import { appendAudit } from "./audit.mjs";

export const MAX_READ = 8 * 1024 * 1024;
const MAX_IDS = 2000;
export const managerUsageFile = (ws, customer, sid) => join(sessionDir(ws, customer, sid), "manager-usage.json");

export function updateManagerUsage(ws, customer, sid, transcriptPath, { scope = null } = {}) {
  if (typeof transcriptPath !== "string" || !transcriptPath) return null;
  const f = managerUsageFile(ws, customer, sid);
  return withFileLock(`${f}.lock`, () => {
    let st;
    try { st = JSON.parse(readFileSync(f, "utf8")); } catch { st = null; }
    if (!st || typeof st !== "object") st = { tokens: 0, by_model: {}, offset: 0, ids: [], transcript: transcriptPath };
    if (st.transcript !== transcriptPath) { st.offset = 0; st.transcript = transcriptPath; }
    let fd;
    try { fd = openSync(transcriptPath, "r"); } catch { return st; }
    let text = "";
    let consumed = 0;
    try {
      const size = fstatSync(fd).size;
      if (size < st.offset) st.offset = 0;
      const len = Math.min(size - st.offset, MAX_READ);
      if (len <= 0) return st;
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, st.offset);
      const last = buf.lastIndexOf(0x0a);
      if (last < 0) return st;
      consumed = last + 1;
      text = buf.subarray(0, consumed).toString("utf8");
    } finally { closeSync(fd); }
    // una voce per message.id: le righe di uno stesso messaggio ripetono l'usage (vale l'ultima, come subagent-trace);
    // gli id già contati in un turno precedente non si ricontano
    const seen = new Set(st.ids ?? []);
    const batch = new Map();
    let anon = 0;
    for (const l of text.split("\n")) {
      if (!l.includes('"assistant"')) continue;
      let ev;
      try { ev = JSON.parse(l); } catch { continue; }
      if (ev?.type !== "assistant" || ev.isSidechain === true || ev.agentId || !ev.message?.usage || ev.message.model === "<synthetic>") continue;
      const id = ev.message.id ?? ev.uuid ?? `anon-${st.offset}-${anon++}`;
      if (seen.has(id)) continue;
      const u = ev.message.usage;
      batch.set(id, { n: (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), model: ev.message.model ?? "" });
    }
    let delta = 0;
    for (const [id, { n, model }] of batch) {
      seen.add(id);
      const k = /haiku/i.test(model) ? "haiku" : /sonnet/i.test(model) ? "sonnet" : /opus/i.test(model) ? "opus" : "other";
      st.by_model[k] = (st.by_model[k] ?? 0) + n;
      delta += n;
    }
    st.tokens += delta;
    st.offset += consumed;
    st.ids = [...seen].slice(-MAX_IDS);
    st.updated_at = new Date().toISOString();
    writeFileAtomic(f, JSON.stringify(st));
    if (delta > 0) {
      try { appendAudit(ws, { session: sid, customer, scope, kind: "budget", actor: "hook:stop-integrity", payload: { subject: "manager", delta, tokens: st.tokens, by_model: st.by_model } }); } catch { /* l'audit non cambia la misura */ }
    }
    return st;
  }, { timeoutMs: 4000 });
}
