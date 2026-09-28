// Voci dell'Atlas (SEL) per step-check, observe-append e capture (K6): lettura leggera, senza il
// modulo yaml (è sul percorso caldo di observe-append). Percorso come readSel dei guard (§8.2):
// S → product/kb, C/L → customers/<cliente>/kb; kb/scopes/<SCOPE>/selectors/<codice>.yaml.
// Il file dell'item è la verità del contenuto: la riga del DB (`kb get`) porta solo titolo e summary,
// non ruolo ed etichetta, per questo la risoluzione legge il file.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { normLabel } from "./snapshot-parse.mjs";

export const SEL_RE = /^([SCL])\.([A-Z0-9]{3,4})\.([A-Z0-9]{3})\.SEL\.\d{4}(\.v\d+)?$/;

const scalar = (v) => {
  if (v == null) return null;
  const s = v.replace(/\s+#.*$/, "").trim();
  if (!s || s === "null" || s === "~") return null;
  const m = /^"((?:[^"\\]|\\.)*)"$/.exec(s) ?? /^'((?:[^']|'')*)'$/.exec(s);
  return m ? m[1].replace(/\\"/g, '"').replace(/''/g, "'") : s;
};

// Chiavi scalari di primo livello e le strategie (kind/value/name) di una voce SEL.
export function parseSelText(text) {
  const out = { strategies: [] };
  let inStrat = false;
  let cur = null;
  for (const line of String(text).split(/\r?\n/)) {
    const top = /^([A-Za-z_][\w]*):\s*(.*)$/.exec(line);
    if (top) {
      inStrat = top[1] === "strategies";
      if (["id", "role", "effect", "label", "field", "stability", "title"].includes(top[1]) && !(top[1] in out)) out[top[1]] = scalar(top[2]);
      if (inStrat && top[2].trim().startsWith("[")) {
        for (const m of top[2].matchAll(/\{([^}]*)\}/g)) {
          const o = {};
          for (const kv of m[1].split(",")) { const [k, ...v] = kv.split(":"); if (k && v.length) o[k.trim()] = scalar(v.join(":")); }
          out.strategies.push(o);
        }
      }
      continue;
    }
    if (!inStrat) continue;
    const item = /^\s*-\s+(?:\{(.*)\}|([A-Za-z_]\w*):\s*(.*))\s*$/.exec(line);
    if (item) {
      cur = {};
      out.strategies.push(cur);
      if (item[1] != null) {
        for (const kv of item[1].split(",")) { const [k, ...v] = kv.split(":"); if (k && v.length) cur[k.trim()] = scalar(v.join(":")); }
      } else cur[item[2]] = scalar(item[3]);
      continue;
    }
    const kv = /^\s+([A-Za-z_]\w*):\s*(.*)$/.exec(line);
    if (kv && cur) cur[kv[1]] = scalar(kv[2]);
  }
  return out;
}

export function selFile(ws, code, customer) {
  const m = typeof code === "string" ? SEL_RE.exec(code) : null;
  if (!m) return null;
  const [, level, cust, scope] = m;
  if (level !== "S" && customer && cust !== customer) return null;
  const root = level === "S" ? join(ws, "product", "kb") : join(ws, "customers", cust, "kb");
  return join(root, "scopes", scope, "selectors", `${code}.yaml`);
}

function toEntry(code, doc) {
  const s = doc.strategies ?? [];
  const label = doc.label ?? s.find((x) => x.name)?.name ?? s.find((x) => x.kind === "label")?.value ?? s.find((x) => x.kind === "text")?.value ?? null;
  const role = doc.role ?? s.find((x) => x.kind === "role")?.value ?? null;
  return { code, role, label, effect: doc.effect ?? null, field: doc.field ?? null, stability: doc.stability ?? null, strategies: s };
}

// → { code, role, label, effect, field, stability, strategies } | null
export function resolveSel(ws, code, customer) {
  const f = selFile(ws, code, customer);
  if (!f) return null;
  let text;
  try { text = readFileSync(f, "utf8"); } catch { return null; }
  const doc = parseSelText(text);
  if (doc.id !== code) return null;
  return toEntry(code, doc);
}

// Tutte le voci SEL dello scope (prodotto + cliente) → [entry]
export function atlasIndex(ws, customer, scope) {
  if (!scope) return [];
  const out = [];
  const dirs = [join(ws, "product", "kb", "scopes", scope, "selectors"), ...(customer ? [join(ws, "customers", customer, "kb", "scopes", scope, "selectors")] : [])];
  for (const d of dirs) {
    let files = [];
    try { files = readdirSync(d).filter((f) => f.endsWith(".yaml")); } catch { continue; }
    for (const f of files) {
      const code = f.slice(0, -5);
      if (!SEL_RE.test(code)) continue;
      let text;
      try { text = readFileSync(join(d, f), "utf8"); } catch { continue; }
      const doc = parseSelText(text);
      if (doc.id === code) out.push(toEntry(code, doc));
    }
  }
  return out;
}

// Ruoli compatibili fra Atlas e albero di accessibilità.
const ROLE_GROUP = {
  textbox: "input", searchbox: "input", search_box: "input", spinbutton: "input", combobox: "input", lookup: "input", textarea: "input", listbox: "input",
  checkbox: "check", switch: "check", toggle: "check",
  button: "button", link: "link", alert: "message", status: "message", toast: "message", alertdialog: "message", dialog: "message",
};
export const roleCompatible = (a, b) => !a || !b || a === b || (ROLE_GROUP[a] && ROLE_GROUP[a] === ROLE_GROUP[b]);

// Voce dell'Atlas che corrisponde a un elemento osservato (etichetta uguale, ruolo compatibile).
export function atlasMatch(atlas, el) {
  const n = normLabel(el.name);
  if (!n) return null;
  return (atlas ?? []).find((a) => a.label && normLabel(a.label) === n && roleCompatible(a.role, el.role)) ?? null;
}

// Sensibilità di un FLD (§19.20, identity.sensitivity): pii, commercial o redact_in_evidence ⇒ il valore
// si maschera per selettore. Il FLD è in kb/scopes/<SCOPE>/fields/<codice>.yaml (prodotto o cliente).
// Lettura leggera del blocco `sensitivity:`; file assente ⇒ null (non sensibile per quanto noto).
const FLD_RE = /^([SCL])\.([A-Z0-9]{3,4})\.([A-Z0-9]{3})\.FLD\.\d{4}(\.v\d+)?$/;
export function fieldSensitivity(ws, code, customer) {
  const m = typeof code === "string" ? FLD_RE.exec(code) : null;
  if (!m) return null;
  const [, level, cust, scope] = m;
  if (level !== "S" && customer && cust !== customer) return null;
  const root = level === "S" ? join(ws, "product", "kb") : join(ws, "customers", cust, "kb");
  let text;
  try { text = readFileSync(join(root, "scopes", scope, "fields", `${code}.yaml`), "utf8"); } catch { return null; }
  const i = text.search(/^\s*sensitivity:\s*$/m);
  if (i < 0) return null;
  const block = text.slice(i).split(/\r?\n/).slice(1);
  const ind = /^(\s*)/.exec(text.slice(i))[1].length;
  const out = {};
  for (const l of block) {
    if (!l.trim()) continue;
    const lead = /^(\s*)/.exec(l)[1].length;
    if (lead <= ind) break;
    const kv = /^\s*([a-z_]+):\s*(\S+)/.exec(l);
    if (kv) out[kv[1]] = kv[2] === "true" ? true : kv[2] === "false" ? false : kv[2].replace(/^["']|["']$/g, "");
  }
  return { ...out, sensitive: out.pii === true || out.commercial === true || out.redact_in_evidence === true };
}
