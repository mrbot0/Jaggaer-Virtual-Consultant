// L'economia della revisione umana (§19.19): la risorsa più scarsa, spesa dove cambia le cose.
//
//   buildQueue({ db?, inboxRoot, scope?, seed = "jvc", sample = 0.05 }) → { strata: [{ stratum, why, items[] }], total }
//     strati in ordine (tabella di §19.19):
//       quarantena    item in quarantena per attributo critico mancante (F12 = quarantena, DB o _inbox/<scope>/digested)   tutti
//       dt021         item ambigui su DT-021 (S vs C): decisioni DT-021 con esito ambiguo, o dt021: ambiguo nel digerito     tutti
//       r3            soggetti con rischio R3 (F10)                                                                          tutti
//       ctr           CTR aperti fra fonti dello stesso cliente                                                             tutti
//       deontiche     unità ambiguous di regole deontiche (residuo di ingest)                                               a lotti da 10
//       campione      il resto dei digeriti: 5 % stratificato per tipo, ordine deterministico da sha256(seed + codice)       min 1 per tipo
//   record(reviewsDir, { verb, code, type?, field?, value?, rule?, reviewer?, at? }) → voce appesa a <reviewsDir>/<AAAA-MM>.jsonl
//     verbi: accept · correct <campo>=<valore> · reject <regola> (la regola violata è obbligatoria)
//   stats(reviewsDir) → { by_type: { T: { reviewed, first_pass_accepted, corrected, rejected, first_pass_rate } }, total }
//     il tasso di accettazione al PRIMO passaggio per tipo di item è la metrica principale della pipeline (il primo verbo
//     registrato per un codice decide il primo passaggio).
// CLI: node scripts/kb/review.mjs queue --root <ws> [--customer C] [--scope S] [--seed s] [--json]
//      node scripts/kb/review.mjs accept <codice> --root <ws> [--customer C] [--reviewer nome]
//      node scripts/kb/review.mjs correct <codice> <campo>=<valore> --root <ws> [--customer C]   (o --payload-file { field, value })
//      node scripts/kb/review.mjs reject <codice> <regola> --root <ws> [--customer C]
//      node scripts/kb/review.mjs stats --root <ws> [--customer C] [--json]
import { readFileSync, writeFileSync, appendFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import YAML from "yaml";
import { openDb } from "./db.mjs";
import { parseCode, isValidCode } from "./codes.mjs";
import { workspacePaths } from "../ingest/lib/paths.mjs";
import { isMain } from "../lib/is-main.mjs";
import { parseArgs, fail } from "../lib/args.mjs";
import { readDataFileSync, inputBase } from "../lib/text-file.mjs";

export const VERBS = ["accept", "correct", "reject"];
export const DEONTIC_BATCH = 10;
export class ReviewError extends Error { constructor(m) { super(m); this.name = "ReviewError"; } }

const readYamlDir = (dir, filter = () => true) => (existsSync(dir) ? readdirSync(dir).filter((f) => /\.ya?ml$/.test(f) && filter(f)).map((f) => { try { return YAML.parse(readFileSync(join(dir, f), "utf8")); } catch { return null; } }).filter(Boolean) : []);
const order = (seed) => (a, b) => createHash("sha256").update(`${seed}|${a}`).digest("hex").localeCompare(createHash("sha256").update(`${seed}|${b}`).digest("hex"));

function inboxScopes(inboxRoot, scope) {
  const base = join(inboxRoot, "_inbox");
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory() && (!scope || e.name === scope)).map((e) => ({ scope: e.name, dir: join(base, e.name) }));
}

export function buildQueue({ db = null, inboxRoot, scope = null, seed = "jvc", sample = 0.05 } = {}) {
  const items = new Map();   // codice → { code, type, facets, dt021?, source }
  if (db) {
    for (const r of db.prepare("select code, type, scope, facets, status from items where status <> 'deprecato'").all()) {
      if (scope && r.scope !== scope) continue;
      items.set(r.code, { code: r.code, type: r.type, facets: JSON.parse(r.facets ?? "{}"), status: r.status, source: "kb" });
    }
  }
  const deontic = [];
  for (const s of inboxScopes(inboxRoot, scope)) {
    for (const it of readYamlDir(join(s.dir, "digested"))) {
      if (!it?.id) continue;
      items.set(it.id, { code: it.id, type: it.type ?? parseCode(it.id)?.type, facets: it.facets ?? {}, status: it.facets?.F12 ?? it.status ?? "digerito", dt021: it.dt021 ?? it.decisions?.["DT-021"] ?? null, missing: it.missing_critical ?? it.gaps ?? [], source: "_inbox" });
    }
    for (const r of readYamlDir(join(s.dir, "residue"))) for (const e of r.entries ?? []) if (e.class === "ambiguous" && e.unit) deontic.push({ unit: e.unit, reason: e.reason, doc: r.doc, scope: s.scope });
    for (const raw of readYamlDir(join(s.dir, "raw"))) for (const it of raw.items ?? []) if (it.residue?.class === "ambiguous" && !deontic.some((d) => d.unit === it.source_unit)) deontic.push({ unit: it.source_unit, reason: it.residue.reason, doc: raw.doc, scope: s.scope });
  }
  const all = [...items.values()];
  const taken = new Set();
  const take = (list) => { const out = list.filter((x) => !taken.has(x.code)); out.forEach((x) => taken.add(x.code)); return out.map((x) => ({ code: x.code, type: x.type, why: x.why ?? null })); };
  const quarantena = take(all.filter((x) => (x.facets?.F12 ?? x.status) === "quarantena").map((x) => ({ ...x, why: x.missing?.length ? `manca ${[].concat(x.missing).join(", ")}` : "attributo critico mancante" })));
  const ambiguousDec = db ? new Set(db.prepare("select subject_code from decisions where table_code='DT-021' and outcome='ambiguo'").all().map((r) => r.subject_code)) : new Set();
  const dt021 = take(all.filter((x) => x.dt021 === "ambiguo" || x.dt021?.outcome === "ambiguo" || ambiguousDec.has(x.code)).map((x) => ({ ...x, why: "S o C? (DT-021 ambiguo)" })));
  const r3 = take(all.filter((x) => x.facets?.F10 === "R3").map((x) => ({ ...x, why: "rischio R3" })));
  const ctr = db ? db.prepare("select code, a_code, b_code, facet from contradictions where coalesce(status,'aperta') not in ('risolta','chiusa','resolved')").all()
    .filter((c) => { const a = parseCode(c.a_code ?? ""), b = parseCode(c.b_code ?? ""); return a && b && a.customer === b.customer && a.customer !== "STD"; })
    .map((c) => ({ code: c.code, type: "CTR", why: `${c.a_code} ↔ ${c.b_code}${c.facet ? ` (${c.facet})` : ""}` })) : [];
  deontic.sort((a, b) => order(seed)(a.unit, b.unit));
  const batches = [];
  for (let i = 0; i < deontic.length; i += DEONTIC_BATCH) batches.push(deontic.slice(i, i + DEONTIC_BATCH));
  const rest = all.filter((x) => !taken.has(x.code) && ["digerito", "validato", "clusterizzato"].includes(x.facets?.F12 ?? x.status));
  const byType = new Map();
  for (const x of rest) { if (!byType.has(x.type)) byType.set(x.type, []); byType.get(x.type).push(x); }
  const campione = [];
  for (const [type, list] of [...byType].sort((a, b) => String(a[0]).localeCompare(String(b[0])))) {
    const n = Math.max(1, Math.ceil(list.length * sample));
    campione.push(...list.map((x) => x.code).sort(order(seed)).slice(0, n).map((code) => ({ code, type, why: `campione ${Math.round(sample * 100)} % (${type})` })));
  }
  const strata = [
    { stratum: "quarantena", why: "item in quarantena per attributo critico mancante: senza di esso l'item non serve", items: quarantena },
    { stratum: "dt021", why: "item ambiguo su DT-021 (S vs C): un errore contamina il livello prodotto", items: dt021 },
    { stratum: "r3", why: "soggetti con rischio R3: il costo di un errore è alto", items: r3 },
    { stratum: "ctr", why: "CTR fra fonti dello stesso cliente: solo un umano sa quale documento è aggiornato", items: ctr },
    { stratum: "deontiche", why: `unità ambiguous di regole deontiche, a lotti da ${DEONTIC_BATCH}`, batches },
    { stratum: "campione", why: "il resto dei digeriti: campione stratificato per tipo", items: campione },
  ];
  return { seed, strata, total: quarantena.length + dt021.length + r3.length + ctr.length + deontic.length + campione.length };
}

export function parseVerb(args, payload = null) {
  const [verb, code, ...rest] = args;
  if (!VERBS.includes(verb)) throw new ReviewError(`verbo sconosciuto: ${verb} (${VERBS.join(", ")})`);
  if (!code) throw new ReviewError(`${verb} richiede il codice`);
  if (!isValidCode(code) && !/^U\.[A-Z0-9]+\.\d{4,}$/.test(code) && !/^CTR-|^C\.|^L\./.test(code)) throw new ReviewError(`codice non valido: ${code}`);
  if (verb === "accept") return { verb, code };
  if (verb === "correct") {
    const fv = payload ?? (() => { const m = /^([\w.[\]-]+)=(.*)$/s.exec(rest.join(" ")); return m ? { field: m[1], value: m[2] } : null; })();
    if (!fv?.field) throw new ReviewError("correct richiede <campo>=<valore> (o --payload-file { field, value })");
    return { verb, code, field: fv.field, value: fv.value };
  }
  const rule = payload?.rule ?? rest.join(" ").trim();
  if (!rule) throw new ReviewError("reject richiede la regola violata");
  return { verb, code, rule };
}

export function record(reviewsDir, entry) {
  if (!VERBS.includes(entry.verb)) throw new ReviewError(`verbo sconosciuto: ${entry.verb}`);
  mkdirSync(reviewsDir, { recursive: true });
  const at = entry.at ?? new Date().toISOString();
  const e = { at, verb: entry.verb, code: entry.code, type: entry.type ?? parseCode(entry.code)?.type ?? (/^U\./.test(entry.code) ? "UNT" : null), reviewer: entry.reviewer ?? null,
    ...(entry.field ? { field: entry.field, value: entry.value } : {}), ...(entry.rule ? { rule: entry.rule } : {}) };
  const file = join(reviewsDir, `${at.slice(0, 7)}.jsonl`);
  appendFileSync(file, `${JSON.stringify(e)}\n`);
  return { file, entry: e };
}

export function stats(reviewsDir) {
  const entries = existsSync(reviewsDir) ? readdirSync(reviewsDir).filter((f) => f.endsWith(".jsonl")).sort()
    .flatMap((f) => readFileSync(join(reviewsDir, f), "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)) : [];
  entries.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const first = new Map();
  const by_type = {};
  for (const e of entries) {
    const t = e.type ?? "?";
    by_type[t] ??= { reviewed: 0, first_pass_accepted: 0, corrected: 0, rejected: 0, accepted: 0 };
    const s = by_type[t];
    if (!first.has(e.code)) { first.set(e.code, e.verb); s.reviewed++; if (e.verb === "accept") s.first_pass_accepted++; }
    if (e.verb === "correct") s.corrected++;
    else if (e.verb === "reject") s.rejected++;
    else s.accepted++;
  }
  for (const s of Object.values(by_type)) s.first_pass_rate = s.reviewed ? Math.round((s.first_pass_accepted / s.reviewed) * 1000) / 1000 : null;
  return { by_type, total: entries.length };
}

const HELP = `uso: node scripts/kb/review.mjs queue --root <workspace> [--customer C] [--scope S] [--seed s] [--db <file>] [--json]
     node scripts/kb/review.mjs accept <codice> --root <workspace> [--customer C] [--reviewer nome]
     node scripts/kb/review.mjs correct <codice> <campo>=<valore> --root <workspace> [--customer C]   (oppure --payload-file { field, value })
     node scripts/kb/review.mjs reject <codice> <regola> --root <workspace> [--customer C]            (oppure --payload-file { rule })
     node scripts/kb/review.mjs stats --root <workspace> [--customer C] [--json]

Coda stratificata della revisione umana (§19.19): quarantena, DT-021 ambigui, R3, CTR dello stesso cliente, unità
deontiche ambigue a lotti da ${DEONTIC_BATCH}, campione del 5 % per tipo (seme deterministico). I verbi sono registrati in
customers/<C>/reviews/<AAAA-MM>.jsonl (livello S: product/reviews/) e alimentano il tasso di accettazione al primo
passaggio per tipo (stats).

Exit code: 0 ok · 1 errore utente (verbo, codice, argomenti) · 2 errore di sistema.`;

export function main(argv) {
  const [cmd, ...rest] = argv;
  const { opts, positional } = parseArgs(rest);
  const asJson = !!opts.json;
  if (!cmd || cmd === "--help" || opts.help) { console.log(HELP); return cmd ? 0 : 1; }
  if (!opts.root) return fail(asJson, 1, "richiesto --root <workspace>");
  let paths;
  try { paths = workspacePaths({ root: opts.root, customer: opts.customer ?? null }); } catch (e) { return fail(asJson, 1, e.message); }
  try {
    if (cmd === "queue") {
      const dbFile = opts.db ?? paths.db;
      const db = existsSync(dbFile) ? openDb(dbFile, { createIfMissing: false }) : null;
      try {
        const q = buildQueue({ db, inboxRoot: paths.inboxRoot, scope: opts.scope ?? null, seed: opts.seed ?? "jvc" });
        console.log(JSON.stringify(asJson ? { ok: true, ...q } : { ok: true, total: q.total, strata: q.strata.map((s) => ({ stratum: s.stratum, n: s.items?.length ?? s.batches.reduce((a, b) => a + b.length, 0) })) }));
      } finally { db?.close(); }
      return 0;
    }
    if (cmd === "stats") { console.log(JSON.stringify({ ok: true, ...stats(paths.reviews) })); return 0; }
    // WP10a giro 1 (minore 2): payload confinato al workspace (--root)
    let payload = null;
    if (opts["payload-file"]) { const d = readDataFileSync(inputBase(), opts["payload-file"], YAML.parse); if (d.error) return fail(asJson, 1, d.error); payload = d.data; }
    const v = parseVerb([cmd, ...positional], payload);
    const r = record(paths.reviews, { ...v, reviewer: opts.reviewer ?? null });
    console.log(JSON.stringify({ ok: true, ...r }));
    return 0;
  } catch (e) {
    if (e instanceof ReviewError) return fail(asJson, 1, e.message);
    return fail(asJson, 2, `errore di sistema: ${e.message ?? e}`);
  }
}

if (isMain(import.meta.url)) process.exit(main(process.argv.slice(2)));
