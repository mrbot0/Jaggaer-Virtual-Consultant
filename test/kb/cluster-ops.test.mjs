import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { openDb } from "../../scripts/kb/db.mjs";
import { reindex } from "../../scripts/kb/reindex.mjs";
import { admit, reject, merge, split, quarantine, sample, deprecate, recordDigest, AdmissionError, PolicyError } from "../../scripts/kb/cluster.mjs";

const CLI = fileURLToPath(new URL("../../scripts/kb/cluster.mjs", import.meta.url));
const NOW = "2026-09-23T10:00:00.000Z";

function facets(over = {}) {
  return { F1: "doc-cliente-tecnica", F4: "oggetto-config", F5: "saas-core", F6: ["indirect"], F7: "sap-ecc", F8: "specifica", F9: "periodica",
    F10: "R2", F11: "deterministico", F12: "validato", F13: { verified_at: "2026-09-01", release: "R25.2" }, F15: "tecnica", ...over };
}
function writeItem(root, obj) {
  const [, , scope] = obj.id.split(".");
  const dir = join(root, "kb", "scopes", scope, "items");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${obj.id}.yaml`), YAML.stringify({ title: `Item ${obj.id}`, summary: "Item di prova.", sources: [{ doc: "t" }], ...obj }));
}
function workspace() {
  const root = mkdtempSync(join(tmpdir(), "cls-"));
  writeItem(root, { id: "C.ACME.ADM.CFG.0001", type: "CFG", cfg_area: "005", facets: facets() });
  writeItem(root, { id: "C.ACME.ADM.CFG.0002", type: "CFG", cfg_area: "006", facets: facets({ F10: "R1" }) });
  writeItem(root, { id: "C.ACME.ADM.CFG.0003", type: "CFG", cfg_area: "005", unknown: null, facets: facets() });
  const dbPath = join(root, "knowledge.db");
  const stats = reindex(root, dbPath);
  return { root, dbPath, db: openDb(dbPath), stats };
}

test("reindex carica i cluster del plugin (--clusters, default clusters/)", () => {
  const { db, stats } = workspace();
  assert.equal(stats.clusters_upserted, 195);
  assert.equal(stats.clusters_invalid, 0);
  const row = db.prepare("select * from clusters where code='CL-CFG-005'").get();
  assert.equal(row.family, "CL-CFG");
  assert.equal(JSON.parse(row.inclusion)[0].field, "cfg_area");
  assert.equal(db.prepare("select depth, domain, base_risk from cluster_details where code='CL-CFG-005'").get().base_risk, "R2");
});

test("admit: ammette se tutti i criteri di inclusione valgono e nessuno di esclusione, con DT-005", () => {
  const { db, root } = workspace();
  const r = admit(db, "CL-CFG-005", "C.ACME.ADM.CFG.0001", { decisionCode: "L.ACME.ADM.DEC.0001", root, now: NOW });
  assert.equal(r.verdict, "ammesso");
  assert.equal(r.dt.table, "DT-005");
  const m = db.prepare("select * from cluster_members where cluster_code='CL-CFG-005'").all();
  assert.deepEqual(m.map((x) => [x.item_code, x.decision_code, x.admitted_at]), [["C.ACME.ADM.CFG.0001", "L.ACME.ADM.DEC.0001", NOW]]);
});

test("admit: nel dubbio non entra — lancia nominando il criterio, nessuna scrittura di membro", () => {
  const { db, root } = workspace();
  assert.throws(() => admit(db, "CL-CFG-005", "C.ACME.ADM.CFG.0002", { root, now: NOW }),
    (e) => e instanceof AdmissionError && e.verdict === "rigettato" && e.criterion === "I1" && /I1/.test(e.message));
  assert.equal(db.prepare("select count(*) n from cluster_members").get().n, 0);
  const ev = db.prepare("select op, reason from cluster_events where item_code='C.ACME.ADM.CFG.0002'").get();
  assert.equal(ev.op, "admit-denied");
  assert.match(ev.reason, /I1/);
  assert.throws(() => admit(db, "CL-CFG-999", "C.ACME.ADM.CFG.0001", { root }), /cluster inesistente/);
  assert.throws(() => admit(db, "CL-CFG-005", "C.ACME.ADM.CFG.0999", { root }), /item inesistente/);
});

test("reject richiede un motivo e rimuove l'appartenenza", () => {
  const { db, root } = workspace();
  admit(db, "CL-CFG-005", "C.ACME.ADM.CFG.0001", { root, now: NOW });
  assert.throws(() => reject(db, "CL-CFG-005", "C.ACME.ADM.CFG.0001", {}), /motivo/);
  const r = reject(db, "CL-CFG-005", "C.ACME.ADM.CFG.0001", { reason: "area errata dopo revisione", now: NOW });
  assert.equal(r.was_member, true);
  assert.equal(db.prepare("select count(*) n from cluster_members").get().n, 0);
});

test("quarantine: stato dell'item 'quarantena' con il motivo registrato", () => {
  const { db } = workspace();
  quarantine(db, "C.ACME.ADM.CFG.0003", "criterio insufficiente: area ambigua", { now: NOW });
  assert.equal(db.prepare("select status from items where code='C.ACME.ADM.CFG.0003'").get().status, "quarantena");
  assert.equal(db.prepare("select reason from cluster_events where op='quarantine'").get().reason, "criterio insufficiente: area ambigua");
  assert.throws(() => quarantine(db, "C.ACME.ADM.CFG.0003", ""), /motivo/);
});

function seedMembers(db, cluster, codes) {
  const ins = db.prepare("insert or ignore into cluster_members(cluster_code,item_code,admitted_at,decision_code) values (?,?,?,null)");
  for (const c of codes) ins.run(cluster, c, NOW);
}
const codes = (n, from = 1) => Array.from({ length: n }, (_, i) => `C.ACME.ADM.CFG.${String(from + i).padStart(4, "0")}`);

test("merge solo con sovrapposizione > 70%", () => {
  const { db } = workspace();
  seedMembers(db, "CL-CFG-005", codes(10));
  seedMembers(db, "CL-CFG-017", [...codes(9), ...codes(1, 50)]);  // 9 / 11 = 82%
  seedMembers(db, "CL-CFG-006", codes(3, 100));
  assert.throws(() => merge(db, "CL-CFG-005", "CL-CFG-006"), (e) => e instanceof PolicyError && /70%/.test(e.message));
  const r = merge(db, "CL-CFG-005", "CL-CFG-017", { now: NOW });
  assert.ok(r.overlap > 0.7);
  assert.equal(db.prepare("select count(*) n from cluster_members where cluster_code='CL-CFG-005'").get().n, 11);
  assert.equal(db.prepare("select count(*) n from cluster_members where cluster_code='CL-CFG-017'").get().n, 0);
  assert.equal(db.prepare("select status from clusters where code='CL-CFG-017'").get().status, "fuso");
  assert.equal(db.prepare("select merged_into from cluster_details where code='CL-CFG-017'").get().merged_into, "CL-CFG-005");
  assert.throws(() => merge(db, "CL-CFG-005", "CL-ERR-001"), /stessa famiglia/);
});

test("split solo oltre 40 membri e con varianza alta sulla faccetta", () => {
  const { db } = workspace();
  const ins = db.prepare("insert into items(code,level,customer,scope,type,title,summary,facets,status,path,hash,updated_at) values (?,?,?,?,?,?,?,?,?,?,?,?)");
  const many = codes(42, 200);
  many.forEach((c, i) => ins.run(c, "C", "ACME", "ADM", "CFG", "t", "s", JSON.stringify(facets({ F7: i % 2 ? "sap-ecc" : "oracle" })), "validato", "p", "h", NOW));
  seedMembers(db, "CL-CFG-004", many.slice(0, 40));
  assert.throws(() => split(db, "CL-CFG-004", { facet: "F7" }), (e) => e instanceof PolicyError && /40/.test(e.message));
  seedMembers(db, "CL-CFG-004", many);
  const p = split(db, "CL-CFG-004", { facet: "F7", now: NOW });
  assert.equal(p.members, 42);
  assert.deepEqual(p.groups.map((g) => [g.value, g.count]), [["oracle", 21], ["sap-ecc", 21]]);
  assert.equal(p.proposal, true);
  assert.throws(() => split(db, "CL-CFG-004", { facet: "F10" }), /varianza/);  // tutti R2
});

test("sample: 10% deterministico per seme", () => {
  const { db } = workspace();
  seedMembers(db, "CL-CFG-005", codes(15));
  seedMembers(db, "CL-CFG-006", codes(15, 20));
  const a = sample(db, "CL-CFG", { pct: 10, seed: "2026-W39" });
  const b = sample(db, "CL-CFG", { pct: 10, seed: "2026-W39" });
  assert.equal(a.population, 30);
  assert.equal(a.sample.length, 3);
  assert.deepEqual(a, b);
  const c = sample(db, "CL-CFG", { pct: 10, seed: "2026-W40" });
  assert.notDeepEqual(a.sample, c.sample);
  assert.throws(() => sample(db, "CL-CFG", { pct: 10 }), /seed/);
});

test("deprecate: solo cluster vuoti per 2 digestioni", () => {
  const { db } = workspace();
  seedMembers(db, "CL-CFG-006", codes(1));
  recordDigest(db, { now: NOW });
  assert.throws(() => deprecate(db, "CL-CFG-019"), (e) => e instanceof PolicyError && /2 digestioni/.test(e.message));
  recordDigest(db, { now: NOW });
  const r = deprecate(db, "CL-CFG-019", { now: NOW });
  assert.equal(r.status, "deprecato");
  assert.throws(() => deprecate(db, "CL-CFG-006"), /membri/);
  assert.equal(db.prepare("select empty_digests from cluster_details where code='CL-CFG-006'").get().empty_digests, 0);
});

test("CLI: admit con --json, rifiuto di policy → exit 3, argomenti → exit 1", () => {
  const { dbPath, root, db } = workspace();
  db.close();
  const ok = spawnSync(process.execPath, [CLI, "admit", "CL-CFG-005", "C.ACME.ADM.CFG.0001", "--db", dbPath, "--root", root, "--json"], { encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.equal(JSON.parse(ok.stdout).verdict, "ammesso");
  const denied = spawnSync(process.execPath, [CLI, "admit", "CL-CFG-005", "C.ACME.ADM.CFG.0002", "--db", dbPath, "--root", root, "--json"], { encoding: "utf8" });
  assert.equal(denied.status, 3);
  assert.equal(JSON.parse(denied.stdout).criterion, "I1");
  assert.equal(spawnSync(process.execPath, [CLI, "admit", "--db", dbPath, "--json"], { encoding: "utf8" }).status, 1);
  assert.equal(spawnSync(process.execPath, [CLI, "--help"], { encoding: "utf8" }).status, 0);
  const s = spawnSync(process.execPath, [CLI, "sample", "CL-CFG", "--seed", "x", "--db", dbPath, "--json"], { encoding: "utf8" });
  assert.equal(s.status, 0, s.stdout + s.stderr);
});
