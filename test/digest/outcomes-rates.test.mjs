import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../../scripts/kb/db.mjs";
import { rates } from "../../scripts/digest/outcomes-rates.mjs";

const CLI = fileURLToPath(new URL("../../scripts/digest/outcomes-rates.mjs", import.meta.url));

// Registro sintetico: DEC di DT-002 su ACME e BETA, con esiti di tutti i tipi.
function registry(path = ":memory:") {
  const db = openDb(path);
  const dec = db.prepare("insert into decisions(code,table_code,agent,session,subject_code,subject_cluster,inputs,priors,score,outcome,strategy,at) values (?,?,?,?,?,?,?,?,?,?,?,?)");
  const out = db.prepare("insert into outcomes(decision_code,verified_at,verified_by,result,evidence_code,note) values (?,?,?,?,?,?)");
  let n = 0;
  const add = (cust, { table = "DT-002", cluster = "CL-CFG-005", shape = "libresco", outcome = "procedi", strategy = null, result }) => {
    n++;
    const code = `L.${cust}.ADM.DEC.${String(n).padStart(4, "0")}`;
    dec.run(code, table, "adm-expert", "SES.X", "C.ACME.ADM.CFG.0019", cluster, JSON.stringify({ shape, risk: "R2" }), "{}", 0.4, outcome, strategy, "2026-09-01T00:00:00Z");
    if (result) out.run(code, "2026-09-02", "esecuzione", result, null, null);
  };
  // ACME, libresco, procedi: 20 confermate, 8 smentite, 4 parziali, 3 non-verificabili, 2 senza esito
  for (let i = 0; i < 20; i++) add("ACME", { result: "confermata" });
  for (let i = 0; i < 8; i++) add("ACME", { result: "smentita" });
  for (let i = 0; i < 4; i++) add("ACME", { result: "parziale" });
  for (let i = 0; i < 3; i++) add("ACME", { result: "non-verificabile" });
  for (let i = 0; i < 2; i++) add("ACME", {});
  // ACME, consolidato: 5 confermate
  for (let i = 0; i < 5; i++) add("ACME", { shape: "consolidato", result: "confermata" });
  // BETA, libresco: 3 smentite, altra strategia
  for (let i = 0; i < 3; i++) add("BETA", { result: "smentita", strategy: "STR-REPLAY" });
  // altra tabella
  for (let i = 0; i < 4; i++) add("ACME", { table: "DT-017", outcome: "STR-REPLAY", strategy: "STR-REPLAY", result: "smentita" });
  return db;
}

test("tassi per tabella, cliente, forma: parziale vale 0.5, non-verificabile escluso", () => {
  const db = registry();
  const r = rates(db, { table: "DT-002", customer: "ACME", shape: "libresco", outcome: "procedi" });
  // n = 20 + 8 + 4 = 32 (3 non-verificabili e 2 senza esito esclusi)
  assert.equal(r.n, 32);
  assert.equal(r.confirmed, 22);   // 20 + 4 × 0.5
  assert.equal(r.disproved, 10);   // 8 + 4 × 0.5
  assert.equal(r.rate_disproved, 0.3125);
  assert.equal(r.sufficient, true);
});

test("finestra minima: sotto 30 DEC il tasso non è sufficiente", () => {
  const db = registry();
  const r = rates(db, { table: "DT-002", customer: "ACME", shape: "consolidato" });
  assert.deepEqual(r, { n: 5, confirmed: 5, disproved: 0, rate_disproved: 0, sufficient: false });
  assert.equal(rates(db, { table: "DT-002", customer: "ACME", shape: "consolidato", windowMin: 5 }).sufficient, true);
});

test("filtri per cluster, strategia e tutti i clienti", () => {
  const db = registry();
  assert.equal(rates(db, { table: "DT-002", shape: "libresco" }).n, 35); // ACME 32 + BETA 3
  assert.equal(rates(db, { table: "DT-002", strategy: "STR-REPLAY" }).rate_disproved, 1);
  assert.equal(rates(db, { table: "DT-002", cluster: "CL-CFG-999" }).n, 0);
  assert.equal(rates(db, { table: "DT-002", cluster: "CL-CFG-999" }).rate_disproved, null);
  assert.equal(rates(db, { table: "DT-017", customer: "ACME" }).n, 4);
});

test("CLI --json: tassi e exit 0; argomenti mancanti exit 1", () => {
  const path = join(mkdtempSync(join(tmpdir(), "rates-")), "k.db");
  registry(path).close();
  const r = spawnSync(process.execPath, [CLI, "--db", path, "--table", "DT-002", "--customer", "ACME", "--shape", "libresco", "--json"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.ok, true);
  assert.equal(j.n, 32);
  const bad = spawnSync(process.execPath, [CLI, "--json"], { encoding: "utf8" });
  assert.equal(bad.status, 1);
});
