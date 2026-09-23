import { test } from "node:test";
import assert from "node:assert/strict";
import { coverage } from "../../scripts/kb/epistemic.mjs";

const cfg = { type: "CFG", attrs: { location: "tecnica", options: "tecnica", dependencies: "tecnica", current_state: "d'uso" } };
const ev0 = { obsConfirmations: 0, execWithOutcome: 0, userStatements: 0, freshness: 1, openContradictions: 0 };

test("libresco: doc alte, osservazione ed esecuzione basse; gaps calcolati", () => {
  const r = coverage(cfg, ev0);
  assert.equal(r.shape, "libresco");
  assert.deepEqual(r.gaps, ["impacts", "risk", "rollback"]);
});

test("contraddittorio vince su tutto; ignoto quando tutto è basso", () => {
  assert.equal(coverage(cfg, { ...ev0, obsConfirmations: 3, execWithOutcome: 3, openContradictions: 1 }).shape, "contraddittorio");
  assert.equal(coverage({ type: "CFG", attrs: {} }, ev0).shape, "ignoto");
});

test("consolidato con osservazione ed esecuzione", () => {
  const full = { type: "CFG", attrs: { location: "tecnica", options: "tecnica", dependencies: "tecnica", impacts: "tecnica", current_state: "d'uso", risk: "d'uso", rollback: "tecnica" } };
  assert.equal(coverage(full, { ...ev0, obsConfirmations: 3, execWithOutcome: 3, userStatements: 1 }).shape, "consolidato");
});
