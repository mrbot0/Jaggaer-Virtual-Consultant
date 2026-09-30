import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../scripts/kb/db.mjs";
import { withLock } from "../../scripts/kb/lock.mjs";

test("apre in WAL, applica la migrazione, registra la versione", () => {
  const db = openDb(join(mkdtempSync(join(tmpdir(), "kb-")), "knowledge.db"));
  assert.equal(db.pragma("journal_mode", { simple: true }), "wal");
  const tables = db.prepare("select name from sqlite_master where type in ('table','virtual table')").all().map((r) => r.name);
  for (const t of ["items","relations","clusters","cluster_members","observations","lessons","decisions","outcomes","epistemic","contradictions","sessions","items_fts","meta"]) assert.ok(tables.includes(t), t);
  assert.equal(db.prepare("select value from meta where key='knowledge_version'").get().value, "1");
});

test("openDb con createIfMissing:false rifiuta un percorso inesistente senza crearlo", () => {
  const dir = mkdtempSync(join(tmpdir(), "kb-nocreate-"));
  const missing = join(dir, "non-esiste.db");
  assert.throws(() => openDb(missing, { createIfMissing: false }), /non trovato/);
  assert.equal(existsSync(missing), false);
  // il default (createIfMissing:true) continua a creare il file
  const ok = join(dir, "creato.db");
  openDb(ok);
  assert.equal(existsSync(ok), true);
});

test("un lock attivo impedisce un secondo lock finché non scade", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lock-"));
  let inner = false;
  await withLock(dir, "knowledge", 1000, async () => {
    await assert.rejects(() => withLock(dir, "knowledge", 1000, async () => { inner = true; }), /lock attivo/);
  });
  assert.equal(inner, false);
});
