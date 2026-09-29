// WP09d — E. Config audit (F10, §51.4): baseline con impronta, deriva fra due ambienti (proposta per alignment.drift_known,
// environments.yaml mai modificato), regola RUL violata su una baseline sintetica.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import YAML from "yaml";
import { openDb } from "../../scripts/kb/db.mjs";
import { writeAnalysisItem, facetsFor } from "../../scripts/analysis/common.mjs";
import { diff } from "../../scripts/config/diff.mjs";
import { lint, holds } from "../../scripts/config/lint.mjs";
import { cfg, writeItem } from "../helpers/wp09b-items.mjs";
import { ws09d, cli } from "../helpers/wp09d.mjs";

const B = "scripts/config/baseline.mjs";
const D = "scripts/config/diff.mjs";
const LNT = "scripts/config/lint.mjs";

function auditWs() {
  const ws = ws09d();
  writeItem(ws, cfg("C.ACME.ADM.CFG.0019", { area: "CL-CFG-020", current_state: { value: { strict_import: true, batch: 500 }, observed_at: "2026-09-20", source: "osservazione" } }));
  writeItem(ws, cfg("C.ACME.ADM.CFG.0020", { area: "CL-CFG-006", current_state: { value: "assente", observed_at: "2026-09-20", source: "osservazione", env: "preprod" } }));
  const db = openDb(join(ws, "customers", "ACME", "knowledge.db"));
  db.prepare("insert into observations(code, session, scope, page_sig, payload, confirmed_count) values (?,?,?,?,?,1)")
    .run("L.ACME.ADM.OBS.0001", "SES.ACME.1", "ADM", "adm/import", JSON.stringify({ id: "L.ACME.ADM.OBS.0001", env: "sandbox", ts: "2026-09-21T10:00:00Z", config: { object: "C.ACME.ADM.CFG.0031", area: "CL-CFG-005", values: { notify: "daily" } } }));
  db.close();
  mkdirSync(join(ws, "customers", "ACME", "config"), { recursive: true });
  writeFileSync(join(ws, "customers", "ACME", "config", "environments.yaml"), "environments: []\n");
  return ws;
}

test("baseline: CFG current_state + OBS con config dell'ambiente + --input; impronta; mai sovrascritta", () => {
  const ws = auditWs();
  const r = cli(B, ["--customer", "ACME", "--env", "sandbox", "--json"], { ws });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.json.objects, 2, "CFG.0020 è di preprod: escluso");
  assert.deepEqual(r.json.sources, { cfg: 1, obs: 1, input: 0 });
  const doc = YAML.parse(readFileSync(r.json.file, "utf8"));
  assert.deepEqual(doc.objects["C.ACME.ADM.CFG.0019"].values, { strict_import: true, batch: 500 });
  assert.match(doc.hash, /^[0-9a-f]{64}$/);
  const r2 = cli(B, ["--customer", "ACME", "--env", "sandbox", "--json"], { ws });
  assert.notEqual(r2.json.file, r.json.file, "la baseline esistente non si sovrascrive");
  assert.equal(readdirSync(join(ws, "customers/ACME/config-baselines/sandbox")).length, 2);
  assert.equal(cli(B, ["--customer", "ACME", "--env", "vuoto", "--json"], { ws: ws09d() }).status, 1, "nessun oggetto");
});

test("diff: deriva rilevata fra sandbox e preprod; proposta per alignment.drift_known; environments.yaml intatto", () => {
  const ws = auditWs();
  assert.equal(cli(B, ["--customer", "ACME", "--env", "sandbox", "--json"], { ws }).status, 0);
  const input = join(ws, "preprod.yaml");
  writeFileSync(input, YAML.stringify({ objects: { "C.ACME.ADM.CFG.0019": { area: "CL-CFG-020", values: { strict_import: false, batch: 500 } }, "C.ACME.ADM.CFG.0031": { area: "CL-CFG-005", values: { notify: "daily" } } } }));
  assert.equal(cli(B, ["--customer", "ACME", "--env", "preprod", "--input", input, "--json"], { ws }).status, 0);
  const envBefore = readFileSync(join(ws, "customers/ACME/config/environments.yaml"), "utf8");
  const r = cli(D, ["--customer", "ACME", "--env-a", "sandbox", "--env-b", "preprod", "--propose", "--json"], { ws });
  assert.equal(r.status, 3, r.stdout + r.stderr);
  assert.deepEqual(r.json.drift.map((d) => [d.object, d.kind, d.path, d.a, d.b]), [
    ["C.ACME.ADM.CFG.0019", "changed", "strict_import", true, false],
    ["C.ACME.ADM.CFG.0020", "only_b", null, null, { value: "assente" }],
  ]);
  const p = YAML.parse(readFileSync(r.json.proposal, "utf8"));
  assert.equal(p.proposal, "alignment.drift_known"); assert.equal(p.status, "da-approvare");
  assert.deepEqual(p.drift_known[0], { object: "C.ACME.ADM.CFG.0019", paths: ["strict_import"] });
  assert.equal(readFileSync(join(ws, "customers/ACME/config/environments.yaml"), "utf8"), envBefore, "environments.yaml non si tocca");
  assert.deepEqual(diff({ objects: { a: { values: { x: [1, 2] } } } }, { objects: { a: { values: { x: [1, 2] } } } }), []);
});

test("baseline manomessa (impronta diversa) ⇒ rifiutata da diff e lint", () => {
  const ws = auditWs();
  const r = cli(B, ["--customer", "ACME", "--env", "sandbox", "--json"], { ws });
  const doc = YAML.parse(readFileSync(r.json.file, "utf8"));
  doc.objects["C.ACME.ADM.CFG.0019"].values.strict_import = false;
  writeFileSync(r.json.file, YAML.stringify(doc));
  const l = cli(LNT, ["--customer", "ACME", "--baseline", r.json.file, "--json"], { ws });
  assert.equal(l.status, 2); assert.match(l.json.error, /impronta/);
});

test("lint: regola RUL violata su una baseline sintetica (per area, con when), rispettata ⇒ exit 0", () => {
  const ws = auditWs();
  writeAnalysisItem(ws, { customer: "ACME", scope: "ADM", type: "RUL" }, (code) => ({ id: code, type: "RUL", title: "Import rigoroso attivo", summary: "strict_import deve essere attivo.",
    facets: facetsFor("RUL"), sources: [{ note: "politica del cliente" }],
    rule: { applies_to: { area: "CL-CFG-020" }, when: { path: "batch", op: "gte", value: 100 }, assert: { path: "strict_import", op: "eq", value: true }, severity: "high", message: "import senza unicità" } }));
  const synth = join(ws, "synth.yaml");
  writeFileSync(synth, YAML.stringify({ objects: { "C.ACME.ADM.CFG.0019": { area: "CL-CFG-020", values: { strict_import: false, batch: 500 } } } }));
  const b = cli(B, ["--customer", "ACME", "--env", "preprod", "--input", synth, "--json"], { ws });
  const r = cli(LNT, ["--customer", "ACME", "--env", "preprod", "--json"], { ws });
  assert.equal(r.status, 3, r.stdout + r.stderr);
  assert.deepEqual(r.json.violations.map((v) => [v.rule, v.object, v.path, v.expected, v.actual, v.severity]), [["C.ACME.ADM.RUL.0001", "C.ACME.ADM.CFG.0019", "strict_import", true, false, "high"]]);
  const ok = cli(B, ["--customer", "ACME", "--env", "sandbox", "--json"], { ws });
  assert.equal(cli(LNT, ["--customer", "ACME", "--baseline", ok.json.file, "--json"], { ws }).status, 0);
  assert.ok(b.json.file);
  assert.equal(lint({ objects: { k: { area: "CL-CFG-020", values: { batch: 10, strict_import: false } } } }, [{ id: "R", rule: { applies_to: { area: "CL-CFG-020" }, when: { path: "batch", op: "gte", value: 100 }, assert: { path: "strict_import", op: "eq", value: true }, severity: "low" } }]).violations.length, 0, "when non soddisfatta ⇒ regola non valutata");
  assert.equal(holds("abc", { op: "regex", value: "^a" }), true); assert.equal(holds(undefined, { op: "absent" }), true); assert.equal(holds(3, { op: "in", value: [1, 3] }), true);
});
