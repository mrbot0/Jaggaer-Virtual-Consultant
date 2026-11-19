import Database from "./sqlite.mjs";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
const MIG_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");

// 18/11/2026 (ciclo di bug fixing): ogni apertura eseguiva tutte le migrazioni (CREATE … IF NOT EXISTS), che chiedono il
// blocco di scrittura anche quando lo schema c'è già: con uno scrittore lungo in corso (reindex, atlas-build) anche i
// comandi di sola lettura (kb find, get, precedents, why…) fallivano con «database is locked» dopo 5 s. Le migrazioni sono
// solo CREATE … IF NOT EXISTS e INSERT OR IGNORE: se tutti gli oggetti che creano esistono già (e meta ha la versione) non
// c'è nulla da fare e non si eseguono. Una migrazione con altre istruzioni (ALTER, UPDATE…) si esegue sempre, come prima.
let MIGRATIONS = null;
function migrations() {
  if (MIGRATIONS) return MIGRATIONS;
  const sql = readdirSync(MIG_DIR).filter((f) => f.endsWith(".sql")).sort().map((f) => readFileSync(join(MIG_DIR, f), "utf8"));
  const objects = new Set();
  let simple = true;
  for (const text of sql) {
    const body = text.replace(/--[^\n]*/g, "");
    for (const st of body.split(";").map((s) => s.trim()).filter(Boolean)) {
      const m = /^CREATE\s+(?:VIRTUAL\s+)?(?:TABLE|INDEX|TRIGGER|VIEW)\s+IF\s+NOT\s+EXISTS\s+([A-Za-z_][\w]*)/i.exec(st);
      if (m) objects.add(m[1]);
      else if (!/^INSERT\s+OR\s+IGNORE\s+INTO\s+meta\b/i.test(st)) simple = false;
    }
  }
  return (MIGRATIONS = { sql, objects, simple });
}
function schemaComplete(db, mig) {
  if (!mig.simple) return false;
  const have = new Set(db.prepare("select name from sqlite_master").all().map((r) => r.name));
  for (const o of mig.objects) if (!have.has(o)) return false;
  return !!db.prepare("select 1 from meta where key='knowledge_version'").get();
}

export function openDb(path, { createIfMissing = true } = {}) {
  if (!createIfMissing && path !== ":memory:" && !existsSync(path)) {
    throw new Error(`database non trovato: ${path}`);
  }
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  const mig = migrations();
  if (!schemaComplete(db, mig)) for (const text of mig.sql) db.exec(text);
  return db;
}
