// Redazione alla cattura (§54.2, K6.2/K6.3): observe-append e chrome/capture la applicano PRIMA di
// scrivere. Solo moduli built-in: è sul percorso caldo di observe-append.
//  - profilo standard: e-mail, partita IVA, codice fiscale, IBAN, telefoni, valori delle variabili
//    d'ambiente note (NRT_*, XRAY_*, JIRA_* e nomi da segreto), credenziali negli URL e token;
//  - profilo strict (pre-produzione, produzione, Jira): in più gli importi con valuta;
//  - testo libero oltre 40 caratteri troncato nell'OBS (ciò che non si maschera con certezza).
export const PROFILES = ["standard", "strict"];
export const FREE_TEXT_MAX = 40;

// §51.3: sandbox/dev standard; preprod e prod strict; Jira sempre strict. Ambiente ignoto ⇒ strict.
export function profileFor({ envType = null, jira = false, declared = null } = {}) {
  if (jira) return "strict";
  if (declared === "strict") return "strict";
  if (envType === "sandbox" || envType === "dev") return declared === "strict" ? "strict" : "standard";
  return "strict";
}

const ENV_NAME = /^(NRT|XRAY|JIRA)_|TOKEN|SECRET|PASSW(OR)?D|API_?KEY|PRIVATE|CREDENTIAL/i;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function envSecrets(env) {
  const out = [];
  for (const [k, v] of Object.entries(env ?? {})) if (ENV_NAME.test(k) && typeof v === "string" && v.length >= 4) out.push(v);
  return out.sort((a, b) => b.length - a.length);
}
// N1 (27/10/2026): le sole variabili da segreto dell'ambiente, in un oggetto semplice: chi redige migliaia di testi in una
// chiamata (observe-append sulle pagine pesanti) lo calcola una volta e lo passa come `env` (stesso risultato: redactText
// considera solo queste variabili; leggere process.env a ogni testo costa).
export function secretEnv(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env ?? {})) if (ENV_NAME.test(k) && typeof v === "string" && v.length >= 4) out[k] = v;
  return out;
}

// [nome, regex, sostituto]; l'ordine conta (IBAN prima della P.IVA, telefoni dopo i codici).
const BASE = [
  ["url-credentials", /(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, "$1***@"],
  ["token", /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{6,}/g, "$1 [segreto]"],
  ["email", /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[email]"],
  ["iban", /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){3,7}(?:[ ]?[A-Z0-9]{1,3})?\b/g, "[iban]"],
  ["codice-fiscale", /\b[A-Z]{6}[0-9LMNPQRSTUV]{2}[A-EHLMPR-T][0-9LMNPQRSTUV]{2}[A-Z][0-9LMNPQRSTUV]{3}[A-Z]\b/gi, "[cf]"],
  ["partita-iva", /\b(?:IT[ ]?)?\d{11}\b/g, "[piva]"],
  ["telefono", /(?:\+|\b00)39[ .-]?\d{2,4}(?:[ .-]?\d{2,4}){2,3}\b|\b3\d{2}[ .-]?\d{3}[ .-]?\d{3,4}\b|\b0\d{1,3}[ .-]?\d{5,8}\b/g, "[tel]"],
];
const AMOUNT = ["importo", /(?:€|EUR|USD|CHF|£|\$)[ ]?\d{1,3}(?:[.,' ]\d{3})*(?:[.,]\d{1,2})?|\b\d{1,3}(?:[.,' ]\d{3})*(?:[.,]\d{1,2})?[ ]?(?:€|EUR|euro|USD|CHF|£)(?![A-Za-z])/gi, "[importo]"];

// → { text, masks: [tipo…] }
export function redactText(text, { profile = "strict", env = process.env } = {}) {
  if (typeof text !== "string" || !text) return { text, masks: [] };
  let s = text;
  const masks = new Set();
  for (const v of envSecrets(env)) {
    const re = new RegExp(esc(v), "g");
    if (re.test(s)) { masks.add("env"); s = s.replace(re, "[segreto]"); }
  }
  for (const [name, re, rep] of profile === "strict" ? [...BASE, AMOUNT] : BASE) {
    re.lastIndex = 0;
    if (re.test(s)) { masks.add(name); re.lastIndex = 0; s = s.replace(re, rep); }
  }
  return { text: s, masks: [...masks] };
}

export const redact = (text, opts) => redactText(text, opts).text;

// Testo libero nell'OBS: redatto e, oltre 40 caratteri, troncato.
export function freeText(text, opts = {}) {
  const r = redactText(text, opts);
  if (typeof r.text !== "string") return r;
  if (r.text.length > FREE_TEXT_MAX) return { text: `${r.text.slice(0, FREE_TEXT_MAX - 1)}…`, masks: [...r.masks, "troncato"] };
  return r;
}
