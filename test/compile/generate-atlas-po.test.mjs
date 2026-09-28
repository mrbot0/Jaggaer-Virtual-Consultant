// WP09b C — generate-atlas-po (F4.2): catena di fallback in ordine DT-008 (testid → role → label → text → css), css solo
// con stability: fragile; strategia primaria da DT-008 (stabilità variabile/instabile ⇒ gradino successivo); page
// object Playwright con locator.or(); compile-plan --atlas usa la mappa.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { chainOf, primaryOf, generateAtlas, toPlaywright } from "../../scripts/compile/generate-atlas-po.mjs";
import { generateSpec } from "../../scripts/chrome/compile-plan.mjs";
import { kbWs, writeItem, sel } from "../helpers/wp09b-items.mjs";

const CLI = fileURLToPath(new URL("../../scripts/compile/generate-atlas-po.mjs", import.meta.url));
const S = (stability, strategies) => ({ ...sel("C.ACME.CAT.SEL.0001"), stability, strategies });

test("fallback in ordine DT-008 qualunque sia l'ordine dichiarato; css escluso salvo stability: fragile", () => {
  const strategies = [{ kind: "css", value: "#q" }, { kind: "label", value: "Cerca" }, { kind: "testid", value: "q" }, { kind: "text", value: "Cerca" }, { kind: "role", value: "searchbox", name: "Cerca" }];
  assert.deepEqual(chainOf(S("stable", strategies)).map((c) => c.kind), ["testid", "role", "label", "text"]);
  assert.deepEqual(chainOf(S("medium", strategies)).map((c) => c.kind), ["testid", "role", "label", "text"]);
  assert.deepEqual(chainOf(S("fragile", strategies)).map((c) => c.kind), ["testid", "role", "label", "text", "css"]);
  assert.deepEqual(chainOf(S("stable", [{ kind: "css", value: "#a" }, { kind: "css", value: "#b" }])), []);
});

test("primaria da DT-008: stabile ⇒ la prima disponibile; instabile su pattern dinamico (score > 0.5) ⇒ un gradino più giù", () => {
  const st = [{ kind: "testid", value: "q" }, { kind: "role", value: "button", name: "Salva" }, { kind: "label", value: "Salva" }];
  assert.equal(primaryOf(S("stable", st)).strategy.kind, "testid");
  assert.equal(primaryOf(S("fragile", st)).strategy.kind, "testid", "instabile da sola: 0.45 < 0.5");
  const f = primaryOf({ ...S("fragile", st), classification: { ui_pattern: "validazione-asincrona-griglia" } });
  assert.equal(f.dec.outcome, "role"); assert.equal(f.strategy.kind, "role");
});

test("generateAtlas + CLI: mappa JSON dei resolver e page object TS con locator.or(); le voci solo css non fragili sono escluse", () => {
  const w = kbWs();
  writeItem(w, sel("S.STD.CAT.SEL.0001", { label: "Cerca" }));
  writeItem(w, { ...sel("C.ACME.CAT.SEL.0002", { label: "Riga", stability: "fragile" }), strategies: [{ kind: "text", value: "Riga" }, { kind: "css", value: "tr.row" }] });
  writeItem(w, { ...sel("C.ACME.CAT.SEL.0003", { label: "Solo css" }), strategies: [{ kind: "css", value: "#x" }, { kind: "text", value: "x" }] });
  const a = generateAtlas(w, { customer: "ACME", scope: "CAT" });
  assert.deepEqual(Object.keys(a.selectors), ["C.ACME.CAT.SEL.0002", "C.ACME.CAT.SEL.0003", "S.STD.CAT.SEL.0001"]);
  assert.deepEqual(a.selectors["C.ACME.CAT.SEL.0002"].chain.map((c) => c.kind), ["text", "css"]);
  assert.deepEqual(a.selectors["C.ACME.CAT.SEL.0003"].chain.map((c) => c.kind), ["text"], "css tolto: stability non fragile");
  const ts = toPlaywright(a);
  assert.match(ts, /export const sel_S_STD_CAT_SEL_0001 = \(page: Page\): Locator => page\.getByTestId\("cerca"\)\.or\(page\.getByRole\("button", \{ name: "Cerca" \}\)\)\.or\(page\.getByLabel\("Cerca"\)\);/);
  const r = spawnSync(process.execPath, [CLI, "--scope", "CAT", "--customer", "ACME", "--ts", "--workspace", w, "--json"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(existsSync(join(w, "customers/ACME/tests/atlas/CAT.po.json")) && existsSync(join(w, "customers/ACME/tests/atlas/CAT.po.ts")));
  // compile-plan con la mappa: il target si risolve con la catena
  const atlas = JSON.parse(readFileSync(join(w, "customers/ACME/tests/atlas/CAT.po.json"), "utf8"));
  const plan = { plan_id: "PLAN.X", customer: "ACME", env: "sandbox", goal: "g", steps: [{ n: 1, verb: "CLICK", action_class: "ACT-OBS", target: "C.ACME.CAT.SEL.0002", expect: { page_sig: "x" } }], repair_policy: { skip_allowed: [], substitute_allowed: [], abort_on: [] } };
  assert.match(generateSpec(w, "ACME", plan, { atlas }).text, /page\.getByText\("Riga"\)\.click\(\)/);
  assert.match(generateSpec(w, "ACME", plan, { atlas, allowFragile: true }).text, /page\.getByText\("Riga"\)\.or\(page\.locator\("tr\.row"\)\)\.click\(\)/);
});
