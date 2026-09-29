// config diff (F10, §51.4) — WP09d. Due baseline (file) o due ambienti (l'ultima baseline di ciascuno) → elenco delle
// derive: oggetto, percorso del valore, valore in A e in B (changed · only_a · only_b). Con --propose scrive una PROPOSTA
// per environments.yaml alignment.drift_known in customers/<C>/config-baselines/drift-proposals/: environments.yaml lo
// modifica solo l'utente (configurazione del cliente, protetta), mai questo script.
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import YAML from "yaml";
import { loadBaseline, latestBaseline, ENV_ID } from "./baseline.mjs";
import { canonical } from "../digest/align.mjs";
import { parseArgs, fail } from "../lib/args.mjs";
import { isMain } from "../lib/is-main.mjs";

// Valori appiattiti per percorso (a.b.c); gli elenchi restano foglie (confronto canonico).
export function flatten(v, prefix = "", out = {}) {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const keys = Object.keys(v);
    if (!keys.length && prefix) out[prefix] = {};
    for (const k of keys) flatten(v[k], prefix ? `${prefix}.${k}` : k, out);
  } else out[prefix || "value"] = v;
  return out;
}

export function diff(a, b) {
  const drift = [];
  const keys = [...new Set([...Object.keys(a.objects), ...Object.keys(b.objects)])].sort();
  for (const k of keys) {
    const A = a.objects[k];
    const B = b.objects[k];
    if (!A) { drift.push({ object: k, kind: "only_b", path: null, a: null, b: B.values }); continue; }
    if (!B) { drift.push({ object: k, kind: "only_a", path: null, a: A.values, b: null }); continue; }
    const fa = flatten(A.values);
    const fb = flatten(B.values);
    for (const p of [...new Set([...Object.keys(fa), ...Object.keys(fb)])].sort()) {
      if (canonical(fa[p]) === canonical(fb[p])) continue;
      drift.push({ object: k, kind: !(p in fa) ? "only_b" : !(p in fb) ? "only_a" : "changed", path: p, a: fa[p] ?? null, b: fb[p] ?? null });
    }
  }
  return drift;
}

export function proposal(a, b, drift, { now = new Date() } = {}) {
  const byObject = new Map();
  for (const d of drift) { if (!byObject.has(d.object)) byObject.set(d.object, []); if (d.path) byObject.get(d.object).push(d.path); }
  return { proposal: "alignment.drift_known", status: "da-approvare", env: a.env, against: b.env, computed_at: now.toISOString(),
    baselines: { [a.env]: a.hash ?? null, [b.env]: b.hash ?? null },
    drift_known: [...byObject.entries()].map(([object, paths]) => ({ object, paths: [...new Set(paths)] })),
    note: "proposta per customers/<C>/config/environments.yaml (alignment.drift_known): la modifica solo l'utente (§51.4); DT-007 alza il rischio sugli oggetti in deriva" };
}

export const HELP = `uso: node scripts/config/diff.mjs --customer <C> (--a <baseline.yaml> --b <baseline.yaml> | --env-a <id> --env-b <id>)
       [--propose] [--workspace <dir>] [--json]

Derive fra due baseline o fra due ambienti (l'ultima baseline di ciascuno). --propose scrive la proposta
alignment.drift_known in customers/<C>/config-baselines/drift-proposals/ (environments.yaml non si tocca).

Exit code: 0 nessuna deriva · 1 argomenti non validi o baseline assenti · 2 errore di sistema · 3 derive trovate.`;

export function run(argv, env = process.env) {
  const { opts } = parseArgs(argv, { flags: ["propose"] });
  const asJson = !!opts.json;
  if (opts.help) { console.log(HELP); return 0; }
  if (!/^[A-Z0-9]{4}$/.test(opts.customer ?? "")) return fail(asJson, 1, "richiesto --customer <C>");
  const ws = resolve(opts.workspace || env.JVC_WORKSPACE || env.CLAUDE_PROJECT_DIR || process.cwd());
  let fa = opts.a;
  let fb = opts.b;
  if (!fa || !fb) {
    if (!ENV_ID.test(opts["env-a"] ?? "") || !ENV_ID.test(opts["env-b"] ?? "")) return fail(asJson, 1, "servono --a/--b oppure --env-a/--env-b");
    fa = latestBaseline(ws, opts.customer, opts["env-a"]);
    fb = latestBaseline(ws, opts.customer, opts["env-b"]);
    if (!fa || !fb) return fail(asJson, 1, `baseline assente per ${!fa ? opts["env-a"] : opts["env-b"]}: config baseline --env <id> prima`);
  }
  try {
    const a = loadBaseline(fa);
    const b = loadBaseline(fb);
    const drift = diff(a, b);
    let file = null;
    if (opts.propose && drift.length) {
      const dir = join(ws, "customers", opts.customer, "config-baselines", "drift-proposals");
      mkdirSync(dir, { recursive: true });
      const p = proposal(a, b, drift);
      file = join(dir, `${a.env}__${b.env}-${p.computed_at.slice(0, 19).replace(/[:T]/g, "")}.yaml`);
      if (!existsSync(file)) writeFileSync(file, YAML.stringify(p));
    }
    console.log(JSON.stringify({ ok: drift.length === 0, a: fa, b: fb, drift, proposal: file }));
    return drift.length ? 3 : 0;
  } catch (err) { return fail(asJson, 2, `errore di sistema: ${err?.message ?? err}`); }
}

if (isMain(import.meta.url)) process.exitCode = run(process.argv.slice(2));
