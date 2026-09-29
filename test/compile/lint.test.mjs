// WP09b C — lint-spec (expect, DELETE, compensazione, derivation/boundary, anti-indebolimento §30.4 con --against, exit 3)
// e lint-scope (ADR-32: solo SEL/FLW dello scope, fixture di altri scope da handoff, nessuna creazione fra scope).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { lintCase, lintPlan, weakening } from "../../scripts/compile/lint-spec.mjs";
import { lintScope } from "../../scripts/compile/lint-scope.mjs";
import { compileCase } from "../../scripts/compile/compile-case.mjs";
import { kbWs, writeItem, writeCase, writeYaml, sel, flw, hnd, nrtCase } from "../helpers/wp09b-items.mjs";
import { cleanEnv } from "../helpers/hook-env.mjs";

const LINT = fileURLToPath(new URL("../../scripts/compile/lint-spec.mjs", import.meta.url));
const SCOPE = fileURLToPath(new URL("../../scripts/compile/lint-scope.mjs", import.meta.url));
const rules = (vs) => [...new Set(vs.map((x) => x.rule))].sort();

test("lint-spec: caso pulito; passo senza expect, DELETE, compensazione mancante o delete, derivation/boundary assenti, codice analitico ⇒ violazioni", () => {
  assert.deepEqual(lintCase(nrtCase()), []);
  const c = nrtCase();
  delete c.composition.steps[0].expect;
  c.composition.steps.push({ n: 5, verb: "DELETE", target: "C.ACME.P2P.SEL.0002", expect: { toast: "x" } });
  c.compensations = [{ step: 4, kind: "delete" }, { step: 3, kind: "cancel", action: "requisition.delete" }];
  delete c.derivation; delete c.boundary; c.summary = "come S.STD.P2P.BRF.0001";
  assert.deepEqual(rules(lintCase(c)), ["L-ANALYTIC", "L-DELETE", "L-DERIVATION", "L-EXPECT"]);
  const noComp = nrtCase(); noComp.compensations = [];
  assert.deepEqual(lintCase(noComp).map((x) => [x.rule, x.at]), [["L-COMP", "passo 3"], ["L-COMP", "passo 4"]]);
});

test("anti-indebolimento (§30.4): uguaglianza → contenimento, asserzione rimossa, messaggio rimosso, tolleranza allargata, errore atteso tolto, confine anticipato", () => {
  const old = nrtCase(undefined, { baseline: { tolerances: { numeric: { importo: 0.01 }, ignore_fields: [] } } });
  const neu = structuredClone(old);
  neu.composition.steps[1].expect = { value_contains: "FORN" };
  delete neu.composition.steps[2].expect.toast; neu.composition.steps[2].expect.page_sig = "x";
  neu.composition.steps[3].expect.messages = [];
  neu.baseline.tolerances = { numeric: { importo: 0.5 }, ignore_fields: ["data"] };
  neu.expected_errors = [];
  neu.boundary.stop_at_step = 3; neu.boundary.does_not_assert.push("l'invio");
  const w = weakening(old, neu).map((x) => x.message);
  assert.ok(w.some((m) => /uguaglianza su value sostituita da value_contains/.test(m)), w.join("\n"));
  assert.ok(w.some((m) => /expect\.toast rimossa/.test(m)));
  assert.ok(w.some((m) => /messages .*non più verificato/.test(m)));
  assert.ok(w.some((m) => /tolleranza su importo allargata/.test(m)));
  assert.ok(w.some((m) => /ignore_fields/.test(m)));
  assert.ok(w.some((m) => /errore atteso S\.STD\.P2P\.ERR\.0007 rimosso/.test(m)));
  assert.ok(w.some((m) => /confine anticipato/.test(m)));
  assert.ok(w.some((m) => /does_not_assert allargato/.test(m)));
  // un'asserzione rafforzata non è una violazione
  const strong = structuredClone(old); strong.composition.steps[3].expect.messages.push("Importo obbligatorio");
  assert.deepEqual(weakening(old, strong), []);
});

test("lint-spec CLI: exit 3 su violazione con --against, 0 sul pulito; lintPlan sul piano compilato", () => {
  const w = kbWs();
  writeItem(w, sel("C.ACME.P2P.SEL.0001", { role: "textbox", label: "Fornitore" }));
  writeItem(w, sel("C.ACME.P2P.SEL.0002", { label: "Salva bozza" }));
  writeItem(w, sel("C.ACME.P2P.SEL.0003", { label: "Invia" }));
  writeItem(w, flw("C.ACME.P2P.FLW.0001"));
  writeYaml(w, "customers/ACME/tests/fixtures.yaml", { fixtures: [{ name: "s", kind: "supplier", tags: ["attivo-it"], value: "F1" }] });
  const oldF = writeYaml(w, "tmp/old.yaml", nrtCase());
  const weak = nrtCase(); weak.composition.steps[3].expect = { page_sig: "requisition" };
  const newF = writeYaml(w, "tmp/new.yaml", weak);
  assert.equal(spawnSync(process.execPath, [LINT, oldF, "--json"], { encoding: "utf8", env: cleanEnv({ JVC_WORKSPACE: w }) }).status, 0);
  const r = spawnSync(process.execPath, [LINT, newF, "--against", oldF, "--json"], { encoding: "utf8", env: cleanEnv({ JVC_WORKSPACE: w }) });
  assert.equal(r.status, 3, r.stdout);
  assert.ok(JSON.parse(r.stdout).results[0].violations.some((x) => x.rule === "L-WEAKEN"));
  const plan = compileCase(w, nrtCase()).plan;
  assert.deepEqual(lintPlan(plan), []);
  const p2 = structuredClone(plan); p2.compensations = [];
  assert.deepEqual(rules(lintPlan(p2)), ["L-COMP"]);
  const p3 = structuredClone(plan); p3.steps[3].expect = { messages: [] };
  assert.ok(lintPlan(p3, { previous: plan }).some((x) => x.rule === "L-WEAKEN"));
});

test("lint-scope (ADR-32): SEL/FLW di un altro scope, creazione di un'entità di un altro scope, fixture di altro scope senza handoff ⇒ violazioni; con handoff valido ok", () => {
  assert.deepEqual(lintScope(nrtCase()), []);
  const c = nrtCase();
  c.composition.flows.push("C.ACME.VEN.FLW.0001");
  c.composition.steps[1].target = "C.ACME.VEN.SEL.0004";
  c.composition.steps[2].creates = { entity: "supplier", kind: "create", scope: "VEN" };
  c.fixtures.push({ name: "order", kind: "order", scope: "SRC", lookup_or_fail: { kind: "order" } });
  assert.deepEqual(rules(lintScope(c)), ["S-CREATE", "S-FIXTURE", "S-FLW", "S-SEL"]);
  const w = kbWs();
  writeItem(w, hnd("C.ACME.P2P.HND.0001", { from_scope: "SRC", to_scope: "P2P", owner_of_test: "P2P", shared_fixtures: ["order"] }));
  const ok = nrtCase(); ok.fixtures.push({ name: "order", kind: "order", scope: "SRC", from_handoff: "C.ACME.P2P.HND.0001", lookup_or_fail: { kind: "order" } });
  assert.deepEqual(lintScope(ok, { ws: w, customer: "ACME" }), []);
  const wrong = nrtCase(); wrong.fixtures.push({ name: "contract", kind: "contract", scope: "CON", from_handoff: "C.ACME.P2P.HND.0001", lookup_or_fail: { kind: "contract" } });
  assert.match(lintScope(wrong, { ws: w, customer: "ACME" })[0].message, /non lega CON e P2P/);
  const f = writeCase(w, c);
  assert.equal(spawnSync(process.execPath, [SCOPE, f, "--workspace", w, "--json"], { encoding: "utf8", env: cleanEnv({ JVC_WORKSPACE: w }) }).status, 3);
  assert.equal(spawnSync(process.execPath, [SCOPE, writeCase(w, nrtCase("NRT.ACME.P2P.NEG.0002")), "--workspace", w, "--json"], { encoding: "utf8", env: cleanEnv({ JVC_WORKSPACE: w }) }).status, 0);
});
