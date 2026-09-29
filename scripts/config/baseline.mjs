// config baseline (F10, §28, §51.4) — WP09d. Cattura la baseline di configurazione di un ambiente del cliente:
//   - item CFG del cliente con current_state (valore, osservato il, fonte; current_state.env se diverso ⇒ escluso);
//   - OBS del DB del cliente (scritte da observe-append) con payload.config { object, values } o payload.config_values
//     { <oggetto>: { … } } dell'ambiente (payload.env assente o uguale);
//   - facoltativo --input <file> (es. un export di configurazione già parsato) con objects { <chiave>: { area?, values } }.
// Scrive customers/<C>/config-baselines/<env>/<data>.yaml con l'impronta (sha256 del contenuto canonico degli oggetti);
// una baseline esistente non si sovrascrive mai (nuovo nome con l'orario).
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import YAML from "yaml";
import { loadItems } from "../lib/kb-items.mjs";
import { openReadonly } from "../digest/collect.mjs";
import { canonical } from "../digest/align.mjs";
import { parseArgs, fail } from "../lib/args.mjs";
import { isMain } from "../lib/is-main.mjs";

export const ENV_ID = /^[a-z0-9][a-z0-9_-]{0,39}$/i;
export const baselinesDir = (ws, c, env) => join(ws, "customers", c, "config-baselines", env);
export const hashObjects = (objects) => createHash("sha256").update(canonical(objects)).digest("hex");
const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };
const valuesOf = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : { value: v });

export function captureObjects(ws, customer, env, { input = null } = {}) {
  const objects = {};
  const sources = { cfg: 0, obs: 0, input: 0 };
  for (const it of loadItems(ws, { customer, types: ["CFG"] })) {
    if (!it.id.startsWith(`C.${customer}.`) && !it.id.startsWith(`L.${customer}.`)) continue;
    const cs = it.current_state;
    if (!cs || cs.value === undefined) continue;
    if (cs.env && cs.env !== env) continue;
    objects[it.id] = { area: it.area ?? null, values: valuesOf(cs.value), source: `CFG ${cs.source ?? "current_state"}`, observed_at: cs.observed_at ?? null };
    sources.cfg++;
  }
  const db = openReadonly(join(ws, "customers", customer, "knowledge.db"));
  if (db) {
    try {
      let rows = [];
      try { rows = db.prepare("select code, payload from observations order by code").all(); } catch { rows = []; }
      for (const r of rows) {
        const p = parse(r.payload);
        if (!p || (p.env && p.env !== env)) continue;
        const entries = p.config?.object ? [[p.config.object, p.config.values]] : Object.entries(p.config_values ?? {});
        for (const [obj, vals] of entries) {
          const prev = objects[obj];
          objects[obj] = { area: p.config?.area ?? prev?.area ?? null, values: { ...(prev?.values ?? {}), ...valuesOf(vals) }, source: `OBS ${r.code}`, observed_at: p.ts ?? null };
          sources.obs++;
        }
      }
    } finally { db.close(); }
  }
  for (const [k, o] of Object.entries(input?.objects ?? {})) {
    objects[k] = { area: o.area ?? objects[k]?.area ?? null, values: { ...(objects[k]?.values ?? {}), ...valuesOf(o.values ?? o.value) }, source: o.source ?? "input", observed_at: o.observed_at ?? null };
    sources.input++;
  }
  const sorted = Object.fromEntries(Object.keys(objects).sort().map((k) => [k, objects[k]]));
  return { objects: sorted, sources };
}

export function writeBaseline(ws, customer, env, captured, { now = new Date() } = {}) {
  const dir = baselinesDir(ws, customer, env);
  mkdirSync(dir, { recursive: true });
  const day = now.toISOString().slice(0, 10);
  let file = join(dir, `${day}.yaml`);
  if (existsSync(file)) file = join(dir, `${day}-${now.toISOString().slice(11, 19).replace(/:/g, "")}.yaml`);
  let n = 2;
  while (existsSync(file)) file = join(dir, `${day}-${now.toISOString().slice(11, 19).replace(/:/g, "")}-${n++}.yaml`);
  const doc = { customer, env, captured_at: now.toISOString(), sources: captured.sources, objects: captured.objects, hash: hashObjects(captured.objects) };
  writeFileSync(file, YAML.stringify(doc));
  return { file, doc };
}

export function loadBaseline(file) {
  const d = YAML.parse(readFileSync(file, "utf8"));
  if (!d?.objects || typeof d.objects !== "object") throw new Error(`baseline senza objects: ${file}`);
  if (d.hash && hashObjects(d.objects) !== d.hash) throw new Error(`impronta della baseline non coincide (file modificato dopo la cattura): ${file}`);
  return d;
}

export function latestBaseline(ws, customer, env) {
  const dir = baselinesDir(ws, customer, env);
  if (!existsSync(dir)) return null;
  const f = readdirSync(dir).filter((x) => /^\d{4}-\d{2}-\d{2}.*\.yaml$/.test(x)).sort().at(-1);
  return f ? join(dir, f) : null;
}

export const HELP = `uso: node scripts/config/baseline.mjs --customer <C> --env <id> [--input <objects.yaml>] [--workspace <dir>] [--json]

Baseline di configurazione dell'ambiente (F10): CFG current_state + OBS con config + --input; scritta in
customers/<C>/config-baselines/<env>/<data>.yaml con l'impronta sha256 (mai sovrascritta).

Exit code: 0 ok · 1 argomenti non validi o nessun oggetto · 2 errore di sistema.`;

export function run(argv, env = process.env) {
  const { opts } = parseArgs(argv);
  const asJson = !!opts.json;
  if (opts.help) { console.log(HELP); return 0; }
  if (!/^[A-Z0-9]{4}$/.test(opts.customer ?? "") || !ENV_ID.test(opts.env ?? "")) return fail(asJson, 1, "richiesti --customer <C> e --env <id>");
  const ws = resolve(opts.workspace || env.JVC_WORKSPACE || env.CLAUDE_PROJECT_DIR || process.cwd());
  try {
    let input = null;
    if (opts.input) { const t = readFileSync(opts.input, "utf8"); input = t.trimStart().startsWith("{") ? JSON.parse(t) : YAML.parse(t); }
    const cap = captureObjects(ws, opts.customer, opts.env, { input });
    if (!Object.keys(cap.objects).length) return fail(asJson, 1, "nessun oggetto di configurazione: né CFG con current_state, né OBS con config, né --input");
    const r = writeBaseline(ws, opts.customer, opts.env, cap);
    console.log(JSON.stringify({ ok: true, file: r.file, objects: Object.keys(r.doc.objects).length, sources: r.doc.sources, hash: r.doc.hash }));
    return 0;
  } catch (err) { return fail(asJson, 2, `errore di sistema: ${err?.message ?? err}`); }
}

if (isMain(import.meta.url)) process.exitCode = run(process.argv.slice(2));
