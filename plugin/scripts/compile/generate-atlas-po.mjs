// generate-atlas-po (F4.2, §27.1, §23.4, DT-008): dalle voci SEL di uno scope (prodotto + cliente) i page object.
//
//   chainOf(sel) → [{ kind, value, name? }]   catena in ordine DT-008: testid → role → label → text → css; css SOLO
//                                            con stability: fragile (altrimenti esclusa: un css "stabile" è un errore)
//   primaryOf(sel, { priors? }) → { strategy, dec }   DT-008 sulla prima strategia disponibile, la stabilità (stable →
//                                            stabile, medium → variabile, fragile → instabile) e il pattern dinamico;
//                                            oltre 0.5 si scende al gradino successivo della catena
//   generateAtlas(ws, { customer, scope }) → { scope, selectors: { codice: { primary, chain, stability, effect, role, … } }, skipped[] }
//   toPlaywright(atlas) → modulo TS: una funzione per SEL che risolve la catena con locator.or() (corsia compilata)
//
// La mappa JSON è il resolver della corsia guidata (l'agente risolve i target dall'Atlas); il modulo TS è opzionale e lo
// usa compile-plan (--atlas <file.po.json>) per la corsia compilata. Nessuna dipendenza da playwright: solo testo.
//
// CLI: node scripts/compile/generate-atlas-po.mjs --scope <S> [--customer C] [--ts] [--out-dir <dir>] [--workspace <dir>] [--json]
//      output di default: customers/<C>/tests/atlas/<S>.po.json (+ <S>.po.ts con --ts)
// Exit: 0 ok · 1 argomenti non validi · 2 errore di sistema.
import { mkdirSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { parseArgs, fail } from "../lib/args.mjs";
import { isMain } from "../lib/is-main.mjs";
import { writeFileAtomic } from "../../hooks/lib/fsx.mjs";
import { loadItems } from "../lib/kb-items.mjs";
import { evaluate, loadTable } from "../decide/dt-eval.mjs";
import { workspaceCustomer } from "../run/fixtures.mjs";
import { loadTemplate, fillOrWarn } from "../lib/templates.mjs";

export const DT008_ORDER = ["testid", "role", "label", "text", "css"];
const STABILITY = { stable: "stabile", medium: "variabile", fragile: "instabile" };
const DYNAMIC = new Set(["validazione-asincrona-griglia", "griglia-righe"]);

export function chainOf(sel) {
  const strategies = Array.isArray(sel?.strategies) ? sel.strategies : [];
  return strategies.filter((s) => DT008_ORDER.includes(s?.kind) && (s.kind !== "css" || sel.stability === "fragile"))
    .map((s, i) => ({ s, i })).sort((a, b) => DT008_ORDER.indexOf(a.s.kind) - DT008_ORDER.indexOf(b.s.kind) || a.i - b.i)
    .map(({ s }) => ({ kind: s.kind, value: s.value, ...(s.name ? { name: s.name } : {}), ...(s.exact ? { exact: true } : {}) }));
}

export function primaryOf(sel, { priors = {}, table = loadTable("DT-008") } = {}) {
  const chain = chainOf(sel);
  if (!chain.length) return { strategy: null, dec: null };
  const first = chain[0].kind === "text" ? "label" : chain[0].kind;
  const dec = evaluate(table, { first_available: first, stability: STABILITY[sel.stability] ?? null, dynamic_pattern: DYNAMIC.has(sel.classification?.ui_pattern) }, { priors });
  // l'esito DT-008 è un gradino della catena: la prima strategia disponibile da quel gradino in giù
  const from = DT008_ORDER.indexOf(dec.outcome);
  const primary = chain.find((c) => DT008_ORDER.indexOf(c.kind) >= from) ?? chain[chain.length - 1];
  return { strategy: primary, dec: { outcome: dec.outcome, score: dec.score } };
}

export function generateAtlas(ws, { customer = null, scope }) {
  const selectors = {};
  const skipped = [];
  const table = loadTable("DT-008");
  for (const sel of loadItems(ws, { customer, scope, types: ["SEL"] }).sort((a, b) => a.id.localeCompare(b.id))) {
    const chain = chainOf(sel);
    if (!chain.length) { skipped.push({ code: sel.id, reason: sel.strategies?.some((s) => s.kind === "css") ? "solo css con stabilità non fragile" : "nessuna strategia" }); continue; }
    const { strategy, dec } = primaryOf(sel, { table });
    const rest = chain.filter((c) => !(c.kind === strategy.kind && c.value === strategy.value));
    selectors[sel.id] = { concept: sel.concept ?? sel.title, primary: strategy, chain: [strategy, ...rest], stability: sel.stability ?? null, effect: sel.effect ?? null,
      role: sel.role ?? null, frame_context: sel.frame_context ?? null, dt008: dec };
  }
  return { scope, customer, generated_at: new Date().toISOString(), selectors, skipped };
}

const q = (s) => JSON.stringify(String(s));
export function locatorExpr(c, page = "page") {
  if (c.kind === "testid") return `${page}.getByTestId(${q(c.value)})`;
  if (c.kind === "role") return `${page}.getByRole(${q(c.value)}${c.name ? `, { name: ${q(c.name)}${c.exact ? ", exact: true" : ""} }` : ""})`;
  if (c.kind === "label") return `${page}.getByLabel(${q(c.value)}${c.exact ? ", { exact: true }" : ""})`;
  if (c.kind === "text") return `${page}.getByText(${q(c.value)}${c.exact ? ", { exact: true }" : ""})`;
  return `${page}.locator(${q(c.value)})`;
}
const ident = (code) => `sel_${code.replace(/[^A-Za-z0-9]/g, "_")}`;
// WP10a: templates/page-object.ts.tpl (§31.2) se presente e con {{selectors}} e {{atlas_entries}}; altrimenti lo stesso
// testo dal codice. template: undefined = il file di templates/, null = dal codice, stringa = quel template (test).
export const PO_TEMPLATE = "page-object.ts.tpl";
export function toPlaywright(atlas, { template, warnings = null } = {}) {
  const sels = [];
  for (const [code, s] of Object.entries(atlas.selectors)) {
    const [first, ...others] = s.chain.map((c) => locatorExpr(c));
    sels.push(`/** ${code} — ${String(s.concept ?? "").replace(/\*\//g, "* /").replace(/[\r\n]+/g, " ").slice(0, 120)} (stability: ${s.stability}) */`);
    sels.push(`export const ${ident(code)} = (page: Page): Locator => ${[first, ...others.map((o) => `.or(${o})`)].join("")};`);
  }
  const entries = Object.keys(atlas.selectors).map((c) => `  ${q(c)}: ${ident(c)},`);
  const tpl = template === undefined ? loadTemplate(PO_TEMPLATE) : template;
  const fromTpl = fillOrWarn(PO_TEMPLATE, tpl, { scope: String(atlas.scope ?? ""), selectors: sels.join("\n"), atlas_entries: entries.join("\n") }, ["selectors", "atlas_entries"], warnings);
  if (fromTpl != null) return fromTpl;
  const L = [`// Page object generati da generate-atlas-po (scope ${atlas.scope}, DT-008): non modificare a mano.`, `import type { Page, Locator } from "@playwright/test";`, ""];
  L.push(...sels);
  L.push("", `export const ATLAS: Record<string, (page: Page) => Locator> = {`, ...entries, "};", "");
  return L.join("\n");
}

const HELP = `uso: node scripts/compile/generate-atlas-po.mjs --scope <S> [--customer C] [--ts] [--out-dir <dir>] [--workspace <dir>] [--json] [--help]

Dalle voci SEL dello scope (prodotto + cliente) genera la mappa dei resolver (catena DT-008 testid → role → label →
text → css; css solo per stability: fragile) e, con --ts, i page object Playwright per la corsia compilata.

Exit code: 0 ok · 1 argomenti non validi · 2 errore di sistema.`;

export function run(argv, env = process.env) {
  const { opts } = parseArgs(argv, { flags: ["ts"] });
  const asJson = !!opts.json;
  if (opts.help) { console.log(HELP); return 0; }
  if (!opts.scope || !/^[A-Z0-9]{3}$/.test(opts.scope)) return fail(asJson, 1, "richiesto --scope <S>");
  const { ws, customer } = workspaceCustomer(opts, env);
  try {
    const atlas = generateAtlas(ws, { customer, scope: opts.scope });
    const dir = opts["out-dir"] ? resolvePath(opts["out-dir"]) : customer ? join(ws, "customers", customer, "tests", "atlas") : join(ws, "product", "test-templates", "atlas");
    mkdirSync(dir, { recursive: true });
    const json = join(dir, `${opts.scope}.po.json`);
    writeFileAtomic(json, `${JSON.stringify(atlas, null, 2)}\n`);
    const files = [json];
    const warnings = [];
    if (opts.ts) { const ts = join(dir, `${opts.scope}.po.ts`); writeFileAtomic(ts, toPlaywright(atlas, { warnings })); files.push(ts); }
    for (const w of warnings) console.error(`avviso: ${w}`);
    console.log(asJson ? JSON.stringify({ ok: true, files, selectors: Object.keys(atlas.selectors).length, skipped: atlas.skipped, warnings }) : `${Object.keys(atlas.selectors).length} SEL → ${files.join(", ")}${atlas.skipped.length ? ` (esclusi: ${atlas.skipped.map((s) => s.code).join(", ")})` : ""}`);
    return 0;
  } catch (err) {
    return fail(asJson, 2, `errore di sistema: ${err?.message ?? err}`);
  }
}

if (isMain(import.meta.url)) process.exit(run(process.argv.slice(2)));
