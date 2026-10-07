import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { importResult, main } from "../../scripts/decide/import-result.mjs";
import { makeZip } from "../../scripts/ingest/lib/zip-write.mjs";

test("import-result: testo della pagina, log a colonne, errore di formato", () => {
  const a = importResult({ text: "Import completato: 3 righe elaborate, 1 errore.\nRiga 2: valore non valido per Tipo\nCreati: DE_001, DE_003" });
  assert.deepEqual(a.failed, [{ row: 2, message: "valore non valido per Tipo" }]); assert.deepEqual(a.created, ["DE_001", "DE_003"]); assert.equal(a.format_error, false);
  const b = importResult({ table: { headers: ["Row", "Code", "Status", "Message"], rows: [[1, "DE_001", "OK", ""], [2, "DE_002", "ERROR", "Duplicate code"]] } });
  assert.deepEqual(b.ok_rows, [1]); assert.deepEqual(b.failed, [{ row: 2, message: "Duplicate code" }]); assert.deepEqual(b.created, ["DE_001"]);
  assert.equal(importResult({ text: "Il file non corrisponde al template: intestazione mancante" }).format_error, true);
});

test("import-result: row number validation in table (blank, null, non-numeric)", () => {
  const result = importResult({
    table: {
      headers: ["Row", "Code", "Status", "Message"],
      rows: [
        ["", "DE_001", "OK", ""],
        [null, "DE_002", "OK", ""],
        ["abc", "DE_003", "OK", ""],
        [0, "DE_004", "OK", ""],
        [-1, "DE_005", "OK", ""],
        [1, "DE_006", "OK", ""],
      ]
    }
  });
  // Solo la riga 1 è valida
  assert.deepEqual(result.ok_rows, [1]);
  assert.deepEqual(result.created, ["DE_006"]);
});

test("import-result: missing Row or Status column returns format_error", () => {
  const noRow = importResult({
    table: {
      headers: ["Code", "Status", "Message"],
      rows: [[1, "DE_001", "OK", ""]]
    }
  });
  assert.equal(noRow.format_error, true);
  assert.deepEqual(noRow.ok_rows, []);

  const noStatus = importResult({
    table: {
      headers: ["Row", "Code", "Message"],
      rows: [[1, "DE_001", ""]]
    }
  });
  assert.equal(noStatus.format_error, true);
  assert.deepEqual(noStatus.ok_rows, []);
});

test("import-result: success keywords in row message text", () => {
  const result = importResult({
    text: "Riga 1: importata correttamente\nRiga 2: creato con successo\nRiga 3: OK\nRiga 4: completed successfully\nRiga 5: errore di validazione"
  });
  // Righe 1-4 hanno keyword di successo, vanno in ok_rows
  assert.deepEqual(result.ok_rows, [1, 2, 3, 4]);
  // Riga 5 no
  assert.deepEqual(result.failed, [{ row: 5, message: "errore di validazione" }]);
});

test("import-result: CLI --text-file", async () => {
  const testDir = join(import.meta.dirname, "..", "..", ".sessions");
  mkdirSync(testDir, { recursive: true });
  const testFile = join(testDir, `test-import-${Date.now()}.txt`);
  try {
    writeFileSync(testFile, "Riga 1: errore\nCreati: CODE_001");
    const argv = ["--text-file", testFile];
    const exitCode = await main(argv, { JVC_WORKSPACE: join(import.meta.dirname, "../..") });
    assert.equal(exitCode, 0);
  } finally {
    try { rmSync(testFile); } catch { }
  }
});

test("import-result: CLI --in xlsx", async () => {
  const testDir = join(import.meta.dirname, "..", "..", ".sessions");
  mkdirSync(testDir, { recursive: true });
  const testFile = join(testDir, `test-import-${Date.now()}.xlsx`);
  try {
    const wb = '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>';
    const rels = '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>';
    const sheet = '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1"><v>Row</v></c><c r="B1"><v>Status</v></c><c r="C1"><v>Code</v></c></row><row r="2"><c r="A2"><v>1</v></c><c r="B2"><v>OK</v></c><c r="C2"><v>C001</v></c></row></sheetData></worksheet>';
    const buf = makeZip([
      { name: "xl/workbook.xml", data: Buffer.from(wb, "utf8") },
      { name: "xl/_rels/workbook.xml.rels", data: Buffer.from(rels, "utf8") },
      { name: "xl/worksheets/sheet1.xml", data: Buffer.from(sheet, "utf8") }
    ]);
    writeFileSync(testFile, buf);
    const argv = ["--in", testFile];
    const exitCode = await main(argv, { JVC_WORKSPACE: join(import.meta.dirname, "../..") });
    assert.equal(exitCode, 0);
  } finally {
    try { rmSync(testFile); } catch { }
  }
});

test("import-result: CLI missing required input", async () => {
  const argv = [];
  const exitCode = await main(argv, {});
  assert.equal(exitCode, 1);
});
