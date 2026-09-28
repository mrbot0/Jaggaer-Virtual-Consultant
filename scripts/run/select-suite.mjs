// select-suite (F4.3, §27.3, §27.4, §45.5): selezione dei casi NRT di UNO scope (shard) per una run.
//
//   selectSuite(ws, { customer, scope, suite: smoke|full|delta, release?, shadow?, changed?, now?, defects? }) → manifest
//     - stato: promoted; con shadow anche shadow (run di shadow); candidate e quarantine mai;
//     - suite smoke: genere SMK o tag smoke · full: tutti · delta: i casi il cui soggetto (derivation.from, FLW, SEL)
//       è fra i codici cambiati della release (changed, o customers/<C>/releases/<R>/delta.yaml { changed: [...] });
//     - priorità DT-012 dentro lo scope (§27.3): criticità × (1 − copertura) × volatilità × densità difetti × fattori
//       integrazione/identità/handoff (approssimazione additiva della tabella); ordine decrescente;
//   writeManifest → customers/<C>/runs/RUN.<C>.<AAAAMMDD>.<HHMM>.<S>/manifest.yaml (un run per scope; esistente ⇒ errore).
//
// CLI: node scripts/run/select-suite.mjs --suite smoke|full|delta --scope <S> [--release <R>] [--shadow] [--changed <file.yaml>]
//      [--customer C] [--at <ISO>] [--dry-run] [--workspace <dir>] [--json]
// Exit: 0 ok · 1 argomenti non validi · 2 errore di sistema · 3 nessun caso selezionabile.
import { readFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { join, relative } from "node:path";
import YAML from "yaml";
import { parseArgs, fail } from "../lib/args.mjs";
import { isMain } from "../lib/is-main.mjs";
import { writeFileAtomic } from "../../hooks/lib/fsx.mjs";
import { formatRunCode, runRefusal } from "../lib/run-code.mjs";
import { evaluate, loadTable } from "../decide/dt-eval.mjs";
import { typeOf } from "../lib/kb-items.mjs";
import { workspaceCustomer } from "./fixtures.mjs";

export class SuiteError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
export const SUITES = ["smoke", "full", "delta"];

export function loadCases(ws, customer, scope) {
  const dir = join(ws, "customers", customer, "tests", "cases", scope);
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir).filter((x) => /^NRT\..+\.ya?ml$/.test(x)).sort()) {
    try { const c = YAML.parse(readFileSync(join(dir, f), "utf8")); if (c?.id) out.push({ case: c, file: relative(join(ws, "customers", customer), join(dir, f)).replace(/\\/g, "/") }); } catch { /* illeggibile: escluso */ }
  }
  return out;
}

const subjectsOf = (c) => [...(c.derivation?.from ?? []), ...(c.composition?.flows ?? []), ...(c.composition?.steps ?? []).flatMap((s) => [typeof s.target === "string" ? s.target : null, s.from_flow?.flow ?? null])].filter(Boolean);

export function priority(c, { table, changed = new Set(), coverage = new Map(), defects = {} }) {
  const subj = c.derivation?.from?.[0] ?? null;
  const from = c.derivation?.from ?? [];
  const inputs = {
    criticality: c.criticality ?? "media",
    uncovered: Math.max(0, Math.min(1, 1 - Math.min(1, ((coverage.get(subj) ?? 1) - 1) / 3))),
    volatility: subjectsOf(c).some((x) => changed.has(x)) ? "alta" : "bassa",
    integration: c.genre === "INT" || from.some((x) => typeOf(x) === "INT"),
    identity: from.some((x) => typeOf(x) === "KEY"),
    handoff: c.genre === "HND" || from.some((x) => typeOf(x) === "HND") || !!c.boundary?.handoff,
  };
  const d = defects[subj];
  const r = evaluate(table, inputs, { priors: { defect_density: typeof d === "number" ? { value: Math.max(0, Math.min(1, d)) } : null } });
  return { score: r.score, inputs };
}

export function selectSuite(ws, { customer, scope, suite, release = null, shadow = false, changed = null, now = new Date(), defects = null }) {
  if (!SUITES.includes(suite)) throw new SuiteError(1, `suite ${suite}: smoke · full · delta`);
  let changedSet = new Set(changed ?? []);
  if (suite === "delta" && !changed) {
    const f = release ? join(ws, "customers", customer, "releases", release, "delta.yaml") : null;
    if (!f || !existsSync(f)) throw new SuiteError(1, "suite delta: serve --changed <file> o customers/<C>/releases/<R>/delta.yaml con --release");
    changedSet = new Set(YAML.parse(readFileSync(f, "utf8"))?.changed ?? []);
  }
  const states = new Set(["promoted", ...(shadow ? ["shadow"] : [])]);
  const all = loadCases(ws, customer, scope);
  const coverage = new Map();
  for (const { case: c } of all) if (c.state === "promoted") { const s = c.derivation?.from?.[0]; if (s) coverage.set(s, (coverage.get(s) ?? 0) + 1); }
  const defs = defects ?? (() => { const f = join(ws, "customers", customer, "tests", "defect-density.yaml"); try { return YAML.parse(readFileSync(f, "utf8")) ?? {}; } catch { return {}; } })();
  const table = loadTable("DT-012");
  const cases = [];
  const excluded = [];
  for (const { case: c, file } of all) {
    if (c.scope !== scope) { excluded.push({ id: c.id, reason: `scope ${c.scope}` }); continue; }
    if (!states.has(c.state)) { excluded.push({ id: c.id, reason: `stato ${c.state}` }); continue; }
    if (suite === "smoke" && c.genre !== "SMK" && !(c.tags ?? []).includes("smoke")) { excluded.push({ id: c.id, reason: "non smoke" }); continue; }
    if (suite === "delta" && !subjectsOf(c).some((x) => changedSet.has(x))) { excluded.push({ id: c.id, reason: "non toccato dal delta" }); continue; }
    const p = priority(c, { table, changed: changedSet, coverage, defects: defs });
    cases.push({ id: c.id, file, state: c.state, genre: c.genre, priority: p.score, dt012: p.inputs });
  }
  cases.sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
  const run = formatRunCode({ customer, scope, date: now });
  return { run, customer, scope, suite, release, shadow, created_at: now.toISOString(), shard: scope, cases, excluded };
}

export function writeManifest(ws, manifest) {
  const bad = runRefusal(ws, manifest.customer, manifest.run);
  if (bad) throw new SuiteError(1, bad);
  const dir = join(ws, "customers", manifest.customer, "runs", manifest.run);
  if (existsSync(join(dir, "manifest.yaml"))) throw new SuiteError(1, `il run ${manifest.run} esiste già: un run per scope e per minuto (--at per un altro orario)`);
  mkdirSync(dir, { recursive: true });
  writeFileAtomic(join(dir, "manifest.yaml"), YAML.stringify(manifest));
  return `runs/${manifest.run}/manifest.yaml`;
}

const HELP = `uso: node scripts/run/select-suite.mjs --suite smoke|full|delta --scope <S> [--release <R>] [--shadow] [--changed <file.yaml>]
       [--customer C] [--at <ISO>] [--dry-run] [--workspace <dir>] [--json] [--help]

Seleziona i casi NRT di uno scope (promoted; con --shadow anche shadow), li ordina per priorità DT-012 (§27.3) e
scrive il manifest della run in customers/<C>/runs/RUN.<C>.<AAAAMMDD>.<HHMM>.<S>/manifest.yaml.

Exit code: 0 ok · 1 argomenti non validi · 2 errore di sistema · 3 nessun caso selezionabile.`;

export function run(argv, env = process.env) {
  const { opts } = parseArgs(argv, { flags: ["shadow", "dry-run"] });
  const asJson = !!opts.json;
  if (opts.help) { console.log(HELP); return 0; }
  if (!opts.suite || !opts.scope) return fail(asJson, 1, "richiesti --suite e --scope");
  const { ws, customer } = workspaceCustomer(opts, env);
  if (!customer) return fail(asJson, 1, "cliente non determinato: --customer <C>");
  try {
    const changed = opts.changed ? YAML.parse(readFileSync(opts.changed, "utf8"))?.changed ?? [] : null;
    const at = opts.at ? new Date(opts.at) : new Date();
    if (Number.isNaN(at.getTime())) return fail(asJson, 1, `--at non è una data: ${opts.at}`);
    const m = selectSuite(ws, { customer, scope: opts.scope, suite: opts.suite, release: opts.release ?? null, shadow: !!opts.shadow, changed, now: at });
    if (!m.cases.length) { if (asJson) console.log(JSON.stringify({ ok: false, error: "nessun caso selezionabile", manifest: m })); else console.error("nessun caso selezionabile"); return 3; }
    const file = opts["dry-run"] ? null : writeManifest(ws, m);
    console.log(asJson ? JSON.stringify({ ok: true, file, manifest: m }) : `${m.run}: ${m.cases.length} casi (${m.suite}, ${m.scope})${file ? ` → ${file}` : ""}`);
    return 0;
  } catch (err) {
    if (err instanceof SuiteError) return fail(asJson, err.code, err.message);
    return fail(asJson, 2, `errore di sistema: ${err?.message ?? err}`);
  }
}

if (isMain(import.meta.url)) process.exit(run(process.argv.slice(2)));
