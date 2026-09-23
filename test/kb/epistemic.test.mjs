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
  // Un attributo può essere coperto da più generi di fonte contemporaneamente
  // (§9.2: "attributi_attesi_coperti_da_fonti_tecniche / attributi_attesi" —
  // un genere non esclude l'altro sullo stesso attributo).
  const full = { type: "CFG", attrs: { location: ["tecnica", "d'uso"], options: ["tecnica", "d'uso"], dependencies: "tecnica", impacts: "tecnica", current_state: ["d'uso", "tecnica"], risk: "d'uso", rollback: "tecnica" } };
  assert.equal(coverage(full, { ...ev0, obsConfirmations: 3, execWithOutcome: 3, userStatements: 1 }).shape, "consolidato");
});

test("k_user non influenza k_use: i due canali restano indipendenti (§9.2, §9.4)", () => {
  const withUser = coverage(cfg, { ...ev0, userStatements: 10 });
  const withoutUser = coverage(cfg, { ...ev0, userStatements: 0 });
  assert.equal(withUser.k_use, withoutUser.k_use);
  assert.ok(withUser.k_user > withoutUser.k_user);
});
