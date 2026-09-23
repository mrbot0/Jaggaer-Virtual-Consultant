import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { openDb } from "../../scripts/kb/db.mjs";
import { find } from "../../scripts/kb/find.mjs";
import { resolve } from "../../scripts/kb/resolve.mjs";

const KB_CLI = fileURLToPath(new URL("../../scripts/kb/kb.mjs", import.meta.url));

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

test("find rifiuta chiavi di faccetta non in allowlist (SQL injection guard)", () => {
  const db = openDb(join(mkdtempSync(join(tmpdir(), "inj-")), "k.db")); seed(db);
  assert.throws(() => find(db, { facet: { "F10') OR ('1'='1": "x" } }), /faccetta non valida/);
  assert.throws(() => find(db, { facet: { F16: "x" } }), /faccetta non valida/);
  assert.throws(() => find(db, { facet: { F0: "x" } }), /faccetta non valida/);
  // le chiavi valide F1..F15 continuano a funzionare
  assert.doesNotThrow(() => find(db, { facet: { F10: "R0" } }));
});

test("kb.mjs CLI: chiave di faccetta non valida esce con 1, non 2 (errore utente, §44.5)", () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), "inj-cli-")), "k.db");
  seed(openDb(dbPath));
  const r = spawnSync(process.execPath, [KB_CLI, "find", "--facet", "F16=x", "--db", dbPath, "--json"]);
  assert.equal(r.status, 1);
});

test("kb.mjs CLI: --db su file inesistente esce con 1 e non lo crea (delegato a openDb createIfMissing:false)", () => {
  const dir = mkdtempSync(join(tmpdir(), "nodb-cli-"));
  const missing = join(dir, "non-esiste.db");
  const r = spawnSync(process.execPath, [KB_CLI, "find", "--db", missing, "--json"]);
  assert.equal(r.status, 1);
  const out = JSON.parse(r.stdout.toString());
  assert.equal(out.ok, false);
  assert.match(out.error, /non trovato/);
  assert.equal(existsSync(missing), false);
});
