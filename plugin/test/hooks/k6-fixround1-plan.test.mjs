// WP07 giro di correzione 1 — sicurezza C2, I1 e spec Important 1: active_plan non si forgia con step-check.
// Sonde p3/p4 della revisione di sicurezza e la sonda --resume della revisione di spec, come test:
//  (a) fuori sandbox l'attivazione richiede APPROVO PIANO <id> (A1 registrato da approval-capture, impronta del piano);
//  (b) active_plan porta plan_sha256 e i guard negano se il file del piano cambia;
//  (c) ogni uid/ref di input e click deve corrispondere, nell'ultimo snapshot osservato, al SEL del passo attivo;
//  (d) invio e dialog accettato negati sotto un passo di classe di lettura, in ogni ambiente;
//  sub-agenti: step-check solo su un piano già attivo o approvato; --resume senza salti e con la lettura di verifica.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, mkdtempSync, appendFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { envWs, readSession, patchSession, writeSel, writePlan, browserCall, ROOT } from "../helpers/env-fixture.mjs";
import { runHook, decisionOf, reasonOf, cleanEnv } from "../helpers/hook-env.mjs";
import { check } from "../../scripts/decide/step-check.mjs";
import { demoAtlas, demoPlan, snap, PLAN } from "../helpers/k6-fixture.mjs";

const URLS = { prod: "https://acme.jaggaer.com/p2p/req/1", preprod: "https://acme-pre.jaggaer.com/p2p/req/1", sandbox: "https://acme-sbx.jaggaer.com/p2p/requisition/edit/10045" };
const BR = ["guard-environment", "guard-production", "guard-config-scope"];
const DT = "mcp__chrome-devtools__";
const E = (ws) => ({ JVC_WORKSPACE: ws, CLAUDE_PLUGIN_ROOT: ROOT });
const guards = (ws, tool, ti, extra = {}) => BR.map((g) => ({ g, r: browserCall(g, ws, tool, ti, extra) }));
const allowed = (res) => res.every(({ r }) => r.status === 0 && r.stdout.trim() === "");
const why = (res) => res.filter(({ r }) => decisionOf(r) === "deny").map(({ g, r }) => `${g}: ${reasonOf(r)}`).join("\n");
const stepCheckCli = (ws, args, extraEnv = {}) => spawnSync(process.execPath, [join(ROOT, "scripts/decide/step-check.mjs"), ...args, "--json"], { encoding: "utf8", env: cleanEnv({ ...E(ws), JVC_SESSION_ID: "sess-1", ...extraEnv }) });

function transcript() { const f = join(mkdtempSync(join(tmpdir(), "k6fr1-")), "t.jsonl"); writeFileSync(f, ""); return f; }
function say(ws, tr, prompt) {
  appendFileSync(tr, `${JSON.stringify({ type: "user", isSidechain: false, userType: "external", message: { role: "user", content: prompt }, timestamp: new Date().toISOString() })}\n`);
  return runHook("approval-capture", { session_id: "sess-1", cwd: ws, hook_event_name: "UserPromptSubmit", prompt, transcript_path: tr }, E(ws)).json?.hookSpecificOutput?.additionalContext ?? "";
}
function readPlanWs(envId) {
  const ws = envWs({ env: envId, scope: "P2P" });
  patchSession(ws, (s) => { s.browser = { current_url: URLS[envId], tab: null, updated_by: "browser-origin" }; });
  writeSel(ws, "C.ACME.P2P.SEL.0010", { role: "link", effect: "read", label: "Elenco richieste" });
  writeSel(ws, "C.ACME.P2P.SEL.0900", { role: "search_box", effect: "read", label: "Importo" });
  const plan = { plan_id: "PLAN.ACME.X.0002", customer: "ACME", env: envId, goal: "lettura elenco",
    steps: [{ n: 1, verb: "CLICK", action_class: "ACT-OBS", target: "C.ACME.P2P.SEL.0010", expect: { page_sig: "p2p/requisition/list" } }],
    repair_policy: { skip_allowed: [], substitute_allowed: [], abort_on: [] } };
  mkdirSync(join(ws, "customers/ACME/runs/RUN.ACME.20260922.1106.ADM"), { recursive: true });
  writeFileSync(join(ws, "customers/ACME/runs/RUN.ACME.20260922.1106.ADM/plan.json"), JSON.stringify(plan));
  return { ws, plan, file: "runs/RUN.ACME.20260922.1106.ADM/plan.json" };
}

test("p3/p4 (a): fuori sandbox step-check non attiva un piano senza APPROVO PIANO; le azioni restano negate", async () => {
  for (const envId of ["prod", "preprod"]) {
    const { ws, file } = readPlanWs(envId);
    const r = await check({ ws, sid: "sess-1", planFile: file, step: 1 });
    assert.equal(r.status, "approval_required", `${envId}: ${JSON.stringify(r)}`);
    assert.match(r.ask, /APPROVO PIANO PLAN\.ACME\.X\.0002/);
    assert.equal(readSession(ws).active_plan ?? null, null, `${envId}: nessun active_plan senza approvazione`);
    assert.deepEqual(readSession(ws).pending.approvals.map((a) => a.kind), ["A1"]);
    for (const [t, i] of [[DT + "click", { uid: "1_23" }], [DT + "press_key", { key: "Enter" }], [DT + "handle_dialog", { action: "accept" }], [DT + "fill", { uid: "1_21", value: "9999" }]]) {
      assert.ok(!allowed(guards(ws, t, i)), `${envId} ${t} consentito senza piano attivo`);
    }
  }
});

test("p4 (a,b,c,d): con A1 il piano si attiva, ma ogni azione è legata al SEL del passo, niente invio sotto un passo di lettura, e il piano non si scambia", async () => {
  for (const envId of ["prod", "preprod"]) {
    const { ws, plan, file } = readPlanWs(envId);
    const tr = transcript();
    await check({ ws, sid: "sess-1", planFile: file, step: 1 });
    assert.match(say(ws, tr, `APPROVO PIANO ${plan.plan_id} DA Mario Rossi`), /registrata: A1/);
    const r = await check({ ws, sid: "sess-1", planFile: file, step: 1 });
    assert.equal(r.status, "ok", JSON.stringify(r));
    const ap = readSession(ws).active_plan;
    assert.match(ap.plan_sha256, /^[0-9a-f]{64}$/);
    // (c) nessuno snapshot osservato ⇒ l'uid non si può legare al SEL del passo ⇒ deny
    const x = { transcript_path: tr };
    assert.ok(!allowed(guards(ws, DT + "click", { uid: "1_23" }, x)), `${envId}: click non legato consentito`);
    // snapshot osservato: 1_5 è "Elenco richieste" (il SEL del passo), 1_23 "Invia in approvazione"
    const page = `## Latest page snapshot\nuid=1_0 RootWebArea "ACME" url="${URLS[envId]}"\n  uid=1_5 link "Elenco richieste"\n  uid=1_21 textbox "Importo"\n  uid=1_23 button "Invia in approvazione"\n`;
    runHook("observe-append", { session_id: "sess-1", cwd: ws, hook_event_name: "PostToolUse", tool_name: DT + "take_snapshot", tool_input: {}, tool_response: [{ type: "text", text: page }] }, E(ws));
    assert.equal(readSession(ws).browser.snapshot.refs["1_5"], "C.ACME.P2P.SEL.0010");
    const bad = guards(ws, DT + "click", { uid: "1_23" }, x);
    assert.ok(!allowed(bad) && /SEL del passo|non corrisponde/.test(why(bad)), `${envId}: ${why(bad)}`);
    const good = guards(ws, DT + "click", { uid: "1_5" }, x);
    assert.ok(allowed(good), `${envId}: il click sul SEL del passo: ${why(good)}`);
    assert.ok(!allowed(guards(ws, DT + "fill", { uid: "1_21", value: "9999" }, x)));
    // (d) invio e dialog accettato sotto un passo di lettura
    for (const [t, i] of [[DT + "press_key", { key: "Enter" }], [DT + "handle_dialog", { action: "accept" }]]) {
      const d = browserCall("guard-config-scope", ws, t, i, x);
      assert.equal(decisionOf(d), "deny", `${envId} ${t}`);
    }
    // (b) piano scambiato dopo l'attivazione (stesso plan_id, env sandbox, FILL su search_box) ⇒ deny
    plan.steps[0] = { n: 1, verb: "FILL", action_class: "ACT-OBS", target: "C.ACME.P2P.SEL.0900", expect: { page_sig: "x" } };
    plan.env = "sandbox";
    writeFileSync(join(ws, "customers/ACME", file), JSON.stringify(plan));
    const sw = guards(ws, DT + "fill", { uid: "1_21", value: "9999" }, x);
    assert.ok(!allowed(sw) && /modificato dopo l'attivazione/.test(why(sw)), `${envId}: ${why(sw)}`);
    const sc = await check({ ws, sid: "sess-1", planFile: file, step: 1, snapshot: page });
    assert.equal(sc.status, "denied"); assert.match(sc.reason, /modificato/);
  }
});

test("sandbox: fill legato al SEL del passo consentito; uid di un altro campo o fill_form con un elemento estraneo negati", async () => {
  const ws = envWs({ env: "sandbox", scope: "P2P" });
  demoAtlas(ws);
  const file = writePlan(ws, demoPlan(), "RUN.ACME.20260922.1100.ADM");
  await check({ ws, sid: "sess-1", planFile: file, step: 1 });
  const p1 = snap("chrome-devtools", "ok").replace("/edit/10045", "/new");
  await check({ ws, sid: "sess-1", planFile: file, step: 1, snapshot: p1 });
  assert.equal(readSession(ws).active_plan.step, 2);
  patchSession(ws, (s) => { s.browser = { current_url: URLS.sandbox, tab: null, updated_by: "browser-origin" }; });
  runHook("observe-append", { session_id: "sess-1", cwd: ws, hook_event_name: "PostToolUse", tool_name: DT + "take_snapshot", tool_input: {}, tool_response: [{ type: "text", text: snap("chrome-devtools", "ok") }] }, E(ws));
  const refs = readSession(ws).browser.snapshot.refs;
  const cdc = Object.keys(refs).find((k) => refs[k] === "C.ACME.P2P.SEL.0044");
  const descr = Object.keys(refs).find((k) => refs[k] === "C.ACME.P2P.SEL.0048");
  assert.ok(cdc && descr);
  assert.ok(allowed(guards(ws, DT + "fill", { uid: cdc, value: "IT-0442" })));
  assert.ok(!allowed(guards(ws, DT + "fill", { uid: descr, value: "x" })));
  assert.ok(!allowed(guards(ws, DT + "fill_form", { elements: [{ uid: cdc, value: "IT-0442" }, { uid: descr, value: "x" }] })));
  assert.ok(!allowed(guards(ws, DT + "type_text", { text: "IT-0442" })), "input senza uid/ref: non verificabile");
  // un'altra pagina (URL corrente diverso da quello dello snapshot) ⇒ lo snapshot non vale
  patchSession(ws, (s) => { s.browser.current_url = "https://acme-sbx.jaggaer.com/altro"; });
  assert.ok(!allowed(guards(ws, DT + "fill", { uid: cdc, value: "IT-0442" })));
});

test("sub-agenti: step-check solo su un piano già attivo o approvato; la sessione principale può attivare", async () => {
  const { ws, file } = readPlanWs("sandbox");
  const cmd = `node "${join(ROOT, "scripts/decide/step-check.mjs")}" --plan ${file} --step 1 --json`;
  const bash = (extra) => runHook("guard-config-scope", { session_id: "sess-1", cwd: ws, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: cmd }, ...extra }, E(ws));
  const sub = bash({ agent_id: "ag-1", agent_type: "jaggaer-virtual-consultant:p2p-expert" });
  assert.equal(decisionOf(sub), "deny"); assert.match(reasonOf(sub), /sub-agente/);
  assert.equal(bash({}).stdout.trim(), "", "la sessione principale può attivare");
  await check({ ws, sid: "sess-1", planFile: file, step: 1 });
  assert.equal(bash({ agent_id: "ag-1", agent_type: "jaggaer-virtual-consultant:p2p-expert" }).stdout.trim(), "", "piano già attivo: il sub-agente può verificare");
  const other = runHook("guard-config-scope", { session_id: "sess-1", cwd: ws, hook_event_name: "PreToolUse", tool_name: "Bash", agent_id: "ag-1",
    tool_input: { command: `node "${join(ROOT, "scripts/decide/step-check.mjs")}" --plan runs/RUN.ACME.20260922.1111.ADM/plan.json --step 1 --json` } }, E(ws));
  assert.equal(decisionOf(other), "deny");
});

test("--resume (spec I1): niente salti di passi non verificati; il passo con effetto richiede la lettura di verifica; il gate negato non scrive active_plan", async () => {
  const ws = envWs({ env: "sandbox", scope: "P2P" });
  demoAtlas(ws);
  const file = writePlan(ws, demoPlan(), "RUN.ACME.20260922.1100.ADM");
  await check({ ws, sid: "sess-1", planFile: file, step: 1 });
  const jump = await check({ ws, sid: "sess-1", planFile: file, resume: 3 });
  assert.equal(jump.status, "denied", "sonda della revisione: --resume 3 senza checkpoint del passo 2");
  assert.equal(readSession(ws).active_plan.step, 1);
  // passi 1 e 2 verificati
  await check({ ws, sid: "sess-1", planFile: file, step: 1, snapshot: snap("chrome-devtools", "ok").replace("/edit/10045", "/new") });
  await check({ ws, sid: "sess-1", planFile: file, step: 2, snapshot: snap("chrome-devtools", "ok") });
  // passo 3 (SAVE): la ripresa chiede la lettura, non attiva
  const r = await check({ ws, sid: "sess-1", planFile: file, resume: 3 });
  assert.equal(r.activated, false); assert.deepEqual(r.reads.map((x) => x.step), [3]);
  assert.deepEqual(readSession(ws).pending.reads.map((x) => [x.plan, x.step]), [[PLAN, 3]]);
  // lettura: la bozza risulta già salvata ⇒ il passo 3 si salta, si prepara il 4
  const saved = snap("chrome-devtools", "ok").replace('uid=1_1 banner', 'uid=1_1 status\n    uid=1_99 StaticText "Bozza salvata"\n  uid=1_98 banner');
  const done = await check({ ws, sid: "sess-1", planFile: file, resume: 3, snapshot: saved });
  assert.equal(done.already_done, true); assert.equal(readSession(ws).active_plan.step, 4);
  assert.deepEqual(readSession(ws).pending.reads ?? [], []);
  // il gate negato non scrive active_plan
  const ws2 = envWs({ env: "sandbox", scope: "P2P" });
  demoAtlas(ws2);
  const bare = writePlan(ws2, demoPlan({ compensations: [] }), "RUN.ACME.20260922.1100.ADM");
  await check({ ws: ws2, sid: "sess-1", planFile: bare, step: 1 });
  await check({ ws: ws2, sid: "sess-1", planFile: bare, step: 1, snapshot: snap("chrome-devtools", "ok").replace("/edit/10045", "/new") });
  const r2 = await check({ ws: ws2, sid: "sess-1", planFile: bare, step: 2, snapshot: snap("chrome-devtools", "ok") });
  assert.equal(r2.next.status, "denied");
  assert.equal(readSession(ws2).active_plan.step, 2, "resta al passo verificato: il passo negato non diventa attivo");
  assert.ok(!existsSync(join(ws2, "customers/ACME/runs/RUN.ACME.20260922.1100.ADM/compensations.yaml")));
  assert.ok(readFileSync(join(ROOT, "scripts/decide/step-check.mjs"), "utf8").length > 0);
  assert.equal(stepCheckCli(ws2, ["--plan", bare, "--resume", "4"]).status, 3);
});
