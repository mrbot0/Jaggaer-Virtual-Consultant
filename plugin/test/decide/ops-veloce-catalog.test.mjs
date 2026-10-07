// Ops veloce, spec 2026-10-06 §3.3 / §3.7 / §3.8 / §3.9: catalogo delle azioni
// (produzione con approvazione, massivi in preprod, DELETE in sandbox/preprod),
// passo UPLOAD con file e FILL con fields nello schema del piano.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ACT } from "../../hooks/lib/act-classes.mjs";
import { validatePlan } from "../../scripts/decide/validate-plan.mjs";

const SEL = "C.ACME.P2P.SEL.0001";
const plan = (steps) => ({ plan_id: "PLAN.ACME.T.1", customer: "ACME", env: "x", goal: "t", steps, repair_policy: { skip_allowed: [], substitute_allowed: [], abort_on: [] } });

test("catalogo: produzione con approvazione, massivi in preprod, cancellazioni in sandbox/preprod", () => {
  for (const c of ["ACT-CREATE", "ACT-UPDATE", "ACT-UPLOAD", "ACT-SUBMIT", "ACT-CLOSE", "ACT-APPROVE", "ACT-TRANSMIT", "ACT-PUBLISH", "ACT-CFG-CHANGE", "ACT-BULK"]) assert.equal(ACT[c].prod, "approval", c);
  assert.equal(ACT["ACT-BULK"].preprod, "approval");
  assert.deepEqual([ACT["ACT-DELETE"].sandbox, ACT["ACT-DELETE"].preprod, ACT["ACT-DELETE"].prod], ["approval", "approval", "never"]);
});

test("validate-plan: DELETE ammesso in preprod e negato in prod; scritture in prod ammesse; UPLOAD con file; FILL con fields", () => {
  const del = plan([{ n: 1, verb: "DELETE", action_class: "ACT-DELETE", target: SEL, expect: { elements: [] } }]);
  assert.equal(validatePlan(del, { env: { type: "preprod", id: "x" } }).ok, true);
  assert.equal(validatePlan(del, { env: { type: "prod", id: "x" } }).ok, false);
  const wr = plan([{ n: 1, verb: "SAVE", action_class: "ACT-CREATE", target: SEL, expect: { page_sig: "p" } }]);
  assert.equal(validatePlan(wr, { env: { type: "prod", id: "x" } }).ok, true);
  const up = plan([{ n: 1, verb: "UPLOAD", action_class: "ACT-BULK", target: SEL, file: { path: "runs/RUN.ACME.20261007.1000.P2P/import/de.xlsx", sha256: "a".repeat(64), rows: 3 }, expect: { toast: "ok" } }]);
  assert.equal(validatePlan(up, { env: { type: "preprod", id: "x" } }).ok, true);
  const upNoFile = plan([{ n: 1, verb: "UPLOAD", action_class: "ACT-BULK", target: SEL, expect: { toast: "ok" } }]);
  assert.equal(validatePlan(upNoFile, { env: { type: "preprod", id: "x" } }).ok, false);
  const ff = plan([{ n: 1, verb: "FILL", action_class: "ACT-CREATE", fields: [{ target: SEL, value: "x" }, { target: "C.ACME.P2P.SEL.0002", value: 2 }], expect: { elements: [] } }]);
  assert.equal(validatePlan(ff, { env: { type: "sandbox", id: "x" } }).ok, true);
});
