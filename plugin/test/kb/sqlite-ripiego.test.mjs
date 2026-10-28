// 28/10/2026: senza il binario nativo di better-sqlite3 (installazione senza script npm) il plugin usa node:sqlite:
// stessa interfaccia (prepare/run/get/all, exec, pragma, transaction[.immediate], savepoint annidati, sola lettura).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("ripiego su node:sqlite: openDb con le migrazioni, transazioni, rollback e sola lettura", async () => {
  process.env.JVC_SQLITE = "node";
  try {
    const { openDb } = await import("../../scripts/kb/db.mjs");
    const { default: Database } = await import("../../scripts/kb/sqlite.mjs");
    const f = join(mkdtempSync(join(tmpdir(), "sq-")), "k.db");
    const db = openDb(f);
    assert.ok(existsSync(f));
    db.exec("create table if not exists t_ripiego(a integer primary key, b text)");
    const ins = db.prepare("insert into t_ripiego(b) values (?)");
    assert.equal(db.transaction(() => { ins.run("x"); return ins.run("y").lastInsertRowid; }).immediate(), 2);
    assert.throws(() => db.transaction(() => { ins.run("z"); throw new Error("boom"); })(), /boom/);
    db.transaction(() => { ins.run("p"); try { db.transaction(() => { ins.run("q"); throw new Error("inner"); })(); } catch { /* annidata */ } })();
    assert.deepEqual(db.prepare("select b from t_ripiego order by a").all().map((r) => r.b), ["x", "y", "p"]);
    assert.equal(db.prepare("select count(*) as n from t_ripiego where b = 'nessuno'").get().n, 0);
    assert.equal(db.prepare("select * from t_ripiego where b = 'nessuno'").get(), undefined);
    db.close();
    const ro = new Database(f, { readonly: true, fileMustExist: true });
    assert.equal(ro.prepare("select count(*) as n from t_ripiego").get().n, 3);
    assert.throws(() => ro.exec("insert into t_ripiego(b) values ('w')"));
    ro.close();
    assert.throws(() => new Database(join(tmpdir(), "non-esiste-xyz.db"), { readonly: true, fileMustExist: true }));
  } finally { delete process.env.JVC_SQLITE; }
});
