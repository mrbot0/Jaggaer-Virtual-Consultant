// Dinieghi ripetuti dei guard (29/10/2026, decisione dell'utente, punto 3 del piano: «misurare i blocchi e ripararsi da
// soli»). In una sessione reale i guard hanno negato 82 chiamate su 205 (40 %), spesso ripetendo lo stesso diniego: un
// agente che riprova la stessa chiamata non impara niente dal motivo. Qui:
//  - normalizeReason(reason): il motivo senza URL, uid/ref, numeri, hash, percorsi ed etichette tra virgolette, ≤ 120
//    caratteri — la chiave con cui si contano i dinieghi uguali (guard) e si raggruppano nella console (agents denies);
//  - adviceFor(reason): il consiglio per la famiglia del motivo — ambiente/host/impronta/environments.yaml/cartelle ⇒
//    workspace-manager; DB/KB/doctor/integrità/lock ⇒ health-keeper; altrimenti non riprovare e riferire al manager;
//  - bumpDenyCount(...): contatore leggero e persistente per sessione in customers/<C>/.sessions/<sid>/deny-counts.json
//    ({ v: 1, counts: { "<guard>\t<motivo normalizzato>": n } }), sotto lock e con scrittura atomica. Fail-open: ogni
//    guasto (file illeggibile, lock occupato, disco) restituisce null e la decisione del guard non cambia.
// Solo moduli built-in e librerie degli hook: lo carica ogni guard che nega (hooks/lib/guards/common.mjs).
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic, withFileLock } from "./fsx.mjs";
import { sessionDir, isSafeSessionId, CUSTOMER_RE } from "./workspace.mjs";
import { redact } from "./redact.mjs";

// Dinieghi uguali già registrati nella sessione oltre i quali il motivo porta il suggerimento (il terzo in poi).
export const HINT_AFTER = 2;
export const DENY_COUNTS = "deny-counts.json";
const MAX_KEYS = 500;

export const ADVICE = Object.freeze({
  workspace: "il manager invochi workspace-manager",
  health: "il manager invochi health-keeper",
  other: "non riprovare la stessa chiamata: riporta il motivo al manager",
});

// Motivo normalizzato: stesso motivo con bersagli diversi (file, URL, uid, numero di passo, piano) ⇒ stessa chiave.
// revisione di sicurezza: il motivo si redige e si tronca PRIMA delle regex (niente segreti nelle chiavi del contatore e
// della console, tempo limitato su un motivo lungo)
export function normalizeReason(reason, max = 120) {
  const s = redact(String(reason ?? "").slice(0, 1000))
    .replace(/^\[[\w:-]+\]\s*/, "")                                   // prefisso [guard] di deny()
    .replace(/\s*\(negato \d+ volte: [^()]*\)\s*$/, "")                // suggerimento già aggiunto
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'«»<>()]+/gi, "<url>")
    .replace(/"[^"\n]{0,200}"|«[^»\n]{0,200}»/g, "\"…\"")              // etichette e valori tra virgolette
    .replace(/\buid=\S+|\b\d+_\d+\b|\bref_\d+\b|\be\d+\b/g, "<ref>")   // uid di chrome-devtools, ref di playwright e di Claude in Chrome
    .replace(/\b[0-9a-f]{12,}\b/gi, "<hash>")
    .replace(/(?:[A-Za-z]:)?[\\/]?(?:[\w.*~@<>-]+[\\/])+[\w.*~@<>-]*/g, "<percorso>")   // almeno un separatore: /use resta
    .replace(/\d+/g, "N")
    .replace(/\s+/g, " ")
    .trim();
  return s.length > max ? s.slice(0, max).trimEnd() : s;
}

// Famiglia del motivo (sul testo normalizzato: i percorsi non contano, "kb/" in un percorso non è un problema del DB).
// "impronta diversa" è quella di un piano o di un file del run, non dell'ambiente: resta nella famiglia generica.
const WORKSPACE = /\bambient[ei]\b|\bhosts?\b|allowed_hosts|impronta(?! diversa)|env-check|environments\.yaml|remediation-scope\.yaml|\bcartell[ae]\b(?! lo contiene)/i;
const HEALTH_CS = /\b(?:DB|KB)\b/;
const HEALTH = /knowledge\.db|\bdatabase\b|sqlite|\bdoctor\b|integrit[àa]|\block\b|\.lock\b/i;
export function denyFamily(reason) {
  const n = normalizeReason(reason, 400);
  if (WORKSPACE.test(n)) return "workspace";
  if (HEALTH_CS.test(n) || HEALTH.test(n)) return "health";
  return "other";
}
export const adviceFor = (reason) => ADVICE[denyFamily(reason)];
export const denyHint = (reason, n) => ` (negato ${n} volte: ${adviceFor(reason)})`;

export const denyCountsFile = (ws, customer, sid) => join(sessionDir(ws, customer, sid), DENY_COUNTS);

// Incrementa il contatore (guard, motivo normalizzato) della sessione → n (questo diniego compreso) | null (guasto o
// nessuna sessione con cliente). Mai un'eccezione verso il chiamante.
export function bumpDenyCount({ ws, customer, sid, guard, reason }) {
  try {
    if (!ws || !CUSTOMER_RE.test(String(customer ?? "")) || !isSafeSessionId(sid)) return null;
    if (!existsSync(sessionDir(ws, customer, sid))) return null;   // nessuna cartella creata da un guard
    const file = denyCountsFile(ws, customer, sid);
    const key = `${guard}\t${normalizeReason(reason)}`;
    return withFileLock(`${file}.lock`, () => {
      let doc;
      try { doc = JSON.parse(readFileSync(file, "utf8")); } catch (err) {
        if (err?.code && err.code !== "ENOENT") throw err;          // illeggibile (cartella, permessi): guasto
        doc = null;                                                   // assente o JSON rovinato: si riparte da zero
      }
      if (!doc || doc.v !== 1 || !doc.counts || typeof doc.counts !== "object" || Array.isArray(doc.counts)) doc = { v: 1, counts: {} };
      const prev = Number.isInteger(doc.counts[key]) ? doc.counts[key] : 0;
      if (!prev && Object.keys(doc.counts).length >= MAX_KEYS) return 1;   // tetto: il file resta piccolo
      doc.counts[key] = prev + 1;
      doc.updated_at = new Date().toISOString();
      writeFileAtomic(file, JSON.stringify(doc));
      return prev + 1;
    }, { timeoutMs: 250, staleMs: 2000 });
  } catch { return null; }
}
