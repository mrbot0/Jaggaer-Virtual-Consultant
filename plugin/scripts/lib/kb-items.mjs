// Lettura degli item della knowledge base per codice e per scope (§8.2): S → <ws>/product/kb, C/L →
// <ws>/customers/<cliente>/kb; kb/scopes/<SCOPE>/{flows,keys,lifecycles,integrations,configs,procedures,selectors,checks,
// fields,errors,tables}/<codice>.yaml; HND in kb/handoffs/. Il codice è il nome del file. Nessuna scrittura.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";

export const CODE_RE = /^([SCL])\.([A-Z0-9]{3,4})\.([A-Z0-9]{3})\.([A-Z]{3})\.(\d{4})(?:\.v\d+)?$/;
export const TYPE_DIRS = Object.freeze({ FLW: "flows", KEY: "keys", LCY: "lifecycles", INT: "integrations", CFG: "configs", CFP: "procedures",
  SEL: "selectors", CHK: "checks", FLD: "fields", ERR: "errors", TBL: "tables", CAP: "capabilities", TPL: "templates" });
// Codici del dominio analitico: kb/ e i test non li citano (§1.1, §5.4).
export const ANALYTIC_RE = /\b[SCL]\.[A-Z0-9]{3,4}\.[A-Z0-9]{3}\.(?:PAT|PBK|BRF|RUL)\.\d{4}\b/g;

export const kbRoot = (ws, level, customer) => (level === "S" ? join(ws, "product", "kb") : join(ws, "customers", customer, "kb"));

// Percorso del file dell'item (anche se non esiste) · null per un codice non valido o di un altro cliente.
export function itemFile(ws, code, customer = null) {
  const m = CODE_RE.exec(String(code ?? ""));
  if (!m) return null;
  const [, level, cust, scope, type] = m;
  if (level !== "S" && customer && cust !== customer) return null;
  const root = kbRoot(ws, level, cust);
  if (type === "HND") return join(root, "handoffs", `${code}.yaml`);
  return join(root, "scopes", scope, TYPE_DIRS[type] ?? type.toLowerCase(), `${code}.yaml`);
}

function* walk(dir) {
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (!e.name.startsWith(".") && e.name !== "_inbox") yield* walk(p); }
    else if (/^[SCL]\..+\.ya?ml$/.test(e.name)) yield p;
  }
}

function parseFile(f) {
  try { return YAML.parse(readFileSync(f, "utf8")); } catch { return null; }
}

// Item per codice: il file al suo posto; altrimenti una ricerca nella cartella dello scope (layout non canonico).
export function loadItem(ws, code, customer = null) {
  const f = itemFile(ws, code, customer);
  if (!f) return null;
  let it = existsSync(f) ? parseFile(f) : null;
  if (!it) {
    const m = CODE_RE.exec(code);
    const root = kbRoot(ws, m[1], m[2]);
    for (const p of walk(join(root, m[4] === "HND" ? "handoffs" : join("scopes", m[3])))) if (p.endsWith(`${code}.yaml`)) { it = parseFile(p); break; }
  }
  return it && it.id === code ? it : null;
}

// Tutti gli item (prodotto + cliente) di uno scope o di tutti, filtrati per tipo.
export function loadItems(ws, { customer = null, scope = null, types = null } = {}) {
  const roots = [join(ws, "product", "kb"), ...(customer ? [join(ws, "customers", customer, "kb")] : [])];
  const out = [];
  for (const r of roots) {
    const dirs = scope ? [join(r, "scopes", scope), join(r, "handoffs")] : [join(r, "scopes"), join(r, "handoffs")];
    for (const d of dirs) for (const f of walk(d)) {
      const code = f.replace(/\\/g, "/").split("/").pop().replace(/\.ya?ml$/, "");
      const m = CODE_RE.exec(code);
      if (!m || (types && !types.includes(m[4]))) continue;
      if (scope && m[4] === "HND" && !code.includes(`.${scope}.`)) {
        const it = parseFile(f);
        if (!it || ![it.from_scope, it.to_scope, it.owner_of_test].includes(scope)) continue;
        if (it.id === code) out.push(it);
        continue;
      }
      const it = parseFile(f);
      if (it && it.id === code) out.push(it);
    }
  }
  return out;
}

// Codici analitici citati in un oggetto qualsiasi (profondità arbitraria).
export function analyticCodes(obj) {
  const s = JSON.stringify(obj ?? null);
  return [...new Set(s.match(ANALYTIC_RE) ?? [])];
}

export const scopeOf = (code) => CODE_RE.exec(String(code ?? ""))?.[3] ?? null;
export const typeOf = (code) => CODE_RE.exec(String(code ?? ""))?.[4] ?? null;
