// kb coverage (C1.5, §28.2, §27.3): copertura della configurazione e dei test, per scope.
//
//   cfgMatrix(ws, { customer, scopes? }) → { areas[], rows: { <scope>: { <area>: { cell, s[], c[], shape } } }, warnings[] }
//     cella: ✅ CFP S + deviazione C dichiarata (anche vuota) · ◐ solo S · ✗ area pertinente (CFG dello scope) senza CFP
//     · — non pertinente; shape = forma epistemica prevalente dei CFG dell'area nello scope (item.epistemic.shape,
//     identity_quality.shape; senza dati: libresco, conoscenza dai documenti) — cons · libr · emp · ign · contr.
//     "Coperto ma libresco" è un avvertimento: la procedura non è mai stata vista funzionare qui (STR-DRY-RUN).
//   nrtCoverage(ws, { customer, scope }) → { capabilities, handoffs, risk_modes }   ciascuno { total, covered, missing[] }
//     capability ad alta criticità coperta da un caso promoted; handoff coperto (boundary.handoff o derivation);
//     risk mode di §27.2 (negative-generator.deduce sugli item dello scope) coperto da un caso promoted o shadow.
//   renderMatrix(m) → testo come la tabella di §28.2
//
// CLI: node scripts/kb/coverage.mjs [--scope S] [--customer C] [--workspace <dir>] [--json]   (anche kb coverage …)
// Exit: 0 ok · 1 argomenti · 2 errore di sistema.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import YAML from "yaml";
import { parseArgs, fail } from "../lib/args.mjs";
import { isMain } from "../lib/is-main.mjs";
import { loadItems } from "../lib/kb-items.mjs";
import { REGISTRY } from "./codes.mjs";

export const AREAS = Array.from({ length: 20 }, (_, i) => `CL-CFG-${String(i + 1).padStart(3, "0")}`);
const ABBR = { consolidato: "cons", libresco: "libr", empirico: "emp", ignoto: "ign", contraddittorio: "contr" };
const areaOf = (it) => it?.area ?? (it?.classification?.cfg_area ? `CL-CFG-${it.classification.cfg_area}` : null);
const shapeOf = (it) => it?.epistemic?.shape ?? it?.identity_quality?.shape ?? "libresco";

export function cfgMatrix(ws, { customer = null, scopes = REGISTRY.scopes } = {}) {
  const rows = {};
  const warnings = [];
  for (const s of scopes) {
    const items = loadItems(ws, { customer, scope: s, types: ["CFP", "CFG"] });
    const sCfp = items.filter((x) => x.type === "CFP" && x.id.startsWith("S.") && !x.derives_from);
    const cCfp = items.filter((x) => x.type === "CFP" && x.derives_from);
    const cfgs = items.filter((x) => x.type === "CFG");
    const row = {};
    for (const a of AREAS) {
      const S = sCfp.filter((x) => areaOf(x) === a);
      const C = cCfp.filter((x) => S.some((y) => y.id === x.derives_from));
      const cfgA = cfgs.filter((x) => areaOf(x) === a || S.some((p) => (p.governs ?? []).includes(x.id)));
      const pertinent = S.length || cfgA.length;
      const tally = {};
      for (const c of cfgA) tally[shapeOf(c)] = (tally[shapeOf(c)] ?? 0) + 1;
      const shape = Object.entries(tally).sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))[0]?.[0] ?? (S.length ? "libresco" : null);
      const cell = !pertinent ? "—" : S.length && C.length ? "✅" : S.length ? "◐" : "✗";
      row[a] = { cell, s: S.map((x) => x.id), c: C.map((x) => x.id), shape };
      if ((cell === "✅" || cell === "◐") && shape === "libresco") warnings.push(`${s} ${a}: coperto ma libresco — la prima esecuzione sarà STR-DRY-RUN (§28.2)`);
    }
    rows[s] = row;
  }
  return { areas: AREAS, rows, warnings };
}

export function renderMatrix(m) {
  const used = m.areas.filter((a) => Object.values(m.rows).some((r) => r[a].cell !== "—"));
  const head = `      ${used.map((a) => a.replace("CL-", "").padEnd(9)).join("")}`;
  const lines = [head];
  for (const [s, r] of Object.entries(m.rows)) {
    if (!used.some((a) => r[a].cell !== "—")) continue;
    lines.push(`${s.padEnd(6)}${used.map((a) => `${r[a].cell}${r[a].cell === "—" ? "" : ` ${ABBR[r[a].shape] ?? "?"}`}`.padEnd(9)).join("")}`);
  }
  lines.push("", "✅ CFP S + deviazione C · ◐ solo S · ✗ area pertinente senza CFP · — non pertinente · cons/libr/emp/ign/contr = forma epistemica");
  return lines.join("\n");
}

function casesOf(ws, customer, scope) {
  const dir = join(ws, "customers", customer ?? "", "tests", "cases", scope);
  if (!customer || !existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).map((f) => { try { return YAML.parse(readFileSync(join(dir, f), "utf8")); } catch { return null; } }).filter((c) => c?.id);
}

export async function nrtCoverage(ws, { customer, scope }) {
  const { deduce } = await import("../compile/negative-generator.mjs");
  const cases = casesOf(ws, customer, scope);
  const promoted = cases.filter((c) => c.state === "promoted");
  const active = cases.filter((c) => c.state === "promoted" || c.state === "shadow");
  const cites = (c, code) => (c.derivation?.from ?? []).includes(code) || c.capability === code || c.boundary?.handoff === code;
  const items = loadItems(ws, { customer, scope, types: ["CAP", "HND", "KEY", "LCY", "FLD", "INT"] });
  const caps = items.filter((x) => x.type === "CAP" && x.criticality === "alta");
  const hnds = items.filter((x) => x.type === "HND");
  const byId = new Map(items.map((x) => [x.id, x]));
  const modes = items.filter((x) => ["KEY", "LCY", "FLD", "INT", "HND"].includes(x.type)).flatMap((x) => deduce(x, { byId }).filter((d) => d.owner === scope).map((d) => ({ subject: d.subject, risk_mode: d.risk_mode })));
  const uniq = [...new Map(modes.map((m) => [`${m.subject}|${m.risk_mode}`, m])).values()];
  const res = (list, covered) => ({ total: list.length, covered: list.filter(covered).length, missing: list.filter((x) => !covered(x)).map((x) => x.id ?? `${x.subject} · ${x.risk_mode}`) });
  return {
    scope, cases: { total: cases.length, promoted: promoted.length, shadow: cases.filter((c) => c.state === "shadow").length },
    capabilities: res(caps, (c) => promoted.some((k) => cites(k, c.id))),
    handoffs: res(hnds, (h) => promoted.some((k) => cites(k, h.id))),
    risk_modes: res(uniq, (m) => active.some((k) => (k.derivation?.from ?? []).includes(m.subject) && k.derivation?.risk_mode === m.risk_mode)),
  };
}

const HELP = `uso: node scripts/kb/coverage.mjs [--scope S] [--customer C] [--workspace <dir>] [--json] [--help]

Matrice CL-CFG × scope con la forma epistemica prevalente (§28.2) e copertura NRT per scope (capability ad alta
criticità, handoff, risk mode di §27.2).

Exit code: 0 ok · 1 argomenti · 2 errore di sistema.`;

export function main(argv, env = process.env) {
  const { opts } = parseArgs(argv);
  const asJson = !!opts.json;
  if (opts.help) { console.log(HELP); return 0; }
  if (opts.scope && !REGISTRY.scopes.includes(opts.scope)) return fail(asJson, 1, `scope sconosciuto: ${opts.scope}`);
  const ws = resolvePath(opts.workspace || env.JVC_WORKSPACE || env.CLAUDE_PROJECT_DIR || process.cwd());
  let customer = opts.customer ?? null;
  if (!customer) { try { const cur = readFileSync(join(ws, ".jvc", "current-session"), "utf8").trim(); customer = JSON.parse(readFileSync(join(ws, ".jvc", "sessions", `${cur}.json`), "utf8")).customer ?? null; } catch { /* solo prodotto */ } }
  try {
    const m = cfgMatrix(ws, { customer, scopes: opts.scope ? [opts.scope] : REGISTRY.scopes });
    if (asJson) console.log(JSON.stringify({ ok: true, customer, matrix: m }));
    else console.log(`${renderMatrix(m)}${m.warnings.length ? `\n\nAvvertimenti:\n  ${m.warnings.join("\n  ")}` : ""}`);
    return 0;
  } catch (err) { return fail(asJson, 2, `errore di sistema: ${err?.message ?? err}`); }
}

export async function mainNrt(argv, env = process.env) {
  const { opts } = parseArgs(argv);
  const ws = resolvePath(opts.workspace || env.JVC_WORKSPACE || env.CLAUDE_PROJECT_DIR || process.cwd());
  if (!opts.scope || !opts.customer) return fail(!!opts.json, 1, "richiesti --scope e --customer");
  const r = await nrtCoverage(ws, { customer: opts.customer, scope: opts.scope });
  console.log(JSON.stringify({ ok: true, ...r }));
  return 0;
}

if (isMain(import.meta.url)) {
  const argv = process.argv.slice(2);
  if (argv[0] === "nrt") mainNrt(argv.slice(1)).then((c) => process.exit(c), (e) => { console.error(e); process.exit(2); });
  else process.exit(main(argv));
}
