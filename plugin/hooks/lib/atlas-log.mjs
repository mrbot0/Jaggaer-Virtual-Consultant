// Registro dell'esplorazione (soluzione A, spec 2026-09-30 §A1): per ogni pagina letta per intero, SOLA STRUTTURA —
// ruoli, nomi redatti, obblighi — e i click fra le pagine. Mai valori dei campi, mai record di tabelle (righe e celle,
// salvo le intestazioni di colonna), URL senza query. Lo scrive solo observe-append (guard-scope lo protegge).
//   pageRecord(page, { pageSig, profile, env, ts }) · clickRecord({ fromSig, name, ts })
//   appendAtlasLog(file, rec, { maxBytes }) → "written" | "full" · atlasLogFile(ws, customer, sid)
import { appendFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { redactText } from "../../scripts/chrome/redact.mjs";

export const ATLAS_LOG_MAX_BYTES = 20 * 1024 * 1024;
const MAX_ELEMENTS = 300;
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

export function pageRecord(page, { pageSig, profile = "strict", env = process.env, ts = new Date().toISOString() } = {}) {
  const els = Array.isArray(page?.elements) ? page.elements : [];
  // albero dei nodi del parser (page.nodes: id, parent, role, ref); senza albero nessun antenato è noto
  const nodes = Array.isArray(page?.nodes) ? page.nodes : [];
  const byId = new Map(nodes.map((n) => [String(n.id), n]));
  const idOfRef = new Map(nodes.filter((n) => n.ref != null).map((n) => [String(n.ref), String(n.id)]));
  const nodeOf = (e) => (e.ref != null && idOfRef.has(String(e.ref)) ? byId.get(idOfRef.get(String(e.ref))) : null);
  const keyOf = (e) => String(nodeOf(e)?.id ?? e.ref);
  const inRecord = (e) => {
    let p = nodeOf(e)?.parent ?? null;
    for (let hop = 0; p != null && hop < 200; hop++) {
      const a = byId.get(String(p));
      if (!a) break;
      if (RECORD_ROLES.has(a.role)) return true;
      p = a.parent;
    }
    return false;
  };
  const kept = [];
  const index = new Map();
  for (const e of els) {
    if (kept.length >= MAX_ELEMENTS) break;
    if (!STRUCT_ROLES.has(e.role)) continue;
    if (!HEADER_ROLES.has(e.role) && inRecord(e)) continue;
    const name = clean(redactText(clean(e.name), { profile, env }).text);
    let p = nodeOf(e)?.parent ?? null;
    let parent = null;
    for (let hop = 0; p != null && hop < 200; hop++) {
      if (index.has(String(p))) { parent = index.get(String(p)); break; }
      p = byId.get(String(p))?.parent ?? null;
    }
    const rec = { i: kept.length, parent, role: e.role, name };
    if (e.required) rec.required = true;
    if (e.disabled) rec.disabled = true;
    if (e.checked !== undefined) rec.checked = e.checked;
    if (e.level !== undefined) rec.level = e.level;
    index.set(keyOf(e), kept.length);
    kept.push(rec);
  }
  return { kind: "page", ts, url_path: urlPath(page?.url, profile, env), page_sig: pageSig ?? null, title: page?.title ? clean(redactText(page.title, { profile, env }).text) : null, elements: kept };
}

export function clickRecord({ fromSig, name, ts = new Date().toISOString() }) {
  return { kind: "click", ts, from_sig: fromSig ?? null, target: { name: clean(name) } };
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
