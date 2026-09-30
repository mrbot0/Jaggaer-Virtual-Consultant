// evidence select (F5, §27.5, DT-009): quali evidenze catturate vanno in quale sink.
//
//   Punti (capture.mjs KINDS, sette tipi): entry · input · transition · assertion · integration · failure · result
//   (result ≙ snapshot nel dominio di DT-009). Per ogni evidenza registrata (runs/<RUN>/cases/<caso>/evidence/<nn>.yaml,
//   metadati EVD scritti da chrome/capture record): DT-009 con point_kind, required_by_action (evidence_min della classe
//   d'azione del passo, catalogo §29.4), cited_by_finding (punto dichiarato dal piano o passo con divergenza nel
//   checkpoint), duplicate (stesso sha256 già in lista); in lista se score ≥ 0.5; `failure` SEMPRE in lista.
//   Sink: dossier = tutte le selezionate (anche non pubblicabili: restano lì); desk = selezionate pubblicabili;
//   xray = selezionate pubblicabili con profilo strict (§27.5: strict imposto su Jira), al più `xrayCap` per caso, i
//   failure per primi.
//
//   selectEvidence(ws, { customer, run, xrayCap = 5 }) → { run, cases: { <caso>: { scope, dossier[], desk[], xray[], rejected[] } } }
//
// CLI: node scripts/evidence/select.mjs --run <RUN> [--xray-cap 5] [--customer C] [--workspace <dir>] [--json]
//      scrive runs/<RUN>/evidence-selection.yaml
// Exit: 0 ok · 1 argomenti · 2 errore di sistema.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { parseArgs, fail } from "../lib/args.mjs";
import { isMain } from "../lib/is-main.mjs";
import { writeFileAtomic } from "../../hooks/lib/fsx.mjs";
import { runRefusal } from "../lib/run-code.mjs";
import { evaluate, loadTable } from "../decide/dt-eval.mjs";
import { loadCatalog } from "../decide/validate-plan.mjs";
import { workspaceCustomer } from "../run/fixtures.mjs";

export class EvidenceError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
export const POINT_KINDS = ["entry", "input", "transition", "assertion", "integration", "failure", "result"];
const DT009_KIND = { entry: "entry", input: "input", transition: "transition", assertion: "assertion", integration: "integration", failure: "failure", result: "snapshot" };
const EVIDENCE_MIN_ALIAS = { risultato: "result", snapshot: "result" };

const readYaml = (f) => { try { return YAML.parse(readFileSync(f, "utf8")); } catch { return null; } };
function plansOf(runDir) {
  const out = new Map();
  const visit = (d, depth) => {
    if (depth > 4 || !existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory() && !["evidence", "checkpoints", "snapshots"].includes(e.name)) visit(p, depth + 1);
      else if (e.isFile() && /plan\.json$/.test(e.name)) { try { const pl = JSON.parse(readFileSync(p, "utf8")); if (pl?.plan_id) out.set(pl.plan_id, pl); } catch { /* ignorato */ } }
    }
  };
  visit(runDir, 0);
  return out;
}
function divergentSteps(runDir) {
  const d = join(runDir, "checkpoints");
  const out = new Set();
  if (!existsSync(d)) return out;
  for (const f of readdirSync(d).filter((x) => /^\d+\.json$/.test(x))) { try { const c = JSON.parse(readFileSync(join(d, f), "utf8")); if ((c.divergences ?? []).length || c.status === "surprise") out.add(`${c.plan_id}#${c.step}`); } catch { /* ignorato */ } }
  return out;
}

export function loadEvidence(ws, customer, run) {
  const base = join(ws, "customers", customer, "runs", run, "cases");
  const out = [];
  if (!existsSync(base)) return out;
  for (const c of readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()) {
    const ed = join(base, c, "evidence");
    if (!existsSync(ed)) continue;
    for (const f of readdirSync(ed).filter((x) => /^\d+\.yaml$/.test(x)).sort()) {
      const ev = readYaml(join(ed, f));
      if (ev?.type === "EVD") out.push({ ...ev, case: c, meta: `runs/${run}/cases/${c}/evidence/${f}` });
    }
  }
  return out;
}

export function selectEvidence(ws, { customer, run, xrayCap = 5 }) {
  const bad = runRefusal(ws, customer, run);
  if (bad) throw new EvidenceError(1, bad);
  const runDir = join(ws, "customers", customer, "runs", run);
  const plans = plansOf(runDir);
  const diverging = divergentSteps(runDir);
  const catalog = loadCatalog();
  const table = loadTable("DT-009");
  const cases = {};
  for (const ev of loadEvidence(ws, customer, run)) {
    const c = (cases[ev.case] ??= { scope: /^NRT\.[A-Z0-9]{3,4}\.([A-Z0-9]{3})\./.exec(ev.case)?.[1] ?? ev.scope ?? "XSC", dossier: [], desk: [], xray: [], rejected: [], _seen: new Set() });
    if (!POINT_KINDS.includes(ev.kind)) { c.rejected.push({ id: ev.id, reason: `tipo di punto ${ev.kind} fuori dai sette (§27.5)` }); continue; }
    const plan = ev.plan ? plans.get(ev.plan) : null;
    const step = plan?.steps?.find((s) => s.n === ev.step) ?? null;
    const min = (catalog.get(step?.action_class)?.evidence_min ?? []).map((k) => EVIDENCE_MIN_ALIAS[k] ?? k);
    const declared = (plan?.evidence ?? []).some((e) => e.at === ev.step);
    const inputs = { point_kind: DT009_KIND[ev.kind], required_by_action: min.includes(ev.kind), cited_by_finding: declared || diverging.has(`${ev.plan}#${ev.step}`), duplicate: c._seen.has(ev.sha256) };
    const dec = evaluate(table, inputs);
    const always = ev.kind === "failure";
    if (!always && dec.score < 0.5) { c.rejected.push({ id: ev.id, reason: `DT-009 ${dec.score} < 0.5`, score: dec.score }); continue; }
    c._seen.add(ev.sha256);
    const entry = { id: ev.id, kind: ev.kind, step: ev.step ?? null, file: ev.file, meta: ev.meta, caption: ev.caption ?? "", score: always ? 1 : dec.score, profile: ev.profile, publishable: ev.publishable === true };
    c.dossier.push(entry);
    if (entry.publishable) c.desk.push(entry);
    else c.rejected.push({ id: ev.id, reason: `non pubblicabile (${ev.not_publishable_reason ?? "maschere"}): resta nel dossier`, sink: "desk/xray" });
    if (entry.publishable && ev.profile === "strict") c.xray.push(entry);
    else if (entry.publishable) c.rejected.push({ id: ev.id, reason: "profilo non strict: fuori da Xray (§27.5)", sink: "xray" });
  }
  for (const c of Object.values(cases)) {
    delete c._seen;
    const byPriority = [...c.xray].sort((a, b) => (b.kind === "failure") - (a.kind === "failure") || b.score - a.score || (a.step ?? 0) - (b.step ?? 0));
    const keep = new Set(byPriority.slice(0, xrayCap).map((e) => e.id));
    for (const e of c.xray.filter((x) => !keep.has(x.id))) c.rejected.push({ id: e.id, reason: `oltre il tetto di ${xrayCap} allegati Xray per caso`, sink: "xray" });
    c.xray = c.xray.filter((x) => keep.has(x.id));
  }
  return { run, xray_cap: xrayCap, cases };
}

const HELP = `uso: node scripts/evidence/select.mjs --run <RUN> [--xray-cap 5] [--customer C] [--workspace <dir>] [--json] [--help]

Selezione delle evidenze del run con DT-009 (sette tipi di punto, failure sempre): dossier (tutte), desk (pubblicabili),
xray (pubblicabili, profilo strict, al più --xray-cap per caso). Scrive runs/<RUN>/evidence-selection.yaml.

Exit code: 0 ok · 1 argomenti · 2 errore di sistema.`;

export function run(argv, env = process.env) {
  const { opts } = parseArgs(argv);
  const asJson = !!opts.json;
  if (opts.help) { console.log(HELP); return 0; }
  if (!opts.run) return fail(asJson, 1, "richiesto --run <RUN>");
  const { ws, customer } = workspaceCustomer(opts, env);
  if (!customer) return fail(asJson, 1, "cliente non determinato: --customer <C>");
  try {
    const r = selectEvidence(ws, { customer, run: opts.run, xrayCap: opts["xray-cap"] != null ? Number(opts["xray-cap"]) : 5 });
    const file = `runs/${opts.run}/evidence-selection.yaml`;
    writeFileAtomic(join(ws, "customers", customer, file), YAML.stringify(r));
    console.log(asJson ? JSON.stringify({ ok: true, file, ...r }) : `${Object.keys(r.cases).length} casi → ${file}`);
    return 0;
  } catch (err) {
    if (err instanceof EvidenceError) return fail(asJson, err.code, err.message);
    return fail(asJson, 2, `errore di sistema: ${err?.message ?? err}`);
  }
}

if (isMain(import.meta.url)) process.exit(run(process.argv.slice(2)));
