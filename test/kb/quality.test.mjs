import { test } from "node:test";
import assert from "node:assert/strict";
import { confidence, freshness, weight } from "../../scripts/kb/weights.mjs";
import { decayValue, quality } from "../../scripts/kb/quality.mjs";

test("confidenza: formula §6.3", () => {
  assert.equal(confidence({ sourceWeight: 0.85, freshness: 1.0, confirmations: 5, openContradictions: 0 }).toFixed(4), "0.9775");
  assert.equal(freshness(0), 1.0); assert.equal(freshness(1), 0.9); assert.equal(freshness(2), 0.75); assert.equal(freshness(3), 0.5);
});

test("W: portabilità e stato", () => {
  assert.equal(weight({ confidence: 1, portability: "specifica", same_customer: false, status: "promosso" }), 0.1);
  assert.equal(weight({ confidence: 1, portability: "condizionata", condition_met: false, status: "promosso" }), 0.2);
  assert.equal(weight({ confidence: 0.8, portability: "universale", status: "grezzo" }), 0);
});

test("decadimento per tipo, pavimento 0.2, Q monotona nell'età, classe operativa a età 0", () => {
  assert.equal(decayValue(45, "SEL").toFixed(2), "0.50");
  assert.equal(decayValue(365, "KEY").toFixed(2), "0.50");
  assert.equal(decayValue(100000, "SEL"), 0.2);
  const p = (age) => ({ ageDays: age, releaseDistance: 0, authority: 1, docStatus: 1, corroboration: 3, openContradictions: 0, specificity: 1,
    completeness: 1, verifiability: 1, verificationMethod: 1, lastVerifiedDays: age, applicability: 1, stability: 1, unitQuality: 1, envFactor: 1 });
  assert.ok(quality(p(10), "generic", "CFG").Q > quality(p(400), "generic", "CFG").Q);
  assert.equal(quality(p(0), "generic", "CFG").class, "operativa");
});
