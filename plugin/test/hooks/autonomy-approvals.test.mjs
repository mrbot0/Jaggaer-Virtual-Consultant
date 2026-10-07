// Ops veloce (spec 2026-10-06 §2.2, §3.4): le approvazioni richieste dipendono dal livello di autonomia.
import { test } from "node:test";
import assert from "node:assert/strict";
import { requiredApprovals } from "../../hooks/lib/guards/config-scope.mjs";

const E = (type, policy = {}) => ({ type, id: type, policy: { approvals: { config_verde: 1, config_giallo: 2, config_rosso: 3 }, ...policy } });
const R2 = { verb: "SUBMIT", risk: "R2" };
const r = (cls, step, env, aut, lvl = "verde") => { const x = requiredApprovals(cls, step, env, lvl, aut); return Object.entries(x).filter(([, v]) => v).map(([k]) => k).join("+") || "-"; };

test("requiredApprovals: senza livello = comportamento di oggi (basso)", () => {
  assert.equal(r("ACT-SUBMIT", R2, E("sandbox")), "action");
  assert.equal(r("ACT-BULK", {}, E("sandbox")), "a1+a3");
  assert.equal(r("ACT-CFG-CHANGE", {}, E("preprod"), undefined, "giallo"), "a1+a3");
  assert.equal(r("ACT-CREATE", {}, E("preprod")), "-");
});

test("requiredApprovals: tabella 2.2 della spec", () => {
  assert.equal(r("ACT-SUBMIT", R2, E("sandbox"), "alto"), "-");
  assert.equal(r("ACT-SUBMIT", R2, E("sandbox"), "medio"), "-");
  assert.equal(r("ACT-BULK", {}, E("sandbox"), "alto"), "-");
  assert.equal(r("ACT-BULK", {}, E("sandbox"), "medio"), "a1+a3");
  assert.equal(r("ACT-CFG-CHANGE", {}, E("sandbox"), "alto", "rosso"), "a1");
  assert.equal(r("ACT-DELETE", {}, E("sandbox"), "alto"), "a1");
  assert.equal(r("ACT-DELETE", {}, E("preprod"), "medio"), "a1+a3");
  assert.equal(r("ACT-SUBMIT", R2, E("preprod"), "alto"), "a1");
  assert.equal(r("ACT-SUBMIT", R2, E("preprod"), "medio"), "a1");
  assert.equal(r("ACT-SUBMIT", R2, E("preprod"), "basso"), "action");
  assert.equal(r("ACT-BULK", {}, E("preprod"), "alto"), "-");
  assert.equal(r("ACT-CFG-CHANGE", {}, E("preprod", { second_approver_required: true }), "alto", "rosso"), "a1+a2");
  assert.equal(r("ACT-CREATE", {}, E("prod"), "medio"), "a1+a2+a3");
  assert.equal(r("ACT-CREATE", {}, E("prod", { second_approver_required: false }), "medio"), "a1+a3");
  assert.equal(r("ACT-BULK", {}, E("prod", { second_approver_required: false }), "basso"), "a1+a3");
  assert.equal(r("ACT-READ", {}, E("prod"), "medio"), "-");
});
