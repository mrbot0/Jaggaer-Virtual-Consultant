// Cattura integrale dell'esplorazione (28/10/2026, decisione dell'utente: «l'agente che esplora deve scaricare tutto quello
// che vede, scriverlo in locale e imparare il più possibile, in modo da rendere efficiente e veloce la seconda run»).
// Solo in modalità esplorazione, da observe-append, per ogni lettura della pagina riuscita (completa o a pezzi, mai un find):
//  - customers/<C>/explore/pages/<slug>-<h8>.txt   testo integrale della pagina (i data URI in base64 già omessi; nessuna
//    redazione: resta nella cartella del cliente, non esce verso product/); una lettura completa riscrive, un pezzo si aggiunge;
//  - customers/<C>/explore/sitemap.json            { v, pages: { <firma>: { url, title, file, first_seen, last_seen, visits,
//    headings, elements: [[ruolo, nome]] } }, edges: [{ from, via, to, ts }], pending }: la mappa del sito con i click che
//    portano da una pagina all'altra (la seconda run va diretta per URL o per etichetta).
// Fail-open: un guasto qui non tocca il legame dei ref né i guard (lo segnala l'hook come avviso).
//   capturePage({ ws, customer, sig, url, title, page, text, partial, ts }) · captureClick({ ws, customer, fromSig, name, ts })
//   pageDigest(page, { file, max }) → testo compatto: titolo, URL, intestazioni, elementi interattivi con il loro uid/ref
import { mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { writeFileAtomic, withFileLock } from "./fsx.mjs";

export const exploreDir = (ws, customer) => join(ws, "customers", customer, "explore");
const sitemapFile = (ws, customer) => join(exploreDir(ws, customer), "sitemap.json");
export const INTERACTIVE = new Set(["button", "link", "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "checkbox", "radio", "combobox",
  "listbox", "option", "textbox", "searchbox", "spinbutton", "switch", "textarea", "treeitem", "columnheader"]);
const slug = (s) => String(s ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "pagina";
const h8 = (s) => createHash("sha256").update(String(s)).digest("hex").slice(0, 8);
const pageFileName = (sig) => `${slug(String(sig).split("#")[0])}-${h8(sig)}.txt`;

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

export function capturePage({ ws, customer, sig, url, title, page, text, partial = false, ts }) {
  if (!sig || typeof text !== "string" || !text.trim()) return null;
  const dir = join(exploreDir(ws, customer), "pages");
  mkdirSync(dir, { recursive: true });
  const name = pageFileName(sig);
  const file = join(dir, name);
  if (partial) appendFileSync(file, `\n\n----- pezzo ${ts} -----\n${text}`); else writeFileAtomic(file, `# ${title ?? ""}\n# ${url ?? ""}\n# ${ts}\n${text}`);
  const elements = [];
  const seen = new Set();
  for (const e of page?.elements ?? []) {
    if (!INTERACTIVE.has(e.role) || typeof e.name !== "string" || !e.name.trim()) continue;
    const k = `${e.role}\u0001${e.name.trim()}`;
    if (seen.has(k)) continue;
    seen.add(k);
    elements.push([e.role, e.name.trim().slice(0, 160)]);
  }
  const headings = (page?.headings ?? []).map((h) => String(h.text ?? "").slice(0, 160)).filter(Boolean).slice(0, 50);
  update(ws, customer, (m) => {
    const p = m.pages[sig] ?? { url: null, title: null, file: `pages/${name}`, first_seen: ts, visits: 0, headings: [], elements: [] };
    p.url = url ?? p.url;
    p.title = title ?? p.title;
    p.last_seen = ts;
    p.visits = (p.visits ?? 0) + (partial ? 0 : 1);
    p.headings = [...new Set([...(partial ? p.headings : []), ...headings])];
    const known = new Set((partial ? p.elements : []).map(([r, n]) => `${r}\u0001${n}`));
    p.elements = [...(partial ? p.elements : []), ...elements.filter(([r, n]) => !known.has(`${r}\u0001${n}`))];
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
