import { readFileSync } from "node:fs";
import YAML from "yaml";
const EXPECTED = YAML.parse(readFileSync(new URL("../../schemas/expected-attributes.yaml", import.meta.url), "utf8"));
const clamp = (x) => Math.max(0, Math.min(1, x));

export function coverage(item, ev) {
  const expected = EXPECTED[item.type] ?? [];
  const attrs = item.attrs ?? {};
  const covered = Object.keys(attrs);
  const byGenre = (g) => (expected.length ? covered.filter((a) => attrs[a] === g).length / expected.length : 0);
  const k_tech = clamp(byGenre("tecnica"));
  const k_obs = clamp(Math.min(1, ev.obsConfirmations / 3) * ev.freshness);
  const k_exec = clamp(Math.min(1, ev.execWithOutcome / 3) * ev.freshness);
  const k_user = clamp(Math.min(1, ev.userStatements / 2));
  // La conoscenza "d'uso" viene sia da documentazione di genere d'uso sia da
  // dichiarazioni dirette dell'utente (F15 testimoniale / F1 dichiarazione-
  // utente): le due fonti si sommano fino al tetto, non si escludono.
  const k_use = clamp(Math.max(byGenre("d'uso"), k_user));
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
