import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mkWs } from "../helpers/hook-env.mjs";
import { autonomyLevel, capFor } from "../../hooks/lib/autonomy.mjs";

const ws0 = (yaml) => { const ws = mkWs(); mkdirSync(join(ws, "customers/ACME/config"), { recursive: true }); if (yaml != null) writeFileSync(join(ws, "customers/ACME/config/autonomy.yaml"), yaml); return ws; };

test("autonomia: frase > cliente > predefinito; tetto medio in produzione", () => {
  assert.deepEqual(autonomyLevel({ ws: ws0(null), customer: "ACME", envType: "preprod" }), { level: "alto", chosen: "alto", source: "predefinito", warning: null });
  assert.equal(autonomyLevel({ ws: ws0("default: medio\n"), customer: "ACME", envType: "sandbox" }).level, "medio");
  const recs = [{ kind: "autonomy", level: "basso" }, { kind: "A1", plan: "PLAN.X" }, { kind: "autonomy", level: "alto" }];
  assert.deepEqual(autonomyLevel({ ws: ws0("default: medio\n"), customer: "ACME", records: recs, envType: "preprod" }), { level: "alto", chosen: "alto", source: "frase", warning: null });
  assert.equal(autonomyLevel({ ws: ws0(null), customer: "ACME", envType: "prod" }).level, "medio");
  assert.equal(autonomyLevel({ ws: ws0(null), customer: "ACME", records: [{ kind: "autonomy", level: "basso" }], envType: "prod" }).level, "basso");
  assert.equal(capFor("dev"), "alto");
});

test("autonomia: file del cliente illeggibile o valore fuori elenco ⇒ basso con avviso", () => {
  for (const y of ["default: massimo\n", "{{{", "- alto\n"]) {
    const r = autonomyLevel({ ws: ws0(y), customer: "ACME", envType: "sandbox" });
    assert.equal(r.level, "basso", y); assert.match(r.warning, /autonomy\.yaml/);
  }
});
