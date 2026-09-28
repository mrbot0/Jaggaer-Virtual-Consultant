// Storia dei ref del browser per scheda (WP07 giro 5, I-A'): ref → ruolo+nome osservati in OGNI lettura della scheda,
// persistente nella sessione e oltre (file del cliente: una nuova sessione sulla stessa scheda la ritrova), azzerata SOLO da una navigazione a un nuovo documento o dalla chiusura DI QUELLA scheda.
// L'estensione di Claude (e Playwright) conserva la sua mappa ref → elemento per tutta la vita del documento: la storia
// deve vivere almeno quanto lei, altrimenti un ref già assegnato a un vero elemento torna "nuovo" e due letture forgiate
// lo legano al SEL del passo. Non si azzera mai per letture di altre schede né per un cambio di URL visto in una
// risposta (pushState, #frammento: stesso documento, stessa mappa — verificato dal vivo).
//
// Marcatore di osservazione mancante (regola 5): browser-origin (hook leggero) scrive in session.browser.obs_pending
// una voce per OGNI chiamata del browser; observe-append la toglie nella stessa scrittura che aggiorna storia e legami.
// Se observe-append fallisce, scade o non parte, la voce resta e i guard non legano nulla in quella scheda finché
// observe-append non vede una navigazione della scheda a un nuovo documento. I due hook corrono in parallelo: chi
// arriva secondo trova la voce dell'altro (obs_done, ultime OBS_DONE_MAX) e la chiude.
// Solo moduli built-in: browser-origin e guard-config-scope sono sul percorso caldo.
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { writeFileAtomic } from "./fsx.mjs";

const FAM = { "claude-browser": "cl", "chrome-devtools": "dt", playwright: "pw" };
export const HISTORY_MAX = 2000;      // ref per scheda; oltre ⇒ la scheda non lega più nulla fino a una navigazione
export const TABS_MAX = 64;           // schede ricordate; oltre ⇒ la nuova scheda non lega (mai dimenticare le altre)
export const OBS_DONE_MAX = 32;
export const TAINT = "!";

export const tabKey = (family, tab) => `${FAM[family] ?? "x"}|${tab == null || tab === "" ? "?" : String(tab)}`;
const famOf = (key) => String(key).split("|")[0];
const tabOfKey = (key) => String(key).slice(String(key).indexOf("|") + 1);

// Chiave della chiamata comune ai due hook PostToolUse: tool_use_id, o l'impronta dell'input (identico per entrambi).
export function callKey(input) {
  if (typeof input?.tool_use_id === "string" && input.tool_use_id) return `u:${input.tool_use_id.slice(0, 120)}`;
  let s;
  try { s = JSON.stringify([input?.tool_name ?? null, input?.tool_input ?? null, input?.tool_response ?? null]); } catch { s = String(input?.tool_name); }
  return `h:${createHash("sha256").update(s).digest("hex").slice(0, 32)}`;
}

// browser-origin: registra la chiamata come "in attesa di observe-append" (o chiude quella che observe-append ha già visto).
export function markPending(b, key, family, tab, ts) {
  const out = { ...b };
  const done = Array.isArray(out.obs_done) ? out.obs_done.filter((x) => typeof x === "string") : [];
  if (done.includes(key)) { out.obs_done = done.filter((x) => x !== key); return out; }
  const p = out.obs_pending && typeof out.obs_pending === "object" && !Array.isArray(out.obs_pending) ? { ...out.obs_pending } : {};
  p[key] = { tab: tabKey(family, tab), ts };
  out.obs_pending = p;
  return out;
}

// observe-append: chiude la propria voce (o lascia la ricevuta per browser-origin, che può arrivare dopo) e, per ogni
// scheda azzerata da questa chiamata, toglie le voci rimaste di chiamate precedenti su quella scheda.
export function settlePending(b, key, clearedTabs = []) {
  const out = { ...b };
  const p = out.obs_pending && typeof out.obs_pending === "object" && !Array.isArray(out.obs_pending) ? { ...out.obs_pending } : {};
  if (Object.hasOwn(p, key)) delete p[key];
  else out.obs_done = [...(Array.isArray(out.obs_done) ? out.obs_done.filter((x) => typeof x === "string" && x !== key) : []), key].slice(-OBS_DONE_MAX);
  for (const [k, v] of Object.entries(p)) {
    const t = String(v?.tab);
    if (clearedTabs.includes(t) || (clearedTabs.includes("pw|*") && famOf(t) === "pw")) delete p[k];
  }
  out.obs_pending = p;
  return out;
}

// guard: una chiamata precedente della stessa famiglia non osservata su questa scheda (o su una scheda ignota, o
// l'azione non nomina la scheda) ⇒ nessun legame. Stato malformato ⇒ nessun legame (fail-closed).
export function pendingRefusal(b, family, tab) {
  const p = b?.obs_pending;
  if (p === undefined || p === null) return null;
  if (typeof p !== "object" || Array.isArray(p)) return "stato delle osservazioni del browser illeggibile";
  const fam = tabKey(family, null).split("|")[0];
  for (const v of Object.values(p)) {
    const k = typeof v?.tab === "string" ? v.tab : null;
    if (!k) return "stato delle osservazioni del browser illeggibile";
    if (famOf(k) !== fam) continue;
    const t = tabOfKey(k);
    if (t === "?" || tab == null || t === String(tab)) {
      return `una chiamata precedente del browser su questa scheda non è stata registrata da observe-append (fallito o scaduto): nessun legame ref ↔ SEL finché la scheda non naviga a un nuovo documento (navigate)`;
    }
  }
  return null;
}

// ---- file della storia: customers/<C>/.sessions/ref-history.json (del cliente, protetto come .sessions/) { v: 1, strict?, tabs: { "<fam>|<scheda>": { l: {ref: etichetta|"!"}, full?, url?, nav? } } }
export const historyFile = (sessionsDir) => join(sessionsDir, "ref-history.json");
export function loadHistory(file) {
  if (!existsSync(file)) return { v: 1, tabs: {} };
  try {
    const h = JSON.parse(readFileSync(file, "utf8"));
    if (h && h.v === 1 && h.tabs && typeof h.tabs === "object" && !Array.isArray(h.tabs)) return h;
  } catch { /* sotto */ }
  // illeggibile: la storia è persa ⇒ nessuna scheda lega finché non naviga (strict)
  return { v: 1, strict: true, tabs: {} };
}
export const saveHistory = (file, h) => writeFileAtomic(file, JSON.stringify(h));

const stripFragment = (u) => String(u).split("#")[0];
// Navigazione a un NUOVO documento? Un URL con frammento può restare nello stesso documento (la mappa dei ref
// dell'estensione resta: verificato dal vivo) ⇒ no; back/forward possono restare nello stesso documento ⇒ no;
// reload ⇒ sì; un URL http(s) senza frammento ⇒ sempre un nuovo documento (HTML: navigate-to-a-fragment solo con frammento).
export function newDocument(action) {
  if (action.history) return action.historyKind === "reload";
  const u = typeof action.url === "string" ? action.url.trim() : "";
  if (!u || u.includes("#")) return false;
  try {
    const x = new URL(/^[a-z][a-z0-9+.-]*:/i.test(u) ? u : `https://${u}`);
    return x.protocol === "http:" || x.protocol === "https:";
  } catch { return false; }
}

const CLOSE_OPS = { "claude-browser": new Set(["tabs_close", "tabs_close_mcp"]), "chrome-devtools": new Set(["close_page"]) };
// Schede azzerate dalla chiamata (solo con risposta "ok" e, per i navigate, con il marcatore positivo di arrivo):
// [{ key: scheda della storia, pend: [schede delle voci obs_pending da chiudere] }]. Un navigate che non nomina la
// scheda chiude anche le voci a scheda ignota della famiglia (browser-origin le registra con la scheda chiesta).
// Un cambio di scheda NON azzera: il documento (e la mappa dei ref dell'estensione) resta.
export function clearedBy(call, { ok, landedTab = null, landed = () => false }) {
  if (!ok) return [];
  const out = [];
  for (const a of call.actions ?? [call]) {
    const fam = a.family ?? call.family;
    const op = String(a.op ?? "");
    if (CLOSE_OPS[fam]?.has(op) && a.tab != null) out.push({ key: tabKey(fam, a.tab), pend: [tabKey(fam, a.tab)] });
    else if (fam === "playwright" && op === "browser_close") out.push({ key: "pw|*", pend: ["pw|*"] });
    else if (a.kind === "navigate" && !a.switches && newDocument(a) && landed(a)) {
      const key = tabKey(fam, a.tab ?? landedTab);
      out.push({ key, pend: a.tab == null ? [key, tabKey(fam, null)] : [key] });
    }
  }
  return out;
}

// Aggiorna la storia (copia) con gli azzeramenti e le etichette della chiamata e dice quali ref sono legabili.
//  labels: [[ref, etichetta]] di tutta la risposta; keys: schede su cui registrarle; complete: lettura completa che lega.
export function updateHistory(h0, { cleared = [], keys = [], labels = [], complete = false, url = null }) {
  const h = { ...h0, tabs: { ...(h0.tabs ?? {}) } };
  for (const k of cleared) {
    if (k === "pw|*") { for (const t of Object.keys(h.tabs)) if (famOf(t) === "pw") h.tabs[t] = { l: {}, nav: true }; continue; }
    h.tabs[k] = { l: {}, nav: true };
  }
  if (!labels.length) {
    if (url) for (const k of keys) if (h.tabs[k]) h.tabs[k] = { ...h.tabs[k], url };
    return h;
  }
  // nella stessa uscita un ref con due etichette diverse ⇒ contaminato
  const now = new Map();
  for (const [r, k] of labels) now.set(r, now.has(r) && now.get(r) !== k ? TAINT : k);
  for (const key of keys) {
    let t = h.tabs[key];
    if (!t) {
      if (Object.keys(h.tabs).length >= TABS_MAX) { h.tabs[key] = { l: {}, full: true }; continue; }
      t = { l: {} };
    }
    const l = { ...(t.l ?? {}) };
    let n = Object.keys(l).length;
    let full = !!t.full;
    for (const [r, k] of now) {
      const old = l[r];
      if (old === undefined) {
        if (n >= HISTORY_MAX) { full = true; continue; }
        l[r] = complete && k !== TAINT ? k : TAINT;   // regola 4: visto la prima volta fuori da una lettura completa
        n++;
      } else if (old !== k) l[r] = TAINT;             // regola 3: un'altra etichetta
    }
    h.tabs[key] = { ...t, l, ...(full ? { full: true } : {}), ...(url ? { url } : {}) };
  }
  return h;
}

// Un ref della lettura completa sulla scheda `key` è legabile? Controlla la scheda e le letture a scheda ignota della
// stessa famiglia; se la scheda stessa è ignota, tutte le schede della famiglia.
export function bindable(h, key, ref, label) {
  const fam = famOf(key);
  const own = h.tabs?.[key];
  if (!own || own.full || (h.strict && !own.nav)) return false;
  const others = tabOfKey(key) === "?" ? Object.keys(h.tabs ?? {}).filter((k) => famOf(k) === fam) : [key, `${fam}|?`];
  for (const k of others) {
    const t = h.tabs?.[k];
    if (!t) continue;
    if (t.full) return false;
    const v = t.l?.[ref];
    if (v === undefined) continue;
    if (v === TAINT || v !== label) return false;
  }
  return own.l?.[ref] === label;
}
