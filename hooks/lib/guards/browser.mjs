// Parti comuni dei guard del browser (K5, FAIL-CLOSED): contesto, classificazione,
// allow-list degli host dell'ambiente DICHIARATO (§51.2), integrità dei file di
// configurazione copiati in session.env da `use env`.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { guardContext, denyAudited } from "./common.mjs";
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

// Script eseguiti nella pagina: primitive di rete/navigazione ammesse solo se
// ogni URL letterale è di un host dichiarato (e ne esiste almeno uno); codice
// dinamico (eval, accesso calcolato a window, atob…) negato. → null | motivo.
const NET = /\blocation\b|\bopen\s*\(|\bfetch\s*\(|XMLHttpRequest|sendBeacon|\bimport\s*\(|WebSocket|EventSource|RTCPeerConnection|\.src\s*=|\bhref\s*=|\.action\s*=|\.submit\s*\(|requestSubmit|srcdoc|\bgoto\s*\(|\.request\b/;
const DYNAMIC = /\beval\s*\(|\bFunction\s*\(|\b(window|globalThis|self|top|parent|frames|document|navigator)\s*\[|\bconstructor\b|\batob\s*\(|fromCharCode|\\x[0-9a-f]{2}|\\u[0-9a-f{]/i;
const URL_LIT = /(?:\b[a-z][a-z0-9+.-]*:)?\/\/[^\s'"`<>()\\]+/gi;
export function scriptRefusal(code, env) {
  if (typeof code !== "string" || !code.trim()) return "script non ispezionabile (nessun codice): negato";
  if (DYNAMIC.test(code)) return "script con codice dinamico non verificabile (eval, accessi calcolati, decodifiche): negato";
  if (!NET.test(code)) return null;
  const lits = code.match(URL_LIT) ?? [];
  if (!lits.length) return "script con primitive di rete o navigazione senza URL letterali verificabili: negato";
  for (const l of lits) {
    const r = urlRefusal(l.startsWith("//") ? `https:${l}` : l, env);
    if (r) return `script verso una destinazione non consentita — ${r}`;
  }
  return null;
}

export { normalizeHost };
