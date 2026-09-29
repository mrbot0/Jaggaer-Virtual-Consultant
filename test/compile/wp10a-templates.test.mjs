// WP10a — templates/ (ruling del controller 1c, §31.2 e §43.3: spec, page object, contact sheet, report, Defect): gli
// script produttori usano il file di templates/ se c'è, altrimenti generano dal codice; i due percorsi producono lo stesso
// testo sul template distribuito. Un template senza i segnaposto obbligatori è ignorato (si genera dal codice).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ROOT } from "../helpers/hook-env.mjs";
import { loadTemplate, fillTemplate, fillParagraphs, stripHeader } from "../../scripts/lib/templates.mjs";
import { generateSpec } from "../../scripts/chrome/compile-plan.mjs";
import { toPlaywright } from "../../scripts/compile/generate-atlas-po.mjs";
import { renderContactSheet } from "../../scripts/evidence/contact-sheet.mjs";
import { defectDescription } from "../../scripts/xray/defect.mjs";
import { reportTemplate, fill as fillReport } from "../../scripts/report/build-report.mjs";

const FILES = ["playwright-spec.ts.tpl", "page-object.ts.tpl", "contact-sheet.html", "defect.md", "report-action.md", "report-test.md"];

test("templates/: i cinque documenti dell'albero §31.2/§43.3 esistono (spec, page object, contact sheet, report, Defect)", () => {
  for (const f of FILES) assert.ok(existsSync(join(ROOT, "templates", f)), f);
  for (const f of FILES) assert.ok(loadTemplate(f), f);
  assert.equal(loadTemplate("assente.md"), null);
});

test("libreria: sostituzione in un passaggio, riga vuota tolta, segnaposto obbligatori, paragrafi facoltativi", () => {
  assert.equal(fillTemplate("a {{x}} b\n{{y}}\nc\n", { x: "{{y}}", y: "" }), "a {{y}} b\nc\n");
  assert.equal(fillTemplate("a\n{{y}}\nc", { y: "1\n2" }), "a\n1\n2\nc");
  assert.equal(fillTemplate("{{x}}", {}, { required: ["body"] }), null);
  assert.equal(fillParagraphs("{{a}}\n\n{{b}}\n\n{{c}}\n", { a: "A", b: null, c: "C\n\nD" }), "A\n\nC\n\nD");
  assert.equal(stripHeader("{{!-- nota\nsu due righe --}}\nx"), "x");
  assert.equal(stripHeader("<!-- nota -->\nx"), "x");
});

const PLAN = { plan_id: "PLAN.ACME.0042", goal: "apertura della lista */ con\ncommento", steps: [
  { n: 1, verb: "NAVIGATE", action_class: "ACT-OBS", target: { url_pattern: "https://acme.example/p2p" }, expect: { page_sig: "p2p#lista" } },
  { n: 2, verb: "WAIT", action_class: "ACT-OBS", expect: { messages: [] } },
  { n: 3, verb: "VERIFY", check: "CHK-001", expect: { other: 1 } },
  { n: 4, verb: "CAPTURE" },
] };

test("spec Playwright (compile-plan): template = codice; nessun passo; template non valido ⇒ codice", () => {
  const ws = mkdtempSync(join(tmpdir(), "jvc-tpl-"));
  const viaTpl = generateSpec(ws, "ACME", PLAN);
  const viaCode = generateSpec(ws, "ACME", PLAN, { template: null });
  assert.equal(viaTpl.text, viaCode.text);
  assert.match(viaTpl.text, /^\/\/ plan-hash: [0-9a-f]{64}\n/);
  const empty = { ...PLAN, steps: [] };
  assert.equal(generateSpec(ws, "ACME", empty).text, generateSpec(ws, "ACME", empty, { template: null }).text);
  assert.equal(generateSpec(ws, "ACME", PLAN, { template: "// senza hash\n{{body}}" }).text, viaCode.text, "senza {{hash}} il template è ignorato");
});

test("page object (generate-atlas-po --ts): template = codice, anche senza SEL", () => {
  const atlas = { scope: "P2P", selectors: {
    "S.STD.P2P.SEL.0001": { concept: "Salva */ bozza", stability: "stable", chain: [{ kind: "testid", value: "save" }, { kind: "role", value: "button", name: "Salva" }] },
    "C.ACME.P2P.SEL.0002": { concept: "Riga", stability: "fragile", chain: [{ kind: "css", value: "tr.row" }] },
  } };
  assert.equal(toPlaywright(atlas), toPlaywright(atlas, { template: null }));
  const none = { scope: "CAT", selectors: {} };
  assert.equal(toPlaywright(none), toPlaywright(none, { template: null }));
});

test("contact sheet (evidence contact-sheet): template = codice, con escape HTML e caso senza evidenze", () => {
  const data = { release: "R25.3", customer: "ACME", runs: ["RUN.ACME.20260923.1000.CAT", "RUN.<b>"], tree: {
    CAT: { "NRT.ACME.CAT.POS.0001": [{ run: "RUN.ACME.20260923.1000.CAT", id: "EV-01", kind: "failure", step: 2, caption: "errore \"x\" & <y>", href: "CAT/a/1.png" }], "NRT.ACME.CAT.POS.0002": [] },
    P2P: { "NRT.ACME.P2P.NEG.0003": [{ run: "r", id: "EV-02", kind: "entry", step: 1, caption: "ok", href: "P2P/b/2.png" }] },
  } };
  const a = renderContactSheet(data);
  assert.equal(a, renderContactSheet(data, { template: null }));
  assert.match(a, /errore &quot;x&quot; &amp; &lt;y&gt;/);
  assert.match(a, /\(nessuna evidenza pubblicabile\)/);
  assert.ok(a.endsWith("</body></html>\n"));
});

test("Defect (xray defect): descrizione da template = codice, con paragrafi facoltativi assenti", () => {
  const full = { header_line: "Caso: NRT.ACME.CAT.POS.0001 · Run: R · Passo: 3", expected_line: "Atteso: a", observed_line: "Osservato: b\n\ncon riga vuota",
    steps_block: "Passi per riprodurre (minimi):\n1. NAVIGATE x", doc_line: "Riferimento documentale: DOC §2", precedent_line: "Precedente: JIRA-1 (fixed)",
    evidence_line: "Evidenze (profilo strict): EV-01.png", dossier_line: "Dossier: customers/ACME/runs/R/cases/NRT.ACME.CAT.POS.0001/" };
  assert.equal(defectDescription(full), defectDescription(full, { template: null }));
  const partial = { ...full, expected_line: null, steps_block: null, precedent_line: null };
  assert.equal(defectDescription(partial), defectDescription(partial, { template: null }));
  assert.equal(defectDescription(partial, { template: null }).split("\n\n")[0], full.header_line);
});

test("report (build-report): template di templates/ = testo di riserva nel codice, per azione e test", () => {
  const values = { id: "RPT.ACME.20260923.0001", title: "t", run: null, release: "—", outcome: "SUCCESS" };
  for (const kind of ["action", "test"]) {
    const file = reportTemplate(kind);
    const code = reportTemplate(kind, { template: null });
    assert.equal(fillReport(file, values), fillReport(code, values), kind);
  }
});
