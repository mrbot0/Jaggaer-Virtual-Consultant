// Cattura integrale dell'esplorazione (28/10/2026, decisione dell'utente: «l'agente che esplora deve scaricare tutto quello
// che vede, scriverlo in locale e imparare il più possibile, in modo da rendere efficiente e veloce la seconda run»).
// Solo in modalità esplorazione, da observe-append, per ogni lettura della pagina riuscita (completa o a pezzi, mai un find):
//  - customers/<C>/explore/pages/<slug>-<h8>.txt   testo integrale della pagina (i data URI in base64 già omessi; nessuna
//    redazione salvo la policy "redatto", sotto: resta nella cartella del cliente, non esce verso product/); una lettura
//    completa riscrive, un pezzo si aggiunge;
//  - customers/<C>/explore/sitemap.json            { v, pages: { <firma>: { url, title, file, first_seen, last_seen, visits,
//    headings, elements: [[ruolo, nome]], history: [{ ts, sha256, elements }], changed } }, edges: [{ from, via, to, ts }],
//    pending }: la mappa del sito con i click che portano da una pagina all'altra (la seconda run va diretta per URL o per
//    etichetta: scripts/explore/explore.mjs route|status|show la interroga).
// 29/10/2026 (punto 4 del piano approvato, «seconda run davvero eseguibile»):
//  - history: le ultime HISTORY_MAX letture COMPLETE della pagina (un pezzo non conta: non è confrontabile con la pagina
//    intera), ognuna con lo sha256 del testo normalizzato da normalizeForHash (senza gli uid/ref che cambiano a ogni
//    lettura — uid=1_23, [ref_5], [ref=e12], [e12] —, senza il segno del focus, il contesto della scheda e il viewport, con
//    i timestamp delle righe ridotti a <ts>: la stessa pagina invariata dà lo stesso hash) e il numero di elementi
//    interattivi; changed = l'hash è diverso da quello della lettura completa precedente (false alla prima lettura e se la
//    precedente non c'è);
//  - policy (opzionale): { explore_capture: "integrale" | "redatto", profile?: "standard" | "strict", env?: {…} }. Con
//    "redatto" il testo salvato (intestazione compresa), il titolo, le intestazioni e i nomi degli elementi della mappa
//    passano da redactText (scripts/chrome/redact.mjs, profilo policy.profile, default strict; env = le variabili da
//    segreto, default secretEnv(process.env)) e l'URL si riduce a origine + percorso redatto (senza query né frammento,
//    come pageUrl dell'OBS); default (policy assente o altro valore) integrale, come prima. Lo sha256 è sempre del testo
//    letto normalizzato (non del testo salvato): cambiare policy fra due run non fa risultare cambiata la pagina.
//    Il collegamento da observe-append (policy dell'esplorazione del cliente) lo fa chi riscrive observe-append.
// Fail-open: un guasto qui non tocca il legame dei ref né i guard (lo segnala l'hook come avviso).
//   capturePage({ ws, customer, sig, url, title, page, text, partial, ts, policy }) → "explore/pages/<file>.txt" | null
//   captureClick({ ws, customer, fromSig, name, ts })
//   pageDigest(page, { file, max }) → testo compatto: titolo, URL, intestazioni, elementi interattivi con il loro uid/ref
//   normalizeForHash(text) · pageHash(text) → sha256 esadecimale · exploreDir(ws, customer) · sitemapFile(ws, customer)
//   CAPTURE_POLICIES · HISTORY_MAX
import { mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { writeFileAtomic, withFileLock } from "./fsx.mjs";
import { redactText, secretEnv, PROFILES } from "../../scripts/chrome/redact.mjs";

export const exploreDir = (ws, customer) => join(ws, "customers", customer, "explore");
export const sitemapFile = (ws, customer) => join(exploreDir(ws, customer), "sitemap.json");
export const INTERACTIVE = new Set(["button", "link", "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "checkbox", "radio", "combobox",
  "listbox", "option", "textbox", "searchbox", "spinbutton", "switch", "textarea", "treeitem", "columnheader"]);
export const CAPTURE_POLICIES = ["integrale", "redatto"];
export const HISTORY_MAX = 10;
const slug = (s) => String(s ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "pagina";
const h8 = (s) => createHash("sha256").update(String(s)).digest("hex").slice(0, 8);
const pageFileName = (sig) => `${slug(String(sig).split("#")[0])}-${h8(sig)}.txt`;

// Timestamp (cambiano a ogni lettura senza che la pagina cambi): data e ora ISO, data e ora numeriche, ora con i secondi,
// millisecondi dall'epoca come valore di un parametro (gli anti-cache negli URL, ?_=1730…). Bug fixing 29/10/2026: si
// sostituisce il solo timestamp con <ts>, non si toglie la riga (una riga di tabella o un link con una data resta nel
// confronto per il resto del suo contenuto); un numero di 13 cifre fuori da un parametro (EAN, numero di documento) resta.
const TS = [
  /\b\d{4}-\d{2}-\d{2}[T ]\d{1,2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g,
  /\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}[ ,T]+(?:ore )?\d{1,2}[:.]\d{2}(?:[:.]\d{2})?\b/gi,
  /\b\d{1,2}:\d{2}:\d{2}\b/g,
  /(?<=[=_])1[6-9]\d{11}\b/g,
];
export function normalizeForHash(text) {
  return String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .split(/^Tab Context:/m)[0]                        // Claude in Chrome: scheda e tabId in coda alla lettura
    .replace(/^([ \t]*)uid=[\w.:-]+/gm, "$1")            // chrome-devtools, solo in testa alla riga (non ?uid= negli URL)
    .replace(/\[ref[_=][\w-]+\]/g, "")                  // Claude in Chrome [ref_5], Playwright [ref=e12]
    .replace(/\[e\d+\]/g, "")
    .replace(/ \[active\]/g, "")                         // Playwright: l'elemento con il focus (si sposta coi click)
    .replace(/ focused(?=[ \t]|$)/gm, "")                // chrome-devtools: idem
    .split("\n")
    .filter((l) => !/^\s*Viewport:/.test(l))
    .map((l) => TS.reduce((s, re) => s.replace(re, "<ts>"), l).replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}
export const pageHash = (text) => createHash("sha256").update(normalizeForHash(text)).digest("hex");

function loadSitemap(file) {
  try { const m = JSON.parse(readFileSync(file, "utf8")); if (m && m.v === 1 && m.pages && Array.isArray(m.edges)) return m; } catch { /* nuova */ }
  return { v: 1, pages: {}, edges: [], pending: null };
}
const update = (ws, customer, fn) => {
  const dir = exploreDir(ws, customer);
  mkdirSync(dir, { recursive: true });
  const file = sitemapFile(ws, customer);
  return withFileLock(`${file}.lock`, () => { const m = loadSitemap(file); const r = fn(m); writeFileAtomic(file, JSON.stringify(m)); return r; });
};

// Redazione secondo la policy di cattura: identità nel modo integrale (il default).
function redactorFor(policy) {
  if (policy?.explore_capture !== "redatto") return { red: (s) => s, redUrl: (u) => u };
  const profile = PROFILES.includes(policy.profile) ? policy.profile : "strict";
  const env = policy.env && typeof policy.env === "object" ? policy.env : secretEnv(process.env);
  const red = (s) => (typeof s === "string" && s ? redactText(s, { profile, env }).text : s);
  const redUrl = (u) => {
    if (typeof u !== "string" || !u) return u;
    // about:, file: e gli schemi non speciali hanno origin "null": l'URL redatto senza query né frammento
    try { const x = new URL(u); return x.origin === "null" ? red(u.split(/[?#]/)[0]) : `${x.origin}${red(x.pathname)}`; } catch { return red(u.split(/[?#]/)[0]); }
  };
  return { red, redUrl };
}

export function capturePage({ ws, customer, sig, url, title, page, text, partial = false, ts, policy = null }) {
  if (!sig || typeof text !== "string" || !text.trim()) return null;
  const { red, redUrl } = redactorFor(policy);
  const dir = join(exploreDir(ws, customer), "pages");
  mkdirSync(dir, { recursive: true });
  const name = pageFileName(sig);
  const file = join(dir, name);
  const sUrl = url == null ? url : redUrl(url);
  const sTitle = title == null ? title : red(title);
  if (partial) appendFileSync(file, `\n\n----- pezzo ${ts} -----\n${red(text)}`); else writeFileAtomic(file, `# ${sTitle ?? ""}\n# ${sUrl ?? ""}\n# ${ts}\n${red(text)}`);
  const elements = [];
  const seen = new Set();
  for (const e of page?.elements ?? []) {
    if (!INTERACTIVE.has(e.role) || typeof e.name !== "string" || !e.name.trim()) continue;
    const n = red(e.name.trim()).slice(0, 160);
    const k = `${e.role}\u0001${n}`;
    if (seen.has(k)) continue;
    seen.add(k);
    elements.push([e.role, n]);
  }
  const headings = (page?.headings ?? []).map((h) => red(String(h.text ?? "")).slice(0, 160)).filter(Boolean).slice(0, 50);
  const sha256 = partial ? null : pageHash(text);
  update(ws, customer, (m) => {
    const p = m.pages[sig] ?? { url: null, title: null, file: `pages/${name}`, first_seen: ts, visits: 0, headings: [], elements: [] };
    p.url = sUrl ?? p.url;
    p.title = sTitle ?? p.title;
    p.last_seen = ts;
    p.visits = (p.visits ?? 0) + (partial ? 0 : 1);
    p.headings = [...new Set([...(partial ? p.headings : []), ...headings])];
    const known = new Set((partial ? p.elements : []).map(([r, n]) => `${r}\u0001${n}`));
    p.elements = [...(partial ? p.elements : []), ...elements.filter(([r, n]) => !known.has(`${r}\u0001${n}`))];
    // storia corta delle letture complete e cambio rispetto alla precedente (un pezzo non la tocca)
    const history = Array.isArray(p.history) ? p.history : [];
    if (!partial) {
      const prev = history.length ? history[history.length - 1] : null;
      p.changed = !!prev && prev.sha256 !== sha256;
      p.history = [...history, { ts, sha256, elements: elements.length }].slice(-HISTORY_MAX);
    } else {
      p.history = history;
      p.changed = p.changed === true;
    }
    p.file = `pages/${name}`;   // anche dopo la retention, che toglie il riferimento a un file scaduto
    m.pages[sig] = p;
    // un click in attesa da un'altra pagina diventa un arco della mappa
    if (m.pending && m.pending.from && m.pending.from !== sig) {
      const { from, via } = m.pending;
      if (!m.edges.some((x) => x.from === from && x.via === via && x.to === sig)) m.edges.push({ from, via, to: sig, ts });
    }
    m.pending = null;
  });
  return `explore/pages/${name}`;
}

export function captureClick({ ws, customer, fromSig, name, ts }) {
  if (!fromSig || !name) return;
  update(ws, customer, (m) => { m.pending = { from: fromSig, via: String(name).slice(0, 160), ts }; });
}

// Riassunto compatto di una pagina per il modello: al posto dell'albero intero (centinaia di KB) gli elementi utili a
// decidere e a cliccare, con il loro uid/ref. Il testo integrale resta nel file della cattura.
export function pageDigest(page, { file = null, max = 800 } = {}) {
  const out = [`Pagina: ${page?.title ?? "—"} · ${page?.url ?? "—"}`];
  if (file) out.push(`Testo integrale: ${file} (Read a pezzi se serve il contenuto)`);
  const hs = (page?.headings ?? []).map((h) => String(h.text ?? "")).filter(Boolean);
  if (hs.length) out.push(`Intestazioni: ${hs.slice(0, 30).join(" · ")}`);
  const els = (page?.elements ?? []).filter((e) => e.ref != null && INTERACTIVE.has(e.role) && typeof e.name === "string" && e.name.trim());
  out.push(`Elementi interattivi (${els.length}${els.length > max ? `, primi ${max}` : ""}):`);
  for (const e of els.slice(0, max)) out.push(`${e.ref} ${e.role} "${e.name.trim().slice(0, 120)}"`);
  return out.join("\n");
}
