// WP09b giro di correzione 1 — C1 (kb snapshot --area sbloccava un passo di sola area senza osservazioni), I2 (prove di
// kb snapshot forgiabili o vecchie: OBS protette in scrittura, verificate contro la riga del DB, età ≤ 900 s, pagina
// esatta), I3 (promozione per impronta del caso, precedente verde dai risultati) e i minori che rompono funzioni.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFileSync, mkdirSync, mkdtempSync, appendFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import YAML from "yaml";
import { runHook, decisionOf, reasonOf, ROOT } from "../helpers/hook-env.mjs";
import { envWs, browserCall, patchSession, readSession, writePlan, sealActivePlan } from "../helpers/env-fixture.mjs";
import { takeSnapshot } from "../../scripts/kb/snapshot.mjs";
import { snapshotCovers } from "../../hooks/lib/guards/config-scope.mjs";
import { openDb } from "../../scripts/kb/db.mjs";
import { decide, evaluateCase, caseFingerprint } from "../../scripts/run/promotion.mjs";
import { compileCase } from "../../scripts/compile/compile-case.mjs";
import { greenRuns, fingerprintOf } from "../../scripts/chrome/compile-plan.mjs";
import { SCRIPT_CHECKS, runChecks } from "../../scripts/run/checks-run.mjs";
import { lintCase } from "../../scripts/compile/lint-spec.mjs";
import { generate } from "../../scripts/compile/negative-generator.mjs";
import { cfpPlan } from "../../scripts/compile/compile-cfp.mjs";
import { writeItem, writeCase, writeYaml, cfg, cfp, sel, flw, nrtCase, hnd, recordObs } from "../helpers/wp09b-items.mjs";

const RUN = "RUN.ACME.20260929.1000.ADM";
const PLAN = "PLAN.0042";
const S = (n, verb, action_class, extra = {}) => ({ n, verb, action_class, target: "C.ACME.ADM.SEL.0120", expect: { page_sig: "adm/x" }, ...extra });
const plan = (steps) => ({ plan_id: PLAN, customer: "ACME", env: "sandbox", goal: "prova", steps, repair_policy: { skip_allowed: [], substitute_allowed: [], abort_on: [] } });
const click = (ws, tr) => browserCall("guard-config-scope", ws, "mcp__chrome-devtools__click", { uid: "1_7" }, tr ? { transcript_path: tr } : {});
const denied = (r) => decisionOf(r) === "deny";
const silent = (r) => r.status === 0 && r.stdout.trim() === "";
const REM = { levels: { verde: { areas: ["CL-CFG-005"], objects: ["C.ACME.ADM.CFG.0031", "C.ACME.ADM.CFG.0032"] } } };
function approved(ws, steps) {
  const file = writePlan(ws, plan(steps), RUN);
  patchSession(ws, (s) => { s.active_plan = { plan_id: PLAN, file, step: steps.at(-1).n, run: RUN }; });
  sealActivePlan(ws, { refs: { "1_7": "C.ACME.ADM.SEL.0120" } });
  const tr = join(mkdtempSync(join(tmpdir(), "tr-")), "t.jsonl");
  writeFileSync(tr, "");
  appendFileSync(tr, `${JSON.stringify({ type: "user", isSidechain: false, userType: "external", message: { role: "user", content: `APPROVO PIANO ${PLAN}` }, timestamp: new Date().toISOString() })}\n`);
  runHook("approval-capture", { session_id: "sess-1", cwd: ws, hook_event_name: "UserPromptSubmit", prompt: `APPROVO PIANO ${PLAN}`, transcript_path: tr }, { JVC_WORKSPACE: ws, CLAUDE_PLUGIN_ROOT: ROOT });
  return tr;
}
// OBS come le registra observe-append: riga nel DB del cliente (autorità) + file in observations/
// OBS come le registra observe-append: riga nel DB, copia nel file e voce dell'anello (giro 2)
const obs = (ws, code, doc) => recordObs(ws, code, doc);

test("C1: passo di sola area — negato prima e dopo `kb snapshot --area` (rifiutato: serve un oggetto); solo uno snapshot di observe-append per l'area vale", () => {
  const ws = envWs({ env: "sandbox", remediation: REM });
  const tr = approved(ws, [S(1, "NAVIGATE", "ACT-OBS"), S(2, "TOGGLE", "ACT-CFG-CHANGE", { config: { area: "CL-CFG-005", level: "verde" } })]);
  const r0 = click(ws, tr);
  assert.ok(denied(r0)); assert.match(reasonOf(r0), /area CL-CFG-005/);
  assert.throws(() => takeSnapshot({ ws, sid: "sess-1", areas: ["CL-CFG-005"] }), /almeno un oggetto/);
  // anche una voce di sola area con source kb-snapshot (o senza sorgente) non basta
  patchSession(ws, (s) => { s.snapshots = [{ objects: [], areas: ["CL-CFG-005"], ts: new Date().toISOString(), source: "kb-snapshot", obs: [] }, { objects: [], areas: ["CL-CFG-005"], ts: new Date().toISOString() }]; });
  assert.ok(denied(click(ws, tr)), "area-only da kb snapshot: negato");
  patchSession(ws, (s) => { s.snapshots = [{ objects: [], areas: ["CL-CFG-005"], ts: new Date().toISOString(), source: "observe-append", obs: "L.ACME.ADM.OBS.0001" }]; });
  assert.ok(silent(click(ws, tr)), "area-only registrato da observe-append sulla pagina del passo");
});

test("C1: una voce che copre gli oggetti vale solo con un'osservazione per oggetto (observe-append: obs; kb-snapshot: obs per ogni oggetto)", () => {
  const step = S(2, "TOGGLE", "ACT-CFG-CHANGE", { config: { object: "C.ACME.ADM.CFG.0031", governs: ["C.ACME.ADM.CFG.0031", "C.ACME.ADM.CFG.0032"], level: "verde" } });
  const objs = ["C.ACME.ADM.CFG.0031", "C.ACME.ADM.CFG.0032"];
  assert.equal(snapshotCovers({ objects: objs }, step), false, "senza sorgente né osservazioni");
  assert.equal(snapshotCovers({ objects: objs, source: "kb-snapshot", obs: ["L.ACME.ADM.OBS.0001"] }, step), false, "un'osservazione per due oggetti");
  assert.equal(snapshotCovers({ objects: objs, source: "kb-snapshot", obs: ["L.ACME.ADM.OBS.0001", "L.ACME.ADM.OBS.0002"] }, step), true);
  const one = S(2, "TOGGLE", "ACT-CFG-CHANGE", { config: { object: "C.ACME.ADM.CFG.0031", level: "verde" } });
  assert.equal(snapshotCovers({ objects: ["C.ACME.ADM.CFG.0031"], source: "observe-append", obs: "L.ACME.ADM.OBS.0003" }, one), true);
  assert.equal(snapshotCovers({ objects: ["C.ACME.ADM.CFG.0031"], source: "observe-append" }, one), false);
});

test("I2: customers/*/observations/** in sola scrittura per gli hook — Write/Edit e shell negati (sessione e sub-agente)", () => {
  const ws = envWs({ env: "sandbox" });
  const f = join(ws, "customers/ACME/observations/L.ACME.ADM.OBS.9998.yaml");
  for (const extra of [{}, { agent_id: "a1", agent_type: "scope-expert" }]) {
    const w = runHook("guard-config-scope", { session_id: "sess-1", cwd: ws, hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: f, content: "id: x\n" }, ...extra }, { JVC_WORKSPACE: ws, CLAUDE_PLUGIN_ROOT: ROOT });
    assert.ok(denied(w), JSON.stringify(extra)); assert.match(reasonOf(w), /observe-append/);
    const b = runHook("guard-config-scope", { session_id: "sess-1", cwd: ws, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "echo 'page_signature: setup/forms' > customers/ACME/observations/L.ACME.ADM.OBS.9998.yaml" }, ...extra }, { JVC_WORKSPACE: ws, CLAUDE_PLUGIN_ROOT: ROOT });
    assert.ok(denied(b), `shell ${JSON.stringify(extra)}`);
  }
});

test("I2: kb snapshot si fida solo della riga del DB (OBS forgiata come file ⇒ rifiuto), età ≤ 900 s anche con --max-age-s maggiore, pagina esatta (niente sottostringhe)", () => {
  const ws = envWs({ env: "sandbox", remediation: REM });
  approved(ws, [S(1, "NAVIGATE", "ACT-OBS")]);
  writeItem(ws, cfg("C.ACME.ADM.CFG.0031", { location: { page_sig: "setup/forms" } }));
  const code = (fn) => { try { fn(); return 0; } catch (err) { return err.code; } };
  // file forgiato senza riga nel DB
  mkdirSync(join(ws, "customers/ACME/observations"), { recursive: true });
  writeFileSync(join(ws, "customers/ACME/observations/L.ACME.ADM.OBS.9998.yaml"), YAML.stringify({ id: "L.ACME.ADM.OBS.9998", page_signature: "setup/forms", ts: new Date().toISOString() }));
  assert.equal(code(() => takeSnapshot({ ws, sid: "sess-1", objects: ["C.ACME.ADM.CFG.0031"] })), 3, "OBS senza riga nel DB");
  // riga vecchia di 10 giorni: rifiutata anche con maxAgeS 1e9
  obs(ws, "L.ACME.ADM.OBS.0001", { page_signature: "setup/forms", url: "https://acme-sbx.jaggaer.com/setup/forms", ts: new Date(Date.now() - 10 * 86400e3).toISOString() });
  assert.equal(code(() => takeSnapshot({ ws, sid: "sess-1", objects: ["C.ACME.ADM.CFG.0031"], maxAgeS: 1e9 })), 3);
  // pagina diversa che contiene la firma come sottostringa: non è la pagina dell'oggetto
  obs(ws, "L.ACME.ADM.OBS.0002", { page_signature: "setup/forms-archive", url: "https://acme-sbx.jaggaer.com/setup/forms-archive" });
  assert.equal(code(() => takeSnapshot({ ws, sid: "sess-1", objects: ["C.ACME.ADM.CFG.0031"] })), 3);
  // il file non conta: se dice un'altra pagina, vale la riga del DB
  obs(ws, "L.ACME.ADM.OBS.0003", { page_signature: "setup/forms#form-documenti", url: "https://acme-sbx.jaggaer.com/setup/forms" });
  writeFileSync(join(ws, "customers/ACME/observations/L.ACME.ADM.OBS.0003.yaml"), YAML.stringify({ id: "L.ACME.ADM.OBS.0003", page_signature: "altro" }));
  const r = takeSnapshot({ ws, sid: "sess-1", objects: ["C.ACME.ADM.CFG.0031"], maxAgeS: 1e9 });
  assert.equal(r.objects[0].obs, "L.ACME.ADM.OBS.0003");
  assert.deepEqual(readSession(ws).snapshots.at(-1).obs, ["L.ACME.ADM.OBS.0003"]);
});

test("I3: la promozione conta solo i run con l'impronta della versione attuale del caso; green_precedent dichiarato dal caso è ignorato, quello reale dai risultati vale", () => {
  const v1 = { ...nrtCase(), state: "shadow" };
  const v2 = { ...v1, composition: { ...v1.composition, steps: v1.composition.steps.map((s) => (s.n === 4 ? { ...s, expect: { messages: ["Centro di costo obbligatorio", "Importo mancante"] } } : s)) } };
  const f1 = caseFingerprint(v1); const f2 = caseFingerprint(v2);
  assert.notEqual(f1, f2);
  assert.equal(caseFingerprint({ ...v1, state: "promoted" }), f1, "lo stato non cambia l'impronta");
  const R = (i, fp, status = "green") => ({ run: `RUN.ACME.20260929.${1000 + i}.P2P`, plan_id: `PLAN.${v1.id}`, status, fingerprint: fp });
  assert.equal(decide(v2, { results: [R(1, f1), R(2, f1), R(3, f2)], fingerprint: f2 }).to, "shadow", "i verdi della v1 non contano per la v2");
  assert.equal(decide(v2, { results: [R(1, f2), R(2, f2), R(3, f2)], fingerprint: f2 }).to, "promoted");
  const selfDeclared = { ...v2, epistemic_at_generation: { shape: "consolidato", subject: "S.STD.P2P.FLD.0001", green_precedent: true } };
  assert.equal(decide(selfDeclared, { results: [R(1, caseFingerprint(selfDeclared))], fingerprint: caseFingerprint(selfDeclared) }).to, "shadow", "green_precedent dichiarato: ignorato");
  assert.equal(decide(selfDeclared, { results: [R(1, caseFingerprint(selfDeclared))], fingerprint: caseFingerprint(selfDeclared), greenPrecedent: true }).to, "promoted");
  // evaluateCase ricava il precedente dai risultati di un altro caso promosso sullo stesso soggetto
  const ws = envWs({ env: "sandbox", scope: "P2P" });
  const other = nrtCase("NRT.ACME.P2P.NEG.0002", { state: "promoted" });
  writeCase(ws, other);
  writeYaml(ws, `customers/ACME/runs/RUN.ACME.20260920.0900.P2P/results/PLAN.${other.id}.yaml`, { plan_id: `PLAN.${other.id}`, status: "green", fingerprint: caseFingerprint(other), completed_at: "2026-09-20T09:10:00Z" });
  writeYaml(ws, `customers/ACME/runs/RUN.ACME.20260929.0900.P2P/results/PLAN.${selfDeclared.id}.yaml`, { plan_id: `PLAN.${selfDeclared.id}`, status: "green", fingerprint: caseFingerprint(selfDeclared), completed_at: "2026-09-29T09:10:00Z" });
  assert.equal(evaluateCase(ws, "ACME", selfDeclared).to, "promoted");
});

test("corsia compilata raggiungibile per i casi che creano: l'impronta precede il prefisso, compile-plan conta i verdi per impronta", () => {
  const ws = envWs({ env: "sandbox", scope: "P2P" });
  for (const [n, l] of [["0001", "Fornitore"], ["0002", "Salva bozza"], ["0003", "Invia"]]) writeItem(ws, sel(`C.ACME.P2P.SEL.${n}`, { label: l }));
  writeItem(ws, flw("C.ACME.P2P.FLW.0001"));
  writeYaml(ws, "customers/ACME/tests/fixtures.yaml", { fixtures: [{ name: "s", kind: "supplier", tags: ["attivo-it"], value: "F1" }] });
  const c = nrtCase(); c.composition.steps[2].data = "{{prefix}}-RDA";
  const runs = ["RUN.ACME.20260927.0900.P2P", "RUN.ACME.20260928.0900.P2P", "RUN.ACME.20260929.0900.P2P"];
  const plans = runs.map((run) => compileCase(ws, c, { run }).plan);
  assert.notEqual(plans[0].steps[2].data, plans[1].steps[2].data, "il prefisso cambia per run");
  assert.equal(new Set(plans.map(fingerprintOf)).size, 1, "l'impronta no");
  assert.equal(plans[0].fingerprint, caseFingerprint(c));
  for (const [i, run] of runs.entries()) writeYaml(ws, `customers/ACME/runs/${run}/results/${plans[i].plan_id}.yaml`, { plan_id: plans[i].plan_id, status: "green", plan_hash: `h${i}`, fingerprint: plans[i].fingerprint, completed_at: new Date().toISOString() });
  assert.equal(greenRuns(ws, "ACME", fingerprintOf(plans[2])).length, 3);
});

test("minori: checks-run legge gli esiti per piano, rollback-proven rifiuta la prova a vuoto, uno script sconosciuto fallisce (niente passo browser silenzioso)", () => {
  const ws = envWs({ env: "sandbox" });
  writeItem(ws, cfp("S.STD.ADM.CFP.0014"));
  const ctx = { ws, customer: "ACME", session: readSession(ws), cfp: cfp("S.STD.ADM.CFP.0014"), now: new Date() };
  writeYaml(ws, "customers/ACME/runs/RUN.ACME.20260927.0900.ADM/results/PLAN.S.STD.ADM.CFP.0015.DRY.yaml", { plan_id: "PLAN.S.STD.ADM.CFP.0015.DRY", status: "green", completed_at: new Date().toISOString() });
  assert.equal(SCRIPT_CHECKS["rollback-proven"](ctx).status, "fail", "la prova a vuoto non applica il rollback");
  writeYaml(ws, "customers/ACME/runs/RUN.ACME.20260928.0900.ADM/results/PLAN.S.STD.ADM.CFP.0015.yaml", { plan_id: "PLAN.S.STD.ADM.CFP.0015", status: "green", completed_at: new Date().toISOString() });
  writeYaml(ws, "customers/ACME/runs/RUN.ACME.20260928.0900.ADM/result.yaml", { plan_id: "PLAN.ALTRO", status: "green", completed_at: new Date().toISOString() });
  assert.equal(SCRIPT_CHECKS["rollback-proven"](ctx).status, "pass", "esito per piano anche se result.yaml è di un altro piano");
  writeYaml(ws, "product/kb/scopes/XSC/checks/S.STD.XSC.CHK.0099.yaml", { id: "S.STD.XSC.CHK.0099", type: "CHK", title: "Check con script sconosciuto", summary: "x", kind: "precondition", how: { verb: "SCRIPT", script: "does-not-exist", expect: "ok" }, cost: "cheap", deterministic: true, frequency: "always", cluster: ["CL-CHK-011"], facets: {}, sources: [{ doc: "d" }] });
  const r = runChecks(ctx, { codes: ["S.STD.XSC.CHK.0099"] });
  assert.equal(r.blocked, true); assert.equal(r.results[0].status, "fail"); assert.match(r.results[0].detail, /non implementat/);
  assert.equal(r.plan_steps.length, 0);
});

test("minori: lint-spec e compile-case concordano sulla compensazione fornita dalla FLW; gli scheletri libresco entrano in shadow solo se il lint è pulito; il dry-run cattura anche UPLOAD", () => {
  const ws = envWs({ env: "sandbox", scope: "P2P" });
  writeItem(ws, flw("C.ACME.P2P.FLW.0001"));
  const c = nrtCase(); c.compensations = [c.compensations[1]]; c.composition.steps[2] = { n: 3, verb: "SAVE", from_flow: { flow: "C.ACME.P2P.FLW.0001", step: 3 } };
  assert.ok(lintCase(c).some((x) => x.rule === "L-COMP"), "senza workspace la FLW non si risolve");
  assert.deepEqual(lintCase(c, { ws, customer: "ACME" }).filter((x) => x.rule === "L-COMP"), [], "con il workspace la compensazione della FLW vale come in compile-case");
  const h = hnd("S.STD.P2P.HND.0001", { owner_of_test: "P2P", does_not_pass: ["RdA non approvata"] });   // stop_at_step 4 ⇒ passi segnaposto
  const g = generate([h, { id: "S.STD.P2P.FLD.0001", type: "FLD", label: { it: "Cdc" }, mandatory: { kind: "always" } }], { customer: "ACME" });
  const byGenre = (x) => g.cases.filter((c2) => c2.genre === x);
  assert.ok(byGenre("HND").every((c2) => c2.state === "candidate"), "scheletro con passi segnaposto senza expect: resta candidate");
  assert.ok(g.cases.filter((c2) => c2.derivation.from.includes("S.STD.P2P.FLD.0001")).every((c2) => c2.state === "shadow"));
  assert.ok(g.gated.length >= 1);
  const up = cfp("S.STD.ADM.CFP.0014"); up.steps[4] = { n: 5, verb: "UPLOAD", target: "S.STD.ADM.SEL.0112", data: "{{field.type}}" };
  const p = cfpPlan(ws, up, { customer: "ACME", params: { form: { name: "RdA" }, field: { label: "x", type: "f.csv", mandatory: true } }, dryRun: true }).plan;
  assert.equal(p.steps[4].verb, "CAPTURE");
});
