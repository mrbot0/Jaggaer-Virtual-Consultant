// explore route|status|show (29/10/2026, punto 4 del piano approvato: «seconda run davvero eseguibile»). Strumenti
// eseguibili sulla mappa del sito che la cattura dell'esplorazione scrive (hooks/lib/explore-capture.mjs →
// customers/<C>/explore/sitemap.json): la seconda run non rilegge la mappa a mano, chiede qui dove andare e come.
//  - route  --to "<testo>" [--from "<firma|url|titolo>"]: le pagine che corrispondono al testo (titolo, intestazioni, URL e
//    nomi degli elementi; normalizzato, senza accenti, maiuscole indifferenti) con un punteggio, le prime N con l'URL per
//    andarci diretti con navigate e, da una pagina di partenza (--from, altrimenti la pagina corrente del browser nella
//    sessione, altrimenti la prima pagina vista nell'esplorazione), il percorso più corto di click (BFS sugli archi)
//    [{ da, clicca, arriva }];
//  - status [--stale-days N]: pagine totali, cambiate all'ultima lettura (changed), non rivisitate da più di N giorni
//    (last_seen), orfane (nessun arco in entrata: si raggiungono solo per URL) — cosa riesplorare;
//  - show "<testo>": la scheda di una pagina (url, titolo, intestazioni, elementi, storia, archi in entrata e in uscita,
//    file del testo integrale).
// Sola lettura: non scrive nulla (la mappa la scrive solo observe-append).
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs, fail } from "../lib/args.mjs";
import { isMain } from "../lib/is-main.mjs";
import { sitemapFile } from "../../hooks/lib/explore-capture.mjs";
import { readCurrentSession, readPointer, sessionFile, isSafeSessionId, CUSTOMER_RE } from "../../hooks/lib/workspace.mjs";
import { normalizePath } from "../chrome/snapshot-parse.mjs";

export const TOP = 3;
export const STALE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export class ExploreError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// ---- lettura della mappa ----

export function loadMap(ws, customer) {
  const file = sitemapFile(ws, customer);
  if (!existsSync(file)) throw new ExploreError(1, `nessuna mappa dell'esplorazione per ${customer}: customers/${customer}/explore/sitemap.json assente (si scrive esplorando in modalità esplorazione)`);
  let m;
  try { m = JSON.parse(readFileSync(file, "utf8")); } catch (err) { throw new ExploreError(2, `mappa dell'esplorazione illeggibile (customers/${customer}/explore/sitemap.json): ${err?.message ?? err}`); }
  if (!m || m.v !== 1 || typeof m.pages !== "object" || m.pages === null || !Array.isArray(m.edges)) throw new ExploreError(2, `mappa dell'esplorazione non valida (customers/${customer}/explore/sitemap.json): attesi v: 1, pages, edges`);
  // senza prototipo: una firma cercata come "constructor" o "toString" non è una pagina
  m.pages = Object.assign(Object.create(null), m.pages);
  for (const [sig, p] of Object.entries(m.pages)) {
    if (!p || typeof p !== "object" || Array.isArray(p)) { delete m.pages[sig]; continue; }
    p.headings = Array.isArray(p.headings) ? p.headings : [];
    p.elements = Array.isArray(p.elements) ? p.elements.filter((e) => Array.isArray(e) && e.length >= 2) : [];
    p.history = Array.isArray(p.history) ? p.history : [];
  }
  m.edges = m.edges.filter((e) => e && typeof e.from === "string" && typeof e.to === "string");
  return m;
}

// ---- corrispondenza testuale ----

export const norm = (s) => String(s ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const STOP = new Set(["di", "da", "del", "dello", "della", "dei", "degli", "delle", "il", "lo", "la", "le", "gli", "un", "uno", "una", "ed", "al", "allo",
  "alla", "ai", "agli", "alle", "in", "nel", "nella", "per", "con", "su", "sul", "sulla", "vai", "pagina", "the", "of", "to", "an", "and", "for", "on", "page"]);
export function tokens(q) {
  const all = norm(q).split(" ").filter(Boolean);
  const t = [...new Set(all.filter((x) => x.length >= 2 && !STOP.has(x)))];
  return t.length ? t : [...new Set(all)];
}
const pathOf = (url) => { try { return new URL(url).pathname; } catch { return ""; } };
// chiavi di confronto di un URL: [con la query, senza] (senza frammento né / finale); anche "host/percorso" senza schema
function urlKeys(u) {
  const s = String(u ?? "").trim();
  if (!s) return null;
  for (const c of [s, /^[\w-]+(\.[\w-]+)+(\/|$)/.test(s) ? `https://${s}` : null].filter(Boolean)) {
    try { const x = new URL(c); if (!/^https?:$/.test(x.protocol)) continue; const base = `${x.origin.toLowerCase()}${x.pathname.replace(/\/+$/, "")}`; return [`${base}${x.search}`, base]; } catch { /* prossimo */ }
  }
  return null;
}
const byRecent = (rows) => [...rows].sort((a, b) => String(b[1].last_seen ?? "").localeCompare(String(a[1].last_seen ?? "")) || a[0].localeCompare(b[0])).map(([s]) => s);
// pagine di un URL, dalla più recente: URL identico, poi senza query, poi stesso host e stesso percorso della firma
// (normalizePath: senza i segmenti identificativi, come la parte della firma prima di #)
export function pagesByUrl(m, url) {
  const k = urlKeys(url);
  if (!k) return [];
  const rows = Object.entries(m.pages);
  for (const i of [0, 1]) { const hit = rows.filter(([, p]) => urlKeys(p.url)?.[i] === k[i]); if (hit.length) return byRecent(hit); }
  // stesso percorso della firma solo sullo stesso host (un altro tenant con lo stesso percorso è un'altra pagina)
  const np = normalizePath(k[1]);
  const origin = (u) => { try { return new URL(u).origin.toLowerCase(); } catch { return null; } };
  const o = origin(k[1]);
  if (np) { const hit = rows.filter(([s, p]) => s.split("#")[0] === np && origin(p.url) === o); if (hit.length) return byRecent(hit); }
  return [];
}

// campi della pagina con il peso: titolo e intestazioni dicono cos'è la pagina, l'URL dove sta, gli elementi cosa ci si fa
function fieldsOf(sig, p) {
  const f = [
    { kind: "titolo", weight: 3, texts: [p.title].filter(Boolean).map(String) },
    { kind: "intestazione", weight: 3, texts: p.headings.map(String) },
    { kind: "url", weight: 2, texts: [pathOf(p.url), sig].filter(Boolean) },
    { kind: "elemento", weight: 1, texts: p.elements.map(([, n]) => String(n)), label: p.elements.map(([r, n]) => `${r} "${n}"`) },
  ];
  for (const x of f) { x.norm = x.texts.map(norm); x.words = x.norm.map((s) => s.split(" ")); }
  return f;
}
const why = (f, i) => (f.kind === "elemento" ? `elemento ${f.label[i]}` : f.kind === "url" ? `url ${f.texts[i]}` : `${f.kind} "${f.texts[i]}"`);
// singolare e plurale italiani (fornitore/fornitori, richiesta/richieste) e prefissi da 4 lettere (report/reports)
const stem = (w) => (w.length >= 5 ? w.replace(/[aeiou]$/, "") : w);
const wordMatch = (w, t) => w === t || stem(w) === stem(t) || (t.length >= 4 && w.startsWith(t)) || (w.length >= 4 && t.startsWith(w));

// punteggio = Σ per parola del peso del campo migliore che la contiene (parola intera, singolare/plurale o prefisso da 4
// lettere in su) + bonus della frase intera (2 × peso del campo), × la quota di parole trovate; firma o URL identici
// (anche senza query): 100
export function scorePage(sig, p, q, toks = tokens(q), qk = urlKeys(q)) {
  if (q === sig) return { score: 100, matched: ["firma"] };
  const pk = qk ? urlKeys(p.url) : null;
  if (pk && (pk[0] === qk[0] || pk[1] === qk[1])) return { score: 100, matched: ["url identico"] };
  const fields = fieldsOf(sig, p);
  const reasons = [];
  let score = 0;
  let found = 0;
  for (const t of toks) {
    let best = null;
    for (const f of fields) {
      if (best && best.f.weight >= f.weight) break;
      const i = f.words.findIndex((ws) => ws.some((w) => wordMatch(w, t)));
      if (i >= 0) best = { f, i };
    }
    if (best) { found++; score += best.f.weight; reasons.push(why(best.f, best.i)); }
  }
  const qn = norm(q);
  if (qn && toks.length > 1) {
    for (const f of fields) {
      const i = f.norm.findIndex((s) => ` ${s} `.includes(` ${qn} `));
      if (i >= 0) { score += 2 * f.weight; reasons.unshift(why(f, i)); break; }
    }
  }
  if (!found) return { score: 0, matched: [] };
  return { score: Math.round(score * (found / toks.length) * 100) / 100, matched: [...new Set(reasons)].slice(0, 3) };
}

export function search(m, q, { top = TOP } = {}) {
  const toks = tokens(q);
  const qk = urlKeys(q);
  const out = [];
  for (const [sig, p] of Object.entries(m.pages)) {
    const r = scorePage(sig, p, q, toks, qk);
    if (r.score > 0) out.push({ sig, page: p, ...r });
  }
  out.sort((a, b) => b.score - a.score || (b.page.visits ?? 0) - (a.page.visits ?? 0) || String(b.page.last_seen ?? "").localeCompare(String(a.page.last_seen ?? "")) || a.sig.localeCompare(b.sig));
  return out.slice(0, top);
}

// firma esatta > URL identico > titolo identico (normalizzato) > migliore per punteggio; un URL che non è nella mappa
// non si risolve per somiglianza (partirebbe da una pagina che ne condivide solo una parola)
export function resolvePage(m, q) {
  if (!q) return null;
  if (Object.hasOwn(m.pages, q)) return { sig: q, by: "firma" };
  const byUrl = pagesByUrl(m, q);
  if (byUrl.length) return { sig: byUrl[0], by: "url", others: byUrl.slice(1, 4) };
  if (urlKeys(q)) return null;
  const qn = norm(q);
  const byTitle = Object.entries(m.pages).filter(([, p]) => qn && norm(p.title) === qn);
  if (byTitle.length === 1) return { sig: byTitle[0][0], by: "titolo" };
  const best = search(m, q, { top: 4 });
  if (best.length) return { sig: best[0].sig, by: "ricerca", others: best.slice(1).map((x) => x.sig) };
  return null;
}

// ---- percorso di click ----

// BFS sugli archi; fra due archi con la stessa origine vince il più recente (l'etichetta di oggi)
export function shortestPath(m, from, to) {
  if (!from || !to) return null;
  if (from === to) return [];
  const adj = new Map();
  for (const e of [...m.edges].sort((a, b) => String(b.ts ?? "").localeCompare(String(a.ts ?? "")))) {
    if (!adj.has(e.from)) adj.set(e.from, []);
    adj.get(e.from).push(e);
  }
  const prev = new Map([[from, null]]);
  const queue = [from];
  for (let i = 0; i < queue.length; i++) {
    for (const e of adj.get(queue[i]) ?? []) {
      if (prev.has(e.to)) continue;
      prev.set(e.to, e);
      if (e.to === to) {
        const path = [];
        for (let x = e; x; x = prev.get(x.from)) path.unshift({ da: x.from, clicca: x.via, arriva: x.to });
        return path;
      }
      queue.push(e.to);
    }
  }
  return null;
}

// pagina corrente del browser nella sessione corrente (se è dello stesso cliente)
function sessionUrl(ws, customer, env) {
  try {
    const sid = isSafeSessionId(env.JVC_SESSION_ID) ? env.JVC_SESSION_ID : readCurrentSession(ws);
    if (!sid || readPointer(ws, sid)?.customer !== customer) return null;
    const s = JSON.parse(readFileSync(sessionFile(ws, customer, sid), "utf8"));
    return typeof s?.browser?.current_url === "string" ? s.browser.current_url : null;
  } catch { return null; }
}
const firstSeen = (m) => Object.entries(m.pages).sort((a, b) => String(a[1].first_seen ?? "~").localeCompare(String(b[1].first_seen ?? "~")) || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
const brief = (m, sig) => { const p = m.pages[sig]; return { sig, title: p?.title ?? null, url: p?.url ?? null }; };

export function route(m, { to, from = null, top = TOP, currentUrl = null }) {
  const warnings = [];
  let start = null;
  if (from) {
    const r = resolvePage(m, from);
    if (r) start = { ...brief(m, r.sig), source: "argomento" };
    else warnings.push(`partenza non trovata nella mappa: ${from}`);
  } else if (currentUrl) {
    const r = pagesByUrl(m, currentUrl)[0];
    if (r) start = { ...brief(m, r), source: "sessione" };
    else warnings.push(`la pagina corrente del browser non è nella mappa (${currentUrl}): percorsi dalla prima pagina vista`);
  }
  if (!start && !from) { const s = firstSeen(m); if (s) start = { ...brief(m, s), source: "prima-vista" }; }
  const candidates = search(m, to, { top }).map((c) => {
    const path = start ? shortestPath(m, start.sig, c.sig) : null;
    return { sig: c.sig, title: c.page.title ?? null, url: c.page.url ?? null, score: c.score, matched: c.matched, visits: c.page.visits ?? 0,
      last_seen: c.page.last_seen ?? null, changed: c.page.changed === true, clicks: path ? path.length : null, path };
  });
  return { to, from: start, candidates, warnings };
}

// ---- stato della mappa ----

export function status(m, { staleDays = STALE_DAYS, now = Date.now() } = {}) {
  const incoming = new Set(m.edges.map((e) => e.to));
  const all = Object.entries(m.pages).map(([sig, p]) => ({ sig, p }));
  const row = ({ sig, p }) => ({ sig, title: p.title ?? null, url: p.url ?? null, last_seen: p.last_seen ?? null });
  const age = (p) => { const t = Date.parse(p.last_seen ?? p.first_seen ?? ""); return Number.isFinite(t) ? Math.floor((now - t) / DAY_MS) : null; };
  const changed = all.filter(({ p }) => p.changed === true).map(row).sort((a, b) => String(b.last_seen ?? "").localeCompare(String(a.last_seen ?? "")));
  // senza data valida: vecchia (non si sa quando è stata vista)
  const stale = all.filter(({ p }) => { const t = Date.parse(p.last_seen ?? p.first_seen ?? ""); return !Number.isFinite(t) || now - t > staleDays * DAY_MS; })
    .map((x) => ({ ...row(x), days: age(x.p) })).sort((a, b) => String(a.last_seen ?? "").localeCompare(String(b.last_seen ?? "")));
  const orphans = all.filter(({ sig }) => !incoming.has(sig)).map(row).sort((a, b) => a.sig.localeCompare(b.sig));
  return { pages: all.length, edges: m.edges.length, stale_days: staleDays, changed, stale, orphans, pending: m.pending ?? null };
}

// ---- scheda di una pagina ----

export function show(m, q, customer) {
  const r = resolvePage(m, q);
  if (!r) return null;
  const p = m.pages[r.sig];
  const title = (sig) => m.pages[sig]?.title ?? null;
  return {
    sig: r.sig, resolved_by: r.by, others: r.others ?? [],
    page: { url: p.url ?? null, title: p.title ?? null, first_seen: p.first_seen ?? null, last_seen: p.last_seen ?? null, visits: p.visits ?? 0,
      changed: p.changed === true, headings: p.headings, elements: p.elements, history: p.history },
    text_file: p.file ? `customers/${customer}/explore/${p.file}` : null,
    incoming: m.edges.filter((e) => e.to === r.sig).map((e) => ({ from: e.from, title: title(e.from), via: e.via, ts: e.ts ?? null })),
    outgoing: m.edges.filter((e) => e.from === r.sig).map((e) => ({ via: e.via, to: e.to, title: title(e.to), ts: e.ts ?? null })),
  };
}

// ---- testo per il modello ----

const label = (x) => `${x.title ?? "(senza titolo)"} [${x.sig}]`;
const SOURCE = { argomento: "da --from", sessione: "pagina corrente del browser", "prima-vista": "prima pagina vista nell'esplorazione" };
function routeText(customer, r, m) {
  const L = [`Destinazione "${r.to}" (cliente ${customer}${r.from ? `; partenza ${label(r.from)}, ${SOURCE[r.from.source] ?? r.from.source}` : "; nessuna partenza nota"})`];
  for (const w of r.warnings) L.push(`attenzione: ${w}`);
  if (!r.candidates.length) L.push("Nessuna pagina della mappa corrisponde: esplora la destinazione e riprova.");
  r.candidates.forEach((c, i) => {
    L.push(`${i + 1}. ${label(c)} · punteggio ${c.score}${c.url ? ` · navigate ${c.url}` : " · URL ignoto"}${c.changed ? " · cambiata all'ultima lettura" : ""}`);
    if (c.matched.length) L.push(`   corrispondenze: ${c.matched.join("; ")}`);
    if (c.path && c.path.length) L.push(`   percorso (${c.path.length} click): ${c.path.map((s) => `"${s.clicca}" → ${m.pages[s.arriva]?.title ?? s.arriva}`).join(" · ")}`);
    else if (c.path) L.push("   sei già qui (0 click)");
    else if (r.from) L.push("   nessun percorso di click noto dalla partenza: vai per URL");
  });
  return L.join("\n");
}
function statusText(customer, s) {
  const L = [`Mappa dell'esplorazione di ${customer}: ${s.pages} pagine, ${s.edges} archi.`];
  const list = (title, rows, f) => { L.push(`${title}: ${rows.length}`); for (const x of rows.slice(0, 20)) L.push(`  - ${f(x)}`); if (rows.length > 20) L.push(`  … altre ${rows.length - 20} (--json)`); };
  list("Cambiate all'ultima lettura", s.changed, (x) => `${label(x)} (${x.last_seen ?? "?"})`);
  list(`Non rivisitate da più di ${s.stale_days} giorni`, s.stale, (x) => `${label(x)} (${x.days ?? "?"} giorni)`);
  list("Orfane (solo per URL)", s.orphans, (x) => `${label(x)}${x.url ? ` ${x.url}` : ""}`);
  if (s.pending) L.push(`Click in attesa: "${s.pending.via}" da ${s.pending.from}`);
  return L.join("\n");
}
function showText(r) {
  const p = r.page;
  const L = [`Pagina: ${label({ sig: r.sig, title: p.title })}${r.resolved_by === "ricerca" ? " (trovata per ricerca)" : ""}`, `URL: ${p.url ?? "ignoto"}`,
    `Visite: ${p.visits} · prima ${p.first_seen ?? "?"} · ultima ${p.last_seen ?? "?"} · cambiata all'ultima lettura: ${p.changed ? "sì" : "no"}`];
  if (r.text_file) L.push(`Testo integrale: ${r.text_file}`);
  if (p.headings.length) L.push(`Intestazioni: ${p.headings.join(" · ")}`);
  L.push(`Elementi (${p.elements.length}): ${p.elements.slice(0, 200).map(([ro, n]) => `${ro} "${n}"`).join(" · ")}${p.elements.length > 200 ? " … (--json)" : ""}`);
  L.push(`Archi in entrata (${r.incoming.length}): ${r.incoming.map((e) => `"${e.via}" da ${label({ sig: e.from, title: e.title })}`).join(" · ") || "nessuno (si raggiunge per URL)"}`);
  L.push(`Archi in uscita (${r.outgoing.length}): ${r.outgoing.map((e) => `"${e.via}" → ${label({ sig: e.to, title: e.title })}`).join(" · ") || "nessuno"}`);
  if (r.others.length) L.push(`Altre pagine candidate: ${r.others.join(", ")}`);
  return L.join("\n");
}

// ---- CLI ----

export const HELP = `uso: node scripts/explore/explore.mjs <comando> [opzioni]

Comandi:
  route --to "<testo>" [--from "<firma|url|titolo>"] [--top 3]
        le pagine della mappa che corrispondono al testo (titolo, intestazioni, URL, nomi degli elementi; senza accenti,
        maiuscole indifferenti) con punteggio e URL (per andarci diretti con navigate) e, dalla partenza, il percorso
        più corto di click [{ da, clicca, arriva }]. Partenza: --from, altrimenti la pagina corrente del browser nella
        sessione, altrimenti la prima pagina vista nell'esplorazione
  status [--stale-days 7]
        pagine totali, cambiate all'ultima lettura, non rivisitate da più di N giorni, orfane (nessun arco in entrata:
        si raggiungono solo per URL) — cosa riesplorare
  show "<testo>"
        scheda di una pagina (firma, URL o testo): url, titolo, intestazioni, elementi, storia delle letture, archi in
        entrata e in uscita, file del testo integrale

Opzioni comuni: --customer <C> (default: il cliente della sessione corrente) --workspace <dir> (default $JVC_WORKSPACE)
                --json --help

La mappa è customers/<C>/explore/sitemap.json, scritta dalla cattura dell'esplorazione (sola lettura qui).

Exit code: 0 ok · 1 errore d'uso (comando o argomenti non validi, cliente assente, mappa assente, pagina non trovata) ·
2 errore di sistema (mappa illeggibile o non valida).`;

// opzione numerica: assente ⇒ default; data senza valore o vuota ⇒ NaN (errore d'uso, non il default in silenzio)
const num = (opts, key, def) => (!Object.hasOwn(opts, key) ? def : typeof opts[key] === "string" && opts[key].trim() ? Number(opts[key]) : NaN);

export function run(argv, env = process.env) {
  const { opts, positional } = parseArgs(argv);
  const asJson = !!opts.json;
  if (opts.help) { console.log(HELP); return 0; }
  const cmd = positional[0];
  if (!cmd) { console.log(HELP); return 1; }
  if (!["route", "status", "show"].includes(cmd)) return fail(asJson, 1, `comando sconosciuto: ${cmd}`);
  const ws = resolve(opts.workspace || env.JVC_WORKSPACE || env.CLAUDE_PROJECT_DIR || process.cwd());
  try {
    let customer = opts.customer;
    if (Object.hasOwn(opts, "customer") && !CUSTOMER_RE.test(String(customer ?? ""))) return fail(asJson, 1, `cliente non valido: ${customer ?? "(senza valore)"}`);
    if (customer === undefined) {
      const sid = isSafeSessionId(env.JVC_SESSION_ID) ? env.JVC_SESSION_ID : readCurrentSession(ws);
      try { customer = sid ? readPointer(ws, sid)?.customer ?? null : null; } catch { customer = null; }
      if (!customer) return fail(asJson, 1, "richiesto --customer <C> (nessun cliente attivo nella sessione corrente)");
    }
    if (cmd === "route") {
      const to = opts.to ?? positional[1];
      if (typeof to !== "string" || !to.trim()) return fail(asJson, 1, "route: richiesto --to \"<testo>\"");
      if (Object.hasOwn(opts, "from") && (typeof opts.from !== "string" || !opts.from.trim())) return fail(asJson, 1, "route: --from senza valore");
      const top = num(opts, "top", TOP);
      if (!Number.isInteger(top) || top < 1) return fail(asJson, 1, `--top non valido: ${opts.top ?? "(senza valore)"}`);
      const m = loadMap(ws, customer);
      const r = route(m, { to: to.trim(), from: opts.from?.trim() ?? null, top, currentUrl: opts.from ? null : sessionUrl(ws, customer, env) });
      console.log(asJson ? JSON.stringify({ ok: true, customer, ...r }) : routeText(customer, r, m));
      return 0;
    }
    if (cmd === "status") {
      const days = num(opts, "stale-days", STALE_DAYS);
      if (!Number.isFinite(days) || days < 0) return fail(asJson, 1, `--stale-days non valido: ${opts["stale-days"] ?? "(senza valore)"}`);
      const s = status(loadMap(ws, customer), { staleDays: days });
      console.log(asJson ? JSON.stringify({ ok: true, customer, sitemap: `customers/${customer}/explore/sitemap.json`, ...s }) : statusText(customer, s));
      return 0;
    }
    const q = positional.slice(1).join(" ").trim() || (typeof opts.page === "string" ? opts.page.trim() : "");
    if (!q) return fail(asJson, 1, "show: richiesto \"<testo>\" (firma, URL o titolo della pagina)");
    const r = show(loadMap(ws, customer), q, customer);
    if (!r) return fail(asJson, 1, `nessuna pagina della mappa corrisponde a: ${q}`);
    console.log(asJson ? JSON.stringify({ ok: true, customer, ...r }) : showText(r));
    return 0;
  } catch (err) {
    if (err instanceof ExploreError) return fail(asJson, err.code, err.message);
    return fail(asJson, 2, `errore di sistema: ${err?.message ?? err}`);
  }
}

if (isMain(import.meta.url)) process.exitCode = run(process.argv.slice(2));
