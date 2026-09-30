// Pseudonimizzazione (§22 passo 2, §54.3, §54.5) — WP09d. Token stabili e salati per codici cliente, persone,
// fornitori, email e numeri di documento: HMAC-SHA256(sale, tipo + valore normalizzato), 10 cifre esadecimali.
// Il sale viene SOLO dalla variabile d'ambiente JVC_PSEUDO_SALT (mai da un file del workspace, mai da un argomento):
// senza sale non si pseudonimizza (errore), e senza sale un token non è invertibile né ricalcolabile.
// Nessun valore lascia il cliente: ciò che esce dal cliente (digestione, promozione a product/) passa di qui.
import { createHmac } from "node:crypto";

export const SALT_ENV = "JVC_PSEUDO_SALT";
export const MIN_SALT = 16;
export class PseudonymError extends Error { constructor(m) { super(m); this.name = "PseudonymError"; } }

export const PREFIX = Object.freeze({ customer: "CUST", person: "PERS", supplier: "SUPP", email: "MAIL", document: "DOCN", item: "RIF", ticket: "TKT", value: "VAL" });
const EMAIL_RE = /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g;
// Numeri di documento: prefisso alfabetico facoltativo + separatore + ≥ 6 cifre (PO-4500012345, RDA 2026000123, 4500012345).
// Le date (2026-09-01), le versioni e i SEQ dei codici (4 cifre) non corrispondono.
const DOCNUM_RE = /\b(?:[A-Z]{1,5}[-/ ]?)?\d{6,}\b/g;
const TOKEN_HEAD = /^(?:CUST|PERS|SUPP|MAIL|DOCN|RIF|TKT|VAL)-/;
const TOKEN_TAIL = /(?:CUST|PERS|SUPP|MAIL|DOCN|RIF|TKT|VAL)-$/;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const norm = (s) => String(s).normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase("it");

export function saltFrom(env = process.env) {
  const s = env[SALT_ENV];
  if (typeof s !== "string" || s.length < MIN_SALT) throw new PseudonymError(`${SALT_ENV} assente o più corto di ${MIN_SALT} caratteri: la pseudonimizzazione richiede il sale nell'ambiente (mai in un file)`);
  return s;
}

export function makeToken(salt, kind, value) {
  if (!salt) throw new PseudonymError("sale mancante");
  const p = PREFIX[kind] ?? PREFIX.value;
  return `${p}-${createHmac("sha256", salt).update(`${kind}\u0000${norm(value)}`).digest("hex").slice(0, 10)}`;
}

// pseudonymizer({ salt, customers, people, suppliers }) → { token(kind, v), text(s), object(o), map }
//   customers: codici (4 caratteri) ed eventuali nomi del cliente; people/suppliers: nomi dichiarati (profilo, ticket).
//   I codici degli item del cliente (C.ACME.… / L.ACME.…) diventano RIF-<token> (un item S non cita codici di cliente).
export function pseudonymizer({ salt, customers = [], customerNames = [], people = [], suppliers = [], keepCodes = false } = {}) {
  if (!salt) throw new PseudonymError("sale mancante");
  const map = new Map();
  const token = (kind, v) => { const t = makeToken(salt, kind, v); map.set(t, kind); return t; };
  const codes = customers.filter((c) => /^[A-Z0-9]{4}$/.test(String(c)));
  const byLength = (a, b) => b.length - a.length;
  const named = [
    ...customerNames.filter(Boolean).map((n) => ["customer", String(n)]),
    ...people.filter(Boolean).map((n) => ["person", String(n)]),
    ...suppliers.filter(Boolean).map((n) => ["supplier", String(n)]),
  ].filter(([, n]) => n.trim().length >= 3).sort((a, b) => byLength(a[1], b[1]));
  const itemRe = codes.length ? new RegExp(`\\b[CL]\\.(?:${codes.map(escapeRe).join("|")})\\.[A-Z0-9]{3}\\.[A-Z]{3}\\.\\d{4}(?:\\.v\\d+)?\\b`, "g") : null;
  const custRe = codes.length ? new RegExp(`\\b(?:${codes.map(escapeRe).join("|")})\\b`, "g") : null;
  const text = (s) => {
    if (typeof s !== "string" || !s) return s;
    let out = s;
    if (itemRe && !keepCodes) out = out.replace(itemRe, (m) => token("item", m));
    out = out.replace(EMAIL_RE, (m) => token("email", m));
    for (const [kind, n] of named) out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(n)}(?![\\p{L}\\p{N}])`, "giu"), (m) => token(kind, m));
    // un token già emesso (PREFISSO-hex, anche di sole cifre) non è un numero di documento
    out = out.replace(DOCNUM_RE, (m, off, all) => (TOKEN_HEAD.test(m) || TOKEN_TAIL.test(all.slice(Math.max(0, off - 6), off)) ? m : token("document", m)));
    if (custRe) out = out.replace(custRe, (m) => token("customer", m));
    return out;
  };
  const object = (v, skip = new Set()) => {
    if (typeof v === "string") return text(v);
    if (Array.isArray(v)) return v.map((x) => object(x, skip));
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, skip.has(k) ? x : object(x, skip)]));
    return v;
  };
  return { token, text, object, map };
}
