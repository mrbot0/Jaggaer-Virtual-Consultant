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
  // revisione di sicurezza: in produzione policy, approvazioni e host non si adottano da un file modificato in sessione
  if (old.type === "prod") return { reason: "environments.yaml è cambiato dopo /use env: in produzione serve /use env dell'utente" };
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
  // revisione di sicurezza: host o URL di base cambiati ⇒ la verifica dell'impronta va rifatta (env-check)
  const sameTarget = old.base_url === n.base_url && JSON.stringify([...(old.allowed_hosts ?? [])].sort()) === JSON.stringify([...(n.allowed_hosts ?? [])].sort());
  const env = { ...old, ...(sameTarget ? {} : { verified: false, verified_at: null }), label: n.label ?? null, base_url: n.base_url, allowed_hosts: n.allowed_hosts, policy: n.policy,
    source_sha256: envs.sha256, remediation: remediation.doc, remediation_sha256: remediation.sha256, refreshed_at: new Date().toISOString() };
  try {
    updateSessionFile(sessionFile, (s) => { if (s.env?.id === old.id) s.env = env; return s; });
    appendAudit(ws, { session: session.session_id ?? null, customer, scope: session.scope ?? null, kind: "session", actor: "hook:env-refresh",
      payload: { action: "env-refresh", env: old.id, from: old.source_sha256, to: envs.sha256, ...envChanges(old, env, { sameTarget }) } });
  } catch { /* lo stato si riallinea alla prossima chiamata */ }
  return { env };
}

// 29/10/2026 (decisione dell'utente, punto 10 del piano): registro delle modifiche agli ambienti fatte durante la sessione.
// Il riassunto del cambiamento rispetto al vecchio session.env va nel payload dell'audit (la console degli agenti lo
// mostra: agents status, agents envlog): host aggiunti e tolti, URL di base cambiato, chiavi di policy cambiate (anche
// annidate, per chiave di primo livello), verifica dell'impronta azzerata, remediation-scope.yaml cambiato.
const canon = (v) => (Array.isArray(v) ? `[${v.map(canon).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(",")}}` : JSON.stringify(v ?? null));
export function envChanges(old, env, { sameTarget = null } = {}) {
  const hosts = (e) => new Set((e?.allowed_hosts ?? []).map((h) => String(h).toLowerCase()));
  const before = hosts(old);
  const after = hosts(env);
  const pOld = old?.policy && typeof old.policy === "object" ? old.policy : {};
  const pNew = env?.policy && typeof env.policy === "object" ? env.policy : {};
  const same = sameTarget ?? (old?.base_url === env?.base_url && before.size === after.size && [...before].every((h) => after.has(h)));
  return {
    hosts_added: [...after].filter((h) => !before.has(h)).sort(),
    hosts_removed: [...before].filter((h) => !after.has(h)).sort(),
    base_url_changed: (old?.base_url ?? null) !== (env?.base_url ?? null),
    policy_changed: [...new Set([...Object.keys(pOld), ...Object.keys(pNew)])].filter((k) => canon(pOld[k]) !== canon(pNew[k])).sort(),
    verified_reset: !same && old?.verified === true,
    remediation_changed: (old?.remediation_sha256 ?? null) !== (env?.remediation_sha256 ?? null),
  };
}
