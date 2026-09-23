import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import YAML from "yaml";
import { evaluate, loadTable, writeDecision, TABLES_DIR } from "../../scripts/decide/dt-eval.mjs";
import { calibrate, confidenceCalibration, MIN_DECS } from "../../scripts/digest/calibrate.mjs";
import { openDb } from "../../scripts/kb/db.mjs";

const LEARN = fileURLToPath(new URL("../../scripts/digest/learn.mjs", import.meta.url));
const sha = (f) => createHash("sha256").update(readFileSync(f)).digest("hex");

// DT-002: 'procedi-con-assunzione' a 0.47 smentita 4 volte su 4; a 0.30 confermata; 'chiedi' a 0.525 confermata.
const SMENTITA = { risk: "R2", shape: "libresco", mandatory_missing: false, open_contradiction: false, novelty: true };   // .425 + prior .3×.15 = .47
const CONFERMATA = { risk: "R1", shape: "libresco", mandatory_missing: false, open_contradiction: false, novelty: true }; // .30
const CHIEDI = { risk: "R2", shape: "ignoto", mandatory_missing: false, open_contradiction: false, novelty: true };       // .525

function seed({ smentite = 4, confermate = 6, chiedi = 2 } = {}) {
  const root = mkdtempSync(join(tmpdir(), "cal-"));
  const dbFile = join(root, "knowledge.db");
  const db = openDb(dbFile);
  const t = loadTable("DT-002");
  const add = (inputs, priors, result, agent, confidence, at) => {
    const r = evaluate(t, inputs, { priors });
    const code = writeDecision(db, { customer: "ACME", scope: "ADM", root, result: r, agent, at, context: { confidence, effects: true } });
    db.prepare("insert into outcomes(decision_code,result) values (?,?)").run(code, result);
    return { code, score: r.score, outcome: r.outcome };
  };
  const out = { root, dbFile, db, smentite: [] };
  for (let i = 0; i < smentite; i++) out.smentite.push(add(SMENTITA, { disproved_procedi: 0.3 }, "smentita", "adm-expert", 0.9, "2026-08-10T00:00:00Z").code);
  for (let i = 0; i < confermate; i++) add(CONFERMATA, {}, "confermata", i < 2 ? "adm-expert" : "cat-expert", 0.95, "2026-08-11T00:00:00Z");
  for (let i = 0; i < chiedi; i++) add(CHIEDI, {}, "confermata", "cat-expert", 0.95, "2026-08-12T00:00:00Z");
  return out;
}

test("§12.5 calibrazione solo con ≥ 10 DEC verificate: con 9 nessuna proposta", () => {
  const { db, root } = seed({ smentite: 3, confermate: 5, chiedi: 1 });
  assert.equal(MIN_DECS, 10);
  const r = calibrate(db, { table: "DT-002", outDir: join(root, "proposals") });
  assert.deepEqual(r.proposals, []);
  assert.equal(r.skipped[0].table, "DT-002");
  assert.equal(r.skipped[0].n, 9);
  assert.match(r.skipped[0].reason, /< 10/);
  assert.equal(existsSync(join(root, "proposals")), false);
});

test("§12.5 grid search sulle soglie (±0.10, passo 0.01): la soglia 0.50 scende a 0.47, smentite 4 → 0; proposta scritta, tabella intatta", () => {
  const { db, root, smentite } = seed();
  const before = sha(join(TABLES_DIR, "DT-002.yaml"));
  const outDir = join(root, "proposals");
  const r = calibrate(db, { table: "DT-002", outDir, at: "2026-09-23T00:00:00Z" });
  assert.equal(r.proposals.length, 1);
  const p = r.proposals[0];
  assert.equal(p.table, "DT-002");
  assert.equal(p.from_version, 1);
  assert.equal(p.to_version, 2);
  assert.deepEqual(p.change, { boundary: 0.5, from: 0.5, to: 0.47, delta: -0.03 });
  assert.equal(p.smentite_before, 4);
  assert.equal(p.smentite_after, 0);
  assert.equal(p.unnecessary_asks, 0);
  assert.deepEqual([...p.supporting_decs].sort(), [...smentite].sort());
  const file = join(outDir, "DT-002.v2.proposal.yaml");
  assert.equal(p.file, file);
  const doc = YAML.parse(readFileSync(file, "utf8"));
  for (const k of ["table", "from_version", "to_version", "change", "supporting_decs", "smentite_before", "smentite_after"]) assert.ok(k in doc, k);
  assert.equal(sha(join(TABLES_DIR, "DT-002.yaml")), before, "mai sovrascrivere una tabella");
  // una seconda esecuzione non sovrascrive la proposta
  const again = calibrate(db, { table: "DT-002", outDir });
  assert.equal(again.proposals[0].exists, true);
  assert.deepEqual(readdirSync(outDir), ["DT-002.v2.proposal.yaml"]);
});

test("§12.5 tolleranza sulle domande aggiunte: se lo spostamento chiede su troppe DEC confermate, nessuna proposta", () => {
  const { db, root } = seed();
  const r = calibrate(db, { table: "DT-002", outDir: join(root, "p"), tolerance: 0, filters: {} });
  assert.equal(r.proposals.length, 1, "0.47 non aggiunge domande su DEC confermate: resta proponibile");
  // con confermate a 0.47 (stessi input delle smentite) ogni spostamento che evita le smentite chiede anche su quelle
  const s2 = seed();
  const t = loadTable("DT-002");
  for (let i = 0; i < 3; i++) {
    const res = evaluate(t, SMENTITA, { priors: { disproved_procedi: 0.3 } });
    const code = writeDecision(s2.db, { customer: "ACME", scope: "ADM", root: s2.root, result: res, agent: "adm-expert", at: "2026-08-13T00:00:00Z" });
    s2.db.prepare("insert into outcomes(decision_code,result) values (?,?)").run(code, "confermata");
  }
  const r2 = calibrate(s2.db, { table: "DT-002", outDir: join(s2.root, "p"), tolerance: 1 });
  assert.deepEqual(r2.proposals, []);
  assert.match(r2.skipped[0].reason, /tolleranza|nessuna soglia/);
});

test("§17.4 Brier e sovraconfidenza per (agente, DT, mese): effetti elencati, non applicati", () => {
  const { db } = seed();
  const rows = confidenceCalibration(db, { table: "DT-002" });
  const adm = rows.find((x) => x.agent === "adm-expert");
  // adm-expert: 4 smentite a 0.9 + 2 confermate a 0.95 → Brier (4×0.81 + 2×0.0025)/6
  assert.equal(adm.month, "2026-08");
  assert.equal(adm.n, 6);
  assert.ok(Math.abs(adm.brier - (4 * 0.81 + 2 * 0.0025) / 6) < 1e-6);
  assert.ok(Math.abs(adm.overconfidence - ((4 * 0.9 + 2 * 0.95) / 6 - 2 / 6)) < 1e-6);
  assert.ok(adm.effects.some((e) => /decide_if_confidence.*sale/.test(e)));
  assert.ok(adm.effects.some((e) => /escala/.test(e)));
  assert.equal(adm.applied, false);
  const cat = rows.find((x) => x.agent === "cat-expert");
  assert.ok(cat.brier < 0.10);
  assert.ok(cat.effects.some((e) => /DT-002.*peso pieno/.test(e)));
});

test("CLI learn calibrate --propose --db --out-dir (--json)", () => {
  const { dbFile, db, root } = seed();
  db.close();
  const outDir = join(root, "proposals");
  const r = spawnSync(process.execPath, [LEARN, "calibrate", "--propose", "--db", dbFile, "--out-dir", outDir, "--json"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.proposals.map((p) => p.table), ["DT-002"]);
  assert.ok(existsSync(join(outDir, "DT-002.v2.proposal.yaml")));
  assert.ok(Array.isArray(out.confidence));
  const noProp = spawnSync(process.execPath, [LEARN, "calibrate", "--db", dbFile, "--json"], { encoding: "utf8" });
  assert.equal(noProp.status, 1, "senza --propose: niente da fare, errore d'uso");
});
