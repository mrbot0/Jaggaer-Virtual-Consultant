// Impronta di un caso NRT indipendente dal run (WP09b giro 1, I3/M17): sha256 del JSON canonico del caso senza i campi
// che cambiano senza cambiare il test (stato, riferimenti ALM, priorità, tag). compile-case la mette nel piano
// (`fingerprint`, calcolata PRIMA delle sostituzioni del run come {{prefix}} e le fixture), step-check la scrive in ogni
// esito, la promozione e compile-plan contano solo gli esiti con l'impronta della versione attuale.
import { createHash } from "node:crypto";
import { canonical } from "../../hooks/lib/audit.mjs";

const VOLATILE = ["state", "alm", "priority", "tags"];
export function caseFingerprint(caso) {
  const c = { ...(caso ?? {}) };
  for (const k of VOLATILE) delete c[k];
  return createHash("sha256").update(canonical(c)).digest("hex");
}
