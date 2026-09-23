import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkBoundary } from "../../scripts/kb/validate-boundary.mjs";
import { checkScope } from "../../scripts/kb/validate-scope.mjs";

const BOUNDARY_CLI = fileURLToPath(new URL("../../scripts/kb/validate-boundary.mjs", import.meta.url));
const SCOPE_CLI = fileURLToPath(new URL("../../scripts/kb/validate-scope.mjs", import.meta.url));

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

test("validate-boundary CLI: exit 3 su violazione di policy, 0 se pulito, 1 su input non valido (§44.5)", () => {
  const dirty = ws();
  writeFileSync(join(dirty, "kb/scopes/CAT/flows/S.STD.CAT.FLW.0001.yaml"), "note: vedi analysis/patterns\n");
  const rDirty = spawnSync(process.execPath, [BOUNDARY_CLI, dirty, "--json"]);
  assert.equal(rDirty.status, 3);

  const clean = ws();
  const rClean = spawnSync(process.execPath, [BOUNDARY_CLI, clean, "--json"]);
  assert.equal(rClean.status, 0);

  const rBadInput = spawnSync(process.execPath, [BOUNDARY_CLI, join(clean, "non-esiste"), "--json"]);
  assert.equal(rBadInput.status, 1);
});

test("validate-scope CLI: exit 3 su violazione di policy, 0 se pulito, 1 su input non valido (§44.5)", () => {
  const dirty = ws();
  writeFileSync(join(dirty, "kb/scopes/CAT/flows/S.STD.SRC.FLW.0001.yaml"), "id: S.STD.SRC.FLW.0001\n");
  const rDirty = spawnSync(process.execPath, [SCOPE_CLI, dirty, "--json"]);
  assert.equal(rDirty.status, 3);

  const clean = ws();
  const rClean = spawnSync(process.execPath, [SCOPE_CLI, clean, "--json"]);
  assert.equal(rClean.status, 0);

  const rBadInput = spawnSync(process.execPath, [SCOPE_CLI, join(clean, "non-esiste"), "--json"]);
  assert.equal(rBadInput.status, 1);
});
