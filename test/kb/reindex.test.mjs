import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, unlinkSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../scripts/kb/db.mjs";
import { reindex } from "../../scripts/kb/reindex.mjs";

const fixture = readFileSync(new URL("../fixtures/items/valid.flw.yaml", import.meta.url), "utf8");

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
