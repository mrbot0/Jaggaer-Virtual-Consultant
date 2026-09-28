// WP09b C — compile-case (F4.1): caso NRT → piano con traccia attesa, evidenze, compensazioni prima del passo che crea,
// fixture lookup_or_fail; rifiuti: caso senza compensazione, dominio analitico, fixture mancante, SEL assente.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { compileCase, CompileError } from "../../scripts/compile/compile-case.mjs";
import { validatePlan } from "../../scripts/decide/validate-plan.mjs";
import { kbWs, writeItem, writeCase, writeYaml, sel, flw, nrtCase } from "../helpers/wp09b-items.mjs";

const CLI = fileURLToPath(new URL("../../scripts/compile/compile-case.mjs", import.meta.url));
function ws() {
  const w = kbWs();
  writeItem(w, sel("C.ACME.P2P.SEL.0001", { role: "textbox", label: "Fornitore" }));
  writeItem(w, sel("C.ACME.P2P.SEL.0002", { role: "button", effect: "write", label: "Salva bozza" }));
  writeItem(w, sel("C.ACME.P2P.SEL.0003", { role: "button", effect: "write", label: "Invia" }));
  writeItem(w, flw("C.ACME.P2P.FLW.0001"));
  writeYaml(w, "customers/ACME/tests/fixtures.yaml", { fixtures: [{ name: "supplier_it", kind: "supplier", tags: ["attivo-it"], scope: "VEN", value: "FORN-0001", attrs: { vat: "IT01234567890" } }] });
  return w;
}
const code = (fn) => { try { fn(); return 0; } catch (err) { assert.ok(err instanceof CompileError, String(err)); return err.code; } };

test("caso → piano valido: traccia attesa per passo, compensazioni legate ai passi che creano, fixture risolta, evidenze", () => {
  const w = ws();
  const r = compileCase(w, nrtCase(), { run: "RUN.ACME.20260929.1000.P2P" });
  assert.equal(r.plan.plan_id, "PLAN.NRT.ACME.P2P.NEG.0001");
  assert.equal(validatePlan(r.plan, { env: { id: "sandbox", type: "sandbox" } }).ok, true);
  assert.deepEqual(r.plan.steps.map((s) => [s.n, s.verb, s.action_class]), [[1, "NAVIGATE", "ACT-OBS"], [2, "FILL", "ACT-OBS"], [3, "SAVE", "ACT-CREATE"], [4, "SUBMIT", "ACT-SUBMIT"]]);
  assert.ok(r.plan.steps.every((s) => s.expect && Object.keys(s.expect).length));
  assert.equal(r.plan.steps[1].data, "FORN-0001"); assert.equal(r.plan.steps[1].expect.value, "FORN-0001");
  assert.deepEqual(r.plan.compensations.map((c) => [c.step, c.kind, c.action]), [[3, "cancel", "requisition.cancel-draft"], [4, "cancel", "requisition.withdraw"]]);
  assert.deepEqual(r.plan.repair_policy.abort_on, [3, 4]);
  assert.equal(r.plan.storage_state, ".auth/buyer.json");
  assert.equal(r.plan.checkpoint_dir, undefined, "il run si deduce dal percorso: lo stesso caso ha lo stesso piano in ogni run");
  assert.deepEqual(r.plan.evidence, [{ at: 4, kind: "assertion", caption: "assertion al passo 4" }]);
  assert.deepEqual(r.trace.filter((t) => t.compensation).map((t) => t.compensation.before_step), [3, 4]);
  assert.equal(r.trace[3].boundary, true);
  assert.deepEqual(r.fixtures, { supplier: "supplier_it" });
});

test("F4.1: un caso il cui passo che crea non ha compensazione è rifiutato (anche dalla CLI, exit 3); la FLW del passo la fornisce se il caso la omette", () => {
  const w = ws();
  const c = nrtCase(); c.compensations = [c.compensations[1]]; c.composition.flows = [];
  assert.equal(code(() => compileCase(w, c)), 3);
  assert.throws(() => compileCase(w, c), /passo 3 .*senza compensazione/);
  const f = writeCase(w, c);
  const cli = spawnSync(process.execPath, [CLI, "--case", f, "--workspace", w, "--json"], { encoding: "utf8" });
  assert.equal(cli.status, 3, cli.stdout + cli.stderr);
  // la compensazione della FLW (cancel requisition.cancel-draft) vale per il passo che eredita dalla FLW
  const c2 = nrtCase(); c2.compensations = [c2.compensations[1]]; c2.composition.steps[2] = { n: 3, verb: "SAVE", from_flow: { flow: "C.ACME.P2P.FLW.0001", step: 3 } };
  const r = compileCase(w, c2);
  assert.deepEqual(r.plan.compensations[0], { step: 3, kind: "cancel", entity: "requisition", action: "requisition.cancel-draft", note: "registrata prima del passo 3 (§29.6) — dalla FLW C.ACME.P2P.FLW.0001" });
  assert.deepEqual(r.plan.steps[2].expect, { toast: "Bozza salvata" }, "expect ereditato dalla FLW");
  assert.equal(r.trace[2].source, "C.ACME.P2P.FLW.0001#3");
});

test("rifiuti: dominio analitico citato, fixture mancante (lookup_or_fail), SEL fuori Atlas, passo senza expect né SEL, caso senza derivation", () => {
  const w = ws();
  assert.equal(code(() => compileCase(w, nrtCase(undefined, { summary: "vedi S.STD.P2P.PAT.0003" }))), 3);
  const c = nrtCase(); c.fixtures[0].lookup_or_fail = { kind: "supplier", tag: "bloccato" };
  assert.throws(() => compileCase(w, c), /lookup_or_fail/);
  const c2 = nrtCase(); c2.composition.steps[1].target = "C.ACME.P2P.SEL.0099";
  assert.throws(() => compileCase(w, c2), /non è nell'Atlas/);
  const c3 = nrtCase(); c3.composition.steps.splice(1, 0); c3.composition.steps.push({ n: 5, verb: "WAIT" }); c3.boundary.stop_at_step = 5;
  assert.throws(() => compileCase(w, c3), /senza expect/);
  const c4 = nrtCase(); delete c4.derivation;
  assert.equal(code(() => compileCase(w, c4)), 1);
});

test("confine: i passi oltre boundary.stop_at_step restano fuori dal piano (avviso); CLI con --run scrive piano e traccia nel run", () => {
  const w = ws();
  const c = nrtCase(); c.boundary.stop_at_step = 3; c.evidence = [{ at: 3, kind: "result" }];
  const r = compileCase(w, c);
  assert.deepEqual(r.plan.steps.map((s) => s.n), [1, 2, 3]);
  assert.match(r.warnings[0], /oltre il confine/);
  assert.deepEqual(r.plan.evidence, [{ at: 3, kind: "after", caption: "result al passo 3" }]);
  const f = writeCase(w, nrtCase());
  const cli = spawnSync(process.execPath, [CLI, "--case", f, "--workspace", w, "--run", "RUN.ACME.20260929.1000.P2P", "--json"], { encoding: "utf8" });
  assert.equal(cli.status, 0, cli.stdout + cli.stderr);
  const out = join(w, "customers/ACME/runs/RUN.ACME.20260929.1000.P2P/cases/NRT.ACME.P2P.NEG.0001/plan.json");
  assert.ok(existsSync(out));
  assert.equal(JSON.parse(readFileSync(out, "utf8")).plan_id, "PLAN.NRT.ACME.P2P.NEG.0001");
  assert.ok(existsSync(out.replace(/\.json$/, ".trace.yaml")));
});
