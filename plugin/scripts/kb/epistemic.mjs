import { readFileSync } from "node:fs";
import YAML from "yaml";
const EXPECTED = YAML.parse(readFileSync(new URL("../../schemas/expected-attributes.yaml", import.meta.url), "utf8"));
const clamp = (x) => Math.max(0, Math.min(1, x));

// Un attributo può essere documentato da più generi di fonte alla volta
// (§9.2: "attributi_attesi_coperti_da_fonti_tecniche / attributi_attesi" —
// un genere non esclude l'altro sullo stesso attributo): il valore in
// item.attrs[nome] può quindi essere una singola stringa-genere o un array
// di generi.
const hasGenre = (value, g) => (Array.isArray(value) ? value.includes(g) : value === g);

export function coverage(item, ev) {
  const expected = EXPECTED[item.type] ?? [];
  const attrs = item.attrs ?? {};
  const covered = Object.keys(attrs);
  const byGenre = (g) => (expected.length ? covered.filter((a) => hasGenre(attrs[a], g)).length / expected.length : 0);
  const k_tech = clamp(byGenre("tecnica"));
  // k_use e k_user sono componenti indipendenti (§9.2, esempio §9.4: k_use
  // .43, k_user .50 nello stesso soggetto): k_use misura solo la copertura
  // documentale di genere "d'uso", k_user solo le dichiarazioni dirette.
  const k_use = clamp(byGenre("d'uso"));
  const k_obs = clamp(Math.min(1, ev.obsConfirmations / 3) * ev.freshness);
  const k_exec = clamp(Math.min(1, ev.execWithOutcome / 3) * ev.freshness);
  const k_user = clamp(Math.min(1, ev.userStatements / 2));
  const gaps = expected.filter((a) => !covered.includes(a));
  let shape;
  if (ev.openContradictions > 0) shape = "contraddittorio";
  else if (k_tech < 0.3 && k_use < 0.3 && k_obs < 0.3 && k_exec < 0.3) shape = "ignoto";
  else if (k_tech >= 0.7 && k_use >= 0.5 && k_obs >= 0.7 && k_exec >= 0.7) shape = "consolidato";
  else if ((k_tech >= 0.7 || k_use >= 0.7) && k_obs < 0.3 && k_exec < 0.3) shape = "libresco";
  else if ((k_obs >= 0.7 || k_exec >= 0.7) && k_tech < 0.3 && k_use < 0.3) shape = "empirico";
  else shape = "libresco";
  return { k_tech, k_use, k_obs, k_exec, k_user, shape, gaps };
}
