// WP09b F — promozione (candidate → shadow → promoted | quarantine; F7: shadow → promoted dopo 3 run coerenti; flaky →
// quarantine; mai con una CTR aperta), corsia guidata end-to-end (compile-case → step-check in 3 run → esiti per piano →
// promozione) e coverage (matrice CL-CFG × scope con forma epistemica, copertura NRT).
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { decide, flakiness, evaluateCase, apply } from "../../scripts/run/promotion.mjs";
import { compileCase } from "../../scripts/compile/compile-case.mjs";
import { check } from "../../scripts/decide/step-check.mjs";
import { runResults } from "../../scripts/lib/run-results.mjs";
import { greenRuns, planHash } from "../../scripts/chrome/compile-plan.mjs";
import { cfgMatrix, renderMatrix, nrtCoverage } from "../../scripts/kb/coverage.mjs";
import { envWs, readSession } from "../helpers/env-fixture.mjs";
import { kbWs, writeItem, writeCase, writeYaml, sel, cfp, cfpClient, cfg, hnd, nrtCase, FACETS } from "../helpers/wp09b-items.mjs";

const PROMO = fileURLToPath(new URL("../../scripts/run/promotion.mjs", import.meta.url));
const R = (status, i) => ({ run: `RUN.ACME.20260929.${String(1000 + i)}.P2P`, plan_id: "PLAN.X", status, plan_hash: "h" });

test("F7: shadow → promoted dopo 3 run coerenti (non prima); consolidato con precedente verde: una basta; NEG senza ERR e CTR aperta: mai", () => {
  const c = { ...nrtCase(), state: "shadow" };
  assert.equal(decide(c, { results: [R("green", 1), R("green", 2)] }).to, "shadow");
  const d = decide(c, { results: [R("green", 1), R("green", 2), R("green", 3)] });
  assert.equal(d.to, "promoted"); assert.equal(d.evidence.length, 3);
  assert.equal(decide(c, { results: [R("green", 1), R("green", 2), R("yellow", 3)] }).to, "shadow", "ultimi 3 non tutti verdi; un solo cambio non è flakiness");
  const fast = { ...c, epistemic_at_generation: { shape: "consolidato", subject: "S.STD.P2P.FLD.0001", green_precedent: true } };
  assert.equal(decide(fast, { results: [R("green", 1)] }).to, "promoted");
  assert.equal(decide({ ...c, expected_errors: [] }, { results: [R("green", 1), R("green", 2), R("green", 3)] }).to, "shadow");
  const ctr = decide(c, { results: [R("green", 1), R("green", 2), R("green", 3)], openCtr: [{ code: "C.ACME.P2P.CTR.0001", a_code: "S.STD.P2P.FLD.0001", b_code: "L.ACME.P2P.OBS.0004" }] });
  assert.equal(ctr.to, "shadow"); assert.match(ctr.reason, /contraddizione aperta/);
});

test("flakiness: esiti incoerenti fra run (verde/rosso/verde) oltre il budget ⇒ quarantine, da shadow e da promoted; quarantine → shadow solo a mano", () => {
  const flaky = [R("green", 1), R("yellow", 2), R("green", 3)];
  assert.equal(flakiness(flaky), 2);
  for (const state of ["shadow", "promoted"]) {
    const d = decide({ ...nrtCase(), state }, { results: flaky });
    assert.equal(d.to, "quarantine"); assert.match(d.reason, /esiti incoerenti/);
  }
  assert.equal(decide({ ...nrtCase(), state: "promoted" }, { results: [R("green", 1), R("green", 2), R("yellow", 3)] }).to, "promoted", "un solo passaggio a rosso è una regressione, non flakiness");
  assert.equal(decide({ ...nrtCase(), state: "quarantine" }, { results: [R("green", 1), R("green", 2), R("green", 3)] }).to, "quarantine");
  assert.equal(decide(nrtCase(), { lint: [] }).to, "shadow", "candidate con lint puliti ⇒ shadow");
  assert.equal(decide(nrtCase(), { lint: [{ rule: "L-COMP" }] }).to, "candidate");
});

test("corsia guidata end-to-end: il caso compilato gira 3 volte (step-check, un run per volta), l'esito resta per piano, compile-plan conta 3 verdi, la promozione lo porta a promoted", async () => {
  const ws = envWs({ env: "sandbox", scope: "P2P" });
  writeItem(ws, sel("C.ACME.P2P.SEL.0001", { role: "textbox", label: "Fornitore" }));
  const caso = nrtCase("NRT.ACME.P2P.POS.0001", {
    state: "shadow", title: "Il form della RdA mostra il fornitore",
    composition: { steps: [
      { n: 1, verb: "NAVIGATE", target: { url_pattern: "https://acme-sbx.jaggaer.com/req/new" }, expect: { page_sig: "req/new" } },
      { n: 2, verb: "READ", target: "C.ACME.P2P.SEL.0001", expect: { elements: ["C.ACME.P2P.SEL.0001"] } }] },
    boundary: { stop_at_step: 2, does_not_assert: ["il salvataggio"] }, fixtures: [], compensations: [], evidence: [], expected_errors: undefined,
  });
  const caseFile = writeCase(ws, caso);
  const page = "## Latest page snapshot\nuid=1_0 RootWebArea \"ACME SBX\" url=\"https://acme-sbx.jaggaer.com/req/new\"\n  uid=1_1 heading \"Nuova RdA\" level=\"1\"\n  uid=1_3 textbox \"Fornitore\"\n";
  for (const [i, hhmm] of ["0900", "1000", "1100"].entries()) {
    const run = `RUN.ACME.2026092${i + 7}.${hhmm}.P2P`;
    const { plan } = compileCase(ws, caso, { run });
    const rel = `runs/${run}/cases/${caso.id}/plan.json`;
    mkdirSync(join(ws, "customers/ACME", rel, ".."), { recursive: true });
    writeFileSync(join(ws, "customers/ACME", rel), JSON.stringify(plan, null, 2));
    assert.equal((await check({ ws, sid: "sess-1", planFile: rel, step: 1 })).status, "ok");
    assert.equal((await check({ ws, sid: "sess-1", planFile: rel, step: 1, snapshot: page })).status, "ok");
    const last = await check({ ws, sid: "sess-1", planFile: rel, step: 2, snapshot: page });
    assert.equal(last.plan_status, "completed", JSON.stringify(last.divergences));
    assert.equal(readSession(ws).active_plan, null);
  }
  const res = runResults(ws, "ACME", { planIds: [`PLAN.${caso.id}`] });
  assert.deepEqual(res.map((r) => r.status), ["green", "green", "green"]);
  assert.equal(greenRuns(ws, "ACME", planHash(compileCase(ws, caso).plan)).length, 3, "stesso piano in ogni run: compile-plan conta 3 verdi");
  const d = evaluateCase(ws, "ACME", YAML.parse(readFileSync(caseFile, "utf8")));
  assert.equal(d.to, "promoted", d.reason);
  const cli = spawnSync(process.execPath, [PROMO, "evaluate", "--case", caseFile, "--apply", "--workspace", ws, "--json"], { encoding: "utf8" });
  assert.equal(cli.status, 0, cli.stdout + cli.stderr);
  assert.equal(YAML.parse(readFileSync(caseFile, "utf8")).state, "promoted");
  assert.ok(existsSync(join(ws, "customers/ACME/tests/promotion-log.jsonl")));
  assert.throws(() => apply(ws, { customer: "ACME", file: caseFile, caso: { ...caso, genre: "NEG", id: "NRT.ACME.P2P.NEG.0009", expected_errors: [] }, decision: { from: "shadow", to: "promoted", reason: "x" } }), /non applicabile/);
});

test("coverage §28.2: matrice CL-CFG × scope con celle ✅/◐/✗/— e forma epistemica prevalente; coperto ma libresco è un avvertimento", () => {
  const w = kbWs();
  writeItem(w, cfp("S.STD.ADM.CFP.0014"));                                   // area CL-CFG-005, governa CFG.0031
  writeItem(w, cfpClient("C.ACME.ADM.CFP.0002"));                            // deviazione del cliente
  writeItem(w, cfg("S.STD.ADM.CFG.0031", { epistemic: { shape: "consolidato" } }));
  writeItem(w, cfp("S.STD.ADM.CFP.0020", { area: "CL-CFG-008", governs: ["S.STD.ADM.CFG.0040"], risk: "R1", rollback: undefined }));
  writeItem(w, cfg("S.STD.ADM.CFG.0040", { area: "CL-CFG-008" }));
  writeItem(w, cfg("S.STD.CAT.CFG.0001", { area: "CL-CFG-010", epistemic: { shape: "empirico" } }));
  const m = cfgMatrix(w, { customer: "ACME", scopes: ["ADM", "CAT", "SRC"] });
  assert.deepEqual([m.rows.ADM["CL-CFG-005"].cell, m.rows.ADM["CL-CFG-005"].shape], ["✅", "consolidato"]);
  assert.deepEqual([m.rows.ADM["CL-CFG-008"].cell, m.rows.ADM["CL-CFG-008"].shape], ["◐", "libresco"]);
  assert.deepEqual([m.rows.CAT["CL-CFG-010"].cell, m.rows.CAT["CL-CFG-010"].shape], ["✗", "empirico"]);
  assert.equal(m.rows.SRC["CL-CFG-005"].cell, "—");
  assert.deepEqual(m.warnings, ["ADM CL-CFG-008: coperto ma libresco — la prima esecuzione sarà STR-DRY-RUN (§28.2)"]);
  const txt = renderMatrix(m);
  assert.match(txt, /CFG-005\s+CFG-008\s+CFG-010/);
  assert.match(txt, /ADM\s+✅ cons\s+◐ libr\s+—/);
  const kb = spawnSync(process.execPath, [fileURLToPath(new URL("../../scripts/kb/kb.mjs", import.meta.url)), "coverage", "--scope", "ADM", "--customer", "ACME", "--workspace", w, "--json"], { encoding: "utf8" });
  assert.equal(kb.status, 0, kb.stdout + kb.stderr);
  assert.equal(JSON.parse(kb.stdout).matrix.rows.ADM["CL-CFG-005"].cell, "✅");
});

test("coverage NRT: capability ad alta criticità, handoff e risk mode dello scope coperti dai casi", async () => {
  const w = kbWs();
  writeYaml(w, "product/kb/scopes/P2P/capabilities/S.STD.P2P.CAP.0001.yaml", { id: "S.STD.P2P.CAP.0001", type: "CAP", title: "Creare RdA", summary: "Creare RdA.", criticality: "alta", facets: FACETS, sources: [{ doc: "d" }] });
  writeYaml(w, "product/kb/scopes/P2P/capabilities/S.STD.P2P.CAP.0002.yaml", { id: "S.STD.P2P.CAP.0002", type: "CAP", title: "Approvare RdA", summary: "Approvare.", criticality: "alta", facets: FACETS, sources: [{ doc: "d" }] });
  writeItem(w, hnd("S.STD.P2P.HND.0001"));
  writeItem(w, { id: "S.STD.P2P.FLD.0001", type: "FLD", title: "Centro di costo", summary: "Cdc.", facets: FACETS, sources: [{ doc: "d" }], document: "document.requisition", label: { it: "Centro di costo" }, section: "h", field_type: "text", mandatory: { kind: "always" } });
  writeCase(w, nrtCase("NRT.ACME.P2P.NEG.0001", { state: "promoted", capability: "S.STD.P2P.CAP.0001", derivation: { from: ["S.STD.P2P.FLD.0001"], risk_mode: "obbligatorio omesso" } }));
  const r = await nrtCoverage(w, { customer: "ACME", scope: "P2P" });
  assert.deepEqual([r.capabilities.total, r.capabilities.covered, r.capabilities.missing], [2, 1, ["S.STD.P2P.CAP.0002"]]);
  assert.deepEqual([r.handoffs.total, r.handoffs.covered], [1, 0]);
  assert.ok(r.risk_modes.total >= 2);
  assert.ok(r.risk_modes.covered >= 1);
  assert.ok(r.risk_modes.missing.some((m) => /S\.STD\.P2P\.HND\.0001/.test(m)));
});
