import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../scripts/kb/db.mjs";
import { assignSeq, formatCode } from "../../scripts/kb/assign-seq.mjs";

test("i SEQ sono progressivi per (livello, cliente, scope, tipo)", () => {
  const db = openDb(join(mkdtempSync(join(tmpdir(), "seq-")), "k.db"));
  const key = { level: "S", customer: "STD", scope: "SRC", type: "FLW" };
  const ins = db.prepare("insert into items(code,level,customer,scope,type,title,summary,facets,status,path,hash,updated_at) values (?,?,?,?,?,?,?,?,?,?,?,?)");
  const a = assignSeq(db, key);
  ins.run(formatCode({ ...key, seq: a }), "S","STD","SRC","FLW","t","s","{}","digerito","p","h","2026-09-23");
  assert.equal(assignSeq(db, key), a + 1);
  assert.equal(formatCode({ ...key, seq: a }), "S.STD.SRC.FLW.0001");
  assert.equal(assignSeq(db, { ...key, type: "KEY" }), 1);
});

test("un codice già presente non viene sovrascritto (Review Focus 3)", () => {
  const db = openDb(join(mkdtempSync(join(tmpdir(), "seq-")), "k.db"));
  const ins = db.prepare("insert into items(code,level,customer,scope,type,title,summary,facets,status,path,hash,updated_at) values (?,?,?,?,?,?,?,?,?,?,?,?)");
  const row = ["S.STD.SRC.FLW.0001","S","STD","SRC","FLW","t","s","{}","digerito","p","h","2026-09-23"];
  ins.run(...row);
  assert.throws(() => ins.run(...row), /UNIQUE|PRIMARY KEY/);
});
