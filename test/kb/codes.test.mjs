import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCode, isValidCode } from "../../scripts/kb/codes.mjs";

test("parsing di un codice valido", () => {
  assert.deepEqual(parseCode("S.STD.SRC.FLW.0003"), { level: "S", customer: "STD", scope: "SRC", type: "FLW", seq: 3, version: 1 });
  assert.deepEqual(parseCode("C.ACME.ADM.CFP.0002.v2"), { level: "C", customer: "ACME", scope: "ADM", type: "CFP", seq: 2, version: 2 });
});

test("S richiede STD; C e L richiedono un cliente di 4 caratteri", () => {
  assert.equal(isValidCode("S.ACME.SRC.FLW.0003"), false);
  assert.equal(isValidCode("C.STD.SRC.FLW.0003"), false);
  assert.equal(isValidCode("L.ACME.ANL.TBL.0007"), true);
});

test("tipo non ammesso al livello, scope sconosciuto, SEQ non a 4 cifre", () => {
  assert.equal(isValidCode("S.STD.SRC.PRF.0001"), false);
  assert.equal(isValidCode("S.STD.ZZZ.FLW.0001"), false);
  assert.equal(isValidCode("S.STD.SRC.FLW.003"), false);
});
