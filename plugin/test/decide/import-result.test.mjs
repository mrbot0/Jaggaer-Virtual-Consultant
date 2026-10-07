import { test } from "node:test";
import assert from "node:assert/strict";
import { importResult } from "../../scripts/decide/import-result.mjs";

test("import-result: testo della pagina, log a colonne, errore di formato", () => {
  const a = importResult({ text: "Import completato: 3 righe elaborate, 1 errore.\nRiga 2: valore non valido per Tipo\nCreati: DE_001, DE_003" });
  assert.deepEqual(a.failed, [{ row: 2, message: "valore non valido per Tipo" }]); assert.deepEqual(a.created, ["DE_001", "DE_003"]); assert.equal(a.format_error, false);
  const b = importResult({ table: { headers: ["Row", "Code", "Status", "Message"], rows: [[1, "DE_001", "OK", ""], [2, "DE_002", "ERROR", "Duplicate code"]] } });
  assert.deepEqual(b.ok_rows, [1]); assert.deepEqual(b.failed, [{ row: 2, message: "Duplicate code" }]); assert.deepEqual(b.created, ["DE_001"]);
  assert.equal(importResult({ text: "Il file non corrisponde al template: intestazione mancante" }).format_error, true);
});
