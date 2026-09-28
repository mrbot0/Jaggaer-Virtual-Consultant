// WP09b carry 2: kb compensation e kb snapshot riusano ciò che K6 già scrive (runs/<RUN>/compensations.yaml +
// session.pending.compensations; session.snapshots) e guard-config-scope li legge: la compensazione registrata per
// plan+step sblocca il passo che crea; lo snapshot deve COPRIRE tutti gli oggetti governati (config.object +
// config.governs), non basta uno snapshot di un'altra pagina o di un solo oggetto (WP07 security minor 1).
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, appendFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { runHook, decisionOf, reasonOf, ROOT } from "../helpers/hook-env.mjs";
import { envWs, browserCall, patchSession, readSession, writePlan, sealActivePlan } from "../helpers/env-fixture.mjs";
import { addCompensation, doneCompensation, listCompensations } from "../../scripts/kb/compensation.mjs";
import { takeSnapshot } from "../../scripts/kb/snapshot.mjs";
import { openDb } from "../../scripts/kb/db.mjs";
import { gateStep } from "../../scripts/decide/step-check.mjs";
import { registerCreated, createdEntities } from "../../scripts/run/fixtures.mjs";
import { governedObjects, snapshotCovers } from "../../hooks/lib/guards/config-scope.mjs";
import { writeItem, cfg, recordObs } from "../helpers/wp09b-items.mjs";

const KB = fileURLToPath(new URL("../../scripts/kb/kb.mjs", import.meta.url));
const RUN = "RUN.ACME.20260929.1000.ADM";
const PLAN = "PLAN.0042";
const S = (n, verb, action_class, extra = {}) => ({ n, verb, action_class, target: "C.ACME.ADM.SEL.0120", expect: { page_sig: "adm/x" }, ...extra });
const plan = (steps) => ({ plan_id: PLAN, customer: "ACME", env: "sandbox", goal: "prova", steps, repair_policy: { skip_allowed: [], substitute_allowed: [], abort_on: [] } });
const click = (ws, tr) => browserCall("guard-config-scope", ws, "mcp__chrome-devtools__click", { uid: "1_7" }, tr ? { transcript_path: tr } : {});
const denied = (r) => decisionOf(r) === "deny";
const silent = (r) => r.status === 0 && r.stdout.trim() === "";

function active(ws, steps, step) {
  const file = writePlan(ws, plan(steps), RUN);
  patchSession(ws, (s) => { s.active_plan = { plan_id: PLAN, file, step, run: RUN }; });
  sealActivePlan(ws, { refs: { "1_7": "C.ACME.ADM.SEL.0120" } });
  return file;
}

test("kb compensation add: stessa voce di step-check (plan, step, kind, …, status pending) su disco nel run e in session.pending; guard-config-scope sblocca il passo che crea", () => {
  const ws = envWs({ env: "sandbox" });
  active(ws, [S(1, "FILL", "ACT-CREATE", { data: "x" }), S(2, "SAVE", "ACT-CREATE")], 2);
  const r0 = click(ws);
  assert.ok(denied(r0)); assert.match(reasonOf(r0), /compensazione non registrata/);
  const e = addCompensation({ ws, sid: "sess-1", step: 2, kind: "cancel", entity: "requisition", action: "requisition.cancel-draft" });
  assert.equal(e.run, RUN);
  // stesso formato della voce che step-check scrive all'attivazione (gateStep)
  const g = gateStep({ plan: { plan_id: PLAN, compensations: [{ step: 2, kind: "cancel", entity: "requisition", action: "requisition.cancel-draft" }] }, step: S(2, "SAVE", "ACT-CREATE"), env: readSession(ws).env, records: [], now: new Date(), planFile: "x" });
  const { registered_at, run, ...mine } = e;
  assert.deepEqual(Object.keys(mine).sort(), Object.keys(g.compensation).sort());
  const onDisk = YAML.parse(readFileSync(join(ws, "customers/ACME/runs", RUN, "compensations.yaml"), "utf8")).compensations;
  assert.deepEqual(onDisk.map((c) => [c.plan, c.step, c.kind, c.status]), [[PLAN, 2, "cancel", "pending"]]);
  assert.deepEqual(readSession(ws).pending.compensations.map((c) => [c.plan, c.step, c.kind]), [[PLAN, 2, "cancel"]]);
  assert.ok(silent(click(ws)), "compensazione registrata ⇒ il passo che crea è consentito (sandbox, R1)");
  assert.equal(listCompensations({ ws, sid: "sess-1" }).run_entries.length, 1);
});

test("kb compensation: mai delete (tipo o azione), mai dopo il passo verificato; done chiude la voce, la toglie da pending e compensa l'entità creata", () => {
  const ws = envWs({ env: "sandbox" });
  active(ws, [S(1, "SAVE", "ACT-CREATE"), S(2, "SAVE", "ACT-UPDATE")], 2);
  const code = (fn) => { try { fn(); return 0; } catch (err) { return err.code; } };
  assert.equal(code(() => addCompensation({ ws, sid: "sess-1", step: 2, kind: "delete" })), 3);
  assert.equal(code(() => addCompensation({ ws, sid: "sess-1", step: 2, kind: "cancel", action: "requisition.delete" })), 3);
  patchSession(ws, (s) => { s.active_plan.last_verified_step = 1; });
  assert.equal(code(() => addCompensation({ ws, sid: "sess-1", step: 1, kind: "cancel" })), 3, "il passo 1 è già verificato: troppo tardi");
  const created = registerCreated(ws, "ACME", RUN, { entity: "requisition", case: "NRT.ACME.ADM.POS.0001", step: 2 });
  assert.match(created.ref, /^NRT-20260929-[0-9A-F]{4}-REQUIS-001$/);
  addCompensation({ ws, sid: "sess-1", step: 2, kind: "cancel", ref: created.ref });
  // CLI via kb.mjs con chiave=valore (nessun JSON in linea)
  const d = spawnSync(process.execPath, [KB, "compensation", "done", "--plan", PLAN, "--step", "2", "--workspace", ws, "--session", "sess-1", "--json"], { encoding: "utf8", env: { ...process.env, JVC_WORKSPACE: ws } });
  assert.equal(d.status, 0, d.stdout + d.stderr);
  assert.equal(readSession(ws).pending.compensations.length, 0);
  assert.equal(YAML.parse(readFileSync(join(ws, "customers/ACME/runs", RUN, "compensations.yaml"), "utf8")).compensations[0].status, "done");
  assert.equal(createdEntities(ws, "ACME", { run: RUN })[0].status, "compensated");
  const add = spawnSync(process.execPath, [KB, "compensation", "add", "--step", "2", "kind=close", "entity=requisition", "--workspace", ws, "--session", "sess-1", "--json"], { encoding: "utf8" });
  assert.equal(add.status, 0, add.stdout + add.stderr);
  assert.throws(() => doneCompensation({ ws, sid: "sess-1", plan: PLAN, step: 9 }), /nessuna compensazione/);
});

// ——— snapshot ———
// OBS come le registra observe-append (giri 1-2: riga del DB, copia nel file, voce dell'anello in session.json)
const obs = (ws, code, { page_signature, url, ts = new Date(), elements = [] }) => recordObs(ws, code, { page_signature, url, elements_seen: elements, ts: ts.toISOString() });
const REM = { levels: { verde: { areas: ["CL-CFG-005"], objects: ["C.ACME.ADM.CFG.0031", "C.ACME.ADM.CFG.0032"] } } };
function transcript(prompts) {
  const f = join(mkdtempSync(join(tmpdir(), "tr-")), "t.jsonl");
  writeFileSync(f, "");
  for (const p of prompts) appendFileSync(f, `${JSON.stringify({ type: "user", isSidechain: false, userType: "external", message: { role: "user", content: p }, timestamp: new Date().toISOString() })}\n`);
  return f;
}

test("kb snapshot: stato dalle OBS della pagina dell'oggetto (location del CFG); senza location, senza OBS della pagina o con OBS vecchia ⇒ rifiuto", () => {
  const ws = envWs({ env: "sandbox", remediation: REM });
  active(ws, [S(1, "NAVIGATE", "ACT-OBS")], 1);
  writeItem(ws, cfg("C.ACME.ADM.CFG.0031", { location: { page_sig: "setup/forms/7", selectors: ["C.ACME.ADM.SEL.0120"] } }));
  writeItem(ws, cfg("C.ACME.ADM.CFG.0033", { location: undefined }));
  obs(ws, "L.ACME.ADM.OBS.0001", { page_signature: "home", url: "https://acme-sbx.jaggaer.com/home" });
  const code = (fn) => { try { fn(); return 0; } catch (err) { return err.code; } };
  assert.equal(code(() => takeSnapshot({ ws, sid: "sess-1", objects: ["C.ACME.ADM.CFG.0031"] })), 3, "nessuna OBS della pagina dell'oggetto");
  assert.equal(code(() => takeSnapshot({ ws, sid: "sess-1", objects: ["C.ACME.ADM.CFG.0033"] })), 3, "oggetto senza location");
  obs(ws, "L.ACME.ADM.OBS.0002", { page_signature: "setup/forms/7", url: "https://acme-sbx.jaggaer.com/setup/forms/7", ts: new Date(Date.now() - 3600e3) });
  assert.equal(code(() => takeSnapshot({ ws, sid: "sess-1", objects: ["C.ACME.ADM.CFG.0031"] })), 3, "OBS di un'ora fa: rileggere");
  obs(ws, "L.ACME.ADM.OBS.0003", { page_signature: "setup/forms/7", url: "https://acme-sbx.jaggaer.com/setup/forms/7", elements: [{ label: "Obbligatorio", role: "checkbox", value: "false", atlas_match: "C.ACME.ADM.SEL.0120" }, { label: "Altro", role: "link" }] });
  const r = takeSnapshot({ ws, sid: "sess-1", objects: ["C.ACME.ADM.CFG.0031"] });
  assert.deepEqual(r.objects[0].state, [{ label: "Obbligatorio", role: "checkbox", value: "false", sel: "C.ACME.ADM.SEL.0120" }]);
  assert.equal(r.objects[0].obs, "L.ACME.ADM.OBS.0003");
  assert.ok(existsSync(join(ws, "customers/ACME", r.file)));
  const snap = readSession(ws).snapshots.at(-1);
  assert.deepEqual({ ...snap, ts: undefined }, { objects: ["C.ACME.ADM.CFG.0031"], ts: undefined, run: RUN, file: r.file, source: "kb-snapshot", obs: ["L.ACME.ADM.OBS.0003"] });
  assert.equal(code(() => takeSnapshot({ ws, sid: "sess-1", objects: ["C.ACME.ADM.CFG.0031"], obs: "L.ACME.ADM.OBS.0001" })), 3, "--obs di un'altra pagina");
});

test("guard-config-scope (§28.1, CHK.0051): lo snapshot deve coprire TUTTI gli oggetti governati del passo; uno solo non basta, lo snapshot di kb snapshot sì", () => {
  const ws = envWs({ env: "sandbox", remediation: REM });
  const config = { object: "C.ACME.ADM.CFG.0031", governs: ["C.ACME.ADM.CFG.0031", "C.ACME.ADM.CFG.0032"], area: "CL-CFG-005", level: "verde" };
  const step = S(2, "TOGGLE", "ACT-CFG-CHANGE", { config });
  assert.deepEqual(governedObjects(step), ["C.ACME.ADM.CFG.0031", "C.ACME.ADM.CFG.0032"]);
  // giro 1 (C1): ogni voce porta le sue osservazioni (observe-append: una; kb snapshot: una per oggetto)
  assert.equal(snapshotCovers({ objects: ["C.ACME.ADM.CFG.0031"], source: "observe-append", obs: "L.ACME.ADM.OBS.0001" }, step), false);
  assert.equal(snapshotCovers({ objects: ["C.ACME.ADM.CFG.0032", "C.ACME.ADM.CFG.0031"], source: "kb-snapshot", obs: ["L.ACME.ADM.OBS.0001", "L.ACME.ADM.OBS.0002"] }, step), true);
  const areaStep = S(2, "TOGGLE", "ACT-CFG-CHANGE", { config: { area: "CL-CFG-005", level: "verde" } });
  assert.equal(snapshotCovers({ objects: [], areas: ["CL-CFG-005"], source: "observe-append", obs: "L.ACME.ADM.OBS.0003" }, areaStep), true);
  assert.equal(snapshotCovers({ objects: [], areas: ["CL-CFG-005"], source: "kb-snapshot", obs: [] }, areaStep), false, "sola area da kb snapshot: nessuno stato registrato");
  assert.equal(snapshotCovers({ objects: ["C.ACME.ADM.CFG.0031"], source: "observe-append", obs: "L.ACME.ADM.OBS.0001" }, areaStep), false, "solo area: lo snapshot di un oggetto qualsiasi non basta");
  active(ws, [S(1, "NAVIGATE", "ACT-OBS"), step], 2);
  const tr = transcript([`APPROVO PIANO ${PLAN}`]);
  runHook("approval-capture", { session_id: "sess-1", cwd: ws, hook_event_name: "UserPromptSubmit", prompt: `APPROVO PIANO ${PLAN}`, transcript_path: tr }, { JVC_WORKSPACE: ws, CLAUDE_PLUGIN_ROOT: ROOT });
  // uno snapshot fresco di un solo oggetto (come quello che observe-append registra per config.object) non basta
  patchSession(ws, (s) => { s.snapshots = [{ objects: ["C.ACME.ADM.CFG.0031"], ts: new Date().toISOString(), source: "observe-append", obs: "L.ACME.ADM.OBS.0009" }]; });
  const r1 = click(ws, tr);
  assert.ok(denied(r1)); assert.match(reasonOf(r1), /non copre C\.ACME\.ADM\.CFG\.0032/);
  // kb snapshot di entrambi (OBS della pagina di ciascuno) ⇒ consentito
  writeItem(ws, cfg("C.ACME.ADM.CFG.0031", { location: { page_sig: "setup/forms/7" } }));
  writeItem(ws, cfg("C.ACME.ADM.CFG.0032", { location: { url_pattern: "/setup/fields/9" } }));
  obs(ws, "L.ACME.ADM.OBS.0010", { page_signature: "setup/forms/7", url: "https://acme-sbx.jaggaer.com/setup/forms/7" });
  obs(ws, "L.ACME.ADM.OBS.0011", { page_signature: "setup/fields", url: "https://acme-sbx.jaggaer.com/setup/fields/9" });
  const k = spawnSync(process.execPath, [KB, "snapshot", "C.ACME.ADM.CFG.0031", "C.ACME.ADM.CFG.0032", "--workspace", ws, "--session", "sess-1", "--json"], { encoding: "utf8" });
  assert.equal(k.status, 0, k.stdout + k.stderr);
  assert.ok(silent(click(ws, tr)), reasonOf(click(ws, tr)));
  // oltre 60 s lo stesso snapshot non vale più
  patchSession(ws, (s) => { for (const x of s.snapshots) x.ts = new Date(Date.now() - 90000).toISOString(); });
  assert.ok(denied(click(ws, tr)));
});
