// Ingestion incrementale e versionata (§19.16): il DOC v3 sostituisce il v2 e la pipeline non ricomincia da capo.
//
//   diffUnits(oldUnits, newUnits) → { invariate[], modificate: [{ old, new }], nuove[], sparite[] }
//     invariate: stesso hash (e quindi stesso codice, segmentUnits con `previous`); modificate: unità non invariate
//     accoppiate per sezione, tipo e ordine nella sezione (il vecchio testo cambiato); nuove e sparite: il resto.
//   linkedItems(items, codes) → item che citano le unità (sources[].unit / attribute_sources / stringhe U.…)
//   impact(diff, items, { releaseNotes? }) → proposte in termini di ITEM, mai scritture in kb/ (§29.6):
//     modificate ⇒ item collegati tornano a `digerito` e rifanno il back-check; se il VALORE cambia (numeri, codici o
//       modalità deontica diversi fra vecchio e nuovo testo) ⇒ item versionato (.vN) + CTR "cambio documentale" fra le
//       due versioni (non è un errore: è una storia);
//     sparite ⇒ item la cui UNICA fonte è sparita → `source-removed` (va osservato, mai deprecato);
//     release notes fra le versioni come indizio: una voce `changed` che cita l'oggetto dell'unità modificata ⇒ attesa,
//       altrimenti sorpresa documentale.
//   formatDiffReport(r) → testo "cosa è cambiato in termini di item"
// CLI: node scripts/ingest/doc-diff.mjs --old <units-v2.json> --new <units-v3.json> [--items-dir <kb>] [--release-notes <file>]
//        [--out <_inbox/<scope>/doc-diff/<DOC>.yaml>] [--json]
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import YAML from "yaml";
import { parseRule } from "./deontic.mjs";
import { normalizeLabel } from "./dedupe.mjs";
import { isMain } from "../lib/is-main.mjs";
import { parseArgs, fail } from "../lib/args.mjs";
import { confineInputs } from "../lib/text-file.mjs";

export function diffUnits(oldUnits, newUnits) {
  const oldByHash = new Map();
  for (const u of oldUnits) { if (!oldByHash.has(u.hash)) oldByHash.set(u.hash, []); oldByHash.get(u.hash).push(u); }
  const invariate = [];
  const restNew = [];
  const usedOld = new Set();
  for (const u of newUnits) {
    const q = oldByHash.get(u.hash);
    const o = q?.find((x) => !usedOld.has(x.id));
    if (o) { usedOld.add(o.id); invariate.push({ old: o.id, new: u.id }); } else restNew.push(u);
  }
  const restOld = oldUnits.filter((u) => !usedOld.has(u.id));
  const key = (u) => `${u.context?.section_path ?? ""}|${u.type}`;
  const oldQ = new Map();
  for (const u of restOld) { if (!oldQ.has(key(u))) oldQ.set(key(u), []); oldQ.get(key(u)).push(u); }
  const modificate = [];
  const nuove = [];
  for (const u of restNew) {
    const q = oldQ.get(key(u));
    if (q?.length) { const o = q.shift(); modificate.push({ old: o, new: u }); } else nuove.push(u);
  }
  const sparite = [...oldQ.values()].flat();
  return { invariate, modificate, nuove, sparite };
}

const unitsOfItem = (it) => [
  ...(it.sources ?? []).flatMap((s) => (typeof s === "string" ? [s] : [s?.unit, ...(s?.units ?? [])])),
  ...Object.values(it.attribute_sources ?? {}).flat(),
].filter((x) => typeof x === "string" && /^U\./.test(x));

export function linkedItems(items, codes) {
  const set = new Set(codes);
  return items.filter((it) => unitsOfItem(it).some((u) => set.has(u)));
}

const valuesOf = (t) => [...new Set(String(t ?? "").match(/\b\d+(?:[.,]\d+)*%?|\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b|\b(?:true|false|sì|si|no|yes)\b/gi) ?? [])].map((x) => x.toLowerCase()).sort();
export function valueChanged(oldText, newText) {
  const a = valuesOf(oldText), b = valuesOf(newText);
  if (a.join("|") !== b.join("|")) return true;
  const ra = parseRule(oldText), rb = parseRule(newText);
  return ra.modality !== rb.modality || JSON.stringify(ra.mandatory ?? null) !== JSON.stringify(rb.mandatory ?? null);
}

const nextVersion = (code) => { const m = /^(.*?)(?:\.v(\d+))?$/.exec(code); return `${m[1]}.v${Number(m[2] ?? 1) + 1}`; };
const objectTerms = (t) => (normalizeLabel(t).match(/[a-z0-9_]{5,}/g) ?? []);

export function impact(diff, items, { releaseNotes = [] } = {}) {
  const proposals = [];
  const surprises = [];
  const expected = [];
  const changedNotes = releaseNotes.filter((n) => (n.kind ?? n.classification ?? "changed") === "changed");
  for (const m of diff.modificate) {
    const linked = linkedItems(items, [m.old.id]);
    const changed = valueChanged(m.old.text, m.new.text);
    const terms = new Set(objectTerms(m.new.text));
    const hint = changedNotes.find((n) => objectTerms(n.text ?? n.title ?? "").some((t) => terms.has(t)));
    if (hint) expected.push({ unit: m.new.id, note: hint.text ?? hint.title });
    else surprises.push({ unit: m.new.id, old_unit: m.old.id, section: m.new.context?.section ?? null });
    for (const it of linked) {
      proposals.push({ action: "redigest", item: it.id, status: "digerito", reason: `unità ${m.old.id} modificata → ${m.new.id}: rifare il back-check`, unit_old: m.old.id, unit_new: m.new.id });
      if (changed) {
        proposals.push({ action: "version", item: it.id, new_code: nextVersion(it.id), reason: "il valore cambia fra le versioni del documento" });
        proposals.push({ action: "ctr", kind: "cambio documentale", a: it.id, b: nextVersion(it.id), units: [m.old.id, m.new.id], expected: !!hint, reason: hint ? "cambio atteso dalle release notes" : "sorpresa documentale: nessuna release note cita l'oggetto" });
      }
    }
  }
  const goneIds = new Set(diff.sparite.map((u) => u.id));
  for (const it of linkedItems(items, [...goneIds])) {
    const own = unitsOfItem(it);
    if (own.length && own.every((u) => goneIds.has(u))) proposals.push({ action: "source-removed", item: it.id, reason: "l'unica fonte è sparita dal documento: va osservato, non deprecato", units: own });
  }
  const touched = diff.modificate.length + diff.nuove.length + diff.sparite.length;
  return {
    counts: { invariate: diff.invariate.length, modificate: diff.modificate.length, nuove: diff.nuove.length, sparite: diff.sparite.length, da_ridigerire: touched },
    proposals, expected_changes: expected, documentary_surprises: surprises,
    new_units: diff.nuove.map((u) => u.id),
  };
}

export function formatDiffReport(r, { doc = "" } = {}) {
  const c = r.counts;
  const by = (a) => r.proposals.filter((p) => p.action === a);
  return [
    `DIFF DOCUMENTALE ${doc}`.trim(),
    `Unità: ${c.invariate} invariate · ${c.modificate} modificate · ${c.nuove} nuove · ${c.sparite} sparite — costo proporzionale alle ${c.da_ridigerire} toccate`,
    `Item da ridigerire (→ digerito, back-check): ${[...new Set(by("redigest").map((p) => p.item))].join(", ") || "nessuno"}`,
    `Item versionati (valore cambiato): ${by("version").map((p) => `${p.item} → ${p.new_code}`).join(", ") || "nessuno"}`,
    `CTR "cambio documentale": ${by("ctr").length} (${by("ctr").filter((p) => p.expected).length} attesi dalle release notes)`,
    `Item source-removed (da osservare, non deprecati): ${by("source-removed").map((p) => p.item).join(", ") || "nessuno"}`,
    `Sorprese documentali (modifiche senza release note): ${r.documentary_surprises.length}`,
    `Unità nuove da estrarre e digerire: ${c.nuove}`,
  ].join("\n");
}

function readItems(dir) {
  const out = [];
  if (!dir || !existsSync(dir)) return out;
  const walk = (d) => { for (const e of readdirSync(d)) { const p = join(d, e); if (statSync(p).isDirectory()) walk(p); else if (/^[SCL]\..+\.ya?ml$/.test(e)) { try { out.push(YAML.parse(readFileSync(p, "utf8"))); } catch { /* ignora */ } } } };
  walk(dir);
  return out;
}

const HELP = `uso: node scripts/ingest/doc-diff.mjs --old <unità v2 .json|.yaml> --new <unità v3> [--items-dir <kb>] [--release-notes <file>] [--out <file>] [--json]

Diff per hash fra due versioni di un documento (§19.16): invariate · modificate · nuove · sparite, e le conseguenze in
termini di item (ridigerire, versionare con CTR "cambio documentale", source-removed). Solo proposte: nessuna scrittura in kb/.

Exit code: 0 ok · 1 errore utente (argomenti, file illeggibili) · 2 errore di sistema.`;

function main(argv) {
  const { opts } = parseArgs(argv);
  const asJson = !!opts.json;
  if (opts.help) { console.log(HELP); return 0; }
  { const bad = confineInputs(opts, ["old","new","release-notes"], {}); if (bad) return fail(asJson, 1, bad); }
  if (!opts.old || !opts.new) return fail(asJson, 1, "richiesti --old e --new");
  const read = (f) => { const t = readFileSync(f, "utf8"); const v = /^\s*[{[]/.test(t) ? JSON.parse(t) : YAML.parse(t); return Array.isArray(v) ? v : v?.units ?? v?.items ?? []; };
  let a, b, notes = [];
  try { a = read(opts.old); b = read(opts.new); if (opts["release-notes"]) notes = read(opts["release-notes"]); } catch (e) { return fail(asJson, 1, `file illeggibile: ${e.message}`); }
  try {
    const r = impact(diffUnits(a, b), readItems(opts["items-dir"]), { releaseNotes: notes });
    if (opts.out) { mkdirSync(dirname(opts.out), { recursive: true }); writeFileSync(opts.out, YAML.stringify(r, { lineWidth: 0 })); }
    console.log(asJson ? JSON.stringify({ ok: true, ...r }) : formatDiffReport(r));
    return 0;
  } catch (e) { return fail(asJson, 2, `errore di sistema: ${e.message ?? e}`); }
}

if (isMain(import.meta.url)) process.exit(main(process.argv.slice(2)));
