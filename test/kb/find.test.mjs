import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../scripts/kb/db.mjs";
import { find } from "../../scripts/kb/find.mjs";
import { resolve } from "../../scripts/kb/resolve.mjs";

function seed(db) {
  const ins = db.prepare("insert into items(code,level,customer,scope,type,title,summary,facets,weight,status,path,hash,updated_at) values (?,?,?,?,?,?,?,?,?,?,?,?,?)");
  const fts = db.prepare("insert into items_fts(code,title,summary) values (?,?,?)");
  const rows = [
    ["S.STD.SRC.FLW.0001","S","STD","SRC","FLW","Creare evento di gara","crea un evento di gara standard",'{"F10":"R1"}',0.9,"promosso","p","h1","2026-09-23"],
    ["S.STD.SRC.FLW.0002","S","STD","SRC","FLW","Pubblicare evento","pubblica un evento di gara ai fornitori",'{"F10":"R2"}',0.7,"validato","p","h2","2026-09-23"],
    ["S.STD.SRC.CHK.0001","S","STD","SRC","CHK","Categoria attiva","verifica categoria attiva",'{"F10":"R0"}',0.95,"promosso","p","h3","2026-09-23"],
  ];
  for (const r of rows) { ins.run(...r); fts.run(r[0], r[5], r[6]); }
}

test("find filtra per faccetta e ordina per W, con troncamento", () => {
  const db = openDb(join(mkdtempSync(join(tmpdir(), "f-")), "k.db")); seed(db);
  const r = find(db, { scope: "SRC", type: "FLW", top: 1 });
  assert.equal(r.length, 1); assert.equal(r[0].code, "S.STD.SRC.FLW.0001");
  assert.equal(find(db, { scope: "SRC", facet: { F10: "R0" } })[0].code, "S.STD.SRC.CHK.0001");
});

test("resolve usa FTS e ordina per rank × W", () => {
  const db = openDb(join(mkdtempSync(join(tmpdir(), "r-")), "k.db")); seed(db);
  const r = resolve(db, "evento di gara", { top: 2 });
  assert.equal(r[0].code, "S.STD.SRC.FLW.0001");
  assert.equal(r.length, 2);
});
