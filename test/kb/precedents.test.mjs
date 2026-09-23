import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../../scripts/kb/db.mjs";
import { distance, precedents, portabilityValue } from "../../scripts/kb/precedents.mjs";

const KB_CLI = fileURLToPath(new URL("../../scripts/kb/kb.mjs", import.meta.url));
const approx = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);
const F = { F5: "saas-core", F6: ["indirect", "catalogo-centrico"], F7: "sap-s4", F10: "R2" };

test("§12.3 distance: stesso soggetto, stesse faccette, stesso cliente, stessa forma, età 0 → 0", () => {
  const a = { subject: "C.ACME.ADM.CFG.0019", clusters: ["CL-CFG-009"], facets: F, customer: "ACME", shape: "libresco" };
  approx(distance(a, { ...a, age_releases: 0, portability: "specifica" }), 0);
});

test("§12.3 distance: stesso cluster (0.5), Hamming 1/4, età 2 release → 0.35×0.5 + 0.25×0.25 + 0.10×2/3", () => {
  const a = { subject: "C.ACME.ADM.CFG.0019", clusters: ["CL-CFG-009"], facets: F, customer: "ACME", shape: "libresco" };
  const b = { subject: "C.ACME.ADM.CFG.0021", clusters: ["CL-CFG-009", "CL-CFG-001"], facets: { ...F, F10: "R1" }, customer: "ACME", shape: "libresco", age_releases: 2 };
  approx(distance(a, b), 0.175 + 0.0625 + 0.1 * (2 / 3));
  // le faccette multi-valore si confrontano come insiemi (ordine irrilevante)
  approx(distance(a, { ...b, facets: { ...F, F6: ["catalogo-centrico", "indirect"], F10: "R1" } }), 0.175 + 0.0625 + 0.1 * (2 / 3));
});

test("§12.3 distance: altro cliente — 0.20 × (1 − portabilità); età satura a 3; forma diversa; nessun cluster in comune", () => {
  const a = { subject: "S.STD.SRC.FLW.0003", clusters: ["CL-PRO-001"], facets: F, customer: "ACME", shape: "ignoto" };
  const far = { subject: "L.BETA.SRC.FLW.0009", clusters: ["CL-PRO-004"], facets: { F5: "modulo-addon", F6: ["direct"], F7: "oracle", F10: "R1" },
    customer: "BETA", shape: "consolidato", age_releases: 7, portability: "ignota" };
  approx(distance(a, far), 0.35 + 0.25 + 0.2 * (1 - 0.6) + 0.1 + 0.1);
  approx(distance(a, { ...far, portability: "universale" }), 0.35 + 0.25 + 0 + 0.1 + 0.1);
  approx(distance(a, { ...far, portability: "specifica" }), 0.35 + 0.25 + 0.2 * 0.9 + 0.1 + 0.1);
  // età ignota → il massimo (0.10), come null_policy worst di DT-018
  approx(distance(a, { ...far, age_releases: null }), distance(a, far));
});

test("portabilità condizionata(Fn): soddisfatta se la faccetta coincide sui due clienti (§6.3, §11.6)", () => {
  assert.equal(portabilityValue("condizionata(F7)", { F7: "sap-s4" }, { F7: "sap-s4" }), 1);
  assert.equal(portabilityValue("condizionata(F7)", { F7: "sap-s4" }, { F7: "oracle" }), 0.2);
  assert.equal(portabilityValue("condizionata", { F7: "sap-s4" }, { F7: "sap-s4" }), 0.2);
  assert.equal(portabilityValue(undefined, {}, {}), 0.6);
});

function seed() {
  const db = openDb(join(mkdtempSync(join(tmpdir(), "prec-")), "knowledge.db"));
  const item = db.prepare("insert into items(code,level,customer,scope,type,title,summary,facets,status,path,hash,updated_at) values (?,?,?,?,?,?,?,?,?,?,?,?)");
  item.run("C.ACME.ADM.CFG.0019", "C", "ACME", "ADM", "CFG", "Profilo import", "profilo di import catalogo", JSON.stringify({ ...F, F8: "specifica" }), "validato", "p", "h", "2026-09-01");
  item.run("C.ACME.ADM.CFG.0021", "C", "ACME", "ADM", "CFG", "Profilo import B", "altro profilo", JSON.stringify({ ...F, F10: "R1", F8: "specifica" }), "validato", "p", "h", "2026-09-01");
  item.run("C.BETA.ADM.CFG.0007", "C", "BETA", "ADM", "CFG", "Profilo BETA", "profilo di BETA", JSON.stringify({ ...F, F6: ["direct"], F7: "oracle", F10: "R3", F8: "condizionata(F7)" }), "validato", "p", "h", "2026-09-01");
  const mem = db.prepare("insert into cluster_members(cluster_code,item_code) values (?,?)");
  mem.run("CL-CFG-009", "C.ACME.ADM.CFG.0019"); mem.run("CL-CFG-009", "C.ACME.ADM.CFG.0021"); mem.run("CL-CFG-020", "C.BETA.ADM.CFG.0007");
  db.prepare("insert into epistemic(subject_code, shape) values (?,?)").run("C.ACME.ADM.CFG.0019", "libresco");
  db.prepare("insert into meta(key,value) values ('releases', ?)").run(JSON.stringify(["R25.1", "R25.2", "R25.3", "R25.4"]));
  const dec = db.prepare("insert into decisions(code,table_code,agent,session,subject_code,subject_cluster,inputs,score,outcome,strategy,at) values (?,?,?,?,?,?,?,?,?,?,?)");
  const ctx = db.prepare("insert into decision_context(decision_code,release_ref,shape) values (?,?,?)");
  const out = db.prepare("insert into outcomes(decision_code,verified_at,verified_by,result,note) values (?,?,?,?,?)");
  // DEC.0402: stesso soggetto, stessa forma, 1 release fa → 0.10 × 1/3
  dec.run("L.ACME.ADM.DEC.0402", "DT-007", "adm-expert", "S1", "C.ACME.ADM.CFG.0019", "CL-CFG-009", JSON.stringify({ shape: "libresco" }), 0.4, "R2", null, "2026-06-10T10:00:00Z");
  ctx.run("L.ACME.ADM.DEC.0402", "R25.3", "libresco"); out.run("L.ACME.ADM.DEC.0402", "2026-06-11", "esecuzione", "confermata", null);
  // DEC.0377: stesso cluster, F10 diversa, 2 release fa, SMENTITA
  dec.run("L.ACME.ADM.DEC.0377", "DT-007", "adm-expert", "S0", "C.ACME.ADM.CFG.0021", "CL-CFG-009", JSON.stringify({ shape: "libresco" }), 0.4, "R2", null, "2026-05-10T10:00:00Z");
  ctx.run("L.ACME.ADM.DEC.0377", "R25.2", "libresco"); out.run("L.ACME.ADM.DEC.0377", "2026-05-11", "umano", "smentita", "lo snapshot non copriva il profilo");
  // BETA: altro cliente, portabilità condizionata(F7) non soddisfatta, 0 release, forma diversa
  dec.run("L.BETA.ADM.DEC.0119", "DT-007", "adm-expert", "SB", "C.BETA.ADM.CFG.0007", "CL-CFG-020", JSON.stringify({ shape: "consolidato" }), 0.7, "R3", null, "2026-08-10T10:00:00Z");
  ctx.run("L.BETA.ADM.DEC.0119", "R25.4", "consolidato"); out.run("L.BETA.ADM.DEC.0119", "2026-08-11", "umano", "confermata", null);
  // senza esito, e non-verificabile: esclusi
  dec.run("L.ACME.ADM.DEC.0500", "DT-007", "adm-expert", "S2", "C.ACME.ADM.CFG.0019", "CL-CFG-009", "{}", 0.4, "R2", null, "2026-09-10T10:00:00Z");
  dec.run("L.ACME.ADM.DEC.0501", "DT-007", "adm-expert", "S2", "C.ACME.ADM.CFG.0019", "CL-CFG-009", "{}", 0.4, "R2", null, "2026-09-10T10:00:00Z");
  out.run("L.ACME.ADM.DEC.0501", "2026-09-11", "tempo", "non-verificabile", null);
  return db;
}

test("§12.3 kb precedents: distanze attese sul caso della spec (stesso soggetto, stesso cluster smentito, altro cliente)", () => {
  const db = seed();
  const rows = precedents(db, "C.ACME.ADM.CFG.0019", { top: 5, customer: "ACME" });
  assert.deepEqual(rows.map((r) => r.dec), ["L.ACME.ADM.DEC.0402", "L.ACME.ADM.DEC.0377", "L.BETA.ADM.DEC.0119"]);
  approx(rows[0].d, 0.1 / 3);
  approx(rows[1].d, 0.175 + 0.0625 + 0.1 * (2 / 3));
  // BETA: soggetto e cluster diversi (0.35), F6 F7 F10 diverse (0.25×3/4), condizionata(F7) non soddisfatta (0.20×0.8), età 0, forma diversa (0.10)
  approx(rows[2].d, 0.35 + 0.1875 + 0.16 + 0 + 0.1);
  assert.deepEqual(Object.keys(rows[0]).sort(), ["at", "customer", "d", "dec", "note", "outcome", "result", "same_cluster", "same_subject", "table"].sort());
  assert.equal(rows[0].same_subject, true);
  assert.equal(rows[1].same_subject, false);
  assert.equal(rows[1].same_cluster, true);
  assert.equal(rows[1].result, "smentita");
  assert.equal(rows[1].note, "lo snapshot non copriva il profilo");
  assert.equal(rows[2].customer, "BETA");
  assert.equal(precedents(db, "C.ACME.ADM.CFG.0019", { top: 1 }).length, 1);
});

test("§12.3: a parità di distanza (Δd ≤ 0.05) le smentite prima; oltre 0.05 vale la distanza", () => {
  const db = seed();
  // DEC.0378: stesso cluster come .0377 ma confermata e 1 release fa (d più piccola di 0.0333)
  db.prepare("insert into decisions(code,table_code,agent,subject_code,subject_cluster,inputs,outcome,at) values (?,?,?,?,?,?,?,?)")
    .run("L.ACME.ADM.DEC.0378", "DT-007", "adm-expert", "C.ACME.ADM.CFG.0021", "CL-CFG-009", "{}", "R2", "2026-06-01T00:00:00Z");
  db.prepare("insert into decision_context(decision_code,release_ref,shape) values (?,?,?)").run("L.ACME.ADM.DEC.0378", "R25.3", "libresco");
  db.prepare("insert into outcomes(decision_code,result) values (?,?)").run("L.ACME.ADM.DEC.0378", "confermata");
  const rows = precedents(db, "C.ACME.ADM.CFG.0019", { top: 5, customer: "ACME" });
  const i377 = rows.findIndex((r) => r.dec === "L.ACME.ADM.DEC.0377");
  const i378 = rows.findIndex((r) => r.dec === "L.ACME.ADM.DEC.0378");
  assert.ok(rows[i378].d < rows[i377].d && rows[i377].d - rows[i378].d <= 0.05);
  assert.ok(i377 < i378, "la smentita entro 0.05 viene letta per prima");
  // lo stesso soggetto confermato (0.033) resta primo: .0377 dista più di 0.05 da lui (0.304)
  assert.equal(rows[0].dec, "L.ACME.ADM.DEC.0402");
});

test("kb precedents: esclude DEC senza esito e non-verificabili; soggetto senza precedenti → []", () => {
  const db = seed();
  const codes = precedents(db, "C.ACME.ADM.CFG.0019", { top: 10 }).map((r) => r.dec);
  assert.ok(!codes.includes("L.ACME.ADM.DEC.0500"));
  assert.ok(!codes.includes("L.ACME.ADM.DEC.0501"));
  const empty = openDb(":memory:");
  assert.deepEqual(precedents(empty, "C.ACME.ADM.CFG.0019"), []);
});

test("CLI kb precedents <soggetto> --top N --json", () => {
  const dir = mkdtempSync(join(tmpdir(), "prec-cli-"));
  const file = join(dir, "knowledge.db");
  const src = seed();
  src.exec(`vacuum into '${file.replace(/'/g, "''")}'`);
  const r = spawnSync(process.execPath, [KB_CLI, "precedents", "C.ACME.ADM.CFG.0019", "--top", "2", "--customer", "ACME", "--db", file, "--json"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, true);
  assert.deepEqual(out.items.map((x) => x.dec), ["L.ACME.ADM.DEC.0402", "L.ACME.ADM.DEC.0377"]);
  const bad = spawnSync(process.execPath, [KB_CLI, "precedents", "--db", file, "--json"], { encoding: "utf8" });
  assert.equal(bad.status, 1);
});

test("dt-eval writeDecision con context → decision_context (release, forma, confidenza, effetti) usata dai precedenti", async () => {
  const { evaluate, loadTable, writeDecision } = await import("../../scripts/decide/dt-eval.mjs");
  const db = seed();
  const root = mkdtempSync(join(tmpdir(), "prec-dec-"));
  const result = evaluate(loadTable("DT-002"), { risk: "R1", shape: "libresco", mandatory_missing: false, open_contradiction: false, novelty: false });
  const code = writeDecision(db, { customer: "ACME", scope: "ADM", root, result, agent: "adm-expert", subject: "C.ACME.ADM.CFG.0019", cluster: "CL-CFG-009",
    at: "2026-09-20T00:00:00Z", context: { release: "R25.4", confidence: 0.8, effects: true } });
  const row = db.prepare("select * from decision_context where decision_code=?").get(code);
  assert.deepEqual({ release: row.release_ref, shape: row.shape, confidence: row.confidence, effects: row.effects }, { release: "R25.4", shape: "libresco", confidence: 0.8, effects: 1 });
  db.prepare("insert into outcomes(decision_code,result) values (?,?)").run(code, "confermata");
  const p = precedents(db, "C.ACME.ADM.CFG.0019", { top: 1 });
  assert.equal(p[0].dec, code);
  approx(p[0].d, 0);
});
