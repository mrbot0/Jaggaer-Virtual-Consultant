// K4.2 — pipeline a lotti dei campi (§19.6.4 passi 1-4): documento normalizzato,
// segmentazione per sezione (≤ 50 righe per unità), estrazione tabellare,
// deduplica, piano dei lotti ≤ 50 con budget e ripresa, accettazione in _inbox.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, rmSync, realpathSync } from "node:fs";
import { runSessionCli, cleanEnv } from "../helpers/hook-env.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { validateWith } from "../../scripts/lib/schemas.mjs";
import { recognizeFieldTable, segmentFieldTables, MAX_ROWS_PER_UNIT } from "../../scripts/ingest/segment.mjs";
import { extractFieldRows, writeRawFields } from "../../scripts/ingest/field-table.mjs";
import { dedupe, normalizeLabel, normalizeTechnicalName, labelDistance } from "../../scripts/ingest/dedupe.mjs";
import { plan, accept, estimateTokens, writeBatch, suggestCluster, suggestFieldType, MAX_BATCH, BudgetPolicyError } from "../../scripts/kb/digest-fields.mjs";

const DIGEST_CLI = fileURLToPath(new URL("../../scripts/kb/digest-fields.mjs", import.meta.url));
const FT_CLI = fileURLToPath(new URL("../../scripts/ingest/field-table.mjs", import.meta.url));
const MAND = ["Sì", "No", "Obbligatorio nello stato PENDING_APPROVAL", "Obbligatorio se l'importo supera 5000 EUR", "Dovrebbe essere obbligatorio salvo…", "Facoltativo"];
const TYPES = ["Testo", "Numero", "Data", "Lookup", "Elenco", "Flag"];

// Documento sintetico: 300 campi in 4 sezioni (una da 130 su due tabelle), più una tabella non di campi.
function synthDoc(id = "DOC-REQ-SPEC", { n = 300 } = {}) {
  const rows = (from, count, prefix) => Array.from({ length: count }, (_, i) => {
    const k = from + i;
    return [`Campo ${prefix} ${k}`, `REQ_${prefix.toUpperCase()}_${String(k).padStart(4, "0")}`, TYPES[k % TYPES.length], MAND[k % MAND.length], `nota ${k}`];
  });
  const H = ["Campo", "Nome tecnico", "Tipo", "Obbligatorio", "Note"];
  const split = [120, 130, 30, n - 280];
  return {
    id, title: "Specifica richiesta d'acquisto", format: "docx", lang: "it", genre: "tecnica",
    sections: [
      { path: "3.1", title: "Intestazione", level: 2, page: 10, paragraphs: ["Campi di testata."], tables: [{ headers: H, rows: rows(1, split[0], "hdr") }], figures: [] },
      { path: "3.2", title: "Righe", level: 2, page: 14, paragraphs: [], figures: [{ caption: "Griglia righe" }],
        tables: [{ headers: H, rows: rows(121, 70, "lin") }, { headers: ["Parametro", "Valore"], rows: [["strict_import", "false"]] }, { headers: H, rows: rows(191, 60, "lin") }] },
      { path: "3.3", title: "Contabilità", level: 2, paragraphs: [], figures: [], tables: [{ headers: H, rows: rows(251, split[2], "acc") }] },
      { path: "3.4", title: "Allegati", level: 2, paragraphs: [], figures: [], tables: [{ headers: H, rows: rows(281, split[3], "att") }] },
    ],
  };
}

test("parsed-doc.schema.json: il documento normalizzato dei parser (id, title, format, sections[paths, tables, figures])", () => {
  assert.deepEqual(validateWith("parsed-doc.schema.json", synthDoc()).errors, []);
  const { sections, ...noSections } = synthDoc();
  assert.equal(validateWith("parsed-doc.schema.json", noSections).ok, false);
  const bad = synthDoc();
  bad.sections[0].tables[0].rows = "non una matrice";
  assert.equal(validateWith("parsed-doc.schema.json", bad).ok, false);
});

test("recognizeFieldTable: tabelle «campo | tipo | obbligatorio | note» in it/en con sinonimi; le altre no", () => {
  const it = recognizeFieldTable(["Campo", "Tipo", "Obbligatorio", "Note"]);
  assert.deepEqual(it, { label: 0, type: 1, mandatory: 2, notes: 3 });
  assert.deepEqual(recognizeFieldTable(["Field", "Type", "Required", "Description"]), { label: 0, type: 1, mandatory: 2, notes: 3 });
  assert.deepEqual(recognizeFieldTable(["Nome", "Nome tecnico", "Tipo", "Obbligatorietà", "Descrizione"]), { label: 0, technical_name: 1, type: 2, mandatory: 3, notes: 4 });
  assert.deepEqual(recognizeFieldTable(["Name", "Technical name", "Mandatory", "Allowed values"]), { label: 0, technical_name: 1, mandatory: 2, allowed_values: 3 });
  assert.deepEqual(recognizeFieldTable(["ID", "Field", "Type", "Mandatory"]), { technical_name: 0, label: 1, type: 2, mandatory: 3 });
  assert.equal(recognizeFieldTable(["Parametro", "Valore"]), null);
  assert.equal(recognizeFieldTable(["Campo", "Note"]), null);   // senza colonna di obbligatorietà non è una tabella di campi
});

test("segmentFieldTables: 300 campi → unità per sezione con ≤ 50 righe (<sezione>#part-n); le tabelle non di campi sono escluse", () => {
  const units = segmentFieldTables(synthDoc());
  assert.equal(MAX_ROWS_PER_UNIT, 50);
  assert.ok(units.every((u) => u.rows.length <= 50), `max ${Math.max(...units.map((u) => u.rows.length))}`);
  assert.equal(units.reduce((s, u) => s + u.rows.length, 0), 300);
  assert.deepEqual(units.filter((u) => u.section === "3.1").map((u) => [u.id, u.rows.length]), [["3.1#part-1", 40], ["3.1#part-2", 40], ["3.1#part-3", 40]]);
  assert.equal(units.filter((u) => u.section === "3.2").length, 3);                  // 130 righe da due tabelle → 3 parti
  assert.deepEqual(units.find((u) => u.section === "3.3").id, "3.3#part-1");
  assert.ok(units.every((u) => u.document === "DOC-REQ-SPEC" && u.parts >= u.part));
  assert.throws(() => segmentFieldTables({ id: "x" }), /parsed-doc/);
});

test("extractFieldRows: una riga grezza per campo con il testo di obbligatorietà verbatim; writeRawFields scrive _inbox/<scope>/fields/<doc>/<sezione>.yaml", () => {
  const units = segmentFieldTables(synthDoc());
  const rows = extractFieldRows(units[0], { genre: "tecnica" });
  assert.equal(rows.length, 40);
  assert.deepEqual(Object.keys(rows[0]).sort(), ["allowed_values", "document", "genre", "label", "mandatory_text", "notes", "row_ref", "section", "source_unit", "technical_name", "type"].sort());
  assert.equal(rows[0].label, "Campo hdr 1");
  assert.equal(rows[0].technical_name, "REQ_HDR_0001");
  assert.equal(rows[0].mandatory_text, MAND[1]);
  assert.equal(rows[0].source_unit, "DOC-REQ-SPEC/3.1#part-1");
  const root = mkdtempSync(join(tmpdir(), "ft-"));
  const w = writeRawFields(root, "P2P", synthDoc(), { genre: "tecnica" });
  assert.equal(w.rows, 300);
  const dir = join(root, "_inbox", "P2P", "fields", "DOC-REQ-SPEC");
  assert.deepEqual(readdirSync(dir).sort(), ["3.1.yaml", "3.2.yaml", "3.3.yaml", "3.4.yaml"]);
  const sec = YAML.parse(readFileSync(join(dir, "3.2.yaml"), "utf8"));
  assert.equal(sec.rows.length, 130);
  assert.equal(sec.section_title, "Righe");
  assert.throws(() => writeRawFields(root, "XXX", synthDoc()), /scope/);
});

test("field-table CLI: --doc --scope --root scrive i grezzi; scope sconosciuto → exit 1", () => {
  const root = mkdtempSync(join(tmpdir(), "ftc-"));
  const docFile = join(root, "doc.json");
  writeFileSync(docFile, JSON.stringify(synthDoc()));
  const ok = spawnSync(process.execPath, [FT_CLI, "--doc", docFile, "--scope", "P2P", "--root", root, "--json"], { encoding: "utf8", env: cleanEnv({ JVC_WORKSPACE: root }) });
  assert.equal(ok.status, 0, ok.stderr + ok.stdout);
  assert.equal(JSON.parse(ok.stdout).rows, 300);
  const bad = spawnSync(process.execPath, [FT_CLI, "--doc", docFile, "--scope", "ZZZ", "--root", root, "--json"], { encoding: "utf8", env: cleanEnv({ JVC_WORKSPACE: root }) });
  assert.equal(bad.status, 1);
});

test("dedupe: normalizzazione di label e nome tecnico; Levenshtein normalizzato", () => {
  assert.equal(normalizeLabel("  Centro di Costo (CdC)! "), "centro di costo cdc");
  assert.equal(normalizeLabel("Quantità   ordinata"), "quantita ordinata");
  assert.equal(normalizeTechnicalName(" req-hdr.cost center "), "REQ_HDR_COST_CENTER");
  assert.equal(labelDistance("Centro di costo", "Centro di costo"), 0);
  assert.ok(labelDistance("Data consegna", "Data di consegna") < 0.25);
  assert.ok(labelDistance("Centro di costo", "Fornitore") > 0.5);
});

test("dedupe: stesso nome tecnico ⇒ UN campo con due fonti (manuale d'uso + spec tecnica), divergenze segnalate", () => {
  const manual = { label: "Centro di costo", technical_name: "REQ_HDR_COST_CENTER", type: "Lookup", mandatory_text: "Obbligatorio in approvazione",
    allowed_values: [], notes: null, section: "header.accounting", source_unit: "MAN-P2P/4.2#part-1", row_ref: 3, genre: "d'uso", document: "MAN-P2P" };
  const spec = { label: "Cost center", technical_name: "req_hdr_cost_center", type: "lookup", mandatory_text: "Sì",
    allowed_values: [], notes: "E1EDP19-IDTNR", section: "3.3", source_unit: "SPEC-REQ/3.3#part-1", row_ref: 1, genre: "tecnica", document: "SPEC-REQ" };
  const other = { ...manual, label: "Fornitore", technical_name: "REQ_HDR_SUPPLIER", source_unit: "MAN-P2P/4.2#part-1", row_ref: 4 };
  const r = dedupe([manual, spec, other]);
  assert.equal(r.fields.length, 2);
  const cc = r.fields.find((f) => f.technical_name === "REQ_HDR_COST_CENTER");
  assert.equal(cc.sources.length, 2);
  assert.deepEqual(cc.sources.map((s) => s.genre).sort(), ["d'uso", "tecnica"]);
  assert.deepEqual(cc.labels.sort(), ["Centro di costo", "Cost center"]);
  assert.ok(cc.conflicts.some((c) => c.attribute === "mandatory_text"));   // manuale e spec divergono → candidato CTR
  assert.equal(r.stats.merged, 1);
});

test("dedupe: label simile nella stessa sezione ⇒ merge-candidate (non fusione); sezioni diverse o nomi tecnici diversi ⇒ niente", () => {
  const base = { type: "Data", mandatory_text: "Sì", allowed_values: [], notes: null, genre: "d'uso", document: "MAN", row_ref: 1 };
  const rows = [
    { ...base, label: "Data di consegna", technical_name: null, section: "5.1", source_unit: "MAN/5.1#part-1" },
    { ...base, label: "Data di consegna.", technical_name: null, section: "5.1", source_unit: "SPEC/5.1#part-1", document: "SPEC" },
    { ...base, label: "Data di consegna", technical_name: null, section: "6.1", source_unit: "MAN/6.1#part-1" },
    { ...base, label: "Data consegna prevista", technical_name: "A_1", section: "7", source_unit: "MAN/7#part-1" },
    { ...base, label: "Data consegna prevista", technical_name: "B_2", section: "7", source_unit: "MAN/7#part-1" },
  ];
  const r = dedupe(rows);
  assert.equal(r.fields.length, 5);
  assert.equal(r.merge_candidates.length, 1);
  assert.equal(r.merge_candidates[0].section, "5.1");
  assert.ok(r.merge_candidates[0].distance < 0.15);
});

test("suggerimenti: CL-FLD dalla sezione, field_type dal testo del tipo", () => {
  assert.deepEqual(suggestCluster("header.accounting"), { code: "CL-FLD-003", functional_section: "contabilita" });
  assert.equal(suggestCluster("3.1", "Intestazione").code, "CL-FLD-001");
  assert.equal(suggestCluster("3.2", "Righe").code, "CL-FLD-002");
  assert.equal(suggestCluster("3.4", "Allegati").code, "CL-FLD-008");
  assert.equal(suggestCluster("9", "Varie"), null);
  assert.equal(suggestFieldType("Testo"), "text");
  assert.equal(suggestFieldType("Numero"), "number");
  assert.equal(suggestFieldType("Checkbox"), "flag");
  assert.equal(suggestFieldType("Menu a tendina"), "list");
  assert.equal(suggestFieldType("???"), null);
});

// Workspace JVC con il cliente ACME creato dalla CLI di sessione (sessione reale `sid`) e i grezzi del
// documento da 300 campi in customers/ACME/_inbox.
function realWorkspace(sid) {
  const ws = realpathSync.native(mkdtempSync(join(tmpdir(), "jvc-dg-")));
  mkdirSync(join(ws, ".jvc"), { recursive: true });
  const r = newRealSession(ws, sid, "ACME", true);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const root = join(ws, "customers", "ACME");
  writeRawFields(root, "P2P", synthDoc(), { genre: "tecnica" });
  return { ws, root };
}
function newRealSession(ws, sid, customer = "ACME", create = false) {
  return runSessionCli(["use", "customer", customer, ...(create ? ["--new"] : []), "--workspace", ws, "--session", sid, "--json"]);
}

function inboxWith300() {
  const root = mkdtempSync(join(tmpdir(), "dg-"));
  writeRawFields(root, "P2P", synthDoc(), { genre: "tecnica" });
  return root;
}

test("plan: documento da 300 campi → nessun lotto > 50; ogni riga in un lotto; regola suggerita dal parser deontico; ambigui in residuo", () => {
  const root = inboxWith300();
  const p = plan("DOC-REQ-SPEC", { root });
  assert.equal(p.status, "complete");
  assert.equal(p.scope, "P2P");
  assert.equal(MAX_BATCH, 50);
  assert.ok(p.batches.every((b) => b.rows <= 50), `max ${Math.max(...p.batches.map((b) => b.rows))}`);
  assert.equal(p.batches.reduce((s, b) => s + b.rows, 0), 300);
  const dir = join(root, "_inbox", "P2P", "fields", "DOC-REQ-SPEC");
  const files = readdirSync(dir).filter((f) => /^batch-\d+\.yaml$/.test(f));
  assert.equal(files.length, p.batches.length);
  let seen = 0;
  for (const f of files) {
    const b = YAML.parse(readFileSync(join(dir, f), "utf8"));
    assert.ok(b.rows.length <= 50);
    seen += b.rows.length;
    for (const r of b.rows) {
      if (r.mandatory_text === "Obbligatorio nello stato PENDING_APPROVAL") assert.deepEqual(r.suggested.mandatory, { kind: "conditional", in_states: ["PENDING_APPROVAL"] });
      if (r.mandatory_text === "Sì") assert.deepEqual(r.suggested.mandatory, { kind: "always" });
      if (r.mandatory_text === "Dovrebbe essere obbligatorio salvo…") { assert.equal(r.suggested.mandatory, undefined); assert.equal(r.suggested.residue, "ambiguous"); }
    }
    if (b.section === "3.3") assert.equal(b.rows[0].suggested.cluster, "CL-FLD-003");
  }
  assert.equal(seen, 300);
  assert.equal(p.residue.ambiguous, 50);
  assert.ok(existsSync(join(dir, "_residue.yaml")));
  assert.ok(p.tokens_used <= 80000);
  // un secondo plan rilegge solo i grezzi (non i lotti né il residuo)
  assert.equal(plan("DOC-REQ-SPEC", { root }).batches.reduce((s, b) => s + b.rows, 0), 300);
});

test("plan: budget per documento superato → si ferma al lotto corrente con un cursore; --resume in una sessione REALE successiva riprende e completa", () => {
  const { ws, root } = realWorkspace("sess-1");
  const full = plan("DOC-REQ-SPEC", { root: inboxWith300() });
  const perBatch = Math.max(...full.batches.map((b) => b.tokens));
  const p1 = plan("DOC-REQ-SPEC", { root, budget: perBatch * 3, env: { JVC_SESSION_ID: "sess-1" } });
  assert.equal(p1.status, "budget-exceeded");
  assert.ok(p1.batches.length >= 2 && p1.batches.length < full.batches.length);
  assert.equal(p1.cursor, `batch-${String(p1.batches.length + 1).padStart(2, "0")}`);
  let written = p1.batches.length;
  let cursor = p1.cursor;
  for (let guard = 0; cursor && guard < 20; guard++) {
    // §29.10: «si ferma al lotto corrente e riprende alla sessione successiva» — ogni ripresa è una sessione nuova, creata dalla CLI di sessione
    const sid = `sess-${guard + 2}`;
    newRealSession(ws, sid);
    const pn = plan("DOC-REQ-SPEC", { root, budget: perBatch * 3, resume: cursor, env: { JVC_SESSION_ID: sid } });
    assert.equal(pn.batches[0].batch, cursor);
    written += pn.batches.length;
    cursor = pn.cursor;
  }
  assert.equal(written, full.batches.length);
  assert.throws(() => plan("DOC-REQ-SPEC", { root, resume: "batch-99", env: { JVC_SESSION_ID: "sess-1" } }), /cursore/);
});

test("un lotto > 50 campi è un errore (assert rigido), prima di qualsiasi scrittura", () => {
  const root = mkdtempSync(join(tmpdir(), "hb-"));
  const rows = Array.from({ length: 51 }, (_, i) => ({ label: `c${i}` }));
  assert.throws(() => writeBatch(root, "P2P", "DOC", "batch-01", { section: "1", rows }), /50/);
  assert.equal(existsSync(join(root, "_inbox")), false);
});

test("estimateTokens: stima proporzionale alla dimensione del lotto", () => {
  const a = estimateTokens({ rows: [{ label: "x" }] });
  const b = estimateTokens({ rows: Array.from({ length: 10 }, () => ({ label: "x".repeat(100) })) });
  assert.ok(a > 0 && b > a * 5);
});

function fldFor(row, id, over = {}) {
  return { id, type: "FLD", title: `Campo ${row.label}`, summary: `Campo ${row.label} della richiesta.`, sources: row.sources.map((s) => ({ doc: s.document, section: s.section, unit: s.source_unit })),
    document: "document.requisition", label: { it: row.label }, technical_name: row.technical_name, section: "header", field_type: "text",
    facets: { F1: "doc-cliente-tecnica", F4: "struttura-dati", F5: "saas-core", F6: ["indirect"], F7: "sap-ecc", F8: "specifica", F9: "continua",
      F10: "R1", F11: "deterministico", F12: "digerito", F13: { verified_at: "2026-09-01", release: "R25.2" }, F15: "tecnica" }, ...over };
}

test("accept: valida ogni FLD con validateFld e scrive in _inbox/<scope>/digested/ (mai kb/); invalidi e regole ambigue con kind rifiutati", () => {
  const root = inboxWith300();
  plan("DOC-REQ-SPEC", { root });
  const batchFile = join(root, "_inbox", "P2P", "fields", "DOC-REQ-SPEC", "batch-01.yaml");
  const b = YAML.parse(readFileSync(batchFile, "utf8"));
  const clear = b.rows.find((r) => r.suggested.mandatory?.kind === "always");
  const amb = b.rows.find((r) => r.suggested.residue === "ambiguous");
  const cond = b.rows.find((r) => r.suggested.mandatory?.kind === "conditional");
  const items = [
    fldFor(clear, "C.ACME.P2P.FLD.0001", { mandatory: clear.suggested.mandatory }),
    fldFor(amb, "C.ACME.P2P.FLD.0002", { mandatory: { kind: "always" }, mandatory_text: amb.mandatory_text }),   // RF5: ambiguo con kind
    fldFor(amb, "C.ACME.P2P.FLD.0003", { mandatory_text: amb.mandatory_text }),                                  // ambiguo senza kind: ok
    fldFor(cond, "C.ACME.P2P.FLD.0004", { mandatory: { kind: "conditional" } }),                                  // conditional senza condizione
    fldFor({ ...clear, label: "Campo estraneo", technical_name: "NOT_IN_BATCH" }, "C.ACME.P2P.FLD.0005"),
  ];
  const r = accept(batchFile, items, { root });
  assert.deepEqual(r.accepted.map((a) => a.id).sort(), ["C.ACME.P2P.FLD.0001", "C.ACME.P2P.FLD.0003"]);
  const why = Object.fromEntries(r.rejected.map((x) => [x.id, x.errors.join(" | ")]));
  assert.match(why["C.ACME.P2P.FLD.0002"], /ambigu/);
  assert.match(why["C.ACME.P2P.FLD.0004"], /conditional/);
  assert.match(why["C.ACME.P2P.FLD.0005"], /lotto/);
  assert.ok(existsSync(join(root, "_inbox", "P2P", "digested", "C.ACME.P2P.FLD.0001.yaml")));
  assert.equal(existsSync(join(root, "_inbox", "P2P", "digested", "C.ACME.P2P.FLD.0002.yaml")), false);
  assert.equal(existsSync(join(root, "kb")), false);
});

test("digest-fields CLI: plan (exit 0; budget superato → exit 3 con cursore) e accept (rifiutati → exit 1)", () => {
  const root = inboxWith300();
  const ok = spawnSync(process.execPath, [DIGEST_CLI, "plan", "DOC-REQ-SPEC", "--root", root, "--json"], { encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr + ok.stdout);
  assert.equal(JSON.parse(ok.stdout).status, "complete");
  const over = spawnSync(process.execPath, [DIGEST_CLI, "plan", "DOC-REQ-SPEC", "--root", inboxWith300(), "--budget", "3000", "--json"], { encoding: "utf8" });
  assert.equal(over.status, 3);
  assert.match(JSON.parse(over.stdout).cursor, /^batch-\d{2}$/);
  const missing = spawnSync(process.execPath, [DIGEST_CLI, "plan", "NOPE", "--root", root, "--json"], { encoding: "utf8" });
  assert.equal(missing.status, 1);
  const batchFile = join(root, "_inbox", "P2P", "fields", "DOC-REQ-SPEC", "batch-01.yaml");
  const digested = join(root, "digested.yaml");
  writeFileSync(digested, YAML.stringify([{ id: "C.ACME.P2P.FLD.0009", type: "FLD" }]));
  const acc = spawnSync(process.execPath, [DIGEST_CLI, "accept", batchFile, "--digested", digested, "--root", root, "--json"], { encoding: "utf8", env: cleanEnv({ JVC_WORKSPACE: root }) });
  assert.equal(acc.status, 1);
  assert.equal(JSON.parse(acc.stdout).rejected.length, 1);
});

test("plan con --related: il campo del manuale e quello della spec (stesso nome tecnico) sono UNA riga del lotto con due fonti", () => {
  const root = mkdtempSync(join(tmpdir(), "rel-"));
  const mk = (id, genre, label, mand) => ({ id, title: id, format: "docx", genre, sections: [{ path: "4.2", title: "Contabilità", level: 2, paragraphs: [], figures: [],
    tables: [{ headers: ["Campo", "Nome tecnico", "Tipo", "Obbligatorio"], rows: [[label, "REQ_HDR_COST_CENTER", "Lookup", mand], [`Solo ${id}`, `ONLY_${id}`, "Testo", "No"]] }] }] });
  writeRawFields(root, "P2P", mk("MAN", "d'uso", "Centro di costo", "Obbligatorio in approvazione"));
  writeRawFields(root, "P2P", mk("SPEC", "tecnica", "Cost center", "Sì"));
  const p = plan("MAN", { root, related: ["SPEC"] });
  const b = YAML.parse(readFileSync(p.batches[0].file, "utf8"));
  assert.equal(b.rows.length, 2);                                   // il campo solo-SPEC non entra nei lotti di MAN
  const cc = b.rows.find((r) => r.technical_name === "REQ_HDR_COST_CENTER");
  assert.deepEqual(cc.sources.map((s) => s.document).sort(), ["MAN", "SPEC"]);
  assert.match(cc.suggested.contradiction, /CTR/);
  assert.equal(cc.suggested.cluster, "CL-FLD-003");
});

// ——— Giro di correzione 1 (revisione WP05) ———
function smallInbox(rows) {
  const root = mkdtempSync(join(tmpdir(), "fx1-"));
  writeRawFields(root, "P2P", { id: "DOC-FX1", title: "t", format: "docx", sections: [{ path: "1", title: "Intestazione", level: 1, paragraphs: [], figures: [],
    tables: [{ headers: ["Campo", "Nome tecnico", "Tipo", "Obbligatorio"], rows }] }] });
  plan("DOC-FX1", { root });
  return { root, batchFile: join(root, "_inbox", "P2P", "fields", "DOC-FX1", "batch-01.yaml") };
}

test("giro 1 (#2): accept rifiuta un kind di obbligo su una riga suggerita come raccomandazione; never passa; ambiguo non ammette kind", () => {
  const { root, batchFile } = smallInbox([["Note", "HDR_NOTES", "Testo", "Si consiglia di compilarlo"], ["Commessa", "HDR_PROJECT", "Testo", "Consigliato"],
    ["Priorità", "HDR_PRIO", "Testo", "Il campo è obbligatorio se non diversamente configurato."]]);
  const b = YAML.parse(readFileSync(batchFile, "utf8"));
  const row = (t) => b.rows.find((r) => r.technical_name === t);
  assert.equal(row("HDR_NOTES").suggested.modality, "raccomandazione");
  assert.equal(row("HDR_PROJECT").suggested.modality, "raccomandazione");
  assert.equal(row("HDR_PRIO").suggested.modality, "ambiguo");
  const items = [
    fldFor(row("HDR_NOTES"), "C.ACME.P2P.FLD.0011", { mandatory: { kind: "always", modality: "raccomandazione" } }),
    fldFor(row("HDR_PROJECT"), "C.ACME.P2P.FLD.0012", { mandatory: { kind: "always" } }),              // il digester omette la modalità
    fldFor(row("HDR_NOTES"), "C.ACME.P2P.FLD.0013", { label: { it: "Note" }, technical_name: "HDR_NOTES", mandatory: { kind: "never" } }),
    fldFor(row("HDR_PRIO"), "C.ACME.P2P.FLD.0014", { mandatory: { kind: "never" } }),                 // ambiguo: nessun kind, nemmeno never
    fldFor(row("HDR_PRIO"), "C.ACME.P2P.FLD.0015", { mandatory_text: row("HDR_PRIO").mandatory_text }),
  ];
  const r = accept(batchFile, items, { root });
  assert.deepEqual(r.accepted.map((a) => a.id).sort(), ["C.ACME.P2P.FLD.0013", "C.ACME.P2P.FLD.0015"]);
  const why = Object.fromEntries(r.rejected.map((x) => [x.id, x.errors.join(" | ")]));
  assert.match(why["C.ACME.P2P.FLD.0011"], /raccomandazione/);
  assert.match(why["C.ACME.P2P.FLD.0012"], /raccomandazione/);
  assert.match(why["C.ACME.P2P.FLD.0014"], /ambigu/);
});

test("giro 1 (#3): i budget si possono solo abbassare — budget > 80000 o unit-budget > 3000 → rifiuto di policy (exit 3)", () => {
  const root = inboxWith300();
  assert.throws(() => plan("DOC-REQ-SPEC", { root, budget: 10_000_000 }), (e) => e instanceof BudgetPolicyError && /80000/.test(e.message));
  assert.throws(() => plan("DOC-REQ-SPEC", { root, budget: 80001 }), BudgetPolicyError);
  assert.throws(() => plan("DOC-REQ-SPEC", { root, unitBudget: 3001 }), (e) => e instanceof BudgetPolicyError && /3000/.test(e.message));
  assert.equal(plan("DOC-REQ-SPEC", { root, budget: 80000, unitBudget: 3000 }).status, "complete");
  assert.equal(plan("DOC-REQ-SPEC", { root, budget: 20000 }).status, "budget-exceeded");       // abbassare è consentito
  for (const args of [["--budget", "10000000"], ["--unit-budget", "5000"]]) {
    const r = spawnSync(process.execPath, [DIGEST_CLI, "plan", "DOC-REQ-SPEC", "--root", root, ...args, "--json"], { encoding: "utf8" });
    assert.equal(r.status, 3, r.stdout + r.stderr);
    assert.equal(JSON.parse(r.stdout).ok, false);
  }
});

test("giro 2 (#3): il consumo è per sessione REALE del cliente — senza sessione, con un id inventato, con un puntatore forgiato o una sessione di un altro cliente si somma tutto (mai un azzeramento)", () => {
  const { ws, root } = realWorkspace("sess-a");
  const full = plan("DOC-REQ-SPEC", { root: inboxWith300() });
  const budget = Math.max(...full.batches.map((b) => b.tokens)) * 3;
  const p1 = plan("DOC-REQ-SPEC", { root, budget, env: { JVC_SESSION_ID: "sess-a" } });
  assert.equal(p1.status, "budget-exceeded");
  assert.equal(p1.session, "sess-a");
  const cursorFile = join(root, "_inbox", "P2P", "fields", "DOC-REQ-SPEC", "_cursor.yaml");
  const st = YAML.parse(readFileSync(cursorFile, "utf8"));
  assert.equal(st.cursor, p1.cursor);
  assert.deepEqual(st.by_session, { "sess-a": p1.tokens_used });
  const capped = (label, env) => {
    const r = plan("DOC-REQ-SPEC", { root, budget, resume: p1.cursor, env });
    assert.equal(r.batches.length, 0, label);
    assert.equal(r.status, "budget-exceeded", label);
    assert.equal(r.cursor, p1.cursor, label);
    assert.ok(r.tokens_used >= p1.tokens_used, label);
    return r;
  };
  capped("stessa sessione reale", { JVC_SESSION_ID: "sess-a" });
  rmSync(join(ws, ".jvc", "current-session"), { force: true });
  assert.equal(capped("nessuna sessione", {}).session, null);
  assert.equal(capped("id inventato", { JVC_SESSION_ID: "invented-1" }).session, null);
  writeFileSync(join(ws, ".jvc", "sessions", "forged.json"), JSON.stringify({ session_id: "forged", customer: "ACME", path: "customers/ACME/.sessions/forged/session.json" }));
  capped("puntatore senza session.json", { JVC_SESSION_ID: "forged" });
  mkdirSync(join(root, ".sessions", "forged2"), { recursive: true });
  writeFileSync(join(root, ".sessions", "forged2", "session.json"), JSON.stringify({ session_id: "forged2", customer: "ACME" }));
  writeFileSync(join(ws, ".jvc", "sessions", "forged2.json"), JSON.stringify({ session_id: "forged2", customer: "ACME", path: "customers/ACME/.sessions/forged2/session.json" }));
  capped("session.json non conforme allo schema", { JVC_SESSION_ID: "forged2" });
  assert.equal(newRealSession(ws, "sess-beta", "BETA", true).status, 0);
  capped("sessione reale di un altro cliente", { JVC_SESSION_ID: "sess-beta" });
  // una sessione reale nuova dello stesso cliente riparte da zero (§29.10)
  assert.equal(newRealSession(ws, "sess-b").status, 0);
  const next = plan("DOC-REQ-SPEC", { root, budget, resume: p1.cursor, env: { JVC_SESSION_ID: "sess-b" } });
  assert.ok(next.batches.length >= 1);
  assert.equal(next.batches[0].batch, p1.cursor);
  assert.equal(next.session, "sess-b");
  const st2 = YAML.parse(readFileSync(cursorFile, "utf8"));
  assert.deepEqual(Object.keys(st2.by_session).sort(), ["sess-a", "sess-b"]);
  // di nuovo senza sessione: la somma di tutte le sessioni supera il budget → nessun lotto
  if (next.cursor) capped("somma dopo due sessioni", {});
  // ripresa senza cursore salvato: rifiutata (cancellare _cursor.yaml non azzera il consumo)
  rmSync(cursorFile);
  assert.throws(() => plan("DOC-REQ-SPEC", { root, budget, resume: p1.cursor, env: {} }), /cursore/);
});

test("giro 2 (#3): nessuna sessione a scelta del chiamante — l'opzione session e il flag --session sono rifiutati", () => {
  const root = inboxWith300();
  assert.throws(() => plan("DOC-REQ-SPEC", { root, session: "S1" }), /session/);
  const r = spawnSync(process.execPath, [DIGEST_CLI, "plan", "DOC-REQ-SPEC", "--root", root, "--session", "S1", "--json"], { encoding: "utf8" });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(JSON.parse(r.stdout).error, /JVC_SESSION_ID/);
});