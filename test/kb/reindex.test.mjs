import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, unlinkSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../scripts/kb/db.mjs";
import { reindex } from "../../scripts/kb/reindex.mjs";

const fixture = readFileSync(new URL("../fixtures/items/valid.flw.yaml", import.meta.url), "utf8");

test("reindex calcola confidenza (peso della fonte §6.2), peso W e qualità Q", async () => {
  const YAML = (await import("yaml")).default;
  const root = mkdtempSync(join(tmpdir(), "kb-w-"));
  const dir = join(root, "kb", "scopes", "SRC", "flows"); mkdirSync(dir, { recursive: true });
  const base = YAML.parse(fixture);
  const write = (id, facets) => writeFileSync(join(dir, `${id}.yaml`), YAML.stringify({ ...base, id, facets: { ...base.facets, ...facets } }));
  write("S.STD.SRC.FLW.0001", { F1: "doc-standard", F8: "universale", F12: "promosso" });
  write("S.STD.SRC.FLW.0002", { F1: "spec-integrazione-formale", F8: "universale", F12: "grezzo" });
  write("S.STD.SRC.FLW.0003", { F1: "esecuzione-test", F8: "condizionata", F12: "validato" });
  const db = openDb(join(root, "k.db"));
  reindex(root, join(root, "k.db"), { clustersDir: null });
  const row = (c) => db.prepare("select confidence, weight, quality from items where code=?").get(c);
  const promoted = row("S.STD.SRC.FLW.0001");
  assert.equal(promoted.confidence, 0.7);          // doc-standard 0.70 × freschezza 1.0
  assert.ok(promoted.weight > 0);
  assert.equal(promoted.weight, 0.7);              // × universale 1.00 × promosso 1.00
  assert.ok(promoted.quality > 0 && promoted.quality <= 1);
  assert.equal(row("S.STD.SRC.FLW.0002").confidence, 0.95);
  assert.equal(row("S.STD.SRC.FLW.0002").weight, 0);  // grezzo
  assert.equal(row("S.STD.SRC.FLW.0003").weight, 0.17); // 1.00 × condizionata non soddisfatta 0.20 × validato 0.85
});

test("indicizza, salta gli invariati, depreca gli spariti", () => {
  const root = mkdtempSync(join(tmpdir(), "kb-root-"));
  const dir = join(root, "kb", "scopes", "SRC", "flows"); mkdirSync(dir, { recursive: true });
  const file = join(dir, "S.STD.SRC.FLW.0003.yaml"); writeFileSync(file, fixture);
  const dbPath = join(root, "knowledge.db");

  let r = reindex(root, dbPath);
  assert.deepEqual([r.scanned, r.upserted, r.unchanged, r.deprecated], [1, 1, 0, 0]);
  r = reindex(root, dbPath);
  assert.deepEqual([r.upserted, r.unchanged], [0, 1]);

  const db = openDb(dbPath);
  assert.equal(db.prepare("select count(*) as n from items_fts where items_fts match 'gara'").get().n, 1);

  unlinkSync(file);
  r = reindex(root, dbPath);
  assert.equal(r.deprecated, 1);
  assert.equal(db.prepare("select status from items where code='S.STD.SRC.FLW.0003'").get().status, "deprecato");
});
