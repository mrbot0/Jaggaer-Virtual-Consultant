// WP09a-D — schemi di estrazione per tipo di unità (§19.10) e pre-estrazione T0 (extract.mjs):
// golden "procedura → attore/passi/atteso", regola dal parser deontico, candidati di documento dagli export
// di configurazione (FLW/CFG) e dalle spec di integrazione (INT + FLD con lineage), piano entro il budget.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import YAML from "yaml";
import { validateWith } from "../../scripts/lib/schemas.mjs";
import { segmentUnits } from "../../scripts/ingest/segment.mjs";
import { harvest } from "../../scripts/ingest/harvest.mjs";
import { extractUnit, extractDocument, planLlm, ruleSubject, stepParts, writeRaw, DOC_BUDGET } from "../../scripts/ingest/extract.mjs";
import { lineageRelations, normalizeIntMappings } from "../../scripts/kb/chains.mjs";

const SCHEMAS = new URL("../../schemas/unit-extraction/", import.meta.url);
const fixDir = new URL("../fixtures/docs/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const docs = Object.fromEntries(harvest(fixDir, { write: false }).docs.map((d) => [d.meta.source, d]));
const doc1 = (paragraphs, tables = []) => ({ id: "t", title: "T", format: "docx", sections: [{ path: "1", title: "Configurare il profilo di import", level: 1, page: 3, paragraphs, tables, figures: [] }] });

test("schemas/unit-extraction: i sette schemi (procedura, riga-tabella-campi, regola, nota, definizione, tracciato, decisione) sono JSON Schema 2020-12 con source_unit", () => {
  const files = readdirSync(SCHEMAS).sort();
  assert.deepEqual(files, ["decisione", "definizione", "nota", "procedura", "regola", "riga-tabella-campi", "tracciato"].map((x) => `${x}.schema.json`));
  for (const f of files) {
    const s = JSON.parse(readFileSync(new URL(f, SCHEMAS), "utf8"));
    assert.equal(s.$schema, "https://json-schema.org/draft/2020-12/schema");
    assert.ok(s.required.includes("source_unit"), f);
  }
  assert.ok(!validateWith("unit-extraction/procedura.schema.json", { passi: [], source_unit: "U.X.0001" }).ok, "una procedura senza passi non è valida");
});

test("golden: procedura → attore, passi (verbo, oggetto, valore), risultato atteso; il trigger manca ⇒ needs_llm", () => {
  const d = doc1(["L'amministratore configura il profilo di import:", "1. Aprire Amministrazione.", "2. Selezionare il profilo \"Listini storici\".", "3. Impostare strict_import: false.", "4. Fare clic su \"Salva\": la configurazione viene salvata."]);
  const { units } = segmentUnits(d, { docCode: "S.STD.XSC.DOC.0001" });
  const proc = units.find((u) => u.type === "procedura");
  const r = extractUnit(proc, { genre: "d'uso", f1: "doc-standard" });
  assert.deepEqual({ attore: r.extraction.attore, passi: r.extraction.passi, risultato_atteso: r.extraction.risultato_atteso }, {
    attore: "L'amministratore",
    passi: [
      { n: 1, verbo: "aprire", oggetto: "Amministrazione", valore: null },
      { n: 2, verbo: "selezionare", oggetto: "il profilo \"Listini storici\"", valore: "Listini storici" },
      { n: 3, verbo: "impostare", oggetto: "strict_import: false", valore: "false" },
      { n: 4, verbo: "clic", oggetto: "\"Salva\": la configurazione viene salvata", valore: "Salva" },
    ],
    risultato_atteso: "Fare clic su \"Salva\": la configurazione viene salvata.",
  });
  assert.ok(validateWith("unit-extraction/procedura.schema.json", r.extraction).ok);
  assert.equal(r.needs_llm, true);
  assert.deepEqual(r.missing, ["trigger"]);
  assert.deepEqual(r.facets, { F1: "doc-standard", F15: "d'uso" });
  assert.equal(r.raw_id, proc.id.replace(/^U\./, "R."));
  assert.deepEqual(r.candidates, ["CFP", "FLW"], "verbi di configurazione ⇒ CFP prima di FLW");
});

test("regola: modalità, condizione, qualificatori e conseguenza dal parser deontico, soggetto lessicale; ambigua ⇒ residuo ambiguous senza mandatory", () => {
  const { units } = segmentUnits(doc1(["Se la categoria è servizi, il campo Data di consegna deve essere compilato.", "Il centro di costo dovrebbe essere obbligatorio salvo diversa indicazione del buyer."]));
  const [a, b] = units.filter((u) => u.type === "regola").map((u) => extractUnit(u, {}));
  assert.equal(a.extraction.modality, "obbligo-condizionale");
  assert.equal(a.extraction.subject, "Data di consegna");
  assert.equal(a.extraction.mandatory.kind, "conditional");
  assert.equal(a.extraction.consequence, "FLD.mandatory");
  assert.deepEqual(a.candidates, ["FLD"]);
  assert.ok(validateWith("unit-extraction/regola.schema.json", a.extraction).ok);
  assert.equal(b.extraction.modality, "ambiguo");
  assert.equal(b.extraction.mandatory, undefined);
  assert.equal(b.residue.class, "ambiguous");
  assert.equal(ruleSubject("The Cost Center field must be filled."), "Cost Center");
  assert.equal(ruleSubject("Il fornitore deve esistere in SAP."), "fornitore");
  assert.deepEqual(stepParts("Click on Save", 1), { n: 1, verbo: "clic", oggetto: "Save", valore: null });
});

test("riga-tabella-campi = riga grezza di field-table; definizione, decisione, tracciato validi contro i loro schemi", () => {
  const { units } = segmentUnits(docs["sample.docx"], { docCode: "C.ACME.XSC.DOC.0007" });
  const row = extractUnit(units.find((u) => u.type === "riga-tabella-campi"), { genre: "tecnica" });
  assert.deepEqual([row.extraction.label, row.extraction.technical_name, row.extraction.mandatory_text], ["Centro di costo", "REQ_HDR_COST_CENTER", "Sì"]);
  assert.equal(row.needs_llm, false);
  assert.ok(validateWith("unit-extraction/riga-tabella-campi.schema.json", row.extraction).ok);
  const def = extractUnit(units.find((u) => u.type === "definizione"), {});
  assert.equal(def.extraction.term, "centro di costo");
  assert.ok(validateWith("unit-extraction/definizione.schema.json", def.extraction).ok);
  const mail = segmentUnits(docs["thread.eml"]).units;
  const dec = extractUnit(mail.find((u) => u.type === "decisione"), {});
  assert.equal(dec.extraction.author, "Laura Bianchi <laura@example.invalid>");
  assert.ok(validateWith("unit-extraction/decisione.schema.json", dec.extraction).ok);
  const xsd = segmentUnits(docs["sample.xsd"]).units;
  const tr = extractUnit(xsd.find((u) => u.record?.name === "OrderNumber"), {});
  assert.deepEqual([tr.extraction.required, tr.extraction.max_length, tr.extraction.pattern], [true, 20, "PO-[0-9]+"]);
  assert.ok(validateWith("unit-extraction/tracciato.schema.json", tr.extraction).ok);
  assert.equal(extractUnit(units.find((u) => u.type === "esempio"), {}), null, "i tipi di contesto non diventano item grezzi");
});

test("export di configurazione → FLW (attività in ordine di transizione) e CFG con current_state; spec di integrazione → INT con mapping verso i FLD e lineage.required_by", () => {
  const wf = docs["workflow_definition_demo.xml"];
  const r = extractDocument(wf, segmentUnits(wf).units, { profile: { id: "S.STD.XSC.DOC.0003", kind: "config-export", genre: "tecnica", facets: { F1: "esecuzione-config" } } });
  const flw = r.items.find((x) => x.candidates[0] === "FLW");
  assert.deepEqual(flw.extraction.steps.map((s) => s.attivita), ["Start", "Approve Manager", "End"]);
  assert.equal(flw.extraction.steps[1].condizione, "[Document.Total] > 50000");
  const cfg = r.items.find((x) => x.candidates[0] === "CFG" && x.extraction.parameter === "Version");
  // giro 1 (M9): observed_at = data dell'export (qui la data del file, dichiarata in meta.date_source), non più null
  assert.deepEqual({ ...cfg.extraction.current_state, observed_at: "<data>" }, { value: "3", observed_at: "<data>", source: "config-export" });
  assert.match(cfg.extraction.current_state.observed_at, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(wf.meta.date_source, "mtime");
  assert.equal(cfg.confidence, 0.95);
  const w = docs["sample.wsdl"];
  const units = segmentUnits(w).units;
  const s = extractDocument(w, units, { profile: { id: "S.STD.XSC.DOC.0004", kind: "spec-integrazione", genre: "tecnica", facets: { F1: "spec-integrazione-formale" } } });
  const int = s.items.find((x) => x.candidates[0] === "INT" && x.raw_id.includes(".I"));
  assert.ok(int.extraction.protocol.includes("SOAP"));
  assert.ok(int.extraction.operations.includes("UpsertSupplier"));
  const vat = int.extraction.mappings.find((m) => m.target === "/SupplierRequest/VatNumber");
  assert.equal(vat.mandatory, true);
  const fld = s.items.find((x) => x.raw_id === vat.field_ref);
  assert.deepEqual(fld.lineage.required_by, [{ ref: int.raw_id, mandatory_there: true }]);
  // WP09b: dopo la digestione field_ref → codice FLD (normalizeIntMappings, schema INT mappings[].field)
  const codes = Object.fromEntries(int.extraction.mappings.map((m, i) => [m.field_ref, `S.STD.XSC.FLD.${String(i + 1).padStart(4, "0")}`]));
  const digested = normalizeIntMappings({ id: "S.STD.XSC.INT.0001", type: "INT", mappings: int.extraction.mappings }, codes);
  assert.deepEqual(digested.unresolved, []);
  assert.ok(digested.mappings.every((m) => /^S\.STD\.XSC\.FLD\.\d{4}$/.test(m.field) && !("field_ref" in m)));
  assert.ok(lineageRelations(digested).some((rel) => rel.kind === "required_by" && rel.detail.mandatory_there === true));
});

test("piano per lo scope-extractor: sessioni ≤ 80k token, unità ≤ 3k, lotti ≤ 20; writeRaw scrive _inbox/<scope>/raw/<DOCID>.yaml", () => {
  const items = Array.from({ length: 700 }, (_, i) => ({ raw_id: `R.X.${i}`, needs_llm: true, tokens: 400 }));
  items.push({ raw_id: "R.X.big", needs_llm: true, tokens: 5000 });
  const p = planLlm(items);
  assert.ok(p.sessions.length >= 4);
  for (const s of p.sessions) { assert.ok(s.tokens <= DOC_BUDGET); for (const b of s.batch_items) assert.ok(b.length <= 20); }
  assert.deepEqual(p.over_unit_budget, [{ raw_id: "R.X.big", tokens: 5350 }]);
  const ws = mkdtempSync(join(tmpdir(), "jvc-raw-"));
  const d = docs["sample.docx"];
  const res = extractDocument(d, segmentUnits(d, { docCode: "C.ACME.XSC.DOC.0007" }).units, { profile: { id: "C.ACME.XSC.DOC.0007", genre: "tecnica", facets: { F1: "doc-cliente-tecnica" } } });
  const file = writeRaw(join(ws, "_inbox", "P2P"), "C.ACME.XSC.DOC.0007", res, { scope: "P2P" });
  assert.match(file.replace(/\\/g, "/"), /_inbox\/P2P\/raw\/DOC0007\.yaml$/);
  const y = YAML.parse(readFileSync(file, "utf8"));
  assert.equal(y.tier, "T0");
  assert.equal(y.items.length, res.items.length);
});
