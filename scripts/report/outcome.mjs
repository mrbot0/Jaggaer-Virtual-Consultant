// Classificazione degli esiti (K6.6, §29.9): un errore non è un esito, è un evento; l'esito dipende da
// cosa ci si aspettava. Tassonomia chiusa; funzione pura.
//
//   classifyOutcome({ expected, observed, errors, policyAbort, userAbort, completed, understoodError, assumption })
//     → { outcome, reason, completion, learning_event, lesson, defect, xray }
//   expected: { state?, error?: { code?, category?, message? } } · observed: { state? }
//   errors: [{ code?, category?, message?, environment? }] (ERR riconosciuti da observe-append)
//
// Regole: un errore atteso e ricevuto è un successo PIENO; un errore inatteso diventa lezione solo se capito
// e il compito è completato (per altra via o ripreso), altrimenti ERROR-BLOCKING; un errore d'ambiente
// (E2: system, timeout, o marcato environment) non è mai un Defect; la policy che ferma non produce lezione.
// Metriche separate (§29.9): completion (ERROR-AS-LESSON conta come successo) e learning_event.
export const OUTCOMES = ["SUCCESS", "SUCCESS-WITH-ASSUMPTION", "EXPECTED-ERROR-AS-SUCCESS", "ERROR-AS-LESSON", "ERROR-BLOCKING", "ERROR-ENVIRONMENT", "PARTIAL", "ABORTED-BY-POLICY", "ABORTED-BY-USER"];
const ENV_CATEGORIES = new Set(["system", "timeout", "environment"]);
const low = (s) => String(s ?? "").toLowerCase();

export const isEnvironmentError = (e) => e?.environment === true || e?.class === "E2" || ENV_CATEGORIES.has(e?.category);
export function matchesExpected(err, exp) {
  if (!exp || !err) return false;
  if (exp.code && low(exp.code) !== low(err.code)) return false;
  if (exp.category && exp.category !== err.category) return false;
  if (exp.message && !low(err.message).includes(low(exp.message))) return false;
  return !!(exp.code || exp.category || exp.message);
}

// Stato Xray (§27.5): l'errore atteso è PASSED; l'ambiente non è mai FAILED (né un Defect).
const XRAY = {
  "SUCCESS": "PASSED", "SUCCESS-WITH-ASSUMPTION": "PASSED", "EXPECTED-ERROR-AS-SUCCESS": "PASSED", "ERROR-AS-LESSON": "PASSED",
  "ERROR-BLOCKING": "FAILED", "ERROR-ENVIRONMENT": "ABORTED", "PARTIAL": "ABORTED", "ABORTED-BY-POLICY": "ABORTED", "ABORTED-BY-USER": "ABORTED",
};
export const toXrayStatus = (outcome) => XRAY[outcome] ?? "TODO";

const COMPLETION = new Set(["SUCCESS", "SUCCESS-WITH-ASSUMPTION", "EXPECTED-ERROR-AS-SUCCESS", "ERROR-AS-LESSON"]);
function result(outcome, reason, extra = {}) {
  return {
    outcome, reason,
    completion: COMPLETION.has(outcome),
    learning_event: outcome === "ERROR-AS-LESSON" || outcome === "ERROR-BLOCKING" || outcome === "EXPECTED-ERROR-AS-SUCCESS",
    lesson: outcome !== "ABORTED-BY-POLICY",
    defect: outcome === "ERROR-BLOCKING",
    xray: toXrayStatus(outcome),
    ...extra,
  };
}

export function classifyOutcome({ expected = {}, observed = {}, errors = [], policyAbort = false, userAbort = false, completed = false, understoodError = false, assumption = null } = {}) {
  const errs = Array.isArray(errors) ? errors.filter(Boolean) : [];
  if (policyAbort) return result("ABORTED-BY-POLICY", "un guard ha fermato l'azione: la policy ha funzionato (nessuna lezione)");
  if (userAbort) return result("ABORTED-BY-USER", "l'utente ha detto no");
  const expErr = expected?.error ?? null;
  const unexpected = errs.filter((e) => !matchesExpected(e, expErr));
  // WP07 giro 1 (spec I6, §29.8 NEG.0031): l'errore atteso non basta — anche lo stato finale deve essere quello atteso
  const stateMismatch = expected?.state != null && low(expected.state) !== low(observed?.state);
  if (errs.length && unexpected.length === 0 && stateMismatch) return result("ERROR-BLOCKING", `errore atteso ricevuto ma stato finale ${observed?.state ?? "ignoto"} invece di ${expected.state}`);
  if (errs.length && unexpected.length === 0) return result("EXPECTED-ERROR-AS-SUCCESS", `errore atteso ricevuto (${errs.map((e) => e.code ?? e.category).join(", ")}): la regola esiste e funziona`);
  if (unexpected.some(isEnvironmentError)) return result("ERROR-ENVIRONMENT", `errore d'ambiente (${unexpected.filter(isEnvironmentError).map((e) => e.category ?? e.code).join(", ")}): riprova, poi blocked; mai un Defect`);
  if (unexpected.length) {
    if (understoodError && completed) return result("ERROR-AS-LESSON", `errore inatteso capito e registrato (${unexpected.map((e) => e.code ?? e.category).join(", ")}); compito completato`);
    return result("ERROR-BLOCKING", `errore inatteso ${understoodError ? "che ha fermato il compito" : "non capito"} (${unexpected.map((e) => e.code ?? e.category).join(", ")})`);
  }
  if (expErr) return result("ERROR-BLOCKING", "errore atteso non ricevuto: l'atteso dichiarato non è verificato");
  if (!completed) return result("PARTIAL", "parte del piano eseguita, parte no, senza errori");
  if (expected?.state != null && low(expected.state) !== low(observed?.state)) return result("ERROR-BLOCKING", `atteso ${expected.state}, osservato ${observed?.state ?? "nulla"}`);
  if (assumption) return result("SUCCESS-WITH-ASSUMPTION", `verificato su un'assunzione dichiarata: ${assumption}`);
  return result("SUCCESS", expected?.state != null ? `atteso dichiarato verificato: ${expected.state}` : "compito completato");
}
