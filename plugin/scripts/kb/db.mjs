import Database from "better-sqlite3";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
const MIG_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");

export function openDb(path, { createIfMissing = true } = {}) {
  if (!createIfMissing && path !== ":memory:" && !existsSync(path)) {
    throw new Error(`database non trovato: ${path}`);
  }
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  for (const f of readdirSync(MIG_DIR).filter((f) => f.endsWith(".sql")).sort()) db.exec(readFileSync(join(MIG_DIR, f), "utf8"));
  return db;
}
