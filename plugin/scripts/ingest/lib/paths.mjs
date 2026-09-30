// Dove scrive la pipeline di ingest nel workspace di conoscenza (mai nel repository del plugin).
//
//   livello S (conoscenza di prodotto, vendor):  <ws>/product/{kb,sources/units,knowledge.db,reviews}
//   livello C (cliente <C>):                     <ws>/customers/<C>/{kb,sources/units,knowledge.db,reviews,kb/aliases.yaml}
//   _inbox:                                      <ws>/_inbox/<scope>/{parsed,raw,residue,reports,units-plan,survey,coverage}
//                                                (per il cliente: <ws>/customers/<C>/_inbox/<scope>/…)
//   workspacePaths({ root, customer? }) → { level, customer, base, kb, units, db, reviews, aliases, inboxRoot, inbox(scope) }
//   ensureWorkspace(paths) crea le cartelle se assenti (il workspace nasce dallo script, §34.2 onboarding)
import { mkdirSync, existsSync, writeFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CUSTOMER_RE = /^[A-Z0-9]{4}$/;

export function workspacePaths({ root, customer = null }) {
  if (!root) throw new Error("radice del workspace mancante");
  const ws = resolve(root);
  if (customer && !CUSTOMER_RE.test(customer)) throw new Error(`codice cliente non valido: ${customer} (4 caratteri A-Z0-9)`);
  const base = customer ? join(ws, "customers", customer) : join(ws, "product");
  const inboxRoot = customer ? base : ws;
  return {
    level: customer ? "C" : "S",
    customer: customer ?? "STD",
    root: ws,
    base,
    kb: join(base, "kb"),
    units: join(base, "sources", "units"),
    db: join(base, "knowledge.db"),
    reviews: join(base, "reviews"),
    aliases: join(base, "kb", "aliases.yaml"),
    inboxRoot,
    inbox: (scope) => join(inboxRoot, "_inbox", scope),
  };
}

export function ensureWorkspace(p) {
  for (const d of [p.kb, p.units, p.reviews, join(p.inboxRoot, "_inbox")]) mkdirSync(d, { recursive: true });
  const readme = join(p.root, "README.md");
  if (!existsSync(readme)) {
    writeFileSync(readme, `# Workspace di conoscenza JVC\n\nCreato dalla pipeline di ingest (scripts/ingest/ingest.mjs) del plugin jaggaer-virtual-consultant.\n\n- product/ — livello S (conoscenza di prodotto): kb/, sources/units/, knowledge.db\n- customers/<C>/ — livello C per cliente\n- _inbox/<scope>/ — uscite degli script (parsed, raw, residue, reports): mai promosse senza validazione (§29.6)\n`);
  }
  return p;
}

// Giro 1 (M14): l'uscita dell'ingestion non va MAI nel repository del plugin (corpus, requisito 4). Radice del plugin
// da questo file (scripts/ingest/lib → ../../..); confronto sui percorsi reali, senza distinzione di maiuscole su Windows.
export class PolicyError extends Error { constructor(m) { super(m); this.name = "PolicyError"; } }
const PLUGIN_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const canonPath = (p) => {
  let r = resolve(p);
  try { r = realpathSync.native(r); } catch { /* inesistente: resta il percorso risolto */ }
  r = r.replace(/[\\/]+$/, "");
  return process.platform === "win32" ? r.replace(/\//g, "\\").toLowerCase() : r;
};
export function assertOutsidePlugin(root, pluginRoot = PLUGIN_ROOT) {
  const r = canonPath(root), p = canonPath(pluginRoot);
  const sep = process.platform === "win32" ? "\\" : "/";
  if (r === p || r.startsWith(p + sep)) throw new PolicyError(`uscita dentro il repository del plugin rifiutata: ${root} (il workspace di conoscenza è separato, es. ../jvc-knowledge)`);
  return root;
}
