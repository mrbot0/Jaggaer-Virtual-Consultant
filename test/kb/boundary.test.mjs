import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkBoundary } from "../../scripts/kb/validate-boundary.mjs";
import { checkScope } from "../../scripts/kb/validate-scope.mjs";

function ws() { const r = mkdtempSync(join(tmpdir(), "b-")); mkdirSync(join(r, "kb/scopes/CAT/flows"), { recursive: true }); mkdirSync(join(r, "analysis/patterns"), { recursive: true }); return r; }

test("kb non cita analysis né codici analitici; analysis non cita test", () => {
  const r = ws();
  writeFileSync(join(r, "kb/scopes/CAT/flows/S.STD.CAT.FLW.0001.yaml"), "id: S.STD.CAT.FLW.0001\nnote: vedi analysis/patterns e S.STD.CAT.PAT.0002\n");
  writeFileSync(join(r, "analysis/patterns/S.STD.CAT.PAT.0002.yaml"), "id: S.STD.CAT.PAT.0002\nprevention_test: NRT.ACME.CAT.NEG.0031\n");
  assert.equal(checkBoundary(r).length, 3);
});

test("un item in kb/scopes/CAT con scope diverso nel codice è una violazione", () => {
  const r = ws();
  writeFileSync(join(r, "kb/scopes/CAT/flows/S.STD.SRC.FLW.0001.yaml"), "id: S.STD.SRC.FLW.0001\n");
  assert.equal(checkScope(r).length, 1);
});
