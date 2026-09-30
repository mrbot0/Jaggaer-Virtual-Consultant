// Back-check di fondatezza (§19.14): per ogni affermazione dell'item, il testo delle unità citate la DICE?
// Non giudica se è vera: giudica se è citata. Verificatore deterministico T0 (questo script è il gate; un verificatore
// LLM è facoltativo e non sostituisce questo).
//
//   claimsOf(item) → [{ attribute, text, units[], derived? }]
//     le affermazioni sono gli attributi attesi del tipo presenti nell'item (schemas/expected-attributes.yaml), più
//     item.claims[] espliciti; le unità citate vengono da sources[] ({ unit, attribute | attributes }) — una fonte
//     senza attributo vale per tutti — e da item.attribute_sources { attributo: [U…] }; item.derived { attributo:
//     { rule } } marca l'affermazione come derivata dalla regola (non citata).
//   supportOf(claimText, unitTexts) → { verdict: supportata | parziale | non-supportata, key_terms, found, codes, missing_codes }
//     numeri e codici (cifre, MAIUSCOLO_CON_UNDERSCORE, codici con punti o trattini) devono comparire ESATTAMENTE;
//     parole chiave (≥ 4 lettere, senza parole vuote, confronto per radice di 5 lettere): ≥ 60 % supportata,
//     ≥ 30 % parziale, altrimenti non supportata.
//   backcheck(item, unitLookup) → { item, results[], counts, blocked }   una non supportata BLOCCA l'item
// CLI: node scripts/kb/backcheck.mjs --item <file.yaml> (--db <file> | --units-dir <dir>) [--json]
//      exit 0 passa · 1 errore utente · 2 errore di sistema · 3 bloccato (affermazione non supportata)
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { openDb } from "./db.mjs";
import { isMain } from "../lib/is-main.mjs";
import { parseArgs, fail } from "../lib/args.mjs";
import { confineInputs } from "../lib/text-file.mjs";

const EXPECTED = YAML.parse(readFileSync(new URL("../../schemas/expected-attributes.yaml", import.meta.url), "utf8"));
const STOP = new Set(["della", "delle", "dello", "degli", "nella", "nelle", "sono", "viene", "vengono", "questo", "questa", "quando", "anche", "dopo", "prima", "ogni",
  "tutti", "tutte", "essere", "stato", "stata", "come", "dove", "quale", "quali", "their", "there", "these", "those", "which", "where", "when", "with", "from", "that",
  "this", "have", "been", "will", "into", "only", "also", "each", "must", "should", "deve", "devono", "campo", "field", "valore", "value"]);
const norm = (s) => String(s ?? "").toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
const flat = (v) => (v === null || v === undefined ? "" : typeof v === "object" ? (Array.isArray(v) ? v.map(flat).join(" ") : Object.values(v).map(flat).join(" ")) : String(v));

// WP09b (carry WP09a): (1) il segno meno di un numero fa parte del token ("-5" ≠ "5"), riconosciuto solo quando il
// trattino non è interno a una parola; (2) un codice unito da trattini, punti o barre (REQ-CC-1, E-51-B, E1EDK01/BELNR)
// resta UN token se contiene una cifra o è un codice maiuscolo (CL-CFG): il prefisso si confronta. Le parole unite
// senza cifre (sì/no, e/o) non sono codici: si rileggono con le regole semplici.
const SIMPLE_RE = /\b[A-Za-z]*\d[\w.\-/]*\b|\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b|\b[A-Z]{2,}[0-9]*\b/g;
const CODE_RE = /(?<![\w\-./])-?\d[\w.\-/]*\b|\b[A-Za-z0-9]+(?:[-./][A-Za-z0-9]+)+\b|\b[A-Za-z]*\d[\w.\-/]*\b|\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b|\b[A-Z]{2,}[0-9]*\b/g;
const JOINED = /^[A-Za-z0-9]+(?:[-./][A-Za-z0-9]+)+$/;
const isCodeLike = (t) => /\d/.test(t) || /^[A-Z][A-Z0-9]*(?:[-_][A-Z0-9]+)+$/.test(t);
const trim = (t) => t.replace(/[.\-/]+$/, "");
// Token di numeri e codici (tutti, senza filtro): la base del confronto ESATTO.
export function codeTokens(text) {
  const out = [];
  for (const m of String(text ?? "").matchAll(CODE_RE)) {
    const t = m[0];
    if (JOINED.test(t) && !isCodeLike(t)) { for (const s of t.matchAll(SIMPLE_RE)) out.push(trim(s[0])); continue; }
    out.push(trim(t));
  }
  return out.filter(Boolean);
}
// Token del testo CITATO: i codici uniti valgono anche per le loro parti (un numero isolato dell'affermazione resta
// confermato dal codice che lo contiene, come prima); un numero con segno vale solo con il segno.
function haystackTokens(text) {
  const out = [];
  for (const t of codeTokens(text)) {
    out.push(t);
    if (!t.startsWith("-") && /[-./]/.test(t)) for (const p of t.split(/[-./]+/)) if (p) out.push(p);
  }
  return out;
}
export function codesIn(text) {
  const out = new Set();
  for (const c of codeTokens(text)) if ((c.length >= 2 && !/^[A-Z]{2,3}$/.test(c)) || /\d/.test(c)) out.add(c);
  return [...out];
}
// Forma canonica di un token: minuscolo; separatori delle migliaia tolti ("50.000" = "50000", "1,234,567" = "1234567").
export const canonCode = (c) => (/^\d{1,3}(?:[.,]\d{3})+$/.test(c) ? c.replace(/[.,]/g, "") : c).toLowerCase();

export function supportOf(claimText, unitTexts) {
  const hay = norm(unitTexts.join(" \n "));
  const codes = codesIn(claimText);
  // giro 1 (C1): appartenenza all'insieme dei token del testo citato, mai sottostringa ("10" ≠ "100", REQ_CC_1 ≠ REQ_CC_12)
  const tokens = new Set(unitTexts.flatMap((t) => haystackTokens(t)).map(canonCode));
  const missing_codes = codes.filter((c) => !tokens.has(canonCode(c)));
  const words = [...new Set((norm(claimText).match(/[\p{L}]{4,}/gu) ?? []).filter((w) => !STOP.has(w)))];
  const found = words.filter((w) => hay.includes(w.slice(0, 5)));
  const ratio = words.length ? found.length / words.length : codes.length ? 1 : 0;
  let verdict = ratio >= 0.6 ? "supportata" : ratio >= 0.3 ? "parziale" : "non-supportata";
  if (missing_codes.length) verdict = "non-supportata";
  return { verdict, key_terms: words.length, found: found.length, ratio: Math.round(ratio * 100) / 100, codes, missing_codes };
}

export function claimsOf(item) {
  const expected = EXPECTED[item?.type] ?? [];
  const perAttr = new Map();
  const general = [];
  for (const s of item?.sources ?? []) {
    const u = typeof s === "string" ? s : s?.unit;
    if (!u || !/^U\./.test(u)) continue;
    const attrs = typeof s === "object" ? [].concat(s.attribute ?? [], s.attributes ?? []) : [];
    if (!attrs.length) general.push(u);
    for (const a of attrs) { if (!perAttr.has(a)) perAttr.set(a, []); perAttr.get(a).push(u); }
  }
  for (const [a, list] of Object.entries(item?.attribute_sources ?? {})) { if (!perAttr.has(a)) perAttr.set(a, []); perAttr.get(a).push(...[].concat(list)); }
  const claims = [];
  for (const a of expected) {
    if (item[a] === undefined || item[a] === null) continue;
    claims.push({ attribute: a, text: flat(item[a]), units: [...new Set([...(perAttr.get(a) ?? []), ...(perAttr.has(a) ? [] : general)])], derived: item.derived?.[a] ?? null });
  }
  for (const c of item?.claims ?? []) claims.push({ attribute: c.attribute ?? "claim", text: String(c.text ?? ""), units: [].concat(c.units ?? []), derived: c.derived ?? null });
  return claims;
}

export function backcheck(item, lookup) {
  const results = [];
  for (const c of claimsOf(item)) {
    if (c.derived) {
      results.push({ attribute: c.attribute, verdict: c.derived.rule ? "derived" : "non-supportata", rule: c.derived.rule ?? null, reason: c.derived.rule ? `derivata dalla regola ${c.derived.rule}, non citata` : "derivata senza la regola che l'ha prodotta" });
      continue;
    }
    if (!c.units.length) { results.push({ attribute: c.attribute, verdict: "non-supportata", units: [], reason: "nessuna unità citata" }); continue; }
    const texts = c.units.map((u) => lookup(u));
    const absent = c.units.filter((u, i) => texts[i] === null || texts[i] === undefined);
    if (absent.length === c.units.length) { results.push({ attribute: c.attribute, verdict: "non-supportata", units: c.units, reason: `unità citate inesistenti: ${absent.join(", ")}` }); continue; }
    const s = supportOf(c.text, texts.filter((t) => t !== null && t !== undefined));
    results.push({ attribute: c.attribute, verdict: s.verdict, units: c.units, ratio: s.ratio, ...(s.missing_codes.length ? { missing_codes: s.missing_codes } : {}), ...(absent.length ? { missing_units: absent } : {}) });
  }
  const counts = { supportata: 0, parziale: 0, "non-supportata": 0, derived: 0 };
  for (const r of results) counts[r.verdict]++;
  return { item: item?.id ?? null, results, counts, blocked: counts["non-supportata"] > 0, outcome: counts["non-supportata"] > 0 ? "bloccato" : "passa" };
}

export function dbLookup(db) {
  const st = db.prepare("select text from units where code=?");
  return (code) => st.get(code)?.text ?? null;
}
export function dirLookup(unitsDir) {
  const cache = new Map();
  return (code) => {
    if (cache.has(code)) return cache.get(code);
    const token = /^U\.([A-Z0-9]+)\./.exec(code)?.[1];
    const file = token ? join(unitsDir, token, `${code}.yaml`) : null;
    const t = file && existsSync(file) ? YAML.parse(readFileSync(file, "utf8"))?.text ?? null : null;
    cache.set(code, t);
    return t;
  };
}

export function formatReport(r) {
  const lines = [`back-check ${r.item}`];
  for (const x of r.results) lines.push(`  ${x.attribute.padEnd(18)}← ${(x.units ?? []).join(", ") || x.rule || "—"}   ${x.verdict}${x.reason ? ` (${x.reason})` : ""}${x.missing_codes ? ` codici assenti: ${x.missing_codes.join(", ")}` : ""}`);
  lines.push(`  esito: ${r.counts.supportata} supportate, ${r.counts.parziale} parziali, ${r.counts.derived} derivate, ${r.counts["non-supportata"]} non supportate → ${r.outcome}`);
  return lines.join("\n");
}

const HELP = `uso: node scripts/kb/backcheck.mjs --item <file.yaml> (--db <knowledge.db> | --units-dir <sources/units>) [--json] [--help]

Back-check T0 (§19.14): per ogni affermazione dell'item (attributi attesi del tipo e claims[]) verifica sul testo delle
unità citate che numeri e codici compaiano esattamente e che le parole chiave ci siano → supportata · parziale ·
non-supportata · derived (con la regola). Una non supportata blocca l'item.

Exit code: 0 passa · 1 errore utente (argomenti, item illeggibile) · 2 errore di sistema · 3 bloccato.`;

function main(argv) {
  const { opts } = parseArgs(argv);
  const asJson = !!opts.json;
  if (opts.help) { console.log(HELP); return 0; }
  { const bad = confineInputs(opts, ["item"], {}); if (bad) return fail(asJson, 1, bad); }
  if (!opts.item || (!opts.db && !opts["units-dir"])) return fail(asJson, 1, "richiesti --item e --db oppure --units-dir");
  let item;
  try { item = YAML.parse(readFileSync(opts.item, "utf8")); } catch (e) { return fail(asJson, 1, `item illeggibile: ${e.message}`); }
  let db = null;
  try {
    if (opts.db) db = openDb(opts.db, { createIfMissing: false });
    const r = backcheck(item, db ? dbLookup(db) : dirLookup(opts["units-dir"]));
    console.log(asJson ? JSON.stringify({ ok: !r.blocked, ...r }) : formatReport(r));
    return r.blocked ? 3 : 0;
  } catch (e) { return fail(asJson, 2, `errore di sistema: ${e.message ?? e}`); }
  finally { db?.close(); }
}

if (isMain(import.meta.url)) process.exit(main(process.argv.slice(2)));
