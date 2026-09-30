// config lint (F10) — WP09d. Le regole RUL (customers/<C>/analysis/rules e product/analysis/rules) valutate su una
// baseline: per ogni regola gli oggetti a cui si applica (codice CFG esatto, area CL-CFG, chiave), la condizione `when`
// facoltativa e l'asserzione (percorso, operatore, valore) → violazioni con severità e messaggio. Sola lettura.
import { join, resolve } from "node:path";
import { loadBaseline, latestBaseline, ENV_ID } from "./baseline.mjs";
import { flatten } from "./diff.mjs";
import { loadAnalysis } from "../analysis/common.mjs";
import { canonical } from "../digest/align.mjs";
import { parseArgs, fail } from "../lib/args.mjs";
import { isMain } from "../lib/is-main.mjs";
import { confineInputs } from "../lib/text-file.mjs";

const get = (values, path) => { const f = flatten(values ?? {}); return Object.hasOwn(f, path) ? f[path] : undefined; };
const eq = (a, b) => canonical(a) === canonical(b);
export function holds(actual, { op, value }) {
  switch (op) {
    case "eq": return eq(actual, value);
    case "ne": return !eq(actual, value);
    case "in": return Array.isArray(value) && value.some((v) => eq(actual, v));
    case "nin": return Array.isArray(value) && !value.some((v) => eq(actual, v));
    case "gte": return typeof actual === "number" && actual >= value;
    case "lte": return typeof actual === "number" && actual <= value;
    case "gt": return typeof actual === "number" && actual > value;
    case "lt": return typeof actual === "number" && actual < value;
    case "exists": return actual !== undefined && actual !== null;
    case "absent": return actual === undefined || actual === null;
    case "regex": try { return typeof actual === "string" && new RegExp(value).test(actual); } catch { return false; }
    default: return false;
  }
}

export function appliesTo(rule, key, obj) {
  const a = rule.applies_to ?? {};
  if (a.object && a.object !== key) return false;
  if (a.area && obj.area !== a.area) return false;
  if (a.key && key !== a.key) return false;
  return !!(a.object || a.area || a.key);
}

export function lint(baseline, rules) {
  const violations = [];
  let evaluated = 0;
  for (const r of rules) {
    const rule = r.rule;
    for (const [key, obj] of Object.entries(baseline.objects)) {
      if (!appliesTo(rule, key, obj)) continue;
      if (rule.when && !holds(get(obj.values, rule.when.path), rule.when)) continue;
      evaluated++;
      const actual = get(obj.values, rule.assert.path);
      if (holds(actual, rule.assert)) continue;
      violations.push({ rule: r.id, object: key, path: rule.assert.path, op: rule.assert.op, expected: rule.assert.value ?? null, actual: actual ?? null,
        severity: rule.severity, message: rule.message ?? r.title });
    }
  }
  const order = { critical: 0, high: 1, medium: 2, low: 3 };
  violations.sort((x, y) => order[x.severity] - order[y.severity] || x.rule.localeCompare(y.rule) || x.object.localeCompare(y.object));
  return { evaluated, violations };
}

export function loadRules(ws, customer) {
  return [...loadAnalysis(join(ws, "product"), "RUL"), ...loadAnalysis(join(ws, "customers", customer), "RUL")];
}

export const HELP = `uso: node scripts/config/lint.mjs --customer <C> (--baseline <file> | --env <id>) [--workspace <dir>] [--json]

Regole RUL (product/ e cliente) valutate sulla baseline (--baseline o l'ultima dell'ambiente) → violazioni.

Exit code: 0 nessuna violazione · 1 argomenti non validi o baseline assente · 2 errore di sistema · 3 violazioni trovate.`;

export function run(argv, env = process.env) {
  const { opts } = parseArgs(argv);
  const asJson = !!opts.json;
  if (opts.help) { console.log(HELP); return 0; }
  { const bad = confineInputs(opts, ["baseline"], { env }); if (bad) return fail(asJson, 1, bad); }
  if (!/^[A-Z0-9]{4}$/.test(opts.customer ?? "")) return fail(asJson, 1, "richiesto --customer <C>");
  const ws = resolve(opts.workspace || env.JVC_WORKSPACE || env.CLAUDE_PROJECT_DIR || process.cwd());
  const file = opts.baseline ?? (ENV_ID.test(opts.env ?? "") ? latestBaseline(ws, opts.customer, opts.env) : null);
  if (!file) return fail(asJson, 1, "richiesta --baseline <file> o --env <id> con una baseline catturata");
  try {
    const rules = loadRules(ws, opts.customer);
    const r = lint(loadBaseline(file), rules);
    console.log(JSON.stringify({ ok: r.violations.length === 0, baseline: file, rules: rules.length, ...r }));
    return r.violations.length ? 3 : 0;
  } catch (err) { return fail(asJson, 2, `errore di sistema: ${err?.message ?? err}`); }
}

if (isMain(import.meta.url)) process.exitCode = run(process.argv.slice(2));
