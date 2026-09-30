// WP09b D — select-suite (stato, shard per scope, smoke/full/delta, priorità DT-012, manifest nel run RUN a cinque
// segmenti) e fixtures (lookup_or_fail, prefisso NRT-<data>-<run>, registro delle entità create, orfani).
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { selectSuite, writeManifest } from "../../scripts/run/select-suite.mjs";
import { lookupOrFail, resolveCaseFixtures, entityPrefix, registerCreated, orphans, markCompensated, loadRegistry, FixtureError } from "../../scripts/run/fixtures.mjs";
import { kbWs, writeCase, writeYaml, nrtCase } from "../helpers/wp09b-items.mjs";

const SEL = fileURLToPath(new URL("../../scripts/run/select-suite.mjs", import.meta.url));
const FIX = fileURLToPath(new URL("../../scripts/run/fixtures.mjs", import.meta.url));
const AT = new Date(2026, 8, 29, 14, 30);

function casesWs() {
  const w = kbWs();
  writeCase(w, nrtCase("NRT.ACME.P2P.NEG.0001", { state: "promoted", criticality: "alta" }));
  writeCase(w, nrtCase("NRT.ACME.P2P.NEG.0002", { state: "promoted", criticality: "bassa", derivation: { from: ["S.STD.P2P.FLD.0009"], risk_mode: "formato" } }));
  writeCase(w, nrtCase("NRT.ACME.P2P.INT.0003", { state: "shadow", criticality: "media", derivation: { from: ["S.STD.P2P.INT.0001"], risk_mode: "propagazione" } }));
  writeCase(w, nrtCase("NRT.ACME.P2P.SMK.0004", { state: "promoted", criticality: "media", expected_errors: undefined }));
  writeCase(w, nrtCase("NRT.ACME.P2P.NEG.0005", { state: "candidate" }));
  writeCase(w, nrtCase("NRT.ACME.P2P.NEG.0006", { state: "quarantine" }));
  return w;
}

test("select-suite: promoted (e shadow con --shadow), mai candidate/quarantine; smoke = SMK; delta = soggetti cambiati; ordine DT-012", () => {
  const w = casesWs();
  const full = selectSuite(w, { customer: "ACME", scope: "P2P", suite: "full", now: AT });
  assert.equal(full.run, "RUN.ACME.20260929.1430.P2P");
  assert.deepEqual(full.cases.map((c) => c.id).sort(), ["NRT.ACME.P2P.NEG.0001", "NRT.ACME.P2P.NEG.0002", "NRT.ACME.P2P.SMK.0004"]);
  assert.equal(full.cases[0].id, "NRT.ACME.P2P.NEG.0001", "criticità alta prima");
  assert.ok(full.cases.every((c, i, a) => i === 0 || a[i - 1].priority >= c.priority));
  assert.deepEqual(full.excluded.filter((e) => /stato/.test(e.reason)).map((e) => e.id).sort(), ["NRT.ACME.P2P.INT.0003", "NRT.ACME.P2P.NEG.0005", "NRT.ACME.P2P.NEG.0006"]);
  const sh = selectSuite(w, { customer: "ACME", scope: "P2P", suite: "full", shadow: true, now: AT });
  assert.ok(sh.cases.some((c) => c.id === "NRT.ACME.P2P.INT.0003" && c.dt012.integration === true));
  assert.deepEqual(selectSuite(w, { customer: "ACME", scope: "P2P", suite: "smoke", now: AT }).cases.map((c) => c.id), ["NRT.ACME.P2P.SMK.0004"]);
  const delta = selectSuite(w, { customer: "ACME", scope: "P2P", suite: "delta", changed: ["S.STD.P2P.FLD.0009"], now: AT });
  assert.deepEqual(delta.cases.map((c) => c.id), ["NRT.ACME.P2P.NEG.0002"]);
  assert.equal(delta.cases[0].dt012.volatility, "alta");
  assert.throws(() => selectSuite(w, { customer: "ACME", scope: "P2P", suite: "delta", now: AT }), /delta/);
});

test("select-suite: manifest in runs/RUN.<C>.<AAAAMMDD>.<HHMM>.<S>/; stesso minuto ⇒ errore; CLI exit 3 senza casi", () => {
  const w = casesWs();
  const m = selectSuite(w, { customer: "ACME", scope: "P2P", suite: "full", now: AT });
  assert.equal(writeManifest(w, m), "runs/RUN.ACME.20260929.1430.P2P/manifest.yaml");
  assert.equal(YAML.parse(readFileSync(join(w, "customers/ACME/runs/RUN.ACME.20260929.1430.P2P/manifest.yaml"), "utf8")).cases.length, 3);
  assert.throws(() => writeManifest(w, m), /esiste già/);
  const r = spawnSync(process.execPath, [SEL, "--suite", "full", "--scope", "P2P", "--customer", "ACME", "--at", "2026-09-29T15:00:00", "--workspace", w, "--json"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(JSON.parse(r.stdout).file, /^runs\/RUN\.ACME\.20260929\.1500\.P2P\/manifest\.yaml$/);
  assert.equal(spawnSync(process.execPath, [SEL, "--suite", "full", "--scope", "CAT", "--customer", "ACME", "--workspace", w, "--json"], { encoding: "utf8" }).status, 3);
});

test("fixtures: lookup_or_fail trova o fallisce (mai crea); fixture di un caso risolte; ambiente rispettato", () => {
  const w = kbWs();
  writeYaml(w, "customers/ACME/tests/fixtures.yaml", { fixtures: [
    { name: "supplier_it", kind: "supplier", tags: ["attivo-it"], value: "FORN-1", attrs: { vat: "IT1" } },
    { name: "supplier_pre", kind: "supplier", tags: ["attivo-it"], env: "preprod", value: "FORN-2" },
  ] });
  const reg = loadRegistry(w, "ACME");
  assert.equal(lookupOrFail(reg, { kind: "supplier", tag: "attivo-it", vat: "IT1" }).name, "supplier_it");
  assert.equal(lookupOrFail(reg, { kind: "supplier", tag: "attivo-it" }, { env: "preprod" }).name, "supplier_it");
  assert.throws(() => lookupOrFail(reg, { kind: "supplier", tag: "bloccato" }), (e) => e instanceof FixtureError && e.code === 3 && /non si crea al volo/.test(e.message));
  const r = resolveCaseFixtures(nrtCase(), reg);
  assert.equal(r.values.supplier.name, "supplier_it"); assert.deepEqual(r.missing, []);
  const cli = spawnSync(process.execPath, [FIX, "lookup", "kind=supplier", "tag=bloccato", "--customer", "ACME", "--workspace", w, "--json"], { encoding: "utf8" });
  assert.equal(cli.status, 3);
  assert.equal(spawnSync(process.execPath, [FIX, "lookup", "kind=supplier", "tag=attivo-it", "--customer", "ACME", "--workspace", w, "--json"], { encoding: "utf8" }).status, 0);
});

test("fixtures: prefisso NRT-<data>-<run>, registro delle entità create (mai delete), orfani finché non compensate (0 dopo)", () => {
  const w = kbWs();
  const run = "RUN.ACME.20260929.1430.P2P";
  const p = entityPrefix(run);
  assert.match(p, /^NRT-20260929-[0-9A-F]{4}$/);
  assert.equal(entityPrefix(run), p, "deterministico");
  assert.notEqual(entityPrefix("RUN.ACME.20260929.1431.P2P"), p);
  const a = registerCreated(w, "ACME", run, { entity: "requisition", case: "NRT.ACME.P2P.POS.0001", step: 3, compensation: { kind: "cancel" } });
  const b = registerCreated(w, "ACME", run, { entity: "requisition", case: "NRT.ACME.P2P.POS.0001", step: 4 });
  assert.equal(a.ref, `${p}-REQUIS-001`); assert.equal(b.ref, `${p}-REQUIS-002`);
  assert.throws(() => registerCreated(w, "ACME", run, { entity: "x", compensation: { kind: "delete" } }), /mai delete/);
  assert.throws(() => registerCreated(w, "ACME", run, { entity: "x", ref: "ABC-1" }), /prefisso NRT-/);
  assert.equal(orphans(w, "ACME", { run }).length, 2);
  markCompensated(w, "ACME", run, a.ref); markCompensated(w, "ACME", run, b.ref);
  assert.equal(orphans(w, "ACME", { run }).length, 0);
  assert.ok(existsSync(join(w, "customers/ACME/runs", run, "created.yaml")), "il registro resta: le entità si chiudono, non si cancellano");
  const cli = spawnSync(process.execPath, [FIX, "orphans", "--run", run, "--customer", "ACME", "--workspace", w, "--json"], { encoding: "utf8" });
  assert.equal(cli.status, 0, cli.stdout);
});
