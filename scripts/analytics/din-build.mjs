// Costruzione di un DIN dai risultati AGGREGATI di una query (§20.5.2) — WP09d.
// Ingresso (file YAML/JSON, mai inline): document, scope, sample { size, period, source }, fields [{ field, filled, total,
// distinct?, top5_share?, empty_in_states?, values_histogram? }], groups [{ dimension, value, n }] (es. ruoli),
// volumes / amounts / lifecycle già aggregati. Regole:
//   - privacy: nessun gruppo con n < 20 (anche i campi: total < 20) ⇒ rifiuto (exit 3); values_retained: none;
//   - obbligatorietà di fatto: fill_rate ≥ 0.98 su un campo documentato opzionale (FLD mandatory.kind never) ⇒
//     de_facto_mandatory nel DIN + proposta di CTR (customers/<C>/contradictions/proposals/), mai una modifica del FLD;
//   - il DIN valida lo schema (e i controlli di privacy) prima di essere scritto; --write assegna il codice dal DB.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import YAML from "yaml";
import { validateItem, MIN_GROUP } from "../kb/validate-schema.mjs";
import { openDb } from "../kb/db.mjs";
import { assignSeq, formatCode } from "../kb/assign-seq.mjs";
import { indexItemFile } from "../kb/reindex.mjs";
import { itemFile, loadItem } from "../lib/kb-items.mjs";
import { parseArgs, fail } from "../lib/args.mjs";
import { isMain } from "../lib/is-main.mjs";
import { confineInputs } from "../lib/text-file.mjs";

export const DE_FACTO_THRESHOLD = 0.98;
export class PrivacyError extends Error { constructor(m, extra = {}) { super(m); this.name = "PrivacyError"; this.extra = extra; } }
const r3 = (x) => Math.round(x * 1000) / 1000;

// Campo documentato opzionale: FLD con mandatory.kind never (o mandatory: optional).
export function documentedOptional(fld) {
  const m = fld?.mandatory;
  return m === "optional" || m?.kind === "never" || m?.kind === "optional";
}

export function buildDin(input, { lookupField = () => null, minGroup = MIN_GROUP } = {}) {
  const small = [];
  const size = Number(input?.sample?.size);
  if (!Number.isInteger(size) || size < minGroup) small.push(`sample.size ${input?.sample?.size ?? "assente"} < ${minGroup}`);
  for (const g of input.groups ?? []) if (!(Number(g.n) >= minGroup)) small.push(`gruppo ${g.dimension ?? "?"}: ${g.n} < ${minGroup}`);
  for (const f of input.fields ?? []) if (!(Number(f.total) >= minGroup)) small.push(`campo ${f.field}: totale ${f.total} < ${minGroup}`);
  if (small.length) throw new PrivacyError(`aggregati su gruppi sotto ${minGroup} rifiutati (§20.5.5): ${small.join("; ")}`, { small });
  const fields = (input.fields ?? []).map((f) => {
    const out = { field: f.field, fill_rate: r3(Number(f.filled) / Number(f.total)) };
    for (const k of ["distinct", "top5_share", "empty_in_states", "values_histogram", "note"]) if (f[k] !== undefined) out[k] = f[k];
    return out;
  });
  const byRole = {};
  const dims = new Map();
  for (const g of input.groups ?? []) { const d = g.dimension ?? "gruppo"; if (!dims.has(d)) dims.set(d, []); dims.get(d).push(g); }
  for (const [d, gs] of dims) { const tot = gs.reduce((a, g) => a + Number(g.n), 0); byRole[d] = Object.fromEntries(gs.map((g) => [String(g.value), r3(Number(g.n) / tot)])); }
  const deFacto = [];
  const ctr = [];
  for (const f of fields) {
    if (f.fill_rate < DE_FACTO_THRESHOLD) continue;
    const fld = lookupField(f.field);
    if (!fld || !documentedOptional(fld)) continue;
    deFacto.push(f.field);
    ctr.push({ kind: "CTR", status: "proposta", subject: f.field, facet: "mandatory", a: { code: f.field, says: "opzionale (documentato)" },
      b: { evidence: "DIN", says: `compilato nel ${Math.round(f.fill_rate * 1000) / 10}% dei documenti`, fill_rate: f.fill_rate, sample: size },
      proposal: "de_facto_mandatory", note: "§20.5.2: obbligatorietà di fatto — la regola resta documentale; si conferma con l'utente o con un'osservazione" });
  }
  const din = {
    id: input.id ?? null, type: "DIN",
    title: input.title ?? `Profilo dei documenti reali: ${input.document}`.slice(0, 140),
    summary: input.summary ?? `Profilo statistico e anonimo di ${input.document}: ${size} documenti${input.sample?.period ? ` (${input.sample.period})` : ""}, ${fields.length} campi.`,
    facets: input.facets ?? { F1: "osservazione-chrome", F4: "profilo", F5: "reporting-analytics", F6: [], F7: "nessuno", F8: "specifica", F9: "periodica", F10: "R0",
      F11: "probabilistico", F12: "digerito", F13: { verified_at: new Date().toISOString().slice(0, 10), release: input.release ?? "n/d" }, F15: "empirica" },
    sources: input.sources ?? [{ query: input.sample?.source ?? "query aggregata" }],
    document: input.document, sample: { size, ...(input.sample?.period ? { period: input.sample.period } : {}), ...(input.sample?.source ? { source: input.sample.source } : {}) },
    ...(input.volumes ? { volumes: input.volumes } : {}), fields, ...(input.amounts ? { amounts: input.amounts } : {}), ...(input.lifecycle ? { lifecycle: input.lifecycle } : {}),
    ...(Object.keys(byRole).length ? { by_role: byRole } : {}), ...(deFacto.length ? { de_facto_mandatory: deFacto } : {}),
    privacy: { values_retained: "none", aggregation_min_group: minGroup }, ...(input.quality ? { quality: input.quality } : {}),
  };
  return { din, ctr_proposals: ctr };
}

export const HELP = `uso: node scripts/analytics/din-build.mjs --input <aggregati.yaml|json> --customer <C> [--scope S] [--write] [--workspace <dir>] [--json]

DIN (§20.5.2) dai risultati aggregati di una query: fill_rate, distinti, quote, ruoli; gruppi < 20 rifiutati (exit 3);
fill_rate ≥ 0.98 su un campo documentato opzionale ⇒ de_facto_mandatory + proposta di CTR. --write: codice dal DB
(L.<C>.<S>.DIN.nnnn), file in customers/<C>/kb/scopes/<S>/din/ e proposte di CTR in customers/<C>/contradictions/proposals/.

Exit code: 0 ok · 1 errore d'uso o DIN non valido · 2 errore di sistema · 3 privacy (gruppi < 20).`;

export function run(argv, env = process.env) {
  const { opts } = parseArgs(argv, { flags: ["write"] });
  const asJson = !!opts.json;
  if (opts.help) { console.log(HELP); return 0; }
  { const bad = confineInputs(opts, ["input"], { env }); if (bad) return fail(asJson, 1, bad); }
  if (!opts.input || !opts.customer) return fail(asJson, 1, "richiesti --input <file> e --customer <C>");
  if (!/^[A-Z0-9]{4}$/.test(opts.customer)) return fail(asJson, 1, `cliente non valido: ${opts.customer}`);
  const ws = resolve(opts.workspace || env.JVC_WORKSPACE || env.CLAUDE_PROJECT_DIR || process.cwd());
  let input;
  try { const t = readFileSync(opts.input, "utf8"); input = t.trimStart().startsWith("{") ? JSON.parse(t) : YAML.parse(t); } catch (e) { return fail(asJson, 1, `input illeggibile: ${e.message}`); }
  const scope = opts.scope ?? input.scope;
  if (opts.write && !scope) return fail(asJson, 1, "--write richiede lo scope (--scope o scope nell'input)");
  try {
    const built = buildDin(input, { lookupField: (code) => loadItem(ws, code, opts.customer) });
    let file = null;
    if (opts.write) {
      const db = openDb(join(ws, "customers", opts.customer, "knowledge.db"));
      try {
        db.transaction(() => {
          const key = { level: "L", customer: opts.customer, scope, type: "DIN" };
          built.din.id = formatCode({ ...key, seq: assignSeq(db, key) });
          const v = validateItem(built.din);
          if (!v.ok) throw new Error(`DIN non valido: ${v.errors.join("; ")}`);
          file = itemFile(ws, built.din.id);
          const text = YAML.stringify(built.din);
          indexItemFile(db, join(ws, "customers", opts.customer), file, text);
          mkdirSync(dirname(file), { recursive: true });
          writeFileSync(file, text);
        })();
      } finally { db.close(); }
      const pdir = join(ws, "customers", opts.customer, "contradictions", "proposals");
      for (const c of built.ctr_proposals) {
        mkdirSync(pdir, { recursive: true });
        const f = join(pdir, `${built.din.id}.${c.subject}.yaml`);
        if (!existsSync(f)) writeFileSync(f, YAML.stringify({ ...c, from: built.din.id }));
      }
    } else {
      const v = validateItem({ ...built.din, id: `L.${opts.customer}.${scope ?? "ANL"}.DIN.0001` });
      if (!v.ok) return fail(asJson, 1, `DIN non valido: ${v.errors.join("; ")}`);
    }
    console.log(JSON.stringify({ ok: true, din: built.din, ctr_proposals: built.ctr_proposals, file }));
    return 0;
  } catch (err) {
    if (err instanceof PrivacyError) return fail(asJson, 3, err.message, err.extra);
    if (/non valido/.test(String(err?.message))) return fail(asJson, 1, err.message);
    return fail(asJson, 2, `errore di sistema: ${err?.message ?? err}`);
  }
}

if (isMain(import.meta.url)) process.exitCode = run(process.argv.slice(2));
