// WP09b giro di correzione 2 — (1) prova di autenticità delle OBS: kb snapshot accetta una riga del DB solo se è
// nell'anello che observe-append tiene in session.json (codice, page_sig, ts, sha256 del payload): una riga inserita a
// mano nel DB è rifiutata, un'OBS vera di observe-append è accettata; (2) compile-plan lega i verdi al piano compilato
// (almeno un verde con lo stesso plan_hash); (3) esiti dei run protetti in scrittura; (4) messaggio di rollback-proven,
// url_pattern come pattern ancorato, percorsi di soli ID mai uguali.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { runHook, decisionOf, reasonOf, ROOT } from "../helpers/hook-env.mjs";
import { envWs, readSession } from "../helpers/env-fixture.mjs";
import { takeSnapshot, obsMatchesLocation } from "../../scripts/kb/snapshot.mjs";
import { openDb } from "../../scripts/kb/db.mjs";
import { compileEligibility, planHash } from "../../scripts/chrome/compile-plan.mjs";
import { SCRIPT_CHECKS } from "../../scripts/run/checks-run.mjs";
import { writeItem, writeYaml, cfg, cfp } from "../helpers/wp09b-items.mjs";

const P = "https://acme-sbx.jaggaer.com";
const DT = "mcp__chrome-devtools__";
const RUN = "RUN.ACME.20260929.1000.ADM";
const code = (fn) => { try { fn(); return 0; } catch (err) { return err.code; } };

test("(1) OBS vera di observe-append accettata (è nell'anello di session.json con lo sha del payload); riga forgiata nel DB rifiutata", () => {
  const ws = envWs({ env: "sandbox" });
  writeItem(ws, cfg("C.ACME.ADM.CFG.0019", { location: { page_sig: "setup/import-profiles" } }));
  const E = { JVC_WORKSPACE: ws, CLAUDE_PLUGIN_ROOT: ROOT, JVC_SESSION_ID: "sess-1" };
  const post = (tool, input, text) => { for (const h of ["browser-origin", "observe-append"]) runHook(h, { session_id: "sess-1", cwd: ws, hook_event_name: "PostToolUse", tool_name: DT + tool, tool_input: input, tool_response: [{ type: "text", text }] }, E); };
  post("navigate_page", { type: "url", url: `${P}/setup/import-profiles/7`, pageId: 1 }, `Successfully navigated to ${P}/setup/import-profiles/7.\n## Pages\n1: ACME SBX (${P}/setup/import-profiles/7) [selected]`);
  post("take_snapshot", { pageId: 1 }, `## Latest page snapshot\nuid=1_0 RootWebArea "ACME SBX" url="${P}/setup/import-profiles/7"\n  uid=1_1 heading "Setup" level="1"\n  uid=1_3 checkbox "strict_import"\n`);
  const ring = readSession(ws).obs_ring;
  assert.ok(Array.isArray(ring) && ring.length >= 1);
  const db = openDb(join(ws, "customers/ACME/knowledge.db"));
  const rows = db.prepare("select code, page_sig, payload from observations").all();
  for (const r of rows) {
    const e = ring.find((x) => x.code === r.code);
    assert.ok(e, r.code); assert.equal(e.sha256, createHash("sha256").update(r.payload).digest("hex")); assert.equal(e.page_sig, r.page_sig);
  }
  const genuine = rows.find((r) => r.page_sig?.startsWith("setup/import-profiles"));
  assert.ok(genuine, "observe-append ha registrato la pagina");
  assert.equal(takeSnapshot({ ws, sid: "sess-1", objects: ["C.ACME.ADM.CFG.0019"], run: RUN }).objects[0].obs, genuine.code);
  // riga forgiata con l'handle sqlite del test (come una one-liner dalla shell): più recente, stessa pagina, non nell'anello
  const forged = { id: "L.ACME.ADM.OBS.0999", type: "OBS", page_signature: "setup/import-profiles", url: `${P}/setup/import-profiles/7`, ts: new Date(Date.now() + 1000).toISOString(), elements_seen: [{ label: "strict_import", value: "true" }] };
  db.prepare("insert into observations(code, session, scope, page_sig, payload, confirmed_count) values (?,?,?,?,?,1)").run(forged.id, "x", "ADM", forged.page_signature, JSON.stringify(forged));
  assert.equal(takeSnapshot({ ws, sid: "sess-1", objects: ["C.ACME.ADM.CFG.0019"], run: RUN }).objects[0].obs, genuine.code, "la riga forgiata, pur più recente, non conta");
  assert.equal(code(() => takeSnapshot({ ws, sid: "sess-1", objects: ["C.ACME.ADM.CFG.0019"], run: RUN, obs: "L.ACME.ADM.OBS.0999" })), 3);
  // una riga vera con il payload modificato nel DB: lo sha non coincide più ⇒ rifiutata
  db.prepare("update observations set payload = ? where code = ?").run(JSON.stringify({ ...JSON.parse(genuine.payload), elements_seen: [] }), genuine.code);
  db.close();
  assert.equal(code(() => takeSnapshot({ ws, sid: "sess-1", objects: ["C.ACME.ADM.CFG.0019"], run: RUN })), 3);
});

test("(2) compile-plan: i verdi contati per impronta devono includerne uno con lo stesso plan_hash del piano compilato", () => {
  const ws = envWs({ env: "sandbox" });
  const plan = { plan_id: "PLAN.NRT.ACME.P2P.POS.0001", fingerprint: "a".repeat(64), customer: "ACME", env: "sandbox", goal: "g", steps: [{ n: 1, verb: "READ", action_class: "ACT-READ", target: { url_pattern: "x" }, expect: { page_sig: "x" } }], repair_policy: { skip_allowed: [], substitute_allowed: [], abort_on: [] } };
  for (const [i, h] of ["h1", "h2", "h3"].entries()) writeYaml(ws, `customers/ACME/runs/RUN.ACME.2026092${i + 1}.0900.P2P/results/${plan.plan_id}.yaml`, { plan_id: plan.plan_id, status: "green", plan_hash: h, fingerprint: plan.fingerprint, completed_at: new Date().toISOString() });
  let e = compileEligibility(ws, "ACME", plan);
  assert.equal(e.green.length, 3); assert.equal(e.bound, false, "un piano modificato dopo compile-case non si lega ai verdi di altri piani");
  writeYaml(ws, `customers/ACME/runs/RUN.ACME.20260924.0900.P2P/results/${plan.plan_id}.yaml`, { plan_id: plan.plan_id, status: "green", plan_hash: planHash(plan), fingerprint: plan.fingerprint, completed_at: new Date().toISOString() });
  e = compileEligibility(ws, "ACME", plan);
  assert.equal(e.green.length, 4); assert.equal(e.bound, true);
});

test("(3) esiti dei run in sola scrittura per step-check: Write, shell e interpreti negati (sessione e sub-agente)", () => {
  const ws = envWs({ env: "sandbox" });
  const call = (tool, tool_input, extra) => runHook("guard-config-scope", { session_id: "sess-1", cwd: ws, hook_event_name: "PreToolUse", tool_name: tool, tool_input, ...extra }, { JVC_WORKSPACE: ws, CLAUDE_PLUGIN_ROOT: ROOT });
  for (const extra of [{}, { agent_id: "a1", agent_type: "scope-expert" }]) {
    for (const f of [`customers/ACME/runs/${RUN}/results/PLAN.X.yaml`, `customers/ACME/runs/${RUN}/result.yaml`]) {
      const w = call("Write", { file_path: join(ws, f), content: "status: green\n" }, extra);
      assert.equal(decisionOf(w), "deny", f); assert.match(reasonOf(w), /step-check/);
      assert.equal(decisionOf(call("Bash", { command: `echo "status: green" > ${f}` }, extra)), "deny", `shell ${f}`);
    }
    assert.equal(decisionOf(call("Bash", { command: `python -c "open('customers/ACME/runs/${RUN}/results/PLAN.X.yaml','w').write('status: green')"` }, extra)), "deny", "interprete");
    assert.equal(decisionOf(call("Bash", { command: `node -e "require('fs').writeFileSync('customers/ACME/runs/${RUN}/result.yaml','status: green')"` }, extra)), "deny", "node -e");
  }
  // le altre cartelle del run restano scrivibili (piani dei casi, evidenze)
  assert.notEqual(decisionOf(call("Write", { file_path: join(ws, `customers/ACME/runs/${RUN}/cases/NRT.ACME.P2P.POS.0001/plan.json`), content: "{}" }, {})), "deny");
});

test("(4) rollback-proven: il messaggio non invita più alla prova a vuoto; url_pattern ancorato con *; percorsi di soli ID mai uguali", () => {
  const ws = envWs({ env: "sandbox" });
  writeItem(ws, cfp("S.STD.ADM.CFP.0014"));
  const r = SCRIPT_CHECKS["rollback-proven"]({ ws, customer: "ACME", session: readSession(ws), cfp: cfp("S.STD.ADM.CFP.0014"), now: new Date() });
  assert.equal(r.status, "fail"); assert.match(r.detail, /non a vuoto/); assert.ok(!/anche a vuoto/.test(r.detail));
  const at = (url) => ({ url, page_signature: null, elements_seen: [] });
  assert.equal(obsMatchesLocation(at(`${P}/setup/fields/edit`), { url_pattern: "/setup/fields/*" }), true);
  assert.equal(obsMatchesLocation(at(`${P}/setup/fields/edit/more`), { url_pattern: "/setup/fields/*" }), false, "* non attraversa i segmenti");
  assert.equal(obsMatchesLocation(at(`${P}/setup/fields/edit/more`), { url_pattern: "/setup/fields/**" }), true);
  assert.equal(obsMatchesLocation(at(`${P}/admin/setup/fields/edit`), { url_pattern: "/setup/fields/*" }), false, "ancorato all'inizio");
  assert.equal(obsMatchesLocation(at(`${P}/setup/fields`), { url_pattern: "/setup/fields" }), true);
  assert.equal(obsMatchesLocation(at(`${P}/123/456`), { url_pattern: "/789" }), false, "due percorsi di soli ID (vuoti) non sono uguali");
  assert.equal(obsMatchesLocation(at(`${P}/`), { url_pattern: "/" }), false);
});
