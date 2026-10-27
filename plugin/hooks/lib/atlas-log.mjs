// Registro dell'esplorazione (soluzione A, spec 2026-09-30 §A1): per ogni pagina letta (per intero, o a pezzi marcati
// partial: esplorazione libera, 26/10/2026), SOLA STRUTTURA —
// ruoli, nomi redatti, obblighi — e i click fra le pagine. Mai valori dei campi, mai record di tabelle (righe e celle,
// salvo le intestazioni di colonna), URL senza query. Lo scrive solo observe-append (guard-scope lo protegge).
//   pageRecord(page, { pageSig, profile, env, ts, partial }) · clickRecord({ fromSig, name, ts })
//   appendAtlasLog(file, rec, { maxBytes }) → "written" | "full" · atlasLogFile(ws, customer, sid)
import { appendFileSync, mkdirSync, statSync, existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { redactText } from "../../scripts/chrome/redact.mjs";

export const ATLAS_LOG_MAX_BYTES = 20 * 1024 * 1024;
// esplorazione libera (26/10/2026): nessun tetto di elementi per pagina (le pagine pesanti si registravano troncate);
// restano il tetto del file (20 MB) e al più ROWS_PER_TABLE righe per tabella
export const STRUCT_ROLES = new Set(["heading", "button", "link", "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "checkbox", "radio", "combobox",
  "listbox", "option", "textbox", "searchbox", "spinbutton", "switch", "textarea", "group", "region", "form", "navigation", "menu", "menubar", "tablist",
  "tabpanel", "dialog", "alertdialog", "columnheader", "rowheader", "table", "grid", "treeitem"]);
const RECORD_ROLES = new Set(["row", "cell", "gridcell"]);
// solo le intestazioni di colonna: un rowheader sta dentro una riga ed è di solito la chiave del record
const HEADER_ROLES = new Set(["columnheader"]);
const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim().replace(/[\s:*]+$/, "");

export const atlasLogFile = (ws, customer, sid) => join(ws, "customers", customer, ".sessions", sid, "atlas", "pages.jsonl");

function urlPath(url, profile, env) {
  try { return clean(redactText(new URL(url).pathname, { profile, env }).text) || "/"; } catch { return null; }
}

const FIELD_ROLES = new Set(["textbox", "searchbox", "spinbutton", "combobox", "listbox", "textarea", "checkbox", "radio", "switch"]);
const ROWS_PER_TABLE = 20;
const clip = (s, n) => String(s ?? "").slice(0, n);
// revisione 05/10/2026 (I4): nessun valore di esempio per campi segreti né per valori che sembrano chiavi o token
const SECRET_HINT = /password|passwd|secret|segret|token|chiave|api.?key|\bpin\b|\botp\b|credenz|pwd/i;
const TOKEN_LIKE = (v) => /^\S{16,}$/.test(v) && /[a-z]/i.test(v) && /\d/.test(v);
const sampleOk = (e) => !SECRET_HINT.test(`${e.name ?? ""} ${e.description ?? ""} ${e.placeholder ?? ""}`) && !TOKEN_LIKE(String(e.value).trim());

// Registro più ricco (richiesta dell'utente, 05/10/2026): prima la STRUTTURA (ruoli, nomi, obblighi, aiuto, segnaposto,
// sola lettura, non valido, testo lungo, destinazione dei link, valori di esempio dei campi), poi le RIGHE delle tabelle
// (al più 20 per tabella), marcate record: dati, non struttura.
// Tutti i testi passano dalla redazione del profilo dell'ambiente (e-mail, codici fiscali, IBAN, telefoni, codici cliente…).
export function pageRecord(page, { pageSig, profile = "strict", env = process.env, ts = new Date().toISOString(), partial = false } = {}) {
  const els = Array.isArray(page?.elements) ? page.elements : [];
  const nodes = Array.isArray(page?.nodes) ? page.nodes : [];
  const byId = new Map(nodes.map((n) => [String(n.id), n]));
  const idOfRef = new Map(nodes.filter((n) => n.ref != null).map((n) => [String(n.ref), String(n.id)]));
  const nodeOf = (e) => (e.ref != null && idOfRef.has(String(e.ref)) ? byId.get(idOfRef.get(String(e.ref))) : null);
  const keyOf = (e) => String(nodeOf(e)?.id ?? e.ref);
  const red = (t) => clean(redactText(clean(t), { profile, env }).text);
  const ancestor = (e, roles) => {
    let p = nodeOf(e)?.parent ?? null;
    for (let hop = 0; p != null && hop < 200; hop++) {
      const a = byId.get(String(p));
      if (!a) break;
      if (roles.has(a.role)) return a;
      p = a.parent;
    }
    return null;
  };
  const inRecord = (e) => !!ancestor(e, RECORD_ROLES);
  const kept = [];
  const index = new Map();
  const parentOf = (e) => {
    let p = nodeOf(e)?.parent ?? null;
    for (let hop = 0; p != null && hop < 200; hop++) {
      if (index.has(String(p))) return index.get(String(p));
      p = byId.get(String(p))?.parent ?? null;
    }
    return null;
  };
  const push = (e, extra = {}) => {
    // correzione 4 (27/10/2026): il ref dell'elemento (identificativo dello strumento, non un dato della pagina) serve ad
    // atlas-build per riconoscere lo stesso elemento in due pezzi della pagina
    const rec = { i: kept.length, parent: parentOf(e), role: e.role, name: red(e.name), ...(e.ref != null && e.ref !== "" ? { ref: String(e.ref) } : {}), ...extra };
    if (e.required) rec.required = true;
    if (e.disabled) rec.disabled = true;
    if (e.checked !== undefined) rec.checked = e.checked;
    if (e.level !== undefined) rec.level = e.level;
    if (e.description) rec.help = clip(red(e.description), 200);
    if (e.placeholder) rec.placeholder = clip(red(e.placeholder), 120);
    if (e.readonly) rec.readonly = true;
    if (e.invalid) rec.invalid = true;
    if (e.multiline) rec.multiline = true;
    // parametri di matrice (";jsessionid=…") fuori dal percorso: sono di sessione
    if (e.url) { try { rec.href = red(new URL(e.url).pathname.replace(/;[^/]*/g, "")); } catch { /* indirizzo non valido */ } }
    if (FIELD_ROLES.has(e.role) && e.value !== undefined && String(e.value).trim() && sampleOk(e)) rec.sample = clip(red(e.value), 80);
    index.set(keyOf(e), kept.length);
    kept.push(rec);
  };
  // 1. struttura
  for (const e of els) {
    if (!STRUCT_ROLES.has(e.role)) continue;
    if (!HEADER_ROLES.has(e.role) && inRecord(e)) continue;
    push(e);
  }
  // 2. righe delle tabelle (record), al più ROWS_PER_TABLE per tabella
  const ROW = new Set(["row"]);
  const TABLES = new Set(["table", "grid", "treegrid"]);
  const rowsOf = new Map();
  const skippedRows = new Set();
  // la riga delle intestazioni (contiene columnheader) non è un record e non conta fra le 20: le intestazioni ci sono già
  const headerRows = new Set(els.filter((e) => HEADER_ROLES.has(e.role)).map((e) => ancestor(e, ROW)?.id).filter((x) => x != null).map(String));
  for (const e of els) {
    if (HEADER_ROLES.has(e.role)) continue;
    const isRow = e.role === "row";
    if (!isRow && !inRecord(e)) continue;
    const row = isRow ? nodeOf(e) : ancestor(e, ROW);
    if (row && (skippedRows.has(String(row.id)) || headerRows.has(String(row.id)))) continue;
    if (isRow) {
      const k = String(ancestor(e, TABLES)?.id ?? "");
      const n = (rowsOf.get(k) ?? 0) + 1;
      rowsOf.set(k, n);
      if (n > ROWS_PER_TABLE) { skippedRows.add(String(nodeOf(e)?.id ?? e.ref)); continue; }
      push(e, { record: true });
      continue;
    }
    if (!e.name || !String(e.name).trim()) continue;
    push(e, { record: true });
  }
  const hasChild = new Set(nodes.map((n) => String(n.parent)));
  const iframes = nodes.filter((n) => /^iframe$/i.test(String(n.role)) && !hasChild.has(String(n.id))).length;
  const messages = (page?.messages ?? []).map((m) => clip(red(m.text), 200)).filter(Boolean).slice(0, 20);
  return { kind: "page", ts, ...(partial ? { partial: true } : {}), url_path: urlPath(page?.url, profile, env), ...(iframes ? { iframes } : {}), page_sig: pageSig ?? null,
    title: page?.title ? red(page.title) : null, elements: kept, ...(messages.length ? { messages } : {}) };
}

export function clickRecord({ fromSig, name, ts = new Date().toISOString(), effect = false, record = false, uncertain = false }) {
  return { kind: "click", ts, from_sig: fromSig ?? null, target: { name: clean(name) }, ...(effect ? { effect: true } : {}), ...(record ? { record: true } : {}), ...(uncertain ? { uncertain: true } : {}) };
}

export function appendAtlasLog(file, rec, { maxBytes = ATLAS_LOG_MAX_BYTES } = {}) {
  let size = 0;
  try { size = statSync(file).size; } catch { /* assente */ }
  if (size >= maxBytes) return "full";
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(rec)}\n`);
  return "written";
}

// ref degli elementi che stanno dentro un record (riga, cella): un click su di essi non entra nel registro (nomi di
// record: fornitori, persone), observe-append li legge da atlas/last-page.json scritto con la pagina
export function recordRefs(page) {
  const nodes = Array.isArray(page?.nodes) ? page.nodes : [];
  const byId = new Map(nodes.map((n) => [String(n.id), n]));
  const out = [];
  for (const n of nodes) {
    if (n.ref == null) continue;
    let p = RECORD_ROLES.has(n.role) ? n.id : n.parent;
    for (let hop = 0; p != null && hop < 200; hop++) {
      const a = byId.get(String(p));
      if (!a) break;
      if (RECORD_ROLES.has(a.role)) { out.push(String(n.ref)); break; }
      p = a.parent;
    }
  }
  return out;
}

// Avviso "registro pieno" una sola volta per sessione (marcatore nella cartella del registro). → true se va dato ora
export function fullWarningOnce(dir) {
  const marker = join(dir, "full-warned");
  if (existsSync(marker)) return false;
  mkdirSync(dir, { recursive: true });
  writeFileSync(marker, new Date().toISOString());
  return true;
}
