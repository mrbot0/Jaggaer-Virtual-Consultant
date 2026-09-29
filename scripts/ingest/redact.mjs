// Redazione all'ingestion (§31.2, §44.5; minaccia T3 §48.3): le unità di significato si scrivono su disco e nel DB
// solo redatte. Riusa i profili della redazione alla cattura (scripts/chrome/redact.mjs: e-mail, codici fiscali,
// partite IVA, IBAN, telefoni, segreti delle variabili d'ambiente, credenziali negli URL; strict: anche gli importi).
//
//   ingestionProfile({ level, customer }) → "strict" per il livello S (ingestion senza cliente: il livello condiviso da
//       tutti i clienti), "standard" per il livello C di un cliente
//   knownCustomers(root) → codici dei clienti presenti nel workspace (customers/<C>/)
//   makeUnitRedactor({ profile, names, env }) → (unit) → { unit, masks[] }
//       redige ogni stringa dell'unità (testo, righe di tabella, record, passi…; mai le chiavi, l'id, il codice del
//       documento, il tipo, l'hash e il contesto) e maschera come "[cliente]" i nomi dati (T3: i codici dei clienti,
//       mai quello del cliente dell'ingestion stessa); nel profilo strict anche gli autori di commenti, revisioni e
//       decisioni ("[autore]"), sia nei campi sia nel testo
//   redactUnits(units, opts) → { units, stats: { profile, units_redacted, masks: { tipo: n } } }
//   redactDoc(doc, redactor) → il documento normalizzato redatto (per la pre-estrazione e le righe grezze dei campi)
//
// La pipeline (ingest.mjs) lo applica DOPO la segmentazione e PRIMA che le unità siano scritte (segmentUnits riceve il
// redattore e lo applica a ogni unità prima dell'hash: così i codici delle unità restano stabili fra versioni).
//
// CLI: node scripts/ingest/redact.mjs --text-file <file> [--profile standard|strict] [--customer C] [--json] [--help]
// Exit: 0 ok · 1 argomenti o file.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { redactText, PROFILES } from "../chrome/redact.mjs";
import { parseArgs, fail } from "../lib/args.mjs";
import { isMain } from "../lib/is-main.mjs";
import { readTextFile, inputBase } from "../lib/text-file.mjs";

export { PROFILES };
const KEEP = new Set(["id", "doc", "doc_id", "type", "hash", "words", "lang", "context", "refs_out", "part"]);
const AUTHORED = ["comment", "revision", "decision"];
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function ingestionProfile({ level = null, customer = null } = {}) {
  return level === "S" || !customer ? "strict" : "standard";
}

export function knownCustomers(root) {
  try { return readdirSync(join(root, "customers"), { withFileTypes: true }).filter((d) => d.isDirectory() && /^[A-Z0-9]{4}$/.test(d.name)).map((d) => d.name); } catch { return []; }
}

export function makeUnitRedactor({ profile = "strict", names = [], env = process.env } = {}) {
  if (!PROFILES.includes(profile)) throw new Error(`profilo di redazione sconosciuto: ${profile} (${PROFILES.join(" · ")})`);
  const nameRes = [...new Set(names.filter((n) => typeof n === "string" && n.length >= 3))].sort((a, b) => b.length - a.length)
    .map((n) => new RegExp(`(?<![A-Za-z0-9_])${esc(n)}(?![A-Za-z0-9_])`, "g"));
  return (unit) => {
    const masks = new Set();
    const authors = profile === "strict" ? AUTHORED.map((k) => unit?.[k]?.author).filter((a) => typeof a === "string" && a.trim().length >= 2) : [];
    const authorRes = [...new Set(authors)].sort((a, b) => b.length - a.length).map((a) => new RegExp(esc(a), "g"));
    const str = (s) => {
      let out = s;
      for (const re of authorRes) { re.lastIndex = 0; if (re.test(out)) { masks.add("autore"); out = out.replace(re, "[autore]"); } }
      for (const re of nameRes) { re.lastIndex = 0; if (re.test(out)) { masks.add("cliente"); out = out.replace(re, "[cliente]"); } }
      const r = redactText(out, { profile, env });
      for (const m of r.masks) masks.add(m);
      return r.text;
    };
    const deep = (v) => (typeof v === "string" ? str(v) : Array.isArray(v) ? v.map(deep) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x)])) : v);
    const out = {};
    for (const [k, v] of Object.entries(unit ?? {})) out[k] = KEEP.has(k) ? v : k === "section" && v && typeof v === "object" ? { ...deep(v), path: v.path } : deep(v);
    return { unit: out, masks: [...masks] };
  };
}

// Il documento normalizzato per gli usi a valle delle unità (pre-estrazione, righe grezze delle tabelle di campi):
// stesse regole, sezione per sezione; path, kind e level restano.
export function redactDoc(doc, redactor) {
  return { ...doc, sections: (doc.sections ?? []).map((s) => ({ ...redactor(s).unit, path: s.path, kind: s.kind, level: s.level })) };
}

export function redactUnits(units, opts = {}) {
  const profile = opts.profile ?? "strict";
  const r = opts.redactor ?? makeUnitRedactor({ ...opts, profile });
  const stats = { profile, units_redacted: 0, masks: {} };
  const out = units.map((u) => {
    const x = r(u);
    if (x.masks.length) stats.units_redacted++;
    for (const m of x.masks) stats.masks[m] = (stats.masks[m] ?? 0) + 1;
    return x.unit;
  });
  return { units: out, stats };
}

const HELP = `uso: node scripts/ingest/redact.mjs --text-file <file> [--profile standard|strict] [--customer C] [--json] [--help]

Redige un testo come la pipeline di ingestion redige le unità (§31.2, T3): e-mail, codici fiscali, partite IVA, IBAN,
telefoni, segreti, credenziali negli URL; strict (livello S, ingestion senza cliente) anche gli importi; i codici degli
altri clienti del workspace diventano [cliente]. Il file sta nel workspace (confinato come ogni file d'ingresso).

Exit code: 0 ok · 1 argomenti o file.`;

export function run(argv, env = process.env) {
  const { opts } = parseArgs(argv);
  const asJson = !!opts.json;
  if (opts.help) { console.log(HELP); return 0; }
  if (!opts["text-file"]) return fail(asJson, 1, "richiesto --text-file <file>");
  const profile = opts.profile ?? ingestionProfile({ level: opts.customer ? "C" : "S", customer: opts.customer ?? null });
  if (!PROFILES.includes(profile)) return fail(asJson, 1, `profilo sconosciuto: ${profile} (${PROFILES.join(" · ")})`);
  const base = inputBase(env);
  const t = readTextFile(base, String(opts["text-file"]), { max: 1024 * 1024 });
  if (t.error) return fail(asJson, 1, t.error);
  const names = knownCustomers(base).filter((c) => c !== opts.customer);
  const { unit, masks } = makeUnitRedactor({ profile, names, env })({ text: t.text });
  console.log(asJson ? JSON.stringify({ ok: true, profile, masks, text: unit.text }) : unit.text);
  return 0;
}

if (isMain(import.meta.url)) process.exit(run(process.argv.slice(2)));
