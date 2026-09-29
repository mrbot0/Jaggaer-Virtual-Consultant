// xray defect (§27.5, §30.1, §30.4 defect-reporter, ADR-18/27): dal finding al Defect — MAI un Incident.
//   - classi ammesse (DT-001): product-defect · regression · config-drift · baseline-change; environment (ERROR-ENVIRONMENT:
//     mai un Defect), test-defect (healing, PR) ed expected-change (si aggiorna il test) ⇒ rifiuto; un
//     EXPECTED-ERROR-AS-SUCCESS è un successo ⇒ rifiuto;
//   - titolo "[<SCOPE>] <sintesi>" e, se il precedente è un Defect chiuso come fixed, "— regression of <KEY> (fixed in
//     <release>)"; il precedente si collega (links.regression);
//   - descrizione con passi MINIMI (dal piano del caso fino al passo del fallimento), atteso/osservato, riferimento
//     documentale, evidenze; testo redatto con profilo strict; il dominio analitico non si cita (§1.1: rifiuto);
//   - allegati: solo evidenze del caso pubblicabili con profilo strict (sink xray di DT-009, o quelle indicate dal
//     finding se strict); etichetta scope:<id>; tipo da config/xray.yaml defects.issue_type; assegnatario dal registro
//     (defects.assignee_by_scope).
//   Scrive customers/<C>/runs/<RUN>/defects/<id>.json; con --publish lo apre con l'AlmAdapter (rete giù ⇒ coda offline).
//
// CLI: node scripts/xray/defect.mjs (--finding <file.yaml> | case=<NRT…> run=<RUN> step=<n> summary=<testo>
//        [expected=…] [observed=…] [classification=…] [doc=… section=…] [precedent=<KEY> precedent_status=fixed
//        fixed_in=<R>] [evidence=EV-04,EV-06] [id=F-003]) [--publish] [--customer C] [--workspace <dir>] [--json]
// Exit: 0 costruito (e aperto o in coda) · 1 argomenti · 2 errore di sistema · 3 rifiuto (classe, dominio, ALM).
import { readFileSync, mkdirSync } from "node:fs";
import { join, resolve as resolvePath, extname } from "node:path";
import YAML from "yaml";
import { parseArgs } from "../lib/args.mjs";
import { isMain } from "../lib/is-main.mjs";
import { runRefusal } from "../lib/run-code.mjs";
import { writeFileAtomic } from "../../hooks/lib/fsx.mjs";
import { BOUNDARY_RULES } from "../kb/validate-boundary.mjs";
import { selectEvidence } from "../evidence/select.mjs";
import { refusedIssueType, strictText, ISSUE_KEY } from "../../mcp/alm-server/adapter.mjs";
import { contentTypeOf } from "../../mcp/alm-server/payload.mjs";
import { withQueue } from "../../mcp/alm-server/queue.mjs";
import { XrayError, xrayContext, recordCreated, audit, failWith, kv } from "./common.mjs";
import { loadTemplate, fillOrWarn } from "../lib/templates.mjs";

export const DEFECT_CLASSES = ["product-defect", "regression", "config-drift", "baseline-change"];
const NOT_DEFECT = { "environment": "un errore d'ambiente (ERROR-ENVIRONMENT) non è mai un Defect (§29.9): retry, poi blocked", "test-defect": "un difetto del test si ripara (test-mechanic, PR di healing), non è un Defect del prodotto (§30.4)", "expected-change": "un cambiamento atteso aggiorna il test, non apre un Defect (§30.1)" };
const CASE_RE = /^NRT\.([A-Z0-9]{3,4})\.([A-Z0-9]{3})\.[A-Z]{3}\.\d{4}$/;
const KB_RULES = BOUNDARY_RULES.filter((r) => r.dir === "kb").map((r) => new RegExp(r.re.source, `${r.re.flags.replace("g", "")}i`));
const MAX_STEPS = 12;

export function loadFinding(opts, positional, ws) {
  const pairs = kv(positional);
  let f = {};
  if (opts.finding) {
    const file = resolvePath(ws, opts.finding);
    try { f = YAML.parse(readFileSync(file, "utf8")) ?? {}; } catch (err) { throw new XrayError(1, `finding illeggibile: ${opts.finding} (${String(err.message).slice(0, 80)})`); }
  }
  const p = { ...pairs };
  if (p.precedent) p.precedent = { key: p.precedent, status: p.precedent_status ?? null, fixed_in: p.fixed_in ?? null };
  if (p.doc) p.doc = { doc: p.doc, section: p.section ?? null };
  if (p.evidence) p.evidence = p.evidence.split(",").map((x) => x.trim()).filter(Boolean);
  for (const k of ["precedent_status", "fixed_in", "section"]) delete p[k];
  return { ...f, ...p };
}

function boundary(text) {
  for (const re of KB_RULES) { const m = re.exec(text); if (m) return m[0]; }
  return null;
}

// Passi minimi: dal piano del caso, fino al passo del fallimento (incluso), al più MAX_STEPS.
function minimalSteps(plan, step) {
  const steps = (plan?.steps ?? []).filter((s) => Number.isInteger(s.n) && (!step || s.n <= step));
  return steps.slice(-MAX_STEPS).map((s) => `${s.n}. ${[s.verb, s.note ?? s.target ?? "", s.data != null && !/^\{\{.*\}\}$/.test(String(s.data)) ? `«${s.data}»` : ""].filter(Boolean).join(" ")}`);
}

// Descrizione del Defect dalle sue parti (una per paragrafo, null = assente). WP10a: templates/defect.md (§31.2) se
// presente e con {{header_line}} e {{dossier_line}} (ordine e testo fisso dei paragrafi; un paragrafo vuoto sparisce);
// altrimenti dal codice, stesso testo. template: undefined = il file di templates/, null = dal codice, stringa = quel
// template (test). Il chiamante applica poi la redazione strict e il controllo di confine.
export const DEFECT_TEMPLATE = "defect.md";
export const DEFECT_PARTS = ["header_line", "expected_line", "observed_line", "steps_block", "doc_line", "precedent_line", "evidence_line", "dossier_line"];
export function defectDescription(parts, { template, warnings = null } = {}) {
  const tpl = template === undefined ? loadTemplate(DEFECT_TEMPLATE) : template;
  const fromTpl = fillOrWarn(DEFECT_TEMPLATE, tpl, parts, ["header_line", "dossier_line"], warnings, { paragraphs: true });
  if (fromTpl != null) return fromTpl;
  return DEFECT_PARTS.map((k) => parts[k]).filter(Boolean).join("\n\n");
}

export async function buildDefect(ws, { customer, config, finding }) {
  const caseId = finding.case;
  const m = CASE_RE.exec(String(caseId ?? ""));
  if (!m || m[1] !== customer) throw new XrayError(1, `caso del finding non valido per ${customer}: ${JSON.stringify(caseId)}`);
  const scope = m[2];
  const run = finding.run;
  const bad = runRefusal(ws, customer, run);
  if (bad) throw new XrayError(1, bad);
  const cls = finding.classification ?? null;
  if (cls && NOT_DEFECT[cls]) throw new XrayError(3, `${cls}: ${NOT_DEFECT[cls]}`);
  if (cls && !DEFECT_CLASSES.includes(cls)) throw new XrayError(1, `classe del finding non riconosciuta: ${cls} (${[...DEFECT_CLASSES, ...Object.keys(NOT_DEFECT)].join(", ")})`);
  if (finding.outcome === "ERROR-ENVIRONMENT") throw new XrayError(3, NOT_DEFECT.environment);
  if (finding.outcome && finding.outcome !== "ERROR-BLOCKING") throw new XrayError(3, `esito ${finding.outcome}: solo un ERROR-BLOCKING produce un Defect (§29.9)`);
  if (typeof finding.summary !== "string" || !finding.summary.trim()) throw new XrayError(1, "finding senza summary");
  const type = config.defects?.issue_type ?? "Bug";
  const refused = refusedIssueType(type);
  if (refused) throw new XrayError(3, refused);
  const step = finding.step != null ? Number(finding.step) : null;
  if (step != null && !(Number.isInteger(step) && step > 0)) throw new XrayError(1, `passo non valido: ${finding.step}`);
  const prec = finding.precedent?.key ? finding.precedent : null;
  if (prec && !ISSUE_KEY.test(prec.key)) throw new XrayError(1, `precedente non valido: ${prec.key}`);
  const warnings = [];
  if (cls === "regression" && !prec) warnings.push("classe regression senza precedente: il riferimento al Defect precedente manca (§27.5)");
  const fixed = prec && /^(fixed|risolto|chiuso|closed|done)$/i.test(String(prec.status ?? ""));
  const title = `[${scope}] ${finding.summary.trim()}${fixed ? ` — regression of ${prec.key}${prec.fixed_in ? ` (fixed in ${prec.fixed_in})` : ""}` : ""}`;
  const plan = (() => { try { return JSON.parse(readFileSync(join(ws, "customers", customer, "runs", run, "cases", caseId, "plan.json"), "utf8")); } catch { return null; } })();
  if (!plan) warnings.push(`plan.json del caso assente: passi per riprodurre non disponibili`);
  // evidenze strict: il sink xray di DT-009 per il caso; con evidence[] del finding, solo quelle (se strict)
  const sel = selectEvidence(ws, { customer, run, xrayCap: config.attachments_cap ?? 5 }).cases[caseId]?.xray ?? [];
  const wanted = Array.isArray(finding.evidence) && finding.evidence.length ? finding.evidence : null;
  const chosen = wanted ? sel.filter((e) => wanted.includes(e.id)) : sel;
  if (wanted) for (const id of wanted.filter((w) => !sel.some((e) => e.id === w))) warnings.push(`evidenza ${id} esclusa: non pubblicabile con profilo strict (o fuori dal tetto) — resta nel dossier`);
  const attachments = chosen.map((e) => ({ file: e.file, filename: `${e.id}${extname(e.file)}`, contentType: contentTypeOf(e.file) }));
  const docRef = finding.doc ? (typeof finding.doc === "string" ? finding.doc : `${finding.doc.doc}${finding.doc.section ? ` §${finding.doc.section}` : ""}`) : null;
  if (!docRef) warnings.push("finding senza riferimento documentale (§30.4)");
  const parts = {
    header_line: `Caso: ${caseId} · Run: ${run}${step ? ` · Passo: ${step}` : ""}${cls ? ` · Classe: ${cls}` : ""}`,
    expected_line: finding.expected ? `Atteso: ${finding.expected}` : null,
    observed_line: finding.observed ? `Osservato: ${finding.observed}` : null,
    steps_block: plan ? `Passi per riprodurre (minimi):\n${minimalSteps(plan, step).join("\n")}` : null,
    doc_line: docRef ? `Riferimento documentale: ${docRef}` : null,
    precedent_line: prec ? `Precedente: ${prec.key}${prec.status ? ` (${prec.status}${prec.fixed_in ? `, fixed in ${prec.fixed_in}` : ""})` : ""}${fixed ? " — regressione" : ""}` : null,
    evidence_line: attachments.length ? `Evidenze (profilo strict): ${attachments.map((a) => a.filename).join(", ")}` : "Evidenze: nessuna pubblicabile con profilo strict (restano nel dossier)",
    dossier_line: `Dossier: customers/${customer}/runs/${run}/cases/${caseId}/`,
  };
  // la redazione strict e il controllo di confine valgono sul testo finale, anche da template
  const description = strictText(defectDescription(parts, { warnings }));
  const hit = boundary(`${title}\n${description}`);
  if (hit) throw new XrayError(3, `confine di dominio: il Defect non cita il dominio analitico (§1.1): "${hit}"`);
  const id = String(finding.id ?? `${caseId}.${step ?? "x"}`).replace(/[^A-Za-z0-9._-]/g, "_");
  const defect = { summary: strictText(title).slice(0, 250), description, scope, issue_type: type, labels: ["nrt"], precedent: prec ? { key: prec.key, fixed_in: prec.fixed_in ?? null } : null,
    assignee: config.defects?.assignee_by_scope?.[scope] ?? null, attachments };
  return { id, run, case: caseId, defect, warnings, file: `runs/${run}/defects/${id}.json` };
}

const HELP = `uso: node scripts/xray/defect.mjs (--finding <file.yaml> | case=<NRT…> run=<RUN> step=<n> summary=<testo> [expected=…]
       [observed=…] [classification=product-defect|regression|config-drift|baseline-change] [doc=… section=…]
       [precedent=<KEY> precedent_status=fixed fixed_in=<R>] [evidence=EV-04,EV-06] [id=F-003])
       [--publish] [--customer C] [--workspace <dir>] [--json] [--help]

Costruisce il Defect dal finding (mai un Incident): evidenze strict, passi minimi, riferimento documentale, "regression
of <KEY> (fixed in <R>)" se il precedente è fixed, etichetta scope:<id>. Scrive runs/<RUN>/defects/<id>.json;
--publish lo apre (rete giù ⇒ coda offline).

Exit code: 0 ok · 1 argomenti · 2 errore di sistema · 3 rifiuto (classe, dominio, ALM).`;

export async function run(argv, env = process.env) {
  const { opts, positional } = parseArgs(argv, { flags: ["publish"] });
  const asJson = !!opts.json;
  if (opts.help) { console.log(HELP); return 0; }
  try {
    const c = await xrayContext(opts, env);
    const finding = loadFinding(opts, positional, c.ws);
    const d = await buildDefect(c.ws, { customer: c.customer, config: c.config, finding });
    const abs = join(c.ws, "customers", c.customer, d.file);
    mkdirSync(join(abs, ".."), { recursive: true });
    let published = null;
    if (opts.publish) {
      const { materializeAttachments } = await import("../../mcp/alm-server/payload.mjs");
      const attachments = await materializeAttachments(c.ws, c.customer, d.defect.attachments);
      published = await withQueue(c.config, c.queue, async () => { await c.adapter.authenticate(); return c.adapter.createDefect({ ...d.defect, attachments }); }, { op: "defect", run: d.run, payload: { defect: d.defect } });
      if (published.key) await recordCreated(c.ws, env, published.key, "defect", "xray-defect");
      await audit(c.ws, env, c.customer, { action: "xray-defect", run: d.run, case: d.case, scope: d.defect.scope, key: published.key ?? null, queued: !!published.queued }, "xray-defect");
    }
    writeFileAtomic(abs, `${JSON.stringify({ id: d.id, run: d.run, case: d.case, defect: d.defect, warnings: d.warnings, ...(published ? { published } : {}) }, null, 2)}\n`);
    console.log(asJson ? JSON.stringify({ ok: true, file: d.file, summary: d.defect.summary, attachments: d.defect.attachments.length, warnings: d.warnings, ...(published ? { published } : {}) })
      : [`${d.file}: ${d.defect.summary}`, published ? (published.queued ? `  in coda offline (${published.id})` : `  aperto ${published.key}`) : "  costruito (non aperto: --publish)", ...d.warnings.map((w) => `  avviso: ${w}`)].join("\n"));
    return 0;
  } catch (err) { return failWith(asJson, err); }
}

// exitCode, non process.exit: su Windows (Node 24) process.exit dopo più fetch termina il processo con 0xC0000409
if (isMain(import.meta.url)) run(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (e) => { console.error(e); process.exitCode = 2; });
