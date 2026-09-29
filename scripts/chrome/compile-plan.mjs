// compile-plan (K6.8, §23.5, §27.4 — corsia COMPILATA, opzionale, mai il default): da un piano già verde
// ≥ 3 volte (runs/*/result.yaml con lo stesso hash) genera uno spec Playwright per la CI notturna.
// Target dalla catena di strategie dell'Atlas (DT-008): testid → role → label → css; css solo se la
// stabilità "fragile" è ammessa (--allow-fragile). L'hash del piano è nell'intestazione: un piano cambiato
// invalida lo spec (`compile-plan verify`). Solo generazione di testo: questo script NON importa playwright.
//
// CLI: compile-plan --plan <file> [--scope <S>] [--allow-fragile] [--min-green 3]
//      compile-plan verify --plan <file> --spec <file.spec.ts>
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { createHash } from "node:crypto";
import YAML from "yaml";
import { parseArgs, fail } from "../lib/args.mjs";
import { isMain } from "../lib/is-main.mjs";
import { canonical } from "../../hooks/lib/audit.mjs";
import { writeFileAtomic } from "../../hooks/lib/fsx.mjs";
import { selFile } from "./atlas.mjs";
import { locatorExpr } from "../compile/generate-atlas-po.mjs";
import { runResults } from "../lib/run-results.mjs";
import { loadTemplate, fillTemplate } from "../lib/templates.mjs";

export const MIN_GREEN = 3;
const GREEN = new Set(["green", "pass", "passed", "success"]);
export class CompileError extends Error { constructor(code, msg) { super(msg); this.code = code; } }

// Hash del piano: sha256 del JSON canonico (chiavi ordinate) — indipendente da formattazione e YAML/JSON.
export const planHash = (plan) => createHash("sha256").update(canonical(plan)).digest("hex");

// WP09b: anche runs/<RUN>/results/<plan_id>.yaml (un esito per piano nei run con più casi), scripts/lib/run-results.mjs
// WP09b giro 1 (M17): si conta per impronta (fingerprintOf: l'impronta del caso, uguale in ogni run anche con il prefisso
// NRT-<data>-<run> nei dati; per i piani senza impronta, l'hash del piano); un esito vale se una delle due coincide.
export const fingerprintOf = (plan) => plan?.fingerprint ?? planHash(plan);
// WP09b giro 2 (minore 1): l'impronta dichiarata dal piano non basta: almeno uno dei verdi contati deve avere il
// plan_hash del piano che si compila (un piano modificato dopo compile-case non eredita i verdi degli altri).
export function compileEligibility(ws, customer, plan) {
  const hash = planHash(plan);
  const key = fingerprintOf(plan);
  const res = runResults(ws, customer).filter((y) => (y.fingerprint === key || y.plan_hash === key) && GREEN.has(y.status));
  return { green: [...new Set(res.map((y) => y.run))].sort(), bound: res.some((y) => y.plan_hash === hash) };
}
export function greenRuns(ws, customer, key) {
  return [...new Set(runResults(ws, customer).filter((y) => (y.fingerprint === key || y.plan_hash === key) && GREEN.has(y.status)).map((y) => y.run))].sort();
}

const q = (s) => JSON.stringify(String(s));
function locatorFor(ws, customer, code, { allowFragile, atlas = null }) {
  // WP09b: con la mappa di generate-atlas-po (--atlas) la catena DT-008 si risolve con locator.or() (css solo se ammesso)
  const po = atlas?.selectors?.[code];
  if (po) {
    const chain = (po.chain ?? []).filter((c) => c.kind !== "css" || allowFragile);
    if (!chain.length) throw new CompileError(3, `${code}: solo strategia css nella mappa dell'Atlas: ammessa solo con --allow-fragile`);
    const [first, ...rest] = chain.map((c) => locatorExpr(c));
    return [first, ...rest.map((o) => `.or(${o})`)].join("");
  }
  const f = selFile(ws, code, customer);
  if (!f || !existsSync(f)) throw new CompileError(3, `${code} non è nell'Atlas: il piano non si compila`);
  const sel = YAML.parse(readFileSync(f, "utf8"));
  const strategies = Array.isArray(sel?.strategies) ? sel.strategies : [];
  const by = (k) => strategies.find((s) => s?.kind === k);
  if (by("testid")) return `page.getByTestId(${q(by("testid").value)})`;
  if (by("role")) { const s = by("role"); return `page.getByRole(${q(s.value ?? sel.role)}${s.name ? `, { name: ${q(s.name)} }` : ""})`; }
  if (by("label")) return `page.getByLabel(${q(by("label").value)})`;
  if (by("css")) {
    if (!allowFragile) throw new CompileError(3, `${code}: solo strategia css (stabilità ${sel.stability ?? "ignota"}): ammessa solo con --allow-fragile (stabilità fragile consentita)`);
    return `page.locator(${q(by("css").value)})`;
  }
  throw new CompileError(3, `${code}: nessuna strategia utilizzabile nell'Atlas`);
}

const reEsc = (s) => String(s).replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
function expectLines(ws, customer, step, target, opts) {
  const e = step.expect ?? {};
  const L = [];
  const loc = (code) => { try { return locatorFor(ws, customer, code, opts); } catch (err) { if (err.code === 3 && /non è nell'Atlas/.test(err.message)) return null; throw err; } };
  // WP07 giro 3: page_sig come letterale JSON (un a capo in un letterale regex sarebbe un errore di sintassi)
  if (e.page_sig) L.push(`await expect(page).toHaveURL(new RegExp(${q(reEsc(String(e.page_sig).split("#")[0]))}));`);
  for (const el of Array.isArray(e.elements) ? e.elements : []) {
    const code = typeof el === "string" ? el : el?.sel;
    const l = code ? loc(code) : null;
    if (!l) { L.push(`test.info().annotations.push({ type: "verifica omessa", description: ${q(`expect ${code ?? JSON.stringify(el)}: non risolto nell'Atlas`)} });`); continue; }
    L.push(`await expect(${l}).toBeVisible();`);
    if (el && typeof el === "object" && el.value !== undefined) L.push(typeof el.value === "boolean" ? `await expect(${l})${el.value ? "" : ".not"}.toBeChecked();` : `await expect(${l}).toHaveValue(${q(el.value)});`);
  }
  if (e.value !== undefined && target) L.push(/^(true|false)$/i.test(String(e.value)) ? `await expect(${target})${String(e.value).toLowerCase() === "true" ? "" : ".not"}.toBeChecked();` : `await expect(${target}).toHaveValue(${q(e.value)});`);
  if (e.toast) { const l = loc(e.toast); L.push(l ? `await expect(${l}).toBeVisible();` : `await expect(page.getByText(${q(e.toast)})).toBeVisible();`); }
  if (Array.isArray(e.messages)) {
    if (!e.messages.length) L.push(`await expect(page.getByRole("alert")).toHaveCount(0);`);
    for (const m of e.messages) L.push(`await expect(page.getByText(${q(m)})).toBeVisible();`);
  }
  for (const k of Object.keys(e).filter((x) => !["page_sig", "elements", "value", "toast", "messages"].includes(x))) L.push(`test.info().annotations.push({ type: "non compilato", description: ${q(`expect.${k}: resta alla corsia guidata`)} });`);
  return L;
}

// WP10a: templates/playwright-spec.ts.tpl (§31.2) se presente e con {{hash}} e {{body}}; altrimenti lo stesso testo dal
// codice. template: undefined = il file di templates/, null = dal codice, stringa = quel template (test).
export const SPEC_TEMPLATE = "playwright-spec.ts.tpl";
export function generateSpec(ws, customer, plan, { allowFragile = false, atlas = null, template } = {}) {
  const hash = planHash(plan);
  const body = [];
  for (const s of [...(plan.steps ?? [])].sort((a, b) => a.n - b.n)) {
    body.push(`  // passo ${oneLine(s.n)} ${oneLine(s.verb)} (${oneLine(s.action_class ?? "—")})`);
    if (s.verb === "ASK") throw new CompileError(3, `passo ${s.n}: ASK richiede una persona: il piano non si compila`);
    const target = typeof s.target === "string" ? locatorFor(ws, customer, s.target, { allowFragile, atlas }) : null;
    const d = s.data;
    const act = {
      NAVIGATE: () => (s.target?.url_pattern ? `await page.goto(${q(s.target.url_pattern)});` : `await ${target}.click();`),
      CLICK: () => `await ${target}.click();`, SAVE: () => `await ${target}.click();`, SUBMIT: () => `await ${target}.click();`,
      FILL: () => `await ${target}.fill(${q(d ?? "")});`,
      CHOOSE: () => `await ${target}.selectOption(${q(d ?? "")});`, SELECT: () => `await ${target}.selectOption(${q(d ?? "")});`,
      TOGGLE: () => `await ${target}.setChecked(${d === false || d === "false" ? "false" : "true"});`,
      UPLOAD: () => `await ${target}.setInputFiles(${q(d ?? "")});`,
      WAIT: () => (target ? `await ${target}.waitFor();` : `await page.waitForLoadState();`),
      READ: () => `await expect(${target}).toBeVisible();`,
      VERIFY: () => (target ? `await expect(${target}).toBeVisible();` : `test.info().annotations.push({ type: "VERIFY", description: ${q(`${s.check ?? ""}: asserzione del caso NRT`)} });`),
      CAPTURE: () => `await page.screenshot({ path: ${q(`evidence/${plan.plan_id}-${s.n}.png`)} });`,
    }[s.verb];
    if (!act) throw new CompileError(3, `passo ${s.n}: verbo ${s.verb} non compilabile`);
    body.push(`  ${act()}`);
    for (const l of expectLines(ws, customer, s, target, { allowFragile, atlas })) body.push(`  ${l}`);
  }
  const tpl = template === undefined ? loadTemplate(SPEC_TEMPLATE) : template;
  const title = `${oneLine(plan.plan_id)} — ${oneLine(plan.goal)}`;
  const fromTpl = tpl == null ? null : fillTemplate(tpl, { hash, plan_id: oneLine(plan.plan_id), goal: oneLine(plan.goal), test_title: q(title), body: body.join("\n") }, { required: ["hash", "body"] });
  if (fromTpl != null) return { hash, text: fromTpl };
  const text = [
    `// plan-hash: ${hash}`,
    `// ${oneLine(plan.plan_id)} — ${oneLine(plan.goal)}`,
    "// ATTENZIONE: lo spec ripete i passi che creano o modificano dati senza compensazioni registrate (step-check non",
    "// gira in CI): solo in sandbox, su dati di prova, con la pulizia a carico della pipeline (§27.4, §29.6).",
    "// Generato da scripts/chrome/compile-plan.mjs (corsia compilata, §27.4): non modificare. Un piano cambiato invalida",
    "// lo spec (compile-plan verify); l'Atlas resta la fonte dei target.",
    'import { test, expect } from "@playwright/test";',
    "",
    `test(${q(`${oneLine(plan.plan_id)} — ${oneLine(plan.goal)}`)}, async ({ page }) => {`,
    ...body,
    "});",
    "",
  ].join("\n");
  return { hash, text };
}

// Testo del piano in un commento dello spec: niente fine riga (CR, LF, U+2028/2029, U+0085), niente chiusure di
// commento — un goal scritto dall'agente non deve poter uscire dal commento in uno spec che la CI esegue fuori dai guard.
export function oneLine(v) { return String(v ?? "").replace(/[\r\n\v\f\u0085\u2028\u2029]+/g, " ").replace(/\*\//g, "* /").slice(0, 200); }

export function readSpecHash(text) { return /^\/\/ plan-hash: ([0-9a-f]{64})$/m.exec(String(text))?.[1] ?? null; }

async function loadPlan(ws, customer, rel) {
  const { loadPlanFile } = await import("../admin/approvals.mjs");
  const info = await loadPlanFile(ws, customer, rel);
  if (!info) throw new CompileError(1, `piano non trovato: ${rel}`);
  return info.plan;
}

const HELP = `uso: node scripts/chrome/compile-plan.mjs --plan <file> [--scope <S>] [--allow-fragile] [--min-green 3] [--customer <C>] [--atlas <S.po.json>]
       node scripts/chrome/compile-plan.mjs verify --plan <file> --spec <file.spec.ts>
       Opzioni: [--session <id>] [--workspace <dir>] [--json] [--help]

Corsia compilata (opzionale, §27.4): spec Playwright da un piano verde ≥ 3 volte, nell'Atlas la catena
testid → role → label → css (css solo con --allow-fragile). verify: lo spec vale solo per l'hash del piano.
Exit: 0 · 1 argomenti · 2 errore di sistema · 3 rifiuto (meno di 3 verdi, target non compilabile, spec invalidato).`;

export async function run(argv, env = process.env) {
  const { opts, positional } = parseArgs(argv, { flags: ["allow-fragile"] });
  const asJson = !!opts.json;
  if (opts.help) { console.log(HELP); return 0; }
  const ws = resolvePath(opts.workspace || env.JVC_WORKSPACE || env.CLAUDE_PROJECT_DIR || process.cwd());
  try {
    if (!opts.plan) return fail(asJson, 1, "richiesto --plan");
    let customer = opts.customer;
    let scope = opts.scope;
    if (!customer || !scope) {
      const { resolveSessionId, loadSession } = await import("../admin/session.mjs");
      const sid = resolveSessionId({ workspace: ws, arg: opts.session, env });
      const s = sid ? loadSession(ws, sid).session : null;
      customer ??= s?.customer;
      scope ??= s?.scope;
    }
    if (!customer) return fail(asJson, 1, "cliente non risolto: --customer <C>");
    const plan = await loadPlan(ws, customer, opts.plan);
    scope ??= /^[SCL]\.[A-Z0-9]{3,4}\.([A-Z0-9]{3})\./.exec(plan.subject ?? "")?.[1] ?? "XSC";
    if (positional[0] === "verify") {
      if (!opts.spec) return fail(asJson, 1, "verify richiede --spec");
      const specHash = readSpecHash(readFileSync(resolvePath(ws, opts.spec), "utf8"));
      const hash = planHash(plan);
      if (specHash !== hash) return fail(asJson, 3, `spec invalidato: hash del piano ${hash.slice(0, 12)}… ≠ hash dello spec ${String(specHash).slice(0, 12)}… (il piano è cambiato: ricompila dopo 3 nuove esecuzioni verdi)`, { valid: false });
      console.log(asJson ? JSON.stringify({ ok: true, valid: true, hash }) : "spec valido");
      return 0;
    }
    const hash = planHash(plan);
    const min = opts["min-green"] ? Math.max(MIN_GREEN, Number(opts["min-green"])) : MIN_GREEN;
    const { green, bound } = compileEligibility(ws, customer, plan);
    if (green.length < min) return fail(asJson, 3, `${green.length} esecuzioni verdi con questa impronta: ne servono almeno ${min} per compilare (§27.4)`, { green });
    if (!bound) return fail(asJson, 3, `nessuna delle esecuzioni verdi è di questo piano (plan_hash ${hash.slice(0, 12)}…): il piano è cambiato dopo l'esecuzione, rieseguilo`, { green });
    const { text } = generateSpec(ws, customer, plan, { allowFragile: !!opts["allow-fragile"], atlas: opts.atlas ? JSON.parse(readFileSync(resolvePath(ws, opts.atlas), "utf8")) : null });
    const rel = `customers/${customer}/tests/specs/${scope}/${plan.plan_id}.spec.ts`;
    mkdirSync(join(ws, "customers", customer, "tests", "specs", scope), { recursive: true });
    writeFileAtomic(join(ws, rel), text);
    console.log(asJson ? JSON.stringify({ ok: true, spec: rel, hash, green }) : rel);
    return 0;
  } catch (err) {
    if (err instanceof CompileError) return fail(asJson, err.code, err.message);
    return fail(asJson, 2, `errore di sistema: ${err?.message ?? err}`);
  }
}

if (isMain(import.meta.url)) run(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(e); process.exit(2); });
