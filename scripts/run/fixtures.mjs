// Fixture e entità create dai test (F4.4, §29.1 passo 4, §27.1): lookup_or_fail sulle fixture registrate, prefisso
// NRT-<data>-<run> delle entità create, registro delle entità create per il teardown (0 orfani).
//
//   loadRegistry(ws, customer) → { fixtures[] }                customers/<C>/tests/fixtures.yaml
//   lookupOrFail(registry, criteria, { env? }) → fixture         nessuna ⇒ FixtureError(3): la fixture non si crea al volo
//   resolveCaseFixtures(caso, registry, { env? }) → { values: { nome: fixture }, missing: [{ name, criteria }] }
//   entityPrefix(run, date?) → "NRT-<AAAAMMDD>-<XXXX>"            XXXX = impronta del codice RUN (4 hex maiuscole)
//   registerCreated(ws, customer, run, { entity, case?, step?, ref?, attrs?, compensation? }) → voce
//       runs/<RUN>/created.yaml: la voce nasce `open`; la chiude teardown (compensated) — mai cancellata
//   createdEntities(ws, customer, { run? }) → [voce + run]
//   orphans(ws, customer, { run? }) → voci senza compensazione eseguita (§47.2 #1: nessuna entità orfana sconosciuta)
//
// CLI (input da file o chiave=valore, mai JSON in linea):
//   fixtures lookup kind=supplier tag=attivo-it [--customer C] [--env sandbox]
//   fixtures resolve --case <file.yaml> [--customer C] [--env sandbox]
//   fixtures prefix --run <RUN>
//   fixtures register --run <RUN> entity=requisition case=NRT… step=3 [ref=…] [--payload-file <yaml>]
//   fixtures created|orphans [--run <RUN>]
// Exit: 0 ok · 1 errore utente · 2 errore di sistema · 3 fixture mancante / orfani presenti.
import { readFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { createHash } from "node:crypto";
import YAML from "yaml";
import { readDataFileSync, inputBase, confineInputs } from "../lib/text-file.mjs";
import { parseArgs, fail } from "../lib/args.mjs";
import { isMain } from "../lib/is-main.mjs";
import { writeFileAtomic, withFileLock } from "../../hooks/lib/fsx.mjs";
import { parseRunCode, RUN_RE } from "../lib/run-code.mjs";

export class FixtureError extends Error { constructor(code, msg, extra = {}) { super(msg); this.code = code; Object.assign(this, extra); } }

export const registryFile = (ws, customer) => join(ws, "customers", customer, "tests", "fixtures.yaml");
export function loadRegistry(ws, customer) {
  const f = registryFile(ws, customer);
  if (!existsSync(f)) return { fixtures: [] };
  const doc = YAML.parse(readFileSync(f, "utf8")) ?? {};
  return { fixtures: Array.isArray(doc.fixtures) ? doc.fixtures : [] };
}

const asList = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
function matches(fx, criteria, env) {
  if (env && fx.env && ![].concat(fx.env).includes(env)) return false;
  for (const [k, v] of Object.entries(criteria ?? {})) {
    if (k === "tag" || k === "tags") { const tags = asList(fx.tags); if (!asList(v).every((t) => tags.includes(t))) return false; continue; }
    if (["name", "kind", "scope"].includes(k)) { if (fx[k] !== v) return false; continue; }
    if (String(fx.attrs?.[k] ?? fx[k] ?? "") !== String(v)) return false;
  }
  return true;
}

export function lookupOrFail(registry, criteria, { env = null } = {}) {
  if (!criteria || typeof criteria !== "object" || !Object.keys(criteria).length) throw new FixtureError(1, "lookup_or_fail senza criteri");
  const hit = (registry?.fixtures ?? []).filter((fx) => fx && matches(fx, criteria, env)).sort((a, b) => String(a.name).localeCompare(String(b.name)))[0];
  if (!hit) throw new FixtureError(3, `lookup_or_fail: nessuna fixture registrata soddisfa ${Object.entries(criteria).map(([k, v]) => `${k}=${v}`).join(" ")}${env ? ` (ambiente ${env})` : ""}: la fixture non si crea al volo — registrala in tests/fixtures.yaml o chiedila (DT-002)`, { criteria });
  return hit;
}

export function resolveCaseFixtures(caso, registry, { env = null } = {}) {
  const values = {};
  const missing = [];
  for (const f of caso?.fixtures ?? []) {
    try { values[f.name] = lookupOrFail(registry, f.lookup_or_fail, { env }); } catch (err) { if (err.code === 3) missing.push({ name: f.name, criteria: f.lookup_or_fail }); else throw err; }
  }
  return { values, missing };
}

export function entityPrefix(run, date = null) {
  const p = parseRunCode(run);
  if (!p) throw new FixtureError(1, `codice RUN non valido: ${run}`);
  const d = date ?? p.date;
  return `NRT-${d}-${createHash("sha256").update(run).digest("hex").slice(0, 4).toUpperCase()}`;
}

const runDir = (ws, customer, run) => join(ws, "customers", customer, "runs", run);
const createdFile = (ws, customer, run) => join(runDir(ws, customer, run), "created.yaml");
function readCreated(f) {
  if (!existsSync(f)) return [];
  const doc = YAML.parse(readFileSync(f, "utf8")) ?? {};
  return Array.isArray(doc.created) ? doc.created : [];
}

export function registerCreated(ws, customer, run, { entity, case: caseId = null, step = null, ref = null, attrs = null, compensation = null, now = new Date() } = {}) {
  if (!RUN_RE.test(String(run ?? ""))) throw new FixtureError(1, `codice RUN non valido: ${run}`);
  if (!entity) throw new FixtureError(1, "entity obbligatoria");
  if (compensation?.kind && !["close", "cancel", "deactivate", "restore"].includes(compensation.kind)) throw new FixtureError(1, `compensazione ${compensation.kind} non ammessa: close · cancel · deactivate · restore (mai delete)`);
  mkdirSync(runDir(ws, customer, run), { recursive: true });
  const f = createdFile(ws, customer, run);
  return withFileLock(`${f}.lock`, () => {
    const list = readCreated(f);
    const prefix = entityPrefix(run);
    const ent = String(entity).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6) || "ENT";
    const n = list.filter((x) => String(x.ref).startsWith(`${prefix}-${ent}-`)).length + 1;
    const r = ref ?? `${prefix}-${ent}-${String(n).padStart(3, "0")}`;
    if (!String(r).startsWith("NRT-")) throw new FixtureError(1, `riferimento ${r} senza prefisso NRT-: le entità create dai test si riconoscono dal prefisso`);
    const existing = list.find((x) => x.ref === r);
    if (existing) return existing;
    const e = { ref: r, entity, case: caseId, step, ...(attrs ? { attrs } : {}), ...(compensation ? { compensation } : {}), status: "open", created_at: now.toISOString() };
    list.push(e);
    writeFileAtomic(f, YAML.stringify({ created: list }));
    return e;
  });
}

export function markCompensated(ws, customer, run, ref, { now = new Date(), by = "teardown" } = {}) {
  const f = createdFile(ws, customer, run);
  if (!existsSync(f)) return null;
  return withFileLock(`${f}.lock`, () => {
    const list = readCreated(f);
    const e = list.find((x) => x.ref === ref);
    if (!e) return null;
    e.status = "compensated"; e.compensated_at = now.toISOString(); e.compensated_by = by;
    writeFileAtomic(f, YAML.stringify({ created: list }));
    return e;
  });
}

export function createdEntities(ws, customer, { run = null } = {}) {
  const base = join(ws, "customers", customer, "runs");
  const runs = run ? [run] : existsSync(base) ? readdirSync(base).filter((r) => RUN_RE.test(r)) : [];
  return runs.flatMap((r) => readCreated(createdFile(ws, customer, r)).map((e) => ({ ...e, run: r })));
}

export const orphans = (ws, customer, opts = {}) => createdEntities(ws, customer, opts).filter((e) => e.status !== "compensated");

// ——— CLI ———
const HELP = `uso: node scripts/run/fixtures.mjs <comando> [opzioni]
  lookup <chiave=valore…> [--customer C] [--env <id>]      fixture registrata o exit 3 (lookup_or_fail)
  resolve --case <file.yaml> [--customer C] [--env <id>]    fixture di un caso NRT: trovate o mancanti (exit 3)
  prefix --run <RUN>                                         prefisso NRT-<data>-<run> delle entità create
  register --run <RUN> entity=<e> [case=<NRT…>] [step=<n>] [ref=<NRT-…>] [--payload-file <yaml>]
  created [--run <RUN>] · orphans [--run <RUN>] (exit 3 se ce ne sono)
Opzioni comuni: --workspace <dir> --customer <C> --json --help
Exit code: 0 ok · 1 errore utente · 2 errore di sistema · 3 fixture mancante / orfani.`;

export function kvArgs(positional) {
  const out = {};
  for (const p of positional) { const i = p.indexOf("="); if (i > 0) out[p.slice(0, i)] = p.slice(i + 1); }
  return out;
}
export function workspaceCustomer(opts, env) {
  const ws = resolvePath(opts.workspace || env.JVC_WORKSPACE || env.CLAUDE_PROJECT_DIR || process.cwd());
  let customer = opts.customer ?? null;
  if (!customer) {
    try { const cur = readFileSync(join(ws, ".jvc", "current-session"), "utf8").trim(); const p = JSON.parse(readFileSync(join(ws, ".jvc", "sessions", `${cur}.json`), "utf8")); customer = p.customer ?? null; } catch { /* nessuna sessione */ }
  }
  return { ws, customer };
}

export function run(argv, env = process.env) {
  const { opts, positional } = parseArgs(argv);
  const asJson = !!opts.json;
  const [cmd, ...rest] = positional;
  if (opts.help || !cmd) { console.log(HELP); return opts.help ? 0 : 1; }
  { const bad = confineInputs(opts, ["case"], { env }); if (bad) return fail(asJson, 1, bad); }
  const { ws, customer } = workspaceCustomer(opts, env);
  const out = (o) => { console.log(asJson ? JSON.stringify({ ok: true, ...o }) : YAML.stringify(o).trim()); };
  try {
    if (cmd === "prefix") { if (!opts.run) return fail(asJson, 1, "richiesto --run"); out({ prefix: entityPrefix(opts.run) }); return 0; }
    if (!customer) return fail(asJson, 1, "cliente non determinato: --customer <C> o una sessione attiva");
    if (cmd === "lookup") { out({ fixture: lookupOrFail(loadRegistry(ws, customer), kvArgs(rest), { env: opts.env ?? null }) }); return 0; }
    if (cmd === "resolve") {
      if (!opts.case) return fail(asJson, 1, "richiesto --case <file>");
      const r = resolveCaseFixtures(YAML.parse(readFileSync(resolvePath(opts.case), "utf8")), loadRegistry(ws, customer), { env: opts.env ?? null });
      if (r.missing.length) { if (asJson) console.log(JSON.stringify({ ok: false, ...r })); else console.error(`fixture mancanti (lookup_or_fail): ${r.missing.map((m) => m.name).join(", ")}`); return 3; }
      out(r); return 0;
    }
    if (cmd === "register") {
      if (!opts.run) return fail(asJson, 1, "richiesto --run");
      // WP10a giro 1 (minore 2): payload confinato al workspace
      let fromFile = {};
      if (opts["payload-file"]) { const d = readDataFileSync(inputBase(env), opts["payload-file"], YAML.parse); if (d.error) return fail(asJson, 1, d.error); fromFile = d.data ?? {}; }
      const p = { ...fromFile, ...kvArgs(rest) };
      out({ created: registerCreated(ws, customer, opts.run, { entity: p.entity, case: p.case ?? null, step: p.step != null ? Number(p.step) : null, ref: p.ref ?? null, attrs: p.attrs ?? null, compensation: p.compensation ?? null }) });
      return 0;
    }
    if (cmd === "created") { out({ created: createdEntities(ws, customer, { run: opts.run ?? null }) }); return 0; }
    if (cmd === "orphans") { const o = orphans(ws, customer, { run: opts.run ?? null }); out({ orphans: o, count: o.length }); return o.length ? 3 : 0; }
    return fail(asJson, 1, `comando sconosciuto: ${cmd}`);
  } catch (err) {
    if (err instanceof FixtureError) return fail(asJson, err.code, err.message);
    return fail(asJson, 2, `errore di sistema: ${err?.message ?? err}`);
  }
}

if (isMain(import.meta.url)) process.exit(run(process.argv.slice(2)));
