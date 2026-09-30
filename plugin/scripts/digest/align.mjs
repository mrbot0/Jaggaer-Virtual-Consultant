// Digestione settimanale, passo 3 ALLINEAMENTO (§22) — WP09d. Item L di clienti diversi sullo stesso soggetto →
// gruppi. Chiavi, in ordine di priorità (un item cade nella prima che ha):
//   1. stesso genitore S (deviates_from / derives_from)                         S:<codice S>
//   2. stesso technical_name (campi, tabelle, colonne) per tipo                 TN:<tipo>:<nome>
//   3. stesso cluster + titolo normalizzato (senza il codice del cliente)        CT:<cluster>:<titolo>
// Ogni membro porta la sua "affermazione" (claimOf): l'impronta del contenuto sostanziale, per contare chi conferma e
// chi contraddice (portability.mjs).
import { createHash } from "node:crypto";

// Campi che non sono affermazioni sul soggetto (identità, provenienza, ciclo di vita, testo descrittivo).
const NOT_CLAIM = new Set(["id", "type", "title", "summary", "facets", "sources", "classification", "cluster", "deviates_from", "derives_from",
  "technical_name", "promoted_from", "promoted_to", "superseded_by", "confirmed_by_observation", "observed", "quality", "evidence", "label", "labels",
  "source_weight", "note", "notes", "epistemic", "validated"]);

export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  return JSON.stringify(v ?? null);
}

// Affermazione esplicita (claim / value) o impronta dei campi sostanziali.
export function claimOf(obj) {
  if (!obj || typeof obj !== "object") return "?";
  if (obj.claim !== undefined) return `claim:${canonical(obj.claim)}`;
  if (obj.value !== undefined) return `value:${canonical(obj.value)}`;
  const body = Object.fromEntries(Object.entries(obj).filter(([k]) => !NOT_CLAIM.has(k)));
  return createHash("sha256").update(canonical(body)).digest("hex").slice(0, 16);
}

export const normTitle = (s, customer = null) => String(s ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
  .replace(customer ? new RegExp(`\\b${customer.toLowerCase()}\\b`, "g") : /$^/, " ").replace(/[^a-z0-9]+/g, " ").trim();

export function keysOf(item) {
  const o = item.obj ?? {};
  const keys = [];
  const parent = o.deviates_from ?? o.derives_from;
  if (typeof parent === "string" && /^S\./.test(parent)) keys.push(`S:${parent}`);
  if (typeof o.technical_name === "string" && o.technical_name.trim()) keys.push(`TN:${item.type}:${o.technical_name.trim().toLowerCase()}`);
  const t = normTitle(item.title ?? o.title, item.customer);
  for (const c of [...(item.clusters ?? [])].sort()) if (t) keys.push(`CT:${c}:${t}`);
  return keys;
}

// items: [{ customer, code, type, scope, title, obj, clusters, facets, quality }] → gruppi ordinati per chiave.
export function align(items) {
  const groups = new Map();
  for (const it of items) {
    const k = keysOf(it)[0];
    if (!k) continue;
    if (!groups.has(k)) groups.set(k, { key: k, type: it.type, scope: it.scope, members: [] });
    groups.get(k).members.push({ customer: it.customer, code: it.code, claim: claimOf(it.obj), facets: it.facets ?? {}, quality: it.quality ?? null,
      clusters: it.clusters ?? [], title: it.title ?? null, obj: it.obj ?? null });
  }
  return [...groups.values()].map((g) => ({ ...g, customers: [...new Set(g.members.map((m) => m.customer))].sort() }))
    .sort((a, b) => b.customers.length - a.customers.length || a.key.localeCompare(b.key));
}
