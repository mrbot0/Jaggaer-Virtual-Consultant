// Ricarica automatica dell'ambiente dichiarato (28/10/2026, decisione dell'utente: «anche i file di ambienti devono essere
// scrivibili dagli agenti»). Se environments.yaml (o remediation-scope.yaml) cambia dopo `use env`, i guard e env-check non
// negano più con "riesegui /use env": rileggono il file, rivalidano la voce dello stesso id e aggiornano session.env.
// Fail-closed: file illeggibile o non valido, id sparito o tipo cambiato ⇒ { reason } come prima.
//   refreshEnv({ ws, customer, sessionFile, session }) → { env } | { reason }
import { appendAudit } from "./audit.mjs";
import { updateSessionFile } from "./session-state.mjs";

export async function refreshEnv({ ws, customer, sessionFile, session }) {
  const old = session?.env;
  if (!old?.id) return { reason: "nessun ambiente dichiarato: /use env <id>" };
  let v;
  try { v = await import("../../scripts/kb/validate-env.mjs"); } catch (err) { return { reason: `ricarica dell'ambiente non riuscita (${String(err?.message ?? err).slice(0, 80)})` }; }
  let envs;
  let remediation;
  try {
    envs = v.loadEnvironmentsFile(v.environmentsFile(ws, customer));
    remediation = v.loadRemediationScope(ws, customer);
  } catch (err) { return { reason: `environments.yaml non valido dopo la modifica: ${String(err?.message ?? err).slice(0, 160)}` }; }
  const decl = envs.doc.environments.find((e) => e.id === old.id);
  if (!decl) return { reason: `l'ambiente ${old.id} non c'è più in environments.yaml: /use env <id>` };
  const n = v.normalizeEnvironment(decl);
  // il tipo non cambia senza /use env (sandbox → prod cambierebbe tutte le regole a metà sessione)
  if (n.type !== old.type) return { reason: `il tipo dell'ambiente ${old.id} è cambiato (${old.type} → ${n.type}): /use env ${old.id}` };
  const env = { ...old, label: n.label ?? null, base_url: n.base_url, allowed_hosts: n.allowed_hosts, policy: n.policy,
    source_sha256: envs.sha256, remediation: remediation.doc, remediation_sha256: remediation.sha256, refreshed_at: new Date().toISOString() };
  try {
    updateSessionFile(sessionFile, (s) => { if (s.env?.id === old.id) s.env = env; return s; });
    appendAudit(ws, { session: session.session_id ?? null, customer, scope: session.scope ?? null, kind: "session", actor: "hook:env-refresh",
      payload: { action: "env-refresh", env: old.id, from: old.source_sha256, to: envs.sha256 } });
  } catch { /* lo stato si riallinea alla prossima chiamata */ }
  return { env };
}
