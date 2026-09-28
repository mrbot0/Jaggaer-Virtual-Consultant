// WP09b B — catalogo iniziale dei check (§62) in product/kb/scopes/<S>/checks/: item CHK validi, nel cluster CL-CHK
// dichiarato (criteri del file del cluster), CHK.0051 "lo snapshot copre tutti gli oggetti governati"; gli eseguibili da
// script nominano un'implementazione di scripts/run/checks-run.mjs (verificato in test/run/checks-run.test.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { validateItem } from "../../scripts/kb/validate-schema.mjs";
import { evaluateCriterion } from "../../scripts/kb/cluster-rules.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
function catalog() {
  const out = [];
  const base = join(ROOT, "product/kb/scopes");
  for (const s of readdirSync(base)) {
    const d = join(base, s, "checks");
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d)) out.push({ file: f, scope: s, item: YAML.parse(readFileSync(join(d, f), "utf8")) });
  }
  return out;
}

test("§62: 21 check del catalogo iniziale, validi, codice = nome del file, scope ADM · XSC · VEN", () => {
  const all = catalog();
  assert.equal(all.length, 21);
  for (const { file, scope, item } of all) {
    assert.equal(`${item.id}.yaml`, file);
    assert.equal(item.id.split(".")[2], scope);
    const r = validateItem(item);
    assert.equal(r.ok, true, `${item.id}: ${r.errors.join("; ")}`);
  }
  assert.deepEqual([...new Set(all.map((x) => x.scope))].sort(), ["ADM", "VEN", "XSC"]);
  const snap = all.find((x) => x.item.id === "S.STD.ADM.CHK.0051").item;
  assert.match(snap.title, /snapshot copre tutti gli oggetti governati/i);
  assert.deepEqual(snap.cluster, ["CL-CHK-002"]);
  assert.equal(snap.how.script, "snapshot-coverage");
});

test("§62: ogni check soddisfa i criteri del suo cluster CL-CHK (file clusters/CL-CHK/*.yaml); copertura dei cluster 002-008, 010, 011", () => {
  const all = catalog();
  const clusters = new Set();
  for (const { item } of all) {
    for (const c of item.cluster) {
      clusters.add(c);
      const def = YAML.parse(readFileSync(join(ROOT, "clusters/CL-CHK", `${c}.yaml`), "utf8"));
      for (const crit of def.inclusion) assert.equal(evaluateCriterion(crit, item), true, `${item.id} ∉ ${c} (${crit.id})`);
      for (const crit of def.exclusion ?? []) assert.notEqual(evaluateCriterion(crit, item), true);
    }
  }
  assert.deepEqual([...clusters].sort(), ["CL-CHK-002", "CL-CHK-003", "CL-CHK-004", "CL-CHK-005", "CL-CHK-006", "CL-CHK-007", "CL-CHK-008", "CL-CHK-010", "CL-CHK-011"]);
});
