// Ops veloce (spec 2026-10-06 §3.6) — produzione scrivibile: guard-production consente input, click, caricamenti e invii
// solo dentro un passo di piano che scrive (classe con prod "approval"), con policy.write_data: true per i dati e
// l'approvazione del passo (A1 + token del passo, A2 solo col secondo approvatore), confermata nel transcript. DELETE mai.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync, writeFileSync, mkdtempSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { decisionOf, reasonOf } from "../helpers/hook-env.mjs";
import { envWs, browserCall, patchSession, readSession, writePlan, writeSel, sealActivePlan } from "../helpers/env-fixture.mjs";
import { prodStepApproval, appendApproval, approvalsFile, sha256 } from "../../scripts/admin/approvals.mjs";

const G = "guard-production";
const PLAN = "PLAN.0077";
const DT = "mcp__chrome-devtools__";
const denied = (r) => decisionOf(r) === "deny";
const silent = (r) => r.status === 0 && r.stdout.trim() === "";
const SEL = { write: "C.ACME.ADM.SEL.0120", search: "C.ACME.ADM.SEL.0130" };
const step = (n, verb, action_class, target, extra = {}) => ({ n, verb, action_class, target, expect: { page_sig: "x" }, ...extra });
const planOf = (steps) => ({ plan_id: PLAN, customer: "ACME", env: "prod", goal: "diagnosi", approvals: "3A", steps, repair_policy: { skip_allowed: [], substitute_allowed: [], abort_on: [] } });
const CFG = { config: { object: "C.ACME.ADM.CFG.0019", area: "CL-CFG-020", level: "giallo" } };

test("prodStepApproval: A1 + passo, A2 solo col secondo approvatore", () => {
  const t = new Date().toISOString();
  const A1 = { kind: "A1", plan: "PLAN.P", ts: t, hash: "h1", approver_declared: "Anna Bianchi" };
  const A3 = { kind: "A3", plan: "PLAN.P", step: 2, ts: t, hash: "h3" };
  assert.equal(prodStepApproval([A1, A3], "PLAN.P", 2, { second_approver_required: false }, Date.now()).ok, true);
  assert.equal(prodStepApproval([A1], "PLAN.P", 2, { second_approver_required: false }, Date.now()).ok, false);
  assert.equal(prodStepApproval([A1, A3], "PLAN.P", 2, { second_approver_required: true }, Date.now()).ok, false);
});

// Workspace prod con piano attivo (passo 1 = `s`), policy dell'ambiente nella sessione e un registro di approvazioni
// autentico: ogni frase è anche nel transcript (sha e orario del record), come li produce approval-capture.
function prodWs(s, { write_data = false, second = null } = {}) {
  const ws = envWs({ env: "prod", remediation: { levels: { verde: { areas: ["CL-CFG-006"], objects: [] }, giallo: { areas: ["CL-CFG-020"], objects: ["C.ACME.ADM.CFG.0019"] } } } });
  writeSel(ws, SEL.write, { role: "button", effect: "write", label: "Salva" });
  writeSel(ws, SEL.search, { role: "search_box", effect: "read", label: "Cerca ordini" });
  patchSession(ws, (x) => {
    x.env.policy.write_data = write_data;
    if (second !== null) x.env.policy.second_approver_required = second;
    x.active_plan = { plan_id: PLAN, file: writePlan(ws, planOf([s])), step: 1 };
  });
  sealActivePlan(ws);
  const tr = join(mkdtempSync(join(tmpdir(), "trw-")), "t.jsonl");
  writeFileSync(tr, "");
  const f = approvalsFile(ws, "ACME", "sess-1");
  const planSha = sha256(readFileSync(join(ws, "customers/ACME", readSession(ws).active_plan.file), "utf8"));
  const say = (rec, phrase, minAgo) => {
    const d = new Date(Date.now() - minAgo * 60000);
    appendFileSync(tr, `${JSON.stringify({ type: "user", isSidechain: false, userType: "external", message: { role: "user", content: phrase }, timestamp: d.toISOString() })}\n`);
    appendApproval(f, { ...rec, prompt_sha256: sha256(phrase) }, { date: d });
  };
  return {
    ws, tr, planSha,
    a1: (who = null, extra = {}) => say({ kind: "A1", plan: PLAN, approver_declared: who, plan_sha256: planSha, ...extra }, `APPROVO PIANO ${PLAN}${who ? ` DA ${who}` : ""}`, 3),
    a2: (who) => say({ kind: "A2", plan: PLAN, approver_declared: who }, `APPROVO PROVA ${PLAN} DA ${who}`, 2),
    a3: (n = 1) => say({ kind: "A3", plan: PLAN, step: n, approver_declared: null }, `APPROVO PASSO ${n} ${PLAN}`, 1),
  };
}
const call = (w, tool, input) => browserCall(G, w.ws, `${DT}${tool}`, input, { transcript_path: w.tr });
const click = (w) => call(w, "click", { uid: "1_4" });
const save = () => step(1, "SAVE", "ACT-CREATE", SEL.write);

test("prod con write_data spento ⇒ la scrittura sui dati è negata (write_data) anche con APPROVO PIANO e APPROVO PASSO", () => {
  const w = prodWs(save(), { write_data: false, second: false });
  w.a1("Mario Rossi"); w.a3();
  for (const r of [click(w), call(w, "fill", { uid: "1_5", value: "x" }), call(w, "upload_file", { uid: "1", filePath: "C:/a.pdf" })]) {
    assert.ok(denied(r), r.stdout); assert.match(reasonOf(r), /write_data/);
  }
});

test("prod con write_data acceso e secondo approvatore spento: A1 + token del passo ⇒ consentito (click, input, caricamento, invio nel passo)", () => {
  const w = prodWs(save(), { write_data: true, second: false });
  assert.ok(denied(click(w)), "senza approvazioni: negato");
  w.a1("Mario Rossi");
  const noStep = click(w);
  assert.ok(denied(noStep)); assert.match(reasonOf(noStep), /APPROVO PASSO 1/);
  w.a3();
  for (const r of [click(w), call(w, "fill", { uid: "1_5", value: "x" }), call(w, "upload_file", { uid: "1", filePath: "C:/a.pdf" }), call(w, "press_key", { key: "Enter" })]) {
    assert.ok(silent(r), r.stdout);
  }
  // script e strumenti non classificati restano negati anche dentro il passo approvato
  assert.ok(denied(call(w, "evaluate_script", { function: "() => 1" })));
  assert.ok(denied(call(w, "mystery_tool", {})));
});

test("prod con secondo approvatore (default): serve anche A2 da persona diversa; il transcript deve confermare le frasi; il piano non deve cambiare dopo A1", () => {
  const w = prodWs(save(), { write_data: true });   // second_approver_required resta quello della fixture (true)
  w.a1("Mario Rossi"); w.a3();
  const noA2 = click(w);
  assert.ok(denied(noA2)); assert.match(reasonOf(noA2), /A2|APPROVO PROVA/);
  w.a2("mario  rossi");
  assert.ok(denied(click(w)), "A2 dalla stessa persona non vale");
  w.a2("Luca Bianchi");
  const ok = click(w);
  assert.ok(silent(ok), ok.stdout);
  const forged = browserCall(G, w.ws, `${DT}click`, { uid: "1_4" }, { transcript_path: join(mkdtempSync(join(tmpdir(), "trw-")), "vuoto.jsonl") });
  assert.ok(denied(forged)); assert.match(reasonOf(forged), /transcript/);
  const changed = prodWs(save(), { write_data: true, second: false });
  changed.a1("Mario Rossi", { plan_sha256: "f".repeat(64) }); changed.a3();
  const rc = click(changed);
  assert.ok(denied(rc)); assert.match(reasonOf(rc), /piano.*cambiato/);
});

test("prod senza piano attivo ⇒ deny di input, click, caricamenti e invii, anche con write_data acceso", () => {
  const ws = envWs({ env: "prod" });
  patchSession(ws, (x) => { x.env.policy.write_data = true; x.env.policy.second_approver_required = false; });
  for (const [t, i] of [[`${DT}click`, { uid: "1_4" }], [`${DT}fill`, { uid: "1_5", value: "x" }], [`${DT}upload_file`, { uid: "1", filePath: "a.pdf" }], [`${DT}press_key`, { key: "Enter" }]]) {
    assert.ok(denied(browserCall(G, ws, t, i)), t);
  }
});

test("passo DELETE in produzione ⇒ deny sempre, anche con write_data e approvazioni", () => {
  const w = prodWs(step(1, "DELETE", "ACT-DELETE", SEL.write), { write_data: true, second: false });
  w.a1("Mario Rossi"); w.a3();
  for (const r of [click(w), call(w, "fill", { uid: "1_5", value: "x" }), call(w, "press_key", { key: "Enter" })]) {
    assert.ok(denied(r), r.stdout);
  }
  assert.match(reasonOf(click(w)), /non si cancella/);
});

test("caricamento e invio FUORI da un passo di scrittura restano negati (passo di lettura), anche con write_data acceso e approvazioni", () => {
  const w = prodWs(step(1, "FILL", "ACT-READ", SEL.search, { data: "4500012345" }), { write_data: true, second: false });
  w.a1("Mario Rossi"); w.a3();
  assert.ok(silent(call(w, "fill", { uid: "1_5", value: "4500012345" })), "la ricerca resta consentita");
  assert.ok(denied(call(w, "upload_file", { uid: "1", filePath: "a.pdf" })));
  assert.ok(denied(call(w, "press_key", { key: "Enter" })));
  assert.ok(denied(call(w, "type_text", { text: "x", submitKey: "Enter" })));
  assert.ok(denied(call(w, "handle_dialog", { action: "accept" })));
});

test("ACT-CFG-CHANGE in prod non dipende da write_data (governa solo i dati): con write_data spento passa alle approvazioni (A1 + A2 + passo)", () => {
  const w = prodWs(step(1, "TOGGLE", "ACT-CFG-CHANGE", SEL.write, CFG), { write_data: false });
  w.a1("Mario Rossi"); w.a3();
  const r = click(w);
  assert.ok(denied(r)); assert.doesNotMatch(reasonOf(r), /write_data/); assert.match(reasonOf(r), /A2|APPROVO PROVA/);
  w.a2("Luca Bianchi");
  const ok = click(w);
  assert.ok(silent(ok), ok.stdout);
});
