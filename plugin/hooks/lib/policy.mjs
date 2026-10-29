// Policy unica dei guard (29/10/2026, decisione dell'utente: «una sola policy per profilo» invece della condizione
// "esplorazione vera" ripetuta in sette file e delle patch datate). I profili e le capacità sono dichiarati in
// hooks/lib/policy-profiles.json (fonte unica; docs/POLICY.md si genera da lì con scripts/admin/policy-doc.mjs).
//   profileOf(session, envType?) → "senza-sessione" | "produzione" | "piano" | "esplorazione" | "standard"
//   allows(session, capability, envType?) → true solo se il profilo concede la capacità (capacità ignota ⇒ false)
// Fail-closed: profilo o capacità sconosciuti ⇒ false. Leggero: un solo JSON letto all'import, niente YAML né DB.
import { readFileSync } from "node:fs";

export const POLICY = JSON.parse(readFileSync(new URL("./policy-profiles.json", import.meta.url), "utf8"));
const EXPLORE_ENVS = new Set(["sandbox", "preprod"]);

export function profileOf(session, envType = session?.env?.type ?? null) {
  if (!session || typeof session !== "object") return "senza-sessione";
  if (envType === "prod") return "produzione";
  if (session.active_plan) return "piano";
  if (session.mode === "esplorazione" && EXPLORE_ENVS.has(envType)) return "esplorazione";
  return "standard";
}

export function allows(session, capability, envType) {
  if (!Object.hasOwn(POLICY.capabilities, capability)) return false;
  const p = POLICY.profiles[profileOf(session, envType === undefined ? session?.env?.type ?? null : envType)];
  return p?.[capability] === true;
}
