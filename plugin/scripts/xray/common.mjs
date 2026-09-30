// Parti comuni di scripts/xray/*: contesto (workspace, cliente, config/xray.yaml, AlmAdapter dalla factory, coda
// offline), registrazione in session.alm.created delle issue create dagli script (come alm-record per il server MCP),
// audit, uscita coerente (--json). Codici d'uscita comuni: 0 ok (anche "in coda": ADR-22) · 1 argomenti o
// configurazione · 2 errore di sistema · 3 rifiuto, autenticazione o verifica non riuscita.
import { AlmError, safeMessage } from "../../mcp/alm-server/adapter.mjs";
import { almContext } from "../../mcp/alm-server/factory.mjs";
import { OfflineQueue } from "../../mcp/alm-server/queue.mjs";
import { workspaceCustomer } from "../run/fixtures.mjs";
import { fail } from "../lib/args.mjs";

export class XrayError extends Error { constructor(code, msg) { super(msg); this.code = code; } }

export async function xrayContext(opts, env = process.env, { fetchImpl } = {}) {
  const { ws, customer } = workspaceCustomer(opts, env);
  if (!customer) throw new XrayError(1, "cliente non determinato: --customer <C> o una sessione attiva");
  const c = await almContext({ env, ws, customer, fetchImpl });
  return { ...c, queue: new OfflineQueue(ws, customer, { env }) };
}

// Chiavi create dagli script (publish, defect) in session.alm.created: guard-alm-write consente poi update, link e
// import solo su queste. Nessuna sessione ⇒ nulla (esecuzione in CI).
export async function recordCreated(ws, env, key, kind, tool) {
  try {
    const { resolveSessionId, loadSession, updateSession } = await import("../admin/session.mjs");
    const sid = resolveSessionId({ workspace: ws, env });
    if (!sid) return false;
    const { session, file } = loadSession(ws, sid);
    if (!session || !file) return false;
    updateSession(file, (s) => {
      const cur = Array.isArray(s.alm?.created) ? s.alm.created : [];
      if (!cur.some((x) => String(typeof x === "string" ? x : x?.key).toUpperCase() === key)) s.alm = { ...(s.alm ?? {}), created: [...cur, { key, kind, tool, ts: new Date().toISOString() }].slice(-500) };
      return s;
    });
    return true;
  } catch { return false; }
}

export async function audit(ws, env, customer, payload, actor) {
  try {
    const { resolveSessionId } = await import("../admin/session.mjs");
    const { appendAudit } = await import("../../hooks/lib/audit.mjs");
    appendAudit(ws, { session: resolveSessionId({ workspace: ws, env }) ?? "cli", customer, scope: payload.scope ?? null, kind: "run", actor, payload });
  } catch { /* l'audit non cambia l'esito */ }
}

// Errori ⇒ codice d'uscita; il messaggio è già redatto dagli adattatori.
export function failWith(asJson, err) {
  if (err instanceof XrayError) return fail(asJson, err.code, err.message);
  if (err instanceof AlmError) return fail(asJson, err.code === "config" || err.code === "input" ? 1 : 3, err.message, { alm_error: err.code, network: err.network });
  return fail(asJson, 2, `errore di sistema: ${safeMessage(err?.message ?? err)}`);
}

// key=value posizionali (le CLI non ricevono JSON inline: i guard lo negano)
export function kv(positional) {
  const out = {};
  for (const p of positional) { const i = p.indexOf("="); if (i > 0) out[p.slice(0, i)] = p.slice(i + 1); }
  return out;
}
