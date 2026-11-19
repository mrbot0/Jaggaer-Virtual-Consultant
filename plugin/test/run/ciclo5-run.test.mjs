// 18/11/2026 (ciclo di bug fixing 5, collaudo NRT): regressioni della corsia run.
//   1. select-suite: un caso illeggibile (YAML rotto) o senza id non sparisce in silenzio dal run: è fra gli esclusi
//      con il motivo, così chi l'ha scritto lo vede nel manifest;
//   2. baseline compare: --case è un codice NRT (niente letture fuori da tests/baselines/) e --observed è richiesto.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { selectSuite } from "../../scripts/run/select-suite.mjs";
import { compare, BaselineError } from "../../scripts/run/baseline.mjs";
import { kbWs, writeCase, writeYaml, nrtCase } from "../helpers/wp09b-items.mjs";

const AT = new Date(2026, 10, 18, 10, 0);

test("select-suite: caso illeggibile o senza id ⇒ escluso con il motivo (non sparisce dal manifest)", () => {
  const w = kbWs();
  writeCase(w, nrtCase("NRT.ACME.P2P.NEG.0001", { state: "promoted" }));
  const dir = join(w, "customers/ACME/tests/cases/P2P");
  writeFileSync(join(dir, "NRT.ACME.P2P.NEG.0002.yaml"), "id: NRT.ACME.P2P.NEG.0002\nsteps: [ {n: 1\n");   // YAML rotto
  writeFileSync(join(dir, "NRT.ACME.P2P.NEG.0003.yaml"), "title: caso senza id\nstate: promoted\n");
  const m = selectSuite(w, { customer: "ACME", scope: "P2P", suite: "full", now: AT });
  assert.deepEqual(m.cases.map((c) => c.id), ["NRT.ACME.P2P.NEG.0001"]);
  const bad = m.excluded.filter((e) => /illeggibile|senza id/.test(e.reason));
  assert.deepEqual(bad.map((e) => e.file).sort(), ["tests/cases/P2P/NRT.ACME.P2P.NEG.0002.yaml", "tests/cases/P2P/NRT.ACME.P2P.NEG.0003.yaml"], JSON.stringify(m.excluded));
});

test("baseline compare: --case con risalita o non NRT ⇒ errore utente; --observed mancante ⇒ errore utente", () => {
  const w = kbWs();
  // una baseline «forgiata» fuori da tests/baselines/: compare non la deve leggere
  writeYaml(w, "customers/ACME/config/evil.yaml", { case: "x", version: 1, observed: { a: 1 }, tolerances: {} });
  mkdirSync(join(w, "customers/ACME/tests/baselines"), { recursive: true });
  assert.throws(() => compare(w, { customer: "ACME", caseId: "../../config/evil", observed: { a: 1 } }), (e) => e instanceof BaselineError && e.code === 1 && /codice del caso non valido/.test(e.message));
  writeYaml(w, "customers/ACME/tests/baselines/NRT.ACME.P2P.BSL.0001.yaml", { case: "NRT.ACME.P2P.BSL.0001", version: 1, observed: { a: 1 }, tolerances: {} });
  assert.throws(() => compare(w, { customer: "ACME", caseId: "NRT.ACME.P2P.BSL.0001", observed: null }), (e) => e instanceof BaselineError && e.code === 1 && /osservato mancante/.test(e.message));
  assert.equal(compare(w, { customer: "ACME", caseId: "NRT.ACME.P2P.BSL.0001", observed: { a: 1 } }).match, true);
});
