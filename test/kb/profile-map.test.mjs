// WP09a-G — PRF e PMP (schemi, esempi della spec come fixture) e report di copertura per scope (§9.6) con il piano R0.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import YAML from "yaml";
import { validateWith } from "../../scripts/lib/schemas.mjs";
import { openDb } from "../../scripts/kb/db.mjs";
import { report, plan, formatReport, subjectsOf } from "../../scripts/kb/coverage-report.mjs";

const FIX = new URL("../fixtures/profile/", import.meta.url);
const prf = YAML.parse(readFileSync(new URL("C.ACME.XSC.PRF.0001.yaml", FIX), "utf8"));
const pmp = YAML.parse(readFileSync(new URL("C.ACME.XSC.PMP.0001.yaml", FIX), "utf8"));
const KB = new URL("../../scripts/kb/kb.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

test("PRF: l'esempio della spec è valido; documentation_inventory con voce di gap, environments come riferimento; senza inventario o con ERP fuori vocabolario ⇒ invalido", () => {
  const v = validateWith("prf.schema.json", prf);
  assert.ok(v.ok, v.errors.join("; "));
  assert.ok(prf.documentation_inventory.some((d) => d.gap));
  for (const bad of [{ ...prf, documentation_inventory: [] }, { ...prf, erp: { system: "sap-r3" } }, { ...prf, environments: undefined }, { ...prf, id: "C.ACME.P2P.PRF.0001" },
    { ...prf, documentation_inventory: [{ doc: "x.pdf", genre: "manuale" , scopes: [] }] }]) {
    assert.equal(validateWith("prf.schema.json", JSON.parse(JSON.stringify(bad))).ok, false);
  }
});

test("PMP: l'esempio della spec è valido (fasi, varianti con quote, handoff, epistemic_by_stage); forma epistemica fuori vocabolario o fase senza flussi né integrazione ⇒ invalido", () => {
  const v = validateWith("pmp.schema.json", pmp);
  assert.ok(v.ok, v.errors.join("; "));
  assert.equal(pmp.stages[2].variants.reduce((a, x) => a + x.share, 0), 1);
  assert.equal(validateWith("pmp.schema.json", { ...pmp, epistemic_by_stage: { 1: "forse" } }).ok, false);
  assert.equal(validateWith("pmp.schema.json", { ...pmp, stages: [{ n: 1, scope: "P2P", name: "x" }] }).ok, false);
  assert.equal(validateWith("pmp.schema.json", { ...pmp, stages: [{ ...pmp.stages[0], variants: [{ when: "x", share: 1.5 }] }] }).ok, false);
});

function kbWithSubjects() {
  const db = openDb(":memory:");
  const item = (code, type, scope = "ADM") => db.prepare("insert into items(code, level, customer, scope, type, title, summary, facets, status, path, hash, updated_at) values (?, ?, ?, ?, ?, 't', 's', '{}', 'digerito', 'p', 'h', 'now')").run(code, code[0], code.split(".")[1], scope, type);
  const epi = (code, k, shape) => db.prepare("insert into epistemic(subject_code, k_tech, k_use, k_obs, k_exec, shape) values (?,?,?,?,?,?)").run(code, ...k, shape);
  for (let i = 1; i <= 3; i++) { item(`C.ACME.ADM.CFG.000${i}`, "CFG"); epi(`C.ACME.ADM.CFG.000${i}`, [0.8, 0.6, 0.1, 0], "libresco"); }
  item("C.ACME.ADM.CFG.0004", "CFG"); epi("C.ACME.ADM.CFG.0004", [0.9, 0.7, 0.9, 0.8], "consolidato");
  item("C.ACME.ADM.CFG.0005", "CFG");
  item("C.ACME.ADM.CFG.0006", "CFG");
  db.prepare("insert into attribute_coverage(subject_code, attribute, units, genre, answered, recorded_at) values ('C.ACME.ADM.CFG.0006', ?, '[]', 'tecnica', 1, 'now')").run("location");
  item("C.ACME.ADM.FLD.0001", "FLD");
  db.prepare("insert into fields(code, identity) values ('C.ACME.ADM.FLD.0001', ?)").run(JSON.stringify({ names: { label: "Centro di costo" }, datatype: { kind: "lookup" } }));
  return db;
}

test("report di copertura per scope: per tipo soggetti per forma e K medi; EPI dal DB, altrimenti dalla copertura della digestione, altrimenti ignoto; riga identità dei dati; lettura", () => {
  const db = kbWithSubjects();
  const r = report(db, { scope: "ADM", customer: "ACME", date: "2026-09-28" });
  const cfg = r.rows.find((x) => x.type === "CFG");
  assert.deepEqual([cfg.n, cfg.consolidato, cfg.libresco, cfg.ignoto], [6, 1, 3, 2]);
  assert.equal(cfg.k_tech, Math.round(((0.8 * 3 + 0.9 + 0 + 1 / 7) / 6) * 100) / 100);
  assert.equal(subjectsOf(db, "ADM").find((s) => s.code === "C.ACME.ADM.CFG.0006").source, "digestione");
  assert.deepEqual([r.identity.fld, r.identity.blocks_avg, r.identity.missing_system_of_record], [1, 2, 1]);
  assert.match(r.reading, /3 osservazioni mirate \(R0/);
  assert.match(r.reading, /ignoti sono da chiedere/);
  const text = formatReport(r);
  assert.match(text, /^COPERTURA EPISTEMICA — ACME — scope ADM — 2026-09-28/);
  assert.match(text, /consolidato\s+libresco\s+empirico\s+ignoto\s+contradd\.\s+K_tech\s+K_use\s+K_obs\s+K_exec/);
  assert.match(text, /Identità dei dati \(FLD 1\)/);
});

test("--plan: osservazioni R0 per i libreschi e domande dalle banche per gli ignoti (attributi critici); kb epistemic --scope --plan", () => {
  const db = kbWithSubjects();
  const p = plan(db, { scope: "ADM" });
  assert.equal(p.observations.length, 3);
  assert.ok(p.observations.every((o) => o.risk === "R0"));
  const qs = p.questions.filter((q) => q.subject === "C.ACME.ADM.CFG.0005").map((q) => q.attribute);
  assert.deepEqual(qs, ["location", "options", "impacts", "current_state", "rollback"]);
  const dir = mkdtempSync(join(tmpdir(), "cov-"));
  const file = join(dir, "k.db");
  const d = openDb(file);
  d.prepare("insert into items(code, level, customer, scope, type, title, summary, facets, status, path, hash, updated_at) values ('S.STD.P2P.FLW.0001','S','STD','P2P','FLW','t','s','{}','digerito','p','h','now')").run();
  d.close();
  const r = spawnSync(process.execPath, [KB, "epistemic", "--scope", "P2P", "--plan", "--db", file, "--json"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const out = JSON.parse(r.stdout);
  assert.equal(out.report.rows[0].ignoto, 1);
  assert.ok(out.plan.questions.length > 0);
  assert.equal(spawnSync(process.execPath, [KB, "epistemic", "--scope", "XXX", "--db", file], { encoding: "utf8" }).status, 1);
});
