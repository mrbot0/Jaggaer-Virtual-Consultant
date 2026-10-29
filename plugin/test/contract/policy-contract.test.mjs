// Contratto non negoziabile della policy (29/10/2026, punto 8: test di contratto separati dai test di comportamento).
// Qualunque rilassamento futuro dei guard passa da hooks/lib/policy-profiles.json, ma questi invarianti non cambiano:
// nessun profilo concede cancellazioni o upload liberi; la produzione non concede nulla; un piano attivo toglie
// l'esplorazione; senza sessione nulla; capacità sconosciute negate; docs/POLICY.md allineato alla fonte.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { POLICY, profileOf, allows } from "../../hooks/lib/policy.mjs";
import { ROOT } from "../helpers/hook-env.mjs";

const caps = Object.keys(POLICY.capabilities);

test("ogni profilo dichiara ogni capacità (booleano) e una descrizione di quando vale", () => {
  for (const [p, def] of Object.entries(POLICY.profiles)) {
    assert.ok(typeof def.quando === "string" && def.quando.length > 10, p);
    for (const c of caps) assert.equal(typeof def[c], "boolean", `${p}.${c}`);
  }
});

test("invarianti: nessun profilo concede cancellazioni o upload; la produzione e il piano non concedono nulla", () => {
  for (const [p, def] of Object.entries(POLICY.profiles)) {
    assert.equal(def.cancellazioni, false, p);
    assert.equal(def.caricamento_file, false, p);
  }
  for (const c of caps) {
    assert.equal(POLICY.profiles.produzione[c], false, `produzione.${c}`);
    assert.equal(POLICY.profiles.piano[c], false, `piano.${c}`);
  }
});

test("profilo: prod vince su tutto; il piano toglie l'esplorazione; esplorazione solo in sandbox o pre-produzione", () => {
  assert.equal(profileOf(null), "senza-sessione");
  assert.equal(profileOf({ mode: "esplorazione", env: { type: "prod" } }), "produzione");
  assert.equal(profileOf({ mode: "esplorazione", env: { type: "preprod" }, active_plan: { plan_id: "P" } }), "piano");
  assert.equal(profileOf({ mode: "esplorazione", env: { type: "preprod" } }), "esplorazione");
  assert.equal(profileOf({ mode: "esplorazione", env: { type: "sandbox" } }), "esplorazione");
  assert.equal(profileOf({ mode: "esplorazione", env: { type: "dev" } }), "standard");
  assert.equal(profileOf({ mode: "nrt", env: { type: "sandbox" } }), "standard");
  assert.equal(allows({ mode: "esplorazione", env: { type: "sandbox" } }, "capacità-inesistente"), false);
  assert.equal(allows(null, "navigazione_libera"), false);
  assert.equal(allows({ mode: "esplorazione", env: { type: "sandbox" } }, "navigazione_libera"), true);
});

test("docs/POLICY.md è generato dalla fonte unica (scripts/admin/policy-doc.mjs --check)", () => {
  const r = spawnSync(process.execPath, [join(ROOT, "scripts/admin/policy-doc.mjs"), "--check"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
