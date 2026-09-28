// Parti comuni dei guard del browser (K5, FAIL-CLOSED): contesto, classificazione,
// allow-list degli host dell'ambiente DICHIARATO (§51.2), integrità dei file di
// configurazione copiati in session.env da `use env`.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { guardContext, denyAudited } from "./common.mjs";
import { resolveTarget, subset } from "../paths.mjs";
import { classify, isBrowserTool, normalizeHost } from "../browser-tools.mjs";

// Come `guarded` di common.mjs ma sul predicato isBrowserTool (tool_name
// ricontrollato qui: la semantica dei matcher non è verificata). Workspace non
// JVC ⇒ nessuna opinione; qualunque eccezione risale a runHook ⇒ deny.
export function browserGuarded(guard, fn) {
  return (input, env = process.env) => {
    if (!isBrowserTool(String(input.tool_name ?? ""))) return null;
    const ctx = guardContext(input, env);
    if (!ctx.jvc) return null;
    ctx.call = classify(ctx.tool, ctx.ti);
    ctx.actions = ctx.call.actions ?? [ctx.call];
    const no = (reason) => denyAudited(ctx, guard, reason);
    return fn(ctx, no);
  };
}

const sha = (buf) => createHash("sha256").update(buf).digest("hex");
const readText = (f) => { try { return readFileSync(f, "utf8"); } catch (err) { if (err.code === "ENOENT") return null; throw err; } };

// L'ambiente dichiarato e la sua integrità → { env } | { reason }.
// environments.yaml (e remediation-scope.yaml, se `withRemediation`) devono
// essere quelli copiati da `use env`: cambiati o spariti ⇒ deny.
export function declaredEnv(ctx, { withRemediation = false } = {}) {
  if (!ctx.session) return { reason: "nessuna sessione con cliente attivo: /jaggaer-virtual-consultant:use customer <ID>, poi /use env <id>" };
  const env = ctx.session.env;
  if (!env) return { reason: "nessun ambiente dichiarato: /use env <id> prima di usare il browser (§51.2)" };
  const cfg = join(ctx.ws, "customers", ctx.customer, "config");
  const text = readText(join(cfg, "environments.yaml"));
  if (text == null) return { reason: "environments.yaml assente: l'ambiente dichiarato non è più verificabile" };
  if (sha(text) !== env.source_sha256) return { reason: "environments.yaml è cambiato dopo /use env: riesegui /use env <id>" };
  if (withRemediation) {
    const r = readText(join(cfg, "remediation-scope.yaml"));
    const h = r == null ? null : sha(r);
    if (h !== (env.remediation_sha256 ?? null)) return { reason: "remediation-scope.yaml è cambiato dopo /use env: riesegui /use env <id>" };
  }
  return { env };
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const allowList = (env) => (env.allowed_hosts ?? []).map((h) => {
  const n = normalizeHost(h);
  const i = n.lastIndexOf(":");
  return i > 0 && /^\d+$/.test(n.slice(i + 1)) ? { host: n.slice(0, i), port: n.slice(i + 1) } : { host: n, port: "" };
});

// Un URL è raggiungibile nell'ambiente dichiarato? → null (sì) o il motivo del no.
// WHATWG URL: schema http(s), niente userinfo, niente IP letterali, host uguale a
// una voce di allowed_hosts (minuscolo, punto finale tolto, IDN in punycode),
// porta non di default solo se dichiarata.
export function urlRefusal(raw, env) {
  if (typeof raw !== "string" || !raw.trim()) return "URL mancante o non valido";
  let u;
  try { u = new URL(raw.trim()); } catch { return `URL non valido (serve un URL assoluto http/https): ${String(raw).slice(0, 120)}`; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return `schema non ammesso: ${u.protocol} (solo http/https verso host dichiarati)`;
  if (u.username || u.password) return `URL con credenziali (userinfo) negato: ${u.host}`;
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (!host) return "URL senza host";
  if (host.startsWith("[") || IPV4.test(host)) return `IP letterale non ammesso: ${host}`;
  const ok = allowList(env).some((e) => e.host === host && e.port === (u.port ?? ""));
  if (!ok) {
    const sameHost = allowList(env).some((e) => e.host === host);
    return sameHost ? `porta non dichiarata: ${host}:${u.port} (ambiente ${env.id})` : `host non dichiarato: ${host} (ambiente ${env.id}; allowed_hosts: ${env.allowed_hosts.join(", ")}). Gli host SSO/CDN vanno aggiunti in environments.yaml fuori sessione (§58)`;
  }
  return null;
}

// Script nella pagina (giro di correzione 1, I1): negati in ogni ambiente,
// senza denylist. La lettura passa da snapshot / read_page / get_page_text.
export const SCRIPT_DENIED = "script nella pagina negati in ogni ambiente (evaluate_script, javascript_tool, browser_evaluate, run_code, initScript): per leggere usa take_snapshot, read_page o get_page_text";

// File scritti dal server MCP (filePath, filename, outputDirPath, …): solo nelle
// cartelle di lavoro del cliente attivo (sessione, evidenze, run), mai su file
// di stato, registro delle approvazioni, audit o conoscenza.
const OUTPUT_OK = (c, sid) => [`customers/${c}/.sessions/${sid}/**`, `customers/${c}/evidence/**`, `customers/${c}/runs/**`].map((x) => x.toLowerCase());
const OUTPUT_NO = /(^|\/)(session\.json|approvals\.jsonl|invocations\.jsonl|current-session|compact-summary\.md|[^/]*\.lock)$|(^|\/)blackboard(\/|$)/;
export function outputRefusal(ctx, outputs) {
  for (const raw of outputs ?? []) {
    if (typeof raw !== "string" || !raw.trim()) return "percorso di output non valido";
    // WP07 giro 3: il server ripete il nome del file nel risultato (prima del marcatore di pagina): mai a capo o controlli
    if (/[\u0000-\u001f\u007f\u0085\u2028\u2029]/.test(raw)) return `nome del file di output con caratteri di controllo o separatori di riga: ${JSON.stringify(raw)}`;
    let T;
    try { T = resolveTarget(raw, { cwd: ctx.cwd, ws: ctx.ws }); } catch (err) { return `percorso di output negato: ${err.message}`; }
    const rels = [...T.ws];
    const ok = ctx.customer && ctx.sid && rels.length > 0 && rels.every((p) => OUTPUT_OK(ctx.customer, ctx.sid).some((g) => subset(p, g)) && !OUTPUT_NO.test(p));
    if (!ok) return `il server del browser scriverebbe un file fuori dalle cartelle di lavoro della sessione (customers/<C>/.sessions/<sid>/, evidence/, runs/) o su un file di stato: ${raw}`;
  }
  return null;
}

export { normalizeHost };

// WP08 — decisione vincolante del controllore su WP07 (sicurezza): la famiglia del browser di Claude (Claude in Chrome,
// Claude Browser) assegna ref a elementi che non stampa (read_page troncato o profondo, find), quindi il legame
// ref ↔ SEL non è mai affidabile per lei. Fuori dalla sandbox (preprod, prod, dev e ogni tipo diverso da "sandbox")
// ogni sua azione CON EFFETTO (click, testo, tasti, trascinamento, form_input, upload, script, strumenti non
// classificati, batch che ne contiene una) è negata; letture e navigazione restano ammesse ovunque.
const EFFECT_KINDS = new Set(["input", "click", "upload", "script", "other"]);
const effectful = (a) => EFFECT_KINDS.has(a.kind) || (a.kind === "dialog" && a.submits) || a.submits === true;
export function claudeEffectRefusal(ctx, envType) {
  if (envType === "sandbox") return null;
  const bad = (ctx.actions ?? []).find((a) => (a.family ?? ctx.call?.family) === "claude-browser" && effectful(a));
  if (!bad) return null;
  return `azione con effetto del browser di Claude (${bad.op ?? ctx.tool}${bad.action ? ` ${bad.action}` : ""}) negata in ${envType ? `ambiente ${envType}` : "ambiente ignoto"}: `
    + "questa famiglia assegna ref a elementi che non mostra, il legame con il SEL del passo non è verificabile. Fuori dalla sandbox i passi con effetto si eseguono con Chrome DevTools MCP (o Playwright); letture e navigazione con il browser di Claude restano ammesse";
}
