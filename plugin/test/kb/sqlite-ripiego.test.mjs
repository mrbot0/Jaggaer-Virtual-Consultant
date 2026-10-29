// 28/10/2026: senza il binario nativo di better-sqlite3 (installazione senza script npm) il plugin usava node:sqlite.
// 29/10/2026 (decisione dell'utente, punto 9 del piano): node:sqlite è l'unico motore — nessun import di better-sqlite3,
// stessa interfaccia (prepare/run/get/all, exec, pragma anche { simple: true }, transaction[.immediate] con savepoint
// annidati, sola lettura con fileMustExist), righe come oggetti ordinari, numeri e non BigInt, nessun avviso su stderr.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { ROOT } from "../helpers/hook-env.mjs";

const SQLITE = join(ROOT, "scripts", "kb", "sqlite.mjs");
const tmpDb = () => join(mkdtempSync(join(tmpdir(), "sq-")), "k.db");

test("motore unico node:sqlite: openDb con le migrazioni in WAL, transazioni .immediate, rollback, savepoint annidati, sola lettura", async () => {
  const { openDb } = await import("../../scripts/kb/db.mjs");
  const { default: Database, engine } = await import("../../scripts/kb/sqlite.mjs");
  assert.equal(engine(), "node:sqlite");
  const f = tmpDb();
  const db = openDb(f);
  assert.ok(existsSync(f));
  assert.equal(db.pragma("journal_mode", { simple: true }), "wal");
  assert.deepEqual(db.pragma("journal_mode"), [{ journal_mode: "wal" }]);
  assert.equal(db.pragma("busy_timeout", { simple: true }), 5000);
  assert.equal(db.pragma("foreign_keys", { simple: true }), 0, "foreign_keys spenti come in SQLite e better-sqlite3");
  db.exec("create table if not exists t_ripiego(a integer primary key, b text)");
  const ins = db.prepare("insert into t_ripiego(b) values (?)");
  const r = ins.run("w");
  assert.deepEqual(r, { changes: 1, lastInsertRowid: 1 });
  assert.equal(typeof r.lastInsertRowid, "number");
  assert.equal(db.transaction(() => { ins.run("x"); return ins.run("y").lastInsertRowid; }).immediate(), 3);
  assert.throws(() => db.transaction(() => { ins.run("z"); throw new Error("boom"); })(), /boom/);
  assert.equal(db.inTransaction, false);
  db.transaction(() => { ins.run("p"); try { db.transaction(() => { ins.run("q"); throw new Error("inner"); })(); } catch { /* annidata */ } })();
  db.transaction(() => { db.transaction(() => { ins.run("n"); }).immediate(); })();
  assert.deepEqual(db.prepare("select b from t_ripiego order by a").all().map((x) => x.b), ["w", "x", "y", "p", "n"]);
  assert.equal(db.prepare("delete from t_ripiego where b in ('p', 'n')").run().changes, 2);
  assert.equal(db.prepare("select count(*) as n from t_ripiego where b = 'nessuno'").get().n, 0);
  assert.equal(db.prepare("select * from t_ripiego where b = 'nessuno'").get(), undefined);
  db.close();
  db.close();   // chiudere due volte non è un errore (come better-sqlite3)
  assert.equal(db.open, false);
  const ro = new Database(f, { readonly: true, fileMustExist: true });
  assert.equal(ro.readonly, true);
  assert.equal(ro.prepare("select count(*) as n from t_ripiego").get().n, 3);
  assert.throws(() => ro.exec("insert into t_ripiego(b) values ('v')"));
  ro.close();
  assert.throws(() => new Database(join(tmpdir(), "non-esiste-xyz.db"), { readonly: true, fileMustExist: true }), /does not exist/);
});

test("parametri e righe alla maniera di better-sqlite3: oggetti ordinari, nominati con chiavi in più, array posizionali, undefined = NULL, BLOB come Buffer", async () => {
  const { default: Database } = await import("../../scripts/kb/sqlite.mjs");
  const db = new Database(":memory:");
  db.exec("create table t(a integer primary key, b text, c text, d blob)");
  const row0 = db.prepare("select 1 as x, 'y' as y").get();
  assert.equal(Object.getPrototypeOf(row0), Object.prototype, "node:sqlite dà righe con prototipo null: qui oggetti ordinari");
  assert.deepStrictEqual(row0, { x: 1, y: "y" });
  db.prepare("insert into t(b, c) values (@b, @c)").run({ b: "uno", c: "due", extra: "ignorato" });
  db.prepare("insert into t(b, c) values (?, ?)").run(["tre", "quattro"]);
  db.prepare("insert into t(b, c) values (?, ?)").run("cinque", undefined);
  db.prepare("insert into t(b, c) values (?, @c)").run("sei", { c: "sette" });
  db.prepare("insert into t(b, d) values (?, ?)").run("blob", Buffer.from("hi"));
  assert.deepStrictEqual(db.prepare("select b, c from t where d is null order by a").all(), [
    { b: "uno", c: "due" }, { b: "tre", c: "quattro" }, { b: "cinque", c: null }, { b: "sei", c: "sette" },
  ]);
  const blob = db.prepare("select d from t where b = 'blob'").get().d;
  assert.ok(Buffer.isBuffer(blob));
  assert.equal(blob.toString("utf8"), "hi");
  assert.deepStrictEqual([...db.prepare("select b from t where a <= ? order by a").iterate(2)], [{ b: "uno" }, { b: "tre" }]);
  assert.equal(typeof db.prepare("select count(*) as n from t").get().n, "number", "numeri, mai BigInt");
  db.close();
});

test("node:sqlite senza setAllowUnknownNamedParameters (Node < 22.15): le chiavi in più si tolgono leggendo i nomi della query", async () => {
  const require = createRequire(import.meta.url);
  const { StatementSync } = require("node:sqlite");
  const desc = Object.getOwnPropertyDescriptor(StatementSync.prototype, "setAllowUnknownNamedParameters");
  if (!desc) return;   // Node che non lo ha già: il ramo è quello normale
  Object.defineProperty(StatementSync.prototype, "setAllowUnknownNamedParameters", { ...desc, value: undefined });
  try {
    const { default: Database } = await import("../../scripts/kb/sqlite.mjs");
    const db = new Database(":memory:");
    db.exec("create table t(a integer primary key, b text, c text)");
    db.prepare("insert into t(b, c) values (:b, $c)").run({ b: "uno", c: "due", extra: 1, altro: "x" });
    assert.deepStrictEqual(db.prepare("select b, c from t").get(), { b: "uno", c: "due" });
    db.close();
  } finally { Object.defineProperty(StatementSync.prototype, "setAllowUnknownNamedParameters", desc); }
});

test("nessun avviso su stderr: il caricamento di node:sqlite è silenzioso e solo l'ExperimentalWarning di SQLite è scartato", () => {
  const code = `import Database from ${JSON.stringify(pathToFileURL(SQLITE).href)}; const d = new Database(":memory:"); d.prepare("select 1").get(); d.close(); console.log("ok");`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "ok");
  assert.equal(r.stderr.trim(), "", `stderr non vuoto (${process.version}): ${r.stderr}`);
  // Node 22/23: «SQLite is an experimental feature…» emesso dal require → scartato; ogni altro avviso passa
  const sim = `import { withoutSqliteWarning } from ${JSON.stringify(pathToFileURL(SQLITE).href)};
withoutSqliteWarning(() => { process.emitWarning("SQLite is an experimental feature and might change at any time", "ExperimentalWarning"); });
withoutSqliteWarning(() => { process.emitWarning("Altro is an experimental feature", "ExperimentalWarning"); });
process.emitWarning("SQLite fuori dal require", "ExperimentalWarning");`;
  const s = spawnSync(process.execPath, ["--input-type=module", "-e", sim], { encoding: "utf8" });
  assert.equal(s.status, 0, s.stderr);
  assert.doesNotMatch(s.stderr, /SQLite is an experimental feature/);
  assert.match(s.stderr, /Altro is an experimental feature/);
  assert.match(s.stderr, /SQLite fuori dal require/, "il filtro vale solo durante il caricamento");
});

test("doctor deps: non cerca più better-sqlite3, riporta il motore node:sqlite e la versione di Node; senza node:sqlite rosso", async () => {
  const { checkDeps } = await import("../../scripts/admin/doctor.mjs");
  const g = checkDeps(ROOT);
  assert.equal(g.status, "green", JSON.stringify(g));
  assert.match(g.detail, new RegExp(`SQLite: node:sqlite \\(Node ${process.versions.node.replace(/\./g, "\\.")}\\)`));
  assert.doesNotMatch(g.detail, /better-sqlite3/);
  const r = checkDeps(ROOT, { sqlite: () => null, nodeVersion: "22.10.0" });
  assert.equal(r.status, "red");
  assert.match(r.detail, /node:sqlite non disponibile in Node 22\.10\.0/);
  assert.match(r.fix, /22\.13/);
});

test("nessuna dipendenza da better-sqlite3: né in package.json né negli import di hooks/ e scripts/; engines.node ≥ 22.5", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert.equal(pkg.dependencies?.["better-sqlite3"], undefined);
  assert.ok(!Object.keys(pkg.allowScripts ?? {}).some((k) => k.startsWith("better-sqlite3")));
  assert.equal(pkg.engines?.node, ">=22.5");
  const lock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8"));
  assert.ok(!Object.keys(lock.packages ?? {}).some((k) => /better-sqlite3/.test(k)), "package-lock.json senza better-sqlite3");
  const hits = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== "node_modules") walk(p); } else if (/\.(mjs|js|cjs)$/.test(e.name) && /(from\s+|import\(|require\()\s*["']better-sqlite3["']/.test(readFileSync(p, "utf8"))) hits.push(p.slice(ROOT.length));
    }
  };
  for (const d of ["hooks", "scripts", "mcp", "test"]) walk(join(ROOT, d));
  assert.deepEqual(hits, []);
});
