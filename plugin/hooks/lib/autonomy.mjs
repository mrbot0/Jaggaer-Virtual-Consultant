// Livello di autonomia di ops (spec 2026-10-06 §3.1, scelta dell'utente 06–07/10/2026): frase dell'utente nel registro
// delle approvazioni > customers/<C>/config/autonomy.yaml > "alto"; poi il tetto dell'ambiente (produzione: medio).
// Fail-closed: file del cliente illeggibile o fuori elenco ⇒ basso.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";

export const LEVELS = Object.freeze(["basso", "medio", "alto"]);
const rank = (l) => LEVELS.indexOf(l);
export const minLevel = (a, b) => (rank(a) <= rank(b) ? a : b);
export const capFor = (envType) => (envType === "prod" ? "medio" : "alto");
export const autonomyFile = (ws, customer) => join(ws, "customers", customer, "config", "autonomy.yaml");

function customerLevel(ws, customer) {
  const f = autonomyFile(ws, customer);
  if (!existsSync(f)) return { level: null, warning: null };
  try {
    const d = YAML.parse(readFileSync(f, "utf8"));
    if (d && typeof d === "object" && !Array.isArray(d) && LEVELS.includes(d.default)) return { level: d.default, warning: null };
  } catch { /* sotto: fail-closed */ }
  return { level: "basso", warning: `customers/${customer}/config/autonomy.yaml illeggibile o con un valore fuori elenco (alto, medio, basso): vale basso` };
}

export function autonomyLevel({ ws, customer, records = [], envType }) {
  const phrase = (Array.isArray(records) ? records : []).filter((r) => r && r.kind === "autonomy" && LEVELS.includes(r.level)).at(-1);
  let chosen; let source; let warning = null;
  if (phrase) { chosen = phrase.level; source = "frase"; }
  else {
    const c = customerLevel(ws, customer);
    if (c.level) { chosen = c.level; source = "cliente"; warning = c.warning; }
    else { chosen = "alto"; source = "predefinito"; }
  }
  return { level: minLevel(chosen, capFor(envType)), chosen, source, warning };
}
