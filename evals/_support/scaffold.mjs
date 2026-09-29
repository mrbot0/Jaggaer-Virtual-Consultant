// Scaffold dei casi di evals/ (WP10b parte 2, §49.1). Lo lancia lo scaffold.sh di ogni caso quando la suite gira con
// `claude plugin eval . --scaffold`: la cartella corrente è il workspace vuoto della run. Costruisce il workspace
// dimostrativo del cliente fittizio ACME (più BETA, per i casi di isolamento) dallo scenario.yaml del caso:
//   - struttura §8.2 del cliente, environments.yaml di esempio (§51.1), knowledge.db del cliente e del prodotto
//     con le migrazioni applicate;
//   - item del kb (riga nel DB + file YAML minimo al suo percorso), forma epistemica per soggetto (tabella
//     epistemic), precedenti con esito (decisions + outcomes + decision_context), contraddizioni;
//   - file liberi dello scenario (grezzi in _inbox, documenti profilati, piani, snapshot).
// Nessun dato reale: solo i clienti fittizi dei test del plugin. Esportato buildWorkspace(ws, scenario) per il test
// strutturale (test/evals/evals-structure.test.mjs), che costruisce ogni scenario in una cartella temporanea e
// verifica che forma e precedente determinino la strategia attesa.
import { mkdirSync, writeFileSync, copyFileSync, readFileSync } from "node:fs";
import { join, dirname, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { openDb } from "../../scripts/kb/db.mjs";
import { itemFile, CODE_RE } from "../../scripts/lib/kb-items.mjs";
import { upsertClusters, DEFAULT_CLUSTERS_DIR } from "../../scripts/kb/reindex.mjs";

export const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const FICTIONAL_CUSTOMERS = ["ACME", "BETA"];
const CUSTOMER_DIRS = ["lessons", "decisions", "outcomes", "observations", "epistemic", "contradictions", "runs", "reports", "evidence",
  "tests", "_inbox", "audit", "config", "kb/scopes", "kb/handoffs", "sources/units"];
const DEFAULT_FACETS = { F5: "saas-core", F6: ["indiretto"], F7: "SAP", F10: "R1" };
// K per forma: valori che coverage() (scripts/kb/epistemic.mjs) classificherebbe nella stessa forma.
const K_OF = {
  consolidato: { k_tech: 0.8, k_use: 0.6, k_obs: 0.8, k_exec: 0.8 },
  libresco: { k_tech: 0.8, k_use: 0.5, k_obs: 0.1, k_exec: 0 },
  empirico: { k_tech: 0.1, k_use: 0.1, k_obs: 0.8, k_exec: 0.7 },
  ignoto: { k_tech: 0.1, k_use: 0.1, k_obs: 0, k_exec: 0 },
  contraddittorio: { k_tech: 0.7, k_use: 0.5, k_obs: 0.7, k_exec: 0.2 },
};
const sha = (s) => createHash("sha256").update(s).digest("hex");

function safeRel(ws, rel) {
  const abs = resolve(ws, rel);
  if (!abs.startsWith(resolve(ws) + sep)) throw new Error(`percorso dello scenario fuori dal workspace: ${rel}`);
  return abs;
}

function writeRel(ws, rel, content) {
  const abs = safeRel(ws, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, typeof content === "string" ? content : YAML.stringify(content));
}

function customerSkeleton(ws, c) {
  for (const d of CUSTOMER_DIRS) mkdirSync(join(ws, "customers", c, d), { recursive: true });
  copyFileSync(join(PLUGIN_ROOT, "test/fixtures/env/environments.yaml"), join(ws, "customers", c, "config", "environments.yaml"));
  openDb(join(ws, "customers", c, "knowledge.db")).close();
}

function insertItem(db, it, path) {
  const m = CODE_RE.exec(it.code);
  if (!m) throw new Error(`codice di item non valido nello scenario: ${it.code}`);
  const [, level, cust, scope, type] = m;
  const facets = { ...DEFAULT_FACETS, ...(it.facets ?? {}) };
  db.prepare(`insert or replace into items (code, level, customer, scope, type, version, title, summary, facets, confidence, quality, weight,
    status, path, hash, updated_at) values (?, ?, ?, ?, ?, 1, ?, ?, ?, 0.7, 0.7, ?, ?, ?, ?, ?)`)
    .run(it.code, level, cust, scope, type, it.title, it.summary, JSON.stringify(facets), it.weight ?? 0.5, it.status ?? "in-uso", path, sha(it.code + it.summary), "2026-09-20T10:00:00Z");
  db.prepare("insert into items_fts (code, title, summary) values (?, ?, ?)").run(it.code, it.title, it.summary);
  if (it.shape) {
    const k = { ...K_OF[it.shape], ...(it.k ?? {}) };
    db.prepare(`insert or replace into epistemic (subject_code, k_tech, k_use, k_obs, k_exec, k_user, k_level, shape, open_contradictions, computed_at)
      values (?, ?, ?, ?, ?, 0, null, ?, ?, ?)`).run(it.code, k.k_tech, k.k_use, k.k_obs, k.k_exec, it.shape, it.shape === "contraddittorio" ? 1 : 0, "2026-09-20T10:00:00Z");
  }
  for (const [attr, genre] of Object.entries(it.covered ?? {})) {
    db.prepare(`insert or replace into attribute_coverage (subject_code, attribute, units, genre, answered, contradiction, recorded_at)
      values (?, ?, '[]', ?, 1, 0, ?)`).run(it.code, attr, genre, "2026-09-20T10:00:00Z");
  }
  return facets;
}

function insertPrecedent(db, p, facetsBySubject, shapeBySubject) {
  db.prepare(`insert or replace into decisions (code, table_code, agent, session, subject_code, subject_cluster, inputs, priors, score, outcome, strategy, at)
    values (?, ?, ?, 'SES.ACME.20260901.001', ?, null, ?, '{}', null, ?, ?, ?)`)
    .run(p.code, p.table, p.agent ?? "scope-expert", p.subject, JSON.stringify({ shape: p.shape ?? shapeBySubject.get(p.subject) ?? null }), p.outcome, p.strategy ?? null, p.at ?? "2026-09-01T10:00:00Z");
  db.prepare("insert or replace into outcomes (decision_code, verified_at, verified_by, result, evidence_code, note) values (?, ?, 'learn', ?, null, ?)")
    .run(p.code, "2026-09-05T10:00:00Z", p.result, p.note ?? null);
  db.prepare("insert or replace into decision_context (decision_code, release_ref, shape, facets, confidence, effects) values (?, null, ?, ?, 0.7, 1)")
    .run(p.code, p.shape ?? shapeBySubject.get(p.subject) ?? null, JSON.stringify(facetsBySubject.get(p.subject) ?? DEFAULT_FACETS));
}

// Serie di item generati (blocco B, cluster-validator: scissione > 40 membri): { prefix: "C.ACME.CAT.CFG", start, count,
// title, summary, facets, facets_cycle: { Fn: [v1, v2] }, shape?, status?, body?, cluster? } → item con SEQ consecutivi e, con cluster,
// membri del cluster.
function expandGenerated(W) {
  const items = [];
  const members = [];
  for (const g of W.generated ?? []) {
    for (let i = 0; i < g.count; i++) {
      const code = `${g.prefix}.${String(g.start + i).padStart(4, "0")}`;
      const cyc = Object.fromEntries(Object.entries(g.facets_cycle ?? {}).map(([k, vs]) => [k, vs[i % vs.length]]));
      items.push({ code, title: `${g.title} ${i + 1}`, summary: g.summary, facets: { ...(g.facets ?? {}), ...cyc }, ...(g.shape ? { shape: g.shape } : {}), ...(g.status ? { status: g.status } : {}), ...(g.body ? { body: g.body } : {}) });
      if (g.cluster) members.push({ cluster: g.cluster, item: code });
    }
  }
  return { items, members };
}

// scenario.workspace: { items[], generated[], precedents[], contradictions[], clusters, cluster_members[], files{} }
// (tutti facoltativi). clusters: true carica nel DB di ACME il catalogo dei cluster del plugin (come reindex --clusters);
// cluster_members: [{ cluster, item }] ne registra i membri. Il percorso dell'item nel DB è relativo alla radice del
// proprietario (customers/<C>/ o product/), come lo scrive reindex.
export function buildWorkspace(ws, scenario) {
  const W = scenario?.workspace ?? {};
  mkdirSync(join(ws, "product", "kb", "scopes"), { recursive: true });
  mkdirSync(join(ws, "product", "kb", "handoffs"), { recursive: true });
  for (const c of FICTIONAL_CUSTOMERS) customerSkeleton(ws, c);
  const product = openDb(join(ws, "product", "knowledge.db"));
  const dbs = Object.fromEntries(FICTIONAL_CUSTOMERS.map((c) => [c, openDb(join(ws, "customers", c, "knowledge.db"))]));
  const facetsBySubject = new Map();
  const gen = expandGenerated(W);
  const allItems = [...(W.items ?? []), ...gen.items];
  const shapeBySubject = new Map(allItems.filter((x) => x.shape).map((x) => [x.code, x.shape]));
  try {
    for (const it of allItems) {
      const m = CODE_RE.exec(it.code);
      if (!m) throw new Error(`codice di item non valido nello scenario: ${it.code}`);
      const [, level, cust] = m;
      const owner = level === "S" ? null : cust;
      if (owner && !FICTIONAL_CUSTOMERS.includes(owner)) throw new Error(`cliente non fittizio nello scenario: ${owner}`);
      const file = itemFile(ws, it.code, owner);
      const rel = file.slice(ws.length + 1).replaceAll("\\", "/");
      writeRel(ws, rel, { id: it.code, type: m[4], title: it.title, summary: it.summary, facets: { ...DEFAULT_FACETS, ...(it.facets ?? {}) }, ...(it.body ?? {}) });
      // Gli item S stanno nel DB del prodotto e (come dopo reindex) in quello di ogni cliente; gli item C/L nel DB del loro cliente.
      const targets = level === "S" ? [product, ...Object.values(dbs)] : [dbs[owner]];
      const dbPath = level === "S" ? rel.replace(/^product\//, "") : rel.replace(`customers/${owner}/`, "");
      for (const db of targets) facetsBySubject.set(it.code, insertItem(db, it, dbPath));
    }
    for (const p of W.precedents ?? []) insertPrecedent(dbs[CODE_RE.exec(p.code)?.[2] ?? "ACME"] ?? dbs.ACME, p, facetsBySubject, shapeBySubject);
    if (W.clusters) upsertClusters(dbs.ACME, DEFAULT_CLUSTERS_DIR);
    for (const x of [...(W.cluster_members ?? []), ...gen.members]) {
      dbs.ACME.prepare("insert or replace into cluster_members (cluster_code, item_code, admitted_at, decision_code) values (?, ?, ?, null)").run(x.cluster, x.item, "2026-09-20T10:00:00Z");
    }
    for (const x of W.contradictions ?? []) {
      (dbs[x.customer ?? "ACME"] ?? dbs.ACME).prepare("insert or replace into contradictions (code, a_code, b_code, facet, resolution, status) values (?, ?, ?, ?, null, ?)")
        .run(x.code, x.a, x.b, x.facet ?? null, x.status ?? "aperta");
    }
  } finally {
    product.close();
    for (const db of Object.values(dbs)) db.close();
  }
  for (const [rel, content] of Object.entries(W.files ?? {})) writeRel(ws, rel, content);
  return ws;
}

// scaffold.sh → node scaffold.mjs <scenario.yaml> (cartella corrente = workspace vuoto della run)
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (!file) { console.error("uso: node evals/_support/scaffold.mjs <scenario.yaml>"); process.exit(1); }
  const scenario = YAML.parse(readFileSync(file, "utf8"));
  buildWorkspace(process.cwd(), scenario);
  console.log(`workspace ACME pronto per ${scenario.role}/${scenario.case}`);
}
