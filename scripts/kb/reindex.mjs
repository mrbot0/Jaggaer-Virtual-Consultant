import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";
import YAML from "yaml";
import { openDb } from "./db.mjs";
import { validateItem } from "./validate-schema.mjs";
import { parseCode } from "./codes.mjs";
import { validateCluster } from "./cluster-rules.mjs";
import { fileURLToPath } from "node:url";
import { isMain } from "../lib/is-main.mjs";

function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (!e.name.startsWith(".") && e.name !== "_inbox") yield* walk(p); }
    else if (/\.ya?ml$/.test(e.name) && /^[SCL]\./.test(e.name)) yield p;
  }
}

export const DEFAULT_CLUSTERS_DIR = fileURLToPath(new URL("../../clusters", import.meta.url));

function* walkClusters(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walkClusters(p);
    else if (/^CL-.+\.ya?ml$/.test(e.name)) yield p;
  }
}

// Upsert dei file CLS nella tabella `clusters` (+ cluster_details). Lo stato
// gestito dalle operazioni del validatore (fuso, deprecato) non viene
// sovrascritto dal file: il ciclo di vita è nel DB, il contenuto nel file.
export function upsertClusters(db, dir) {
  const stats = { clusters_upserted: 0, clusters_invalid: 0 };
  if (!dir || !existsSync(dir)) return stats;
  const up = db.prepare(`insert into clusters(code,family,name,definition,inclusion,exclusion,facet_signature,owner,portability,status,item_code)
    values (@code,@family,@name,@definition,@inclusion,@exclusion,@facet_signature,@owner,@portability,@status,null)
    on conflict(code) do update set family=excluded.family, name=excluded.name, definition=excluded.definition, inclusion=excluded.inclusion,
    exclusion=excluded.exclusion, facet_signature=excluded.facet_signature, owner=excluded.owner, portability=excluded.portability,
    status=case when clusters.status in ('fuso','deprecato') then clusters.status else excluded.status end`);
  const det = db.prepare(`insert into cluster_details(code,domain,depth,parent,base_risk,path,hash) values (@code,@domain,@depth,@parent,@base_risk,@path,@hash)
    on conflict(code) do update set domain=excluded.domain, depth=excluded.depth, parent=excluded.parent, base_risk=excluded.base_risk,
    path=excluded.path, hash=excluded.hash`);
  for (const file of walkClusters(dir)) {
    const text = readFileSync(file, "utf8");
    const c = YAML.parse(text);
    if (!validateCluster(c).ok) { stats.clusters_invalid++; continue; }
    up.run({ code: c.code, family: c.family, name: c.name, definition: c.definition, inclusion: JSON.stringify(c.inclusion),
      exclusion: JSON.stringify(c.exclusion), facet_signature: JSON.stringify(c.facet_signature), owner: c.owner,
      portability: JSON.stringify(c.portability), status: c.status });
    det.run({ code: c.code, domain: c.domain, depth: c.depth, parent: c.parent ?? null, base_risk: c.base_risk ?? null,
      path: relative(dir, file), hash: createHash("sha256").update(text).digest("hex") });
    stats.clusters_upserted++;
  }
  return stats;
}

export function reindex(root, dbPath, { clustersDir = DEFAULT_CLUSTERS_DIR } = {}) {
  const db = openDb(dbPath);
  const stats = { scanned: 0, upserted: 0, unchanged: 0, deprecated: 0, invalid: 0 };
  const seen = new Set();
  const get = db.prepare("select hash from items where code=?");
  const upsert = db.prepare(`insert into items(code,level,customer,scope,type,version,title,summary,facets,status,path,hash,updated_at,verified_at,release_ref)
    values (@code,@level,@customer,@scope,@type,@version,@title,@summary,@facets,@status,@path,@hash,@updated_at,@verified_at,@release_ref)
    on conflict(code) do update set title=excluded.title, summary=excluded.summary, facets=excluded.facets, status=excluded.status,
    path=excluded.path, hash=excluded.hash, updated_at=excluded.updated_at, verified_at=excluded.verified_at, release_ref=excluded.release_ref, version=excluded.version`);
  const ftsDel = db.prepare("delete from items_fts where code=?");
  const ftsIns = db.prepare("insert into items_fts(code,title,summary) values (?,?,?)");
  const kbDir = existsSync(join(root, "kb")) ? join(root, "kb") : root;
  db.transaction(() => {
    for (const file of walk(kbDir)) {
      stats.scanned++;
      const text = readFileSync(file, "utf8");
      const hash = createHash("sha256").update(text).digest("hex");
      const obj = YAML.parse(text);
      if (!validateItem(obj).ok) { stats.invalid++; continue; }
      const c = parseCode(obj.id); seen.add(obj.id);
      if (get.get(obj.id)?.hash === hash) { stats.unchanged++; continue; }
      upsert.run({ code: obj.id, level: c.level, customer: c.customer, scope: c.scope, type: c.type, version: c.version, title: obj.title,
        summary: obj.summary, facets: JSON.stringify(obj.facets), status: obj.facets.F12, path: relative(root, file), hash,
        updated_at: new Date(statSync(file).mtimeMs).toISOString(), verified_at: obj.facets.F13?.verified_at ?? null, release_ref: obj.facets.F13?.release ?? null });
      ftsDel.run(obj.id); ftsIns.run(obj.id, obj.title, obj.summary);
      stats.upserted++;
    }
    const dep = db.prepare("update items set status='deprecato' where code=?");
    for (const { code } of db.prepare("select code from items where status<>'deprecato'").all()) if (!seen.has(code)) { dep.run(code); stats.deprecated++; }
    Object.assign(stats, upsertClusters(db, clustersDir));
  })();
  return stats;
}

function printHelp() {
  console.log(`uso: node scripts/kb/reindex.mjs --root <dir> --db <file> [--clusters <dir>] [--json] [--help]

Scansiona <dir>/kb, calcola l'hash di ogni item YAML, aggiorna items e
items_fts nel DB SQLite; deprecato per gli item spariti dal filesystem.
--clusters: cartella dei file CLS da caricare in clusters (default: clusters/ del plugin).

Exit code: 0 ok · 1 errore utente (argomenti mancanti) · 2 errore di sistema.`);
}

if (isMain(import.meta.url)) {
  const a = process.argv;
  if (a.includes("--help")) { printHelp(); process.exit(0); }
  const asJson = a.includes("--json");
  const root = a[a.indexOf("--root") + 1];
  const db = a[a.indexOf("--db") + 1];
  if (!root || !db || a.indexOf("--root") < 0 || a.indexOf("--db") < 0) {
    if (asJson) console.log(JSON.stringify({ ok: false, error: "richiesti --root <dir> e --db <file>" }));
    else { console.error("errore: richiesti --root <dir> e --db <file>"); printHelp(); }
    process.exit(1);
  }
  try {
    const ci = a.indexOf("--clusters");
    const stats = reindex(root, db, ci >= 0 && a[ci + 1] ? { clustersDir: a[ci + 1] } : {});
    console.log(JSON.stringify(asJson ? { ok: true, ...stats } : stats));
    process.exit(0);
  } catch (err) {
    if (asJson) console.log(JSON.stringify({ ok: false, error: String(err?.message ?? err) }));
    else console.error(`errore di sistema: ${err?.message ?? err}`);
    process.exit(2);
  }
}
