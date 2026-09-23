// Redazione dei valori sensibili prima della scrittura (§48.1, §54.2, T7):
// valori delle variabili d'ambiente note (NRT_*, XRAY_*, JIRA_* e nomi da
// segreto), credenziali in chiaro, token, credenziali negli URL, e-mail, IBAN.
const ENV_NAME = /^(NRT|XRAY|JIRA)_|TOKEN|SECRET|PASSW(OR)?D|API_?KEY|PRIVATE|CREDENTIAL/i;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function envSecrets(env) {
  const out = [];
  for (const [k, v] of Object.entries(env)) if (ENV_NAME.test(k) && typeof v === "string" && v.length >= 6) out.push(v);
  return out.sort((a, b) => b.length - a.length);
}

const PATTERNS = [
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, "$1***@"],
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{6,}/g, "$1 ***"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, "***"],
  [/\b(sk|pk|rk|ghp|gho|ghs|xox[abprs])[-_][A-Za-z0-9_-]{10,}/g, "***"],
  [/((?:password|passwd|pwd|token|secret|api[_-]?key|access[_-]?key|client[_-]?secret|authorization)["']?\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s&;,'"]+)/gi, "$1***"],
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "***@***"],
  [/\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,7}(?:\s?[A-Z0-9]{1,3})?\b/g, "***IBAN***"],
];

export function redact(text, env = process.env) {
  if (typeof text !== "string" || !text) return text;
  let s = text;
  for (const v of envSecrets(env)) s = s.replace(new RegExp(escapeRe(v), "g"), "***");
  for (const [re, rep] of PATTERNS) s = s.replace(re, rep);
  return s;
}

export function truncate(s, n) { return typeof s === "string" && s.length > n ? `${s.slice(0, n - 1)}…` : s; }
