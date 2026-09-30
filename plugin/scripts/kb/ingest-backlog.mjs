// Backlog di ingestion ordinato da DT-025 sul guadagno epistemico atteso (§19.18), con il guadagno REALIZZATO
// confrontato con l'atteso dopo l'ingestion (un tipo di documento che delude sistematicamente vede scendere il suo
// base_by_kind).
//
//   docSubjects(db, profile) → [{ subject, criticality, impactRadius, kLevel }]
//     i soggetti degli scope del documento già noti al DB (items + epistemic: K sul genere del documento — tecnica ⇒
//     k_tech, d'uso ⇒ k_use, empirica ⇒ k_obs, testimoniale ⇒ k_user); a DB vuoto (bootstrap) i soggetti sono stimati
//     dalle unità del profilo (righe-campo/10 + procedure + regole/3 + tracciati/5, K = 0, criticità 1)
//   AVG_TIER per kind: costo medio per unità (tier 1 = T1; export e tracciati a T0 costano meno)
//   backlog(db, { pending? }) → [{ code, kind, gain, gain_normalized, priority (DT-025), expected, units, reliability }]
//     pending: profili in stato profiled|segmented|extracted (default); ordine: priorità decrescente, codice
//   realized(db, code) → { answered, expected_attributes, realized_gain }  attributi coperti dalla digestione (attribute_coverage)
//     con unità del documento, per costo — lo stesso metro dell'atteso
//   byKindRatio(db) → { <kind>: { expected, realized, ratio } }  per la ricalibrazione di base_by_kind (§19.18)
// CLI: node scripts/kb/ingest-backlog.mjs --db <file> [--all] [--json]
import { readFileSync } from "node:fs";
import YAML from "yaml";
import { openDb } from "./db.mjs";
import { backlogPriorities } from "../decide/ingestion-gain.mjs";
import { evaluate, loadTable } from "../decide/dt-eval.mjs";
import { isMain } from "../lib/is-main.mjs";
import { parseArgs, fail } from "../lib/args.mjs";

const EXPECTED = YAML.parse(readFileSync(new URL("../../schemas/expected-attributes.yaml", import.meta.url), "utf8"));
export const AVG_TIER = { "config-export": 0.4, "spec-integrazione": 0.7, "dati-import": 0.3, "tenant-survey": 0.5, "set-screenshot": 0.8, "training-deck": 1.0,
  "manuale-utente": 1.0, "guida-admin": 1.0, "doc-progetto": 1.1, "doc-configurazione-cliente": 1.1, "release-notes": 0.8, "help-online": 1.0, registrazione: 1.2, "thread-email": 1.2 };
const K_BY_GENRE = { tecnica: "k_tech", "d'uso": "k_use", empirica: "k_obs", testimoniale: "k_user" };

export function docSubjects(db, p) {
  const scopes = JSON.parse(p.scopes ?? "[]");
  const kcol = K_BY_GENRE[p.genre] ?? "k_tech";
  const rows = scopes.length ? db.prepare(`select i.code, i.type, e.${kcol} as k, (select count(*) from relations r where r.from_code = i.code or r.to_code = i.code) as radius
    from items i left join epistemic e on e.subject_code = i.code where i.scope in (select value from json_each(?)) and i.status <> 'deprecato'`).all(JSON.stringify(scopes)) : [];
  const subjects = rows.filter((r) => EXPECTED[r.type]).map((r) => ({ subject: r.code, criticality: (EXPECTED.critical?.[r.type]?.length ?? 1) / Math.max(1, EXPECTED[r.type].length) + 0.5, impactRadius: r.radius ?? 0, kLevel: r.k ?? 0 }));
  if (subjects.length) return subjects;
  const bt = JSON.parse(p.units_by_type ?? "{}");
  const n = Math.max(1, Math.round((bt["riga-tabella-campi"] ?? 0) / 10 + (bt.procedura ?? 0) + (bt.regola ?? 0) / 3 + (bt.tracciato ?? 0) / 5 + (bt.definizione ?? 0) / 5));
  return Array.from({ length: n }, (_, i) => ({ subject: `stima-${i + 1}`, criticality: 1, impactRadius: 0, kLevel: 0 }));
}

export function backlog(db, { pending = ["profiled", "segmented", "extracted"] } = {}) {
  const profiles = db.prepare("select code, kind, genre, scopes, reliability, units, status, doc_id from doc_profiles").all().filter((p) => !pending || pending.includes(p.status));
  if (!profiles.length) return [];
  const withScopes = profiles.map((p) => {
    const unitsByType = Object.fromEntries(db.prepare("select type, count(*) as n from units where doc=? group by type").all(p.code).map((r) => [r.type, r.n]));
    return { ...p, scopes: p.scopes ?? "[]", units_by_type: JSON.stringify(unitsByType) };
  });
  const docs = withScopes.map((p) => ({ id: p.code, kind: p.kind, subjects: docSubjects(db, p), reliability: p.reliability ?? 0.7, units: Math.max(1, p.units ?? 1), avgTier: AVG_TIER[p.kind] ?? 1 }));
  const table = loadTable("DT-025");
  return backlogPriorities(docs).map((d) => ({
    code: d.id, kind: d.kind, gain: Math.round(d.gain * 1e6) / 1e6, gain_normalized: d.gain_normalized,
    priority: evaluate(table, { gain_normalized: d.gain_normalized }).score, subjects: d.subjects.length, units: d.units, reliability: d.reliability,
  }));
}

export function realized(db, code) {
  const p = db.prepare("select code, kind, units, reliability from doc_profiles where code=?").get(code);
  if (!p) return null;
  const rows = db.prepare("select subject_code, attribute, units from attribute_coverage where answered=1").all();
  const own = new Set(db.prepare("select code from units where doc=?").all(code).map((r) => r.code));
  const hits = rows.filter((r) => JSON.parse(r.units ?? "[]").some((u) => own.has(u)));
  const subjects = new Set(hits.map((r) => r.subject_code));
  const expectedAttrs = [...subjects].reduce((a, s) => a + (EXPECTED[/\.([A-Z]{3})\.\d{4}/.exec(s)?.[1]]?.length ?? 7), 0);
  const cost = Math.max(1, p.units ?? 1) * (AVG_TIER[p.kind] ?? 1);
  return { code, answered: hits.length, subjects: subjects.size, expected_attributes: expectedAttrs, realized_gain: Math.round((hits.length * (p.reliability ?? 0.7) / cost) * 1e6) / 1e6 };
}

export function byKindRatio(db, expectedGains) {
  const out = {};
  for (const e of expectedGains) {
    const r = realized(db, e.code);
    if (!r) continue;
    out[e.kind] ??= { expected: 0, realized: 0 };
    out[e.kind].expected += e.gain;
    out[e.kind].realized += r.realized_gain;
  }
  for (const v of Object.values(out)) v.ratio = v.expected ? Math.round((v.realized / v.expected) * 1000) / 1000 : null;
  return out;
}

const HELP = `uso: node scripts/kb/ingest-backlog.mjs --db <knowledge.db> [--all] [--json] [--help]

Backlog di ingestion (§19.18): i documenti profilati non ancora digeriti, ordinati da DT-025 sul guadagno epistemico
atteso Σ(peso_soggetto × gap × affidabilità) / costo (scripts/decide/ingestion-gain.mjs), con il guadagno realizzato
(attributi coperti dalla digestione con unità del documento) accanto all'atteso. --all: tutti i profili.

Exit code: 0 ok · 1 errore utente (DB assente) · 2 errore di sistema.`;

function main(argv) {
  const { opts } = parseArgs(argv, { flags: ["all"] });
  const asJson = !!opts.json;
  if (opts.help) { console.log(HELP); return 0; }
  if (!opts.db) return fail(asJson, 1, "richiesto --db <file>");
  let db;
  try { db = openDb(opts.db, { createIfMissing: false }); } catch (e) { return fail(asJson, 1, e.message); }
  try {
    const list = backlog(db, { pending: opts.all ? null : undefined });
    const rows = list.map((d) => ({ ...d, realized: realized(db, d.code) }));
    console.log(JSON.stringify({ ok: true, backlog: rows, by_kind: byKindRatio(db, list) }));
    return 0;
  } catch (e) { return fail(asJson, 2, `errore di sistema: ${e.message ?? e}`); }
  finally { db.close(); }
}

if (isMain(import.meta.url)) process.exit(main(process.argv.slice(2)));
