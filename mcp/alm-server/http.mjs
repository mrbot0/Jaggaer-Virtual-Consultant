// Richieste HTTP verso Jira/Xray (§53.2, §47 E2, §48.1): solo host DICHIARATI in customers/<C>/config/xray.yaml
// (base_url, xray_url, jira_url; nessun altro host, mai un redirect seguito), https obbligatorio salvo loopback,
// retry con backoff sugli errori di rete e sui 502/503/504 (E2: poi coda offline, mai un difetto), messaggi d'errore
// redatti (mai un token né il valore di una variabile XRAY_*/JIRA_*). global fetch (Node ≥ 22), nessuna dipendenza.
import { AlmError, safeMessage } from "./adapter.mjs";
import { almHosts, hostMatches } from "../../scripts/lib/network-md.mjs";

export const XRAY_CLOUD_DEFAULT = "https://xray.cloud.getxray.app";
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export function hostOf(u) {
  try { return new URL(u).hostname.toLowerCase().replace(/\.$/, ""); } catch { return null; }
}

// Host dichiarati: quelli degli URL di xray.yaml; per il cloud anche l'API di Xray (xray_url o il suo default).
export function declaredHosts(config) {
  const urls = [config?.base_url, config?.jira_url, config?.xray_url, config?.deployment === "cloud" ? (config?.xray_url ?? XRAY_CLOUD_DEFAULT) : null].filter(Boolean);
  return new Set(urls.map(hostOf).filter(Boolean));
}

// URL ammesso ⇒ URL normalizzato senza barra finale; altrimenti AlmError refused (nessuna richiesta parte, nessuna
// credenziale). WP09c giro 1 (C1 c): l'host deve stare SIA in config/xray.yaml SIA nella categoria alm di NETWORK.md
// (file del pacchetto sotto integrità; networkHosts solo da codice, per i test con mock locali).
export function declaredUrl(url, config, what = "URL", networkHosts = null) {
  let u;
  try { u = new URL(String(url)); } catch { throw new AlmError("config", `${what} non valido: ${JSON.stringify(url)}`); }
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (u.username || u.password) throw new AlmError("config", `${what} con credenziali nell'URL: le credenziali solo da variabili d'ambiente (§48.1)`);
  if (!declaredHosts(config).has(host)) throw new AlmError("refused", `host ${host} non dichiarato in config/xray.yaml (base_url/jira_url/xray_url): il plugin parla solo con l'host Jira/Xray dichiarato (§53.2, NETWORK.md)`);
  const allowed = networkHosts ?? almHosts();
  if (!hostMatches(host, allowed)) throw new AlmError("refused", `host ${host} fuori dalla categoria alm di NETWORK.md (${allowed.join(", ") || "nessun host"}): nessuna credenziale verso host non dichiarati dal pacchetto (§53.2); un Jira on-premise va aggiunto a NETWORK.md con una release`);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && LOOPBACK.has(host))) throw new AlmError("refused", `${what} non https: ${u.protocol}//${host}`);
  return u.href.replace(/\/+$/, "");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TRANSIENT = new Set([502, 503, 504]);

// → { status, json, text }. Errori: network (rete, timeout, 502/503/504 dopo i retry), http (altri ≥ 400, 3xx).
export async function request(config, { method = "GET", url, headers = {}, body = undefined, env = process.env, fetchImpl = globalThis.fetch, networkHosts = null }) {
  const net = config?.network ?? {};
  const attempts = Math.max(1, Math.min(5, Number(net.retries ?? 3)));
  const backoff = Math.max(0, Number(net.backoff_ms ?? 500));
  const timeout = Math.max(100, Number(net.timeout_ms ?? 20000));
  const target = declaredUrl(url, config, "URL", networkHosts);
  let last = null;
  for (let i = 0; i < attempts; i++) {
    if (i) await sleep(backoff * 2 ** (i - 1));
    let res;
    try {
      res = await fetchImpl(target, { method, headers, body, redirect: "manual", signal: AbortSignal.timeout(timeout) });
    } catch (err) {
      last = new AlmError("network", `rete: ${method} ${hostOf(target)} non raggiungibile (${safeMessage(err?.cause?.code ?? err?.message ?? err, env)})`, { network: true });
      continue;
    }
    const text = await res.text().catch(() => "");
    if (TRANSIENT.has(res.status)) { last = new AlmError("network", `${method} ${hostOf(target)}: HTTP ${res.status} (servizio non disponibile)`, { network: true, status: res.status }); continue; }
    if (res.status >= 300 && res.status < 400) throw new AlmError("http", `${method} ${hostOf(target)}: redirect HTTP ${res.status} non seguito (solo host dichiarati)`, { status: res.status });
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    if (res.status >= 400) {
      const detail = json ? (json.error ?? json.message ?? (json.errorMessages ?? []).join("; ") ?? "") : text;
      throw new AlmError(res.status === 401 || res.status === 403 ? "auth" : res.status === 404 ? "not-found" : "http", `${method} ${new URL(target).pathname}: HTTP ${res.status} ${safeMessage(typeof detail === "string" ? detail : JSON.stringify(detail), env)}`, { status: res.status });
    }
    return { status: res.status, json, text };
  }
  throw last;
}

export const basicAuth = (user, token) => `Basic ${Buffer.from(`${user}:${token}`).toString("base64")}`;

// Allegati (multipart) verso Jira: X-Atlassian-Token no-check, file già redatti (profilo strict).
export function attachmentForm(files) {
  const form = new FormData();
  for (const f of files) form.append("file", new Blob([Buffer.from(f.data, "base64")], { type: f.contentType }), f.filename);
  return form;
}
