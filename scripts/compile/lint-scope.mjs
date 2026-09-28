// lint-scope (ADR-32 "regola di non creazione fra scope", §27.2 proprietà del test): un caso dello scope S usa solo SEL
// e FLW di S, o fixture di altri scope dichiarate da un handoff (HND che lega i due scope); creare entità di un altro
// scope è una violazione (niente accoppiamento né dati inquinati).
//
//   lintScope(caso, { ws?, customer? }) → violations[{ rule, at, message }]
//     S-SEL       target / wait_for / region SEL di un altro scope
//     S-FLW       FLW (composition.flows, from_flow) di un altro scope
//     S-CREATE    un passo che crea un'entità di un altro scope (creates.scope, o il target del passo che crea di un altro scope)
//     S-FIXTURE   fixture di un altro scope senza from_handoff, o con un HND che non lega i due scope (letto dalla kb con --workspace)
//
// CLI: node scripts/compile/lint-scope.mjs <caso.yaml…> [--workspace <dir>] [--customer C] [--json]
// Exit: 0 pulito · 1 file illeggibile · 2 errore di sistema · 3 violazione.
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import YAML from "yaml";
import { parseArgs, fail } from "../lib/args.mjs";
import { isMain } from "../lib/is-main.mjs";
import { scopeOf, loadItem } from "../lib/kb-items.mjs";
import { classOf, isCreating } from "./compile-case.mjs";

const v = (rule, at, message) => ({ rule, at, message });

export function lintScope(caso, { ws = null, customer = null } = {}) {
  const out = [];
  const S = caso?.scope;
  const steps = Array.isArray(caso?.composition?.steps) ? caso.composition.steps : [];
  for (const f of caso?.composition?.flows ?? []) if (scopeOf(f) !== S) out.push(v("S-FLW", "composition.flows", `FLW ${f} dello scope ${scopeOf(f)}: un caso ${S} compone solo flussi di ${S} (ADR-32)`));
  for (const s of steps) {
    const at = `passo ${s?.n ?? "?"}`;
    for (const [k, code] of [["target", typeof s?.target === "string" ? s.target : null], ["wait_for", s?.wait_for ?? null]]) {
      if (code && scopeOf(code) !== S) out.push(v("S-SEL", at, `${at}: ${k} ${code} dello scope ${scopeOf(code)} (il caso è ${S})`));
    }
    if (s?.from_flow && scopeOf(s.from_flow.flow) !== S) out.push(v("S-FLW", at, `${at}: from_flow ${s.from_flow.flow} dello scope ${scopeOf(s.from_flow.flow)}`));
    if (s && isCreating(s, classOf(s))) {
      const es = s.creates?.scope ?? (typeof s.target === "string" ? scopeOf(s.target) : null);
      if (es && es !== S) out.push(v("S-CREATE", at, `${at}: crea ${s.creates?.entity ?? "un'entità"} dello scope ${es}: un caso ${S} non crea entità di altri scope; la fixture arriva da un handoff (ADR-32)`));
    }
  }
  for (const e of caso?.evidence ?? []) if (e?.region && scopeOf(e.region) !== S) out.push(v("S-SEL", `evidenza al passo ${e.at}`, `regione ${e.region} dello scope ${scopeOf(e.region)}`));
  for (const f of caso?.fixtures ?? []) {
    if (!f?.scope || f.scope === S) continue;
    const at = `fixture ${f.name}`;
    if (!f.from_handoff) { out.push(v("S-FIXTURE", at, `${at} dello scope ${f.scope} senza from_handoff: le fixture di altri scope arrivano solo da un HND dichiarato`)); continue; }
    if (ws) {
      const h = loadItem(ws, f.from_handoff, customer);
      if (!h) out.push(v("S-FIXTURE", at, `${at}: handoff ${f.from_handoff} non trovato nella knowledge base`));
      else {
        const scopes = new Set([h.from_scope, h.to_scope, h.owner_of_test].filter(Boolean));
        if (!(scopes.has(S) && scopes.has(f.scope))) out.push(v("S-FIXTURE", at, `${at}: l'handoff ${h.id} non lega ${f.scope} e ${S}`));
        else if (Array.isArray(h.shared_fixtures) && h.shared_fixtures.length && !h.shared_fixtures.includes(f.name) && !h.shared_fixtures.includes(f.kind)) out.push(v("S-FIXTURE", at, `${at}: non è fra le shared_fixtures dell'handoff ${h.id}`));
      }
    }
  }
  return out;
}

const HELP = `uso: node scripts/compile/lint-scope.mjs <caso.yaml…> [--workspace <dir>] [--customer C] [--json] [--help]

ADR-32: un caso dello scope S usa solo SEL e FLW di S o fixture di altri scope dichiarate da un handoff;
creare entità di un altro scope è una violazione.

Exit code: 0 pulito · 1 file illeggibile · 2 errore di sistema · 3 violazione.`;

export function run(argv, env = process.env) {
  const { opts, positional } = parseArgs(argv);
  const asJson = !!opts.json;
  if (opts.help) { console.log(HELP); return 0; }
  if (!positional.length) return fail(asJson, 1, "nessun caso da controllare");
  const ws = opts.workspace ? resolvePath(opts.workspace) : env.JVC_WORKSPACE ? resolvePath(env.JVC_WORKSPACE) : null;
  const results = [];
  try {
    for (const f of positional) {
      let c;
      try { c = YAML.parse(readFileSync(resolvePath(f), "utf8")); } catch (err) { return fail(asJson, 1, `${f} illeggibile: ${err.message}`); }
      results.push({ file: f, violations: lintScope(c, { ws, customer: opts.customer ?? (c?.id?.split(".")[1] !== "STD" ? c?.id?.split(".")[1] : null) }) });
    }
  } catch (err) { return fail(asJson, 2, `errore di sistema: ${err?.message ?? err}`); }
  const n = results.reduce((a, r) => a + r.violations.length, 0);
  if (asJson) console.log(JSON.stringify({ ok: n === 0, results }));
  else for (const r of results) { if (!r.violations.length) console.log(`✓ ${r.file}`); else { console.log(`✗ ${r.file}`); for (const x of r.violations) console.log(`  ${x.rule} ${x.message}`); } }
  return n ? 3 : 0;
}

if (isMain(import.meta.url)) process.exit(run(process.argv.slice(2)));
