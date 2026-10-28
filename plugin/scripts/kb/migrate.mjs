// kb migrate (§49.4, §56.3) — WP09d. Applica le migrazioni SQL in ordine (file → DB, mai il contrario), le registra
// in schema_migrations (nome, sha256, orario), porta knowledge_version al massimo dichiarato dal plugin
// (plugin.json metadata.knowledge_version_max) e, con --root, ricostruisce l'indice (reindex). Un DB con
// knowledge_version PIÙ NUOVA del plugin non si tocca (exit 3): va aggiornato il plugin, non la conoscenza.
import Database from "./sqlite.mjs";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { openDb } from "./db.mjs";
import { reindex } from "./reindex.mjs";
import { parseArgs, fail } from "../lib/args.mjs";
import { isMain } from "../lib/is-main.mjs";

const MIG_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");
const MANIFEST = new URL("../../.claude-plugin/plugin.json", import.meta.url);
export class MigrateRefusal extends Error { constructor(m) { super(m); this.name = "MigrateRefusal"; } }

export const migrationFiles = () => readdirSync(MIG_DIR).filter((f) => f.endsWith(".sql")).sort()
  .map((name) => { const text = readFileSync(join(MIG_DIR, name), "utf8"); return { name, sha256: createHash("sha256").update(text.replace(/\r\n/g, "\n")).digest("hex") }; });
export function pluginKnowledgeRange() {
  const m = JSON.parse(readFileSync(MANIFEST, "utf8")).metadata ?? {};
  return { min: Number(m.knowledge_version_min), max: Number(m.knowledge_version_max) };
}

// Stato prima di aprire in scrittura: versione e migrazioni già registrate (DB assente ⇒ tutto da applicare).
export function inspect(dbPath) {
  if (!existsSync(dbPath)) return { exists: false, version: null, applied: new Set() };
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const has = (t) => !!db.prepare("select 1 from sqlite_master where type='table' and name=?").get(t);
    const version = has("meta") ? db.prepare("select value from meta where key='knowledge_version'").get()?.value ?? null : null;
    const applied = has("schema_migrations") ? new Set(db.prepare("select name from schema_migrations").all().map((r) => r.name)) : new Set();
    return { exists: true, version, applied };
  } finally { db.close(); }
}

export function migrate(dbPath, { root = null, dryRun = false, now = new Date(), range = pluginKnowledgeRange() } = {}) {
  const before = inspect(dbPath);
  const files = migrationFiles();
  const pending = files.filter((f) => !before.applied.has(f.name)).map((f) => f.name);
  const from = before.version == null ? null : Number(before.version);
  if (from != null && Number.isFinite(range.max) && from > range.max) throw new MigrateRefusal(`knowledge_version ${from} più nuova del plugin (ammessa fino a ${range.max}): aggiorna il plugin, la conoscenza non si retrocede`);
  const to = Number.isFinite(range.max) ? Math.max(from ?? range.max, range.max) : from;
  if (dryRun) return { dry_run: true, pending, knowledge_version: { from, to } };
  const db = openDb(dbPath);   // applica ogni migrazione (idempotenti, in ordine)
  try {
    db.transaction(() => {
      const ins = db.prepare("insert or ignore into schema_migrations(name, sha256, applied_at) values (?,?,?)");
      for (const f of files) ins.run(f.name, f.sha256, now.toISOString());
      if (to != null) db.prepare("insert into meta(key, value) values ('knowledge_version', ?) on conflict(key) do update set value=excluded.value").run(String(to));
    })();
  } finally { db.close(); }
  const stats = root ? reindex(root, dbPath) : null;
  return { dry_run: false, applied: pending, knowledge_version: { from, to }, reindex: stats };
}

export const HELP = `uso: kb migrate --db <knowledge.db> [--root <cartella con kb/>] [--dry-run] [--json] [--help]

Applica le migrazioni SQL pendenti (scripts/kb/migrations, in ordine; file → DB, mai il contrario) e le registra in
schema_migrations; porta knowledge_version al massimo ammesso dal plugin (plugin.json metadata.knowledge_version_max);
con --root ricostruisce l'indice (reindex). È il solo comando ammesso con un DB fuori intervallo (§49.4).

Exit code: 0 ok · 1 argomenti non validi · 2 errore di sistema · 3 DB più nuovo del plugin (rifiutato).`;

export function main(argv) {
  const { opts } = parseArgs(argv, { flags: ["dry-run"] });
  const asJson = !!opts.json;
  if (opts.help) { console.log(HELP); return 0; }
  if (!opts.db) return fail(asJson, 1, "richiesto --db <knowledge.db>");
  if (opts.root && !existsSync(opts.root)) return fail(asJson, 1, `--root non trovato: ${opts.root}`);
  try {
    const r = migrate(opts.db, { root: opts.root ?? null, dryRun: !!opts["dry-run"] });
    console.log(JSON.stringify({ ok: true, ...r }));
    return 0;
  } catch (err) {
    if (err instanceof MigrateRefusal) return fail(asJson, 3, err.message);
    return fail(asJson, 2, `errore di sistema: ${err?.message ?? err}`);
  }
}

if (isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2));
