// Risoluzione di entità e alias (§19.12): lo stesso oggetto ha nomi diversi in documenti diversi ("Centro di costo",
// "CdC", "Cost Center", "REQ_HDR_COST_CENTER"). Senza risoluzione il sistema crea cinque item per un campo.
//
// Registro per cliente: customers/<C>/kb/aliases.yaml (livello S: product/kb/aliases.yaml)
//   { version: 1, terms: [{ term, code?, technical_name?, section?, aliases: [{ text, doc?, lang?, unverified? }] }] }
//   validateRegistry(reg) → { ok, errors }; loadRegistry(file); saveRegistry(file, reg) scrive SOLO un registro valido.
//
//   resolve(reg, { label, technical_name?, section?, lang? }) → { match: termine | null, by, candidates[] }
//     prima dell'item nuovo (l'extractor risolve sull'alias):
//       1. nome tecnico uguale (normalizzato) ⇒ stesso campo, qualunque sia la label (chiave forte)
//       2. label uguale a un termine o a un alias verificato ⇒ quel termine; alias `unverified` ⇒ candidato, non match
//       3. label a distanza normalizzata < 0.15 da un termine della STESSA sezione ⇒ merge-candidate (dedupe.labelDistance),
//          mai fusione d'ufficio: va al validatore
//   addAlias(reg, term, { text, doc?, lang?, unverified? })
//   learn(reg, rows, { docLang? }) → { added, terms_created, unverified }   dalle righe grezze di field-table:
//       stesso nome tecnico ⇒ le label diventano alias verificati; coppie it/en allineate per posizione nella stessa
//       tabella (stessa riga, documenti in lingue diverse, stesso nome tecnico o stessa posizione) ⇒ verificati;
//       una traduzione senza corrispondenza strutturale ⇒ alias `unverified`.
// CLI: node scripts/ingest/aliases.mjs resolve --registry <file> --payload-file <file>   (payload: { label, technical_name?, section? })
//      node scripts/ingest/aliases.mjs learn --registry <file> --rows-file <file.yaml|json> [--json]
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import YAML from "yaml";
import { normalizeLabel, normalizeTechnicalName, labelDistance } from "./dedupe.mjs";
import { isMain } from "../lib/is-main.mjs";
import { parseArgs, fail } from "../lib/args.mjs";
import { confineInputs } from "../lib/text-file.mjs";

export const MERGE_THRESHOLD = 0.15;
export class AliasError extends Error { constructor(m) { super(m); this.name = "AliasError"; } }

export const emptyRegistry = () => ({ version: 1, terms: [] });

export function validateRegistry(reg) {
  const errors = [];
  if (!reg || typeof reg !== "object" || !Array.isArray(reg.terms)) return { ok: false, errors: ["registro senza terms[]"] };
  const seen = new Set();
  reg.terms.forEach((t, i) => {
    if (!t?.term || typeof t.term !== "string") errors.push(`terms[${i}]: term mancante`);
    const k = normalizeLabel(t?.term);
    if (seen.has(k)) errors.push(`terms[${i}]: termine duplicato "${t.term}"`);
    seen.add(k);
    if (!Array.isArray(t?.aliases)) errors.push(`terms[${i}]: aliases deve essere una lista`);
    for (const [j, a] of (t?.aliases ?? []).entries()) if (!a?.text) errors.push(`terms[${i}].aliases[${j}]: text mancante`);
    if (t?.lang && !["it", "en"].includes(t.lang)) errors.push(`terms[${i}]: lingua non valida`);
  });
  return { ok: errors.length === 0, errors };
}

export function loadRegistry(file) {
  if (!existsSync(file)) return emptyRegistry();
  const reg = YAML.parse(readFileSync(file, "utf8")) ?? emptyRegistry();
  const v = validateRegistry(reg);
  if (!v.ok) throw new AliasError(`registro alias non valido (${file}): ${v.errors.join("; ")}`);
  return reg;
}

export function saveRegistry(file, reg) {
  const v = validateRegistry(reg);
  if (!v.ok) throw new AliasError(`registro alias non valido, non scritto: ${v.errors.join("; ")}`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, YAML.stringify(reg, { lineWidth: 0 }));
  return file;
}

const findTerm = (reg, term) => reg.terms.find((t) => normalizeLabel(t.term) === normalizeLabel(term));

export function addAlias(reg, term, { text, doc = null, lang = null, unverified = false, technical_name = null, section = null, code = null } = {}) {
  let t = findTerm(reg, term);
  if (!t) { t = { term, ...(code ? { code } : {}), ...(technical_name ? { technical_name } : {}), ...(section ? { section } : {}), aliases: [] }; reg.terms.push(t); }
  if (technical_name && !t.technical_name) t.technical_name = technical_name;
  if (!text || normalizeLabel(text) === normalizeLabel(t.term)) return t;
  const ex = t.aliases.find((a) => normalizeLabel(a.text) === normalizeLabel(text));
  if (ex) { if (ex.unverified && !unverified) delete ex.unverified; return t; }
  t.aliases.push({ text, ...(doc ? { doc } : {}), ...(lang ? { lang } : {}), ...(unverified ? { unverified: true } : {}) });
  return t;
}

export function resolve(reg, { label, technical_name = null, section = null } = {}) {
  const tn = normalizeTechnicalName(technical_name);
  if (tn) {
    const t = reg.terms.find((x) => normalizeTechnicalName(x.technical_name) === tn || x.aliases.some((a) => normalizeTechnicalName(a.text) === tn && /_/.test(String(a.text))));
    if (t) return { match: t.term, code: t.code ?? null, by: "technical_name", candidates: [] };
  }
  const nl = normalizeLabel(label);
  const candidates = [];
  for (const t of reg.terms) {
    if (normalizeLabel(t.term) === nl) return { match: t.term, code: t.code ?? null, by: "term", candidates: [] };
    const a = t.aliases.find((x) => normalizeLabel(x.text) === nl);
    if (a && !a.unverified) return { match: t.term, code: t.code ?? null, by: "alias", candidates: [] };
    if (a?.unverified) candidates.push({ term: t.term, by: "alias-unverified", distance: 0 });
  }
  for (const t of reg.terms) {
    if (section && t.section && t.section !== section) continue;
    if (!section || !t.section) continue;
    const d = Math.min(labelDistance(label, t.term), ...t.aliases.filter((a) => !a.unverified).map((a) => labelDistance(label, a.text)));
    if (d < MERGE_THRESHOLD) candidates.push({ term: t.term, by: "merge-candidate", distance: Math.round(d * 1000) / 1000 });
  }
  return { match: null, code: null, by: candidates.length ? candidates[0].by : "new", candidates };
}

export function learn(reg, rows, { docLang = {} } = {}) {
  const stats = { added: 0, terms_created: 0, unverified: 0 };
  const before = () => reg.terms.reduce((a, t) => a + t.aliases.length, 0);
  const n0 = before(), t0 = reg.terms.length;
  const byTech = new Map();
  for (const r of rows) {
    const tn = normalizeTechnicalName(r.technical_name);
    if (!tn) continue;
    if (!byTech.has(tn)) byTech.set(tn, []);
    byTech.get(tn).push(r);
  }
  for (const [, list] of byTech) {
    const main = list[0];
    const term = main.label ?? main.technical_name;
    addAlias(reg, term, { technical_name: main.technical_name, section: main.section ?? null });
    for (const r of list) {
      addAlias(reg, term, { text: r.label, doc: r.document ?? null, lang: docLang[r.document] ?? null });
      if (r.technical_name && r.technical_name !== r.label) addAlias(reg, term, { text: r.technical_name, doc: r.document ?? null });
    }
  }
  // coppie it/en per posizione: stessa sezione e stesso riferimento di riga in documenti di lingue diverse
  const noTech = rows.filter((r) => !normalizeTechnicalName(r.technical_name));
  const byPos = new Map();
  for (const r of noTech) { const k = `${r.section}|${r.row_ref}`; if (!byPos.has(k)) byPos.set(k, []); byPos.get(k).push(r); }
  for (const [, list] of byPos) {
    const langs = new Set(list.map((r) => docLang[r.document]).filter(Boolean));
    if (list.length === 2 && langs.size === 2) { addAlias(reg, list[0].label, { text: list[1].label, doc: list[1].document, lang: docLang[list[1].document] }); }
  }
  stats.added = before() - n0;
  stats.terms_created = reg.terms.length - t0;
  stats.unverified = reg.terms.reduce((a, t) => a + t.aliases.filter((x) => x.unverified).length, 0);
  return stats;
}

const HELP = `uso: node scripts/ingest/aliases.mjs resolve --registry <aliases.yaml> --payload-file <file>   ({ label, technical_name?, section? })
     node scripts/ingest/aliases.mjs learn --registry <aliases.yaml> --rows-file <righe grezze .yaml|json> [--doc-lang-file <file>]
     node scripts/ingest/aliases.mjs add --registry <aliases.yaml> --payload-file <file>      ({ term, text, doc?, lang?, unverified? })

Registro degli alias per cliente (§19.12): customers/<C>/kb/aliases.yaml. resolve: nome tecnico (chiave forte) → termine →
alias verificato → merge-candidate (distanza < ${MERGE_THRESHOLD} nella stessa sezione, mai fusione d'ufficio).

Exit code: 0 ok · 1 errore utente (argomenti, registro o payload non valido) · 2 errore di sistema.`;

function main(argv) {
  const [cmd, ...rest] = argv;
  const { opts } = parseArgs(rest);
  const asJson = !!opts.json;
  if (!cmd || cmd === "--help" || opts.help) { console.log(HELP); return cmd ? 0 : 1; }
  { const bad = confineInputs(opts, ["registry","rows-file","doc-lang-file","payload-file"], {}); if (bad) return fail(asJson, 1, bad); }
  if (!["resolve", "learn", "add"].includes(cmd)) return fail(asJson, 1, `comando sconosciuto: ${cmd}`);
  if (!opts.registry) return fail(asJson, 1, "richiesto --registry <file>");
  const read = (f) => { const t = readFileSync(f, "utf8"); return /^\s*[{[]/.test(t) ? JSON.parse(t) : YAML.parse(t); };
  try {
    const reg = loadRegistry(opts.registry);
    if (cmd === "resolve") {
      if (!opts["payload-file"]) return fail(asJson, 1, "richiesto --payload-file");
      console.log(JSON.stringify({ ok: true, ...resolve(reg, read(opts["payload-file"])) }));
      return 0;
    }
    if (cmd === "add") {
      if (!opts["payload-file"]) return fail(asJson, 1, "richiesto --payload-file");
      const p = read(opts["payload-file"]);
      if (!p?.term) return fail(asJson, 1, "payload senza term");
      addAlias(reg, p.term, p);
      saveRegistry(opts.registry, reg);
      console.log(JSON.stringify({ ok: true, term: p.term }));
      return 0;
    }
    if (!opts["rows-file"]) return fail(asJson, 1, "richiesto --rows-file");
    const rowsIn = read(opts["rows-file"]);
    const rows = Array.isArray(rowsIn) ? rowsIn : rowsIn?.rows ?? [];
    const stats = learn(reg, rows, { docLang: opts["doc-lang-file"] ? read(opts["doc-lang-file"]) : {} });
    saveRegistry(opts.registry, reg);
    console.log(JSON.stringify({ ok: true, ...stats }));
    return 0;
  } catch (e) {
    if (e instanceof AliasError || e instanceof SyntaxError || e?.code === "ENOENT") return fail(asJson, 1, e.message);
    return fail(asJson, 2, `errore di sistema: ${e.message ?? e}`);
  }
}

if (isMain(import.meta.url)) process.exit(main(process.argv.slice(2)));
