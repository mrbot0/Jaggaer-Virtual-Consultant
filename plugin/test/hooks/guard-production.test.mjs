// K5.5 — guard-production (PreToolUse sugli strumenti MCP del browser, FAIL-CLOSED,
// attivo con session.env.type = prod). §52.1 strato 3: in prod solo navigazione e
// lettura; input solo su un SEL `search_box` del passo attivo; click solo su un SEL
// `effect: read`; script ⇒ deny; upload, dialog accettati e invio (Enter) solo dentro un passo di scrittura
// approvato (Ops veloce, spec 2026-10-06 §3.6: le scritture sui dati hanno i loro test in prod-writes.test.mjs);
// configurazione solo in un passo ACT-CFG-CHANGE con finestra 3A valida e token
// del passo. Criterio M6: 100 casi avversi generati → 100/100 deny (con write_data spento).
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFileSync, mkdtempSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { decisionOf, reasonOf } from "../helpers/hook-env.mjs";
import { envWs, browserCall, patchSession, writePlan, writeSel, sealActivePlan } from "../helpers/env-fixture.mjs";
import { appendApproval, approvalsFile, sha256 } from "../../scripts/admin/approvals.mjs";
import { ACT } from "../../hooks/lib/act-classes.mjs";
import { loadCatalog } from "../../scripts/decide/validate-plan.mjs";

const G = "guard-production";
const PLAN = "PLAN.0077";
const denied = (r) => decisionOf(r) === "deny";
const silent = (r) => r.status === 0 && r.stdout.trim() === "";

const SEL = {
  write: "C.ACME.ADM.SEL.0120", unknown: "C.ACME.ADM.SEL.0121", search: "C.ACME.ADM.SEL.0130", read: "C.ACME.ADM.SEL.0131",
  missing: "C.ACME.ADM.SEL.0999", other: "C.BETA.ADM.SEL.0001", std: "S.STD.ADM.SEL.0140",
};
function atlas(ws) {
  writeSel(ws, SEL.write, { role: "button", effect: "write", label: "Salva" });
  writeSel(ws, SEL.unknown, { role: "button", effect: null, label: "Pubblica" });   // voce senza effect
  writeSel(ws, SEL.search, { role: "search_box", effect: "read", label: "Cerca ordini" });
  writeSel(ws, SEL.read, { role: "tab", effect: "read", label: "Scheda Righe" });
  writeSel(ws, SEL.std, { role: "search_box", effect: "read", label: "Ricerca standard" });
}
const step = (n, verb, action_class, target, extra = {}) => ({ n, verb, action_class, target, expect: { page_sig: "x" }, ...extra });
const planOf = (steps) => ({ plan_id: PLAN, customer: "ACME", env: "prod", goal: "diagnosi", approvals: "3A", steps, repair_policy: { skip_allowed: [], substitute_allowed: [], abort_on: [] } });
function transcript(prompts) {
  const f = join(mkdtempSync(join(tmpdir(), "trp-")), "t.jsonl");
  writeFileSync(f, prompts.map((p) => JSON.stringify({ type: "user", message: { role: "user", content: p } })).join("\n") + "\n");
  return f;
}

// Scenario = piano/passo attivo + stato delle approvazioni in prod.
function prodWs(scenario) {
  const ws = envWs({ env: "prod", remediation: { levels: { verde: { areas: ["CL-CFG-006"], objects: [] }, giallo: { areas: ["CL-CFG-020"], objects: ["C.ACME.ADM.CFG.0019"] } } } });
  atlas(ws);
  const cfg = { config: { object: "C.ACME.ADM.CFG.0019", area: "CL-CFG-020", level: "giallo" } };
  const f = approvalsFile(ws, "ACME", "sess-1");
  const now = Date.now();
  const a = (rec, minAgo) => appendApproval(f, { prompt_sha256: "0".repeat(64), ...rec }, { date: new Date(now - minAgo * 60000) });
  const S = {
    "senza piano": null,
    "OBS su SEL effect write": step(1, "CLICK", "ACT-OBS", SEL.write),
    "OBS su SEL senza effect": step(1, "CLICK", "ACT-OBS", SEL.unknown),
    "classe di scrittura ACT-CREATE": step(1, "FILL", "ACT-CREATE", SEL.search),
    "classe di scrittura ACT-SUBMIT": step(1, "SUBMIT", "ACT-SUBMIT", SEL.write),
    "CFG-CHANGE finestra scaduta": step(1, "TOGGLE", "ACT-CFG-CHANGE", SEL.write, cfg),
    "CFG-CHANGE senza A2": step(1, "TOGGLE", "ACT-CFG-CHANGE", SEL.write, cfg),
    "CFG-CHANGE A2 dalla stessa persona": step(1, "TOGGLE", "ACT-CFG-CHANGE", SEL.write, cfg),
    "CFG-CHANGE senza token del passo": step(1, "TOGGLE", "ACT-CFG-CHANGE", SEL.write, cfg),
    "SEL assente dall'Atlas": step(1, "CLICK", "ACT-OBS", SEL.missing),
    "SEL di un altro cliente": step(1, "CLICK", "ACT-OBS", SEL.other),
    "target url_pattern": step(1, "CLICK", "ACT-OBS", { url_pattern: "/orders" }),
  }[scenario];
  if (S !== null) { patchSession(ws, (s) => { s.active_plan = { plan_id: PLAN, file: writePlan(ws, planOf([S])), step: 1 }; }); sealActivePlan(ws); }   // impronta come la scrive step-check (WP07 giro 1)
  if (scenario === "CFG-CHANGE finestra scaduta") { a({ kind: "A1", plan: PLAN, approver_declared: "Mario Rossi" }, 61); a({ kind: "A2", plan: PLAN, approver_declared: "Luca Bianchi" }, 60.5); a({ kind: "A3", plan: PLAN, step: 1 }, 60.2); }
  if (scenario === "CFG-CHANGE senza A2") { a({ kind: "A1", plan: PLAN, approver_declared: "Mario Rossi" }, 3); a({ kind: "A3", plan: PLAN, step: 1 }, 1); }
  if (scenario === "CFG-CHANGE A2 dalla stessa persona") { a({ kind: "A1", plan: PLAN, approver_declared: "Mario Rossi" }, 3); a({ kind: "A2", plan: PLAN, approver_declared: "MARIO ROSSI" }, 2); a({ kind: "A3", plan: PLAN, step: 1 }, 1); }
  if (scenario === "CFG-CHANGE senza token del passo") { a({ kind: "A1", plan: PLAN, approver_declared: "Mario Rossi" }, 3); a({ kind: "A2", plan: PLAN, approver_declared: "Luca Bianchi" }, 2); a({ kind: "A3", plan: PLAN, step: 2 }, 1); }
  return ws;
}

const DT = "mcp__chrome-devtools__";
const CB = "mcp__Claude_Browser__";
const PW = "mcp__plugin_playwright_playwright__";
const WRITES = [
  [`${DT}click`, { uid: "1_4" }], [`${DT}fill`, { uid: "1_5", value: "4500012345" }], [`${DT}fill_form`, { elements: [{ uid: "1", value: "x" }] }],
  [`${DT}type_text`, { text: "x" }], [`${DT}press_key`, { key: "Enter" }], [`${DT}upload_file`, { uid: "1", filePath: "C:/a.pdf" }],
  [`${DT}handle_dialog`, { action: "accept" }], [`${DT}evaluate_script`, { function: "() => document.querySelector('#save').click()" }], [`${DT}drag`, { from_uid: "1", to_uid: "2" }],
  [`${DT}mystery_tool`, {}],
  [`${CB}computer`, { action: "left_click", ref: "ref_3" }], [`${CB}computer`, { action: "type", text: "abc" }], [`${CB}computer`, { action: "key", text: "Return" }],
  [`${CB}form_input`, { ref: "ref_4", value: "x" }], [`${CB}file_upload`, { paths: ["a.pdf"] }], [`${CB}javascript_tool`, { action: "javascript_exec", text: "document.forms[0].submit()" }],
  [`${CB}browser_batch`, { actions: [{ name: "computer", input: { action: "screenshot" } }, { name: "computer", input: { action: "left_click", ref: "r" } }] }],
  [`${PW}browser_click`, { element: "Salva", ref: "e1" }], [`${PW}browser_type`, { ref: "e2", text: "x", submit: true }], [`${PW}browser_fill_form`, { fields: [] }],
  [`${PW}browser_select_option`, { ref: "e3", values: ["a"] }], [`${PW}browser_press_key`, { key: "Enter" }], [`${PW}browser_file_upload`, { paths: [] }],
  [`${PW}browser_evaluate`, { function: "() => 1" }], [`${PW}browser_run_code_unsafe`, { code: "await page.click('#save')" }], [`${PW}browser_handle_dialog`, { accept: true }],
  [`${PW}browser_drag`, {}],
];
const SCENARIOS = ["senza piano", "OBS su SEL effect write", "OBS su SEL senza effect", "classe di scrittura ACT-CREATE", "classe di scrittura ACT-SUBMIT",
  "CFG-CHANGE finestra scaduta", "CFG-CHANGE senza A2", "CFG-CHANGE A2 dalla stessa persona", "CFG-CHANGE senza token del passo",
  "SEL assente dall'Atlas", "SEL di un altro cliente", "target url_pattern"];

// 100 casi avversi: prodotto famiglie × tipi × scenari, campionato in modo deterministico
// e stratificato (ogni scenario e ogni chiamata compaiono).
export function adversarialCases(n = 100) {
  const all = [];
  SCENARIOS.forEach((sc, i) => WRITES.forEach((w, j) => all.push({ sc, tool: w[0], input: w[1], key: (i * 7 + j * 13) % 97 })));
  const byScenario = SCENARIOS.map((sc) => all.filter((c) => c.sc === sc).sort((a, b) => a.key - b.key));
  const out = [];
  for (let k = 0; out.length < n; k++) for (const list of byScenario) { if (out.length < n && list[k]) out.push(list[k]); }
  return out;
}

test("M6: 100 casi avversi in produzione (famiglie × tipi × effetti SEL × piano mancante × finestra scaduta) → 100/100 deny", () => {
  const cases = adversarialCases(100);
  assert.equal(cases.length, 100);
  assert.ok(new Set(cases.map((c) => c.sc)).size === SCENARIOS.length);
  assert.ok(new Set(cases.map((c) => c.tool)).size >= 20);
  const wsBy = new Map();
  const tr = transcript(["APPROVO PIANO PLAN.0077 DA Mario Rossi", "APPROVO PROVA PLAN.0077 DA Luca Bianchi", "APPROVO PASSO 1 PLAN.0077"]);
  let deniedCount = 0;
  const leaks = [];
  for (const c of cases) {
    if (!wsBy.has(c.sc)) wsBy.set(c.sc, prodWs(c.sc));
    const r = browserCall(G, wsBy.get(c.sc), c.tool, c.input, { transcript_path: tr });
    if (denied(r)) deniedCount++; else leaks.push(`${c.sc} · ${c.tool} ${JSON.stringify(c.input)} → ${r.stdout || "(silenzio)"}`);
  }
  console.log(`guard-production: ${deniedCount}/100 deny`);
  assert.equal(deniedCount, 100, `scritture in prod non negate:\n${leaks.join("\n")}`);
});

test("letture in prod ⇒ consentite (nessun output); navigazione verso host dichiarati ⇒ consentita, fuori lista ⇒ deny", () => {
  const ws = prodWs("senza piano");
  for (const [t, i] of [[`${DT}take_snapshot`, {}], [`${DT}take_screenshot`, {}], [`${DT}list_network_requests`, {}], [`${DT}hover`, { uid: "1" }], [`${DT}wait_for`, { text: "x" }],
    [`${CB}computer`, { action: "screenshot" }], [`${CB}computer`, { action: "scroll" }], [`${CB}get_page_text`, {}], [`${CB}find`, { query: "Ordini" }], [`${CB}read_page`, {}],
    [`${PW}browser_snapshot`, {}], [`${PW}browser_take_screenshot`, {}], [`${DT}navigate_page`, { url: "https://acme.jaggaer.com/orders/4500012345" }],
    [`${CB}navigate`, { url: "https://sso.acme.it/login" }], [`${DT}handle_dialog`, { action: "dismiss" }], [`${CB}browser_batch`, { actions: [{ name: "computer", input: { action: "screenshot" } }, { name: "find", input: {} }] }]]) {
    const r = browserCall(G, ws, t, i);
    assert.ok(silent(r), `${t} ${JSON.stringify(i)} → ${r.stdout}`);
  }
  assert.ok(denied(browserCall(G, ws, `${DT}navigate_page`, { url: "https://acme-sbx.jaggaer.com/" })));
});

test("input solo sul search_box del passo attivo (anche SEL standard); click solo su SEL effect: read; Enter e dialog accettati mai", () => {
  const ws = prodWs("senza piano");
  const set = (s) => { patchSession(ws, (x) => { x.active_plan = { plan_id: PLAN, file: writePlan(ws, planOf([s])), step: 1 }; }); sealActivePlan(ws); };
  set(step(1, "FILL", "ACT-READ", SEL.search, { data: "4500012345" }));
  assert.ok(silent(browserCall(G, ws, `${DT}fill`, { uid: "1_5", value: "4500012345" })));
  assert.ok(silent(browserCall(G, ws, `${CB}form_input`, { ref: "r", value: "4500012345" })));
  assert.ok(silent(browserCall(G, ws, `${PW}browser_type`, { ref: "e", text: "4500012345" })));
  const enter = browserCall(G, ws, `${DT}type_text`, { text: "4500012345", submitKey: "Enter" });
  assert.ok(denied(enter)); assert.match(reasonOf(enter), /fuori da un passo di scrittura approvato/);
  assert.ok(denied(browserCall(G, ws, `${DT}click`, { uid: "1" })), "click sul search_box: il passo è di input");
  set(step(1, "FILL", "ACT-OBS", SEL.std));
  assert.ok(silent(browserCall(G, ws, `${DT}fill`, { uid: "1_5", value: "x" })), "search_box standard in product/kb");
  set(step(1, "CLICK", "ACT-OBS", SEL.read));
  assert.ok(silent(browserCall(G, ws, `${DT}click`, { uid: "1_9" })));
  assert.ok(silent(browserCall(G, ws, `${CB}computer`, { action: "left_click", ref: "r" })));
  const typing = browserCall(G, ws, `${DT}fill`, { uid: "1_9", value: "x" });
  assert.ok(denied(typing)); assert.match(reasonOf(typing), /search_box/);
  assert.ok(denied(browserCall(G, ws, `${DT}handle_dialog`, { action: "accept" })));
});

test("configurazione in prod: consentita solo con 3A valida (A1, A2 da persona diversa, token del passo, frasi nel transcript)", () => {
  // record autentici: stesso sha del prompt e stesso orario della riga del transcript
  // (come li produce approval-capture); il registro dello scenario "senza A2" ha sha falsi.
  const forged = prodWs("CFG-CHANGE senza A2");
  appendApproval(approvalsFile(forged, "ACME", "sess-1"), { kind: "A2", plan: PLAN, approver_declared: "Luca Bianchi", prompt_sha256: "0".repeat(64) });
  const trF = transcript(["APPROVO PIANO PLAN.0077 DA Mario Rossi", "APPROVO PROVA PLAN.0077 DA Luca Bianchi", "APPROVO PASSO 1 PLAN.0077"]);
  assert.ok(denied(browserCall(G, forged, `${DT}click`, { uid: "1_4" }, { transcript_path: trF })), "record con sha che non corrisponde a nessun prompt ⇒ deny");
  const ws = prodWs("senza piano");
  patchSession(ws, (s) => { s.active_plan = { plan_id: PLAN, file: writePlan(ws, planOf([step(1, "TOGGLE", "ACT-CFG-CHANGE", SEL.write, { config: { object: "C.ACME.ADM.CFG.0019", area: "CL-CFG-020", level: "giallo" } })])), step: 1 }; });
  sealActivePlan(ws);
  const f = approvalsFile(ws, "ACME", "sess-1");
  const tr = join(mkdtempSync(join(tmpdir(), "trp-")), "t.jsonl");
  writeFileSync(tr, "");
  const genuine = (rec, phrase, minAgo) => {
    const d = new Date(Date.now() - minAgo * 60000);
    appendFileSync(tr, `${JSON.stringify({ type: "user", isSidechain: false, userType: "external", message: { role: "user", content: phrase }, timestamp: d.toISOString() })}\n`);
    appendApproval(f, { ...rec, prompt_sha256: sha256(phrase) }, { date: d });
  };
  genuine({ kind: "A1", plan: PLAN, approver_declared: "Mario Rossi" }, "APPROVO PIANO PLAN.0077 DA Mario Rossi", 3);
  genuine({ kind: "A2", plan: PLAN, approver_declared: "Luca Bianchi" }, "APPROVO PROVA PLAN.0077 DA Luca Bianchi", 2);
  genuine({ kind: "A3", plan: PLAN, step: 1, approver_declared: null }, "APPROVO PASSO 1 PLAN.0077", 1);
  const ok = browserCall(G, ws, `${DT}click`, { uid: "1_4" }, { transcript_path: tr });
  assert.ok(silent(ok), ok.stdout);
  assert.ok(denied(browserCall(G, ws, `${DT}click`, { uid: "1_4" }, { transcript_path: transcript(["APPROVO PIANO PLAN.0077 DA Mario Rossi"]) })), "frasi assenti dal transcript");
  // Ops veloce: dentro un passo di scrittura approvato (qui ACT-CFG-CHANGE con 3A) il caricamento è ammesso; fuori da un passo di scrittura mai (prod-writes.test.mjs)
  assert.ok(silent(browserCall(G, ws, `${DT}upload_file`, { uid: "1", filePath: "x" }, { transcript_path: tr })), "upload dentro il passo approvato");
  assert.ok(denied(browserCall(G, ws, `${DT}evaluate_script`, { function: "() => 1" }, { transcript_path: tr })), "script mai");
  appendFileSync(tr, "");
});

test("ambiente non prod ⇒ nessuna opinione; fail-closed su eccezione e su piano illeggibile", () => {
  const sbx = envWs({ env: "sandbox" });
  assert.ok(silent(browserCall(G, sbx, `${DT}click`, { uid: "1" })));
  const ws = prodWs("senza piano");
  const r = browserCall(G, ws, `${DT}take_snapshot`, {}, {}, { JVC_TEST_THROW: "1" });
  assert.ok(denied(r)); assert.match(reasonOf(r), /fail-closed/);
  patchSession(ws, (s) => { s.active_plan = { plan_id: PLAN, file: "../../BETA/runs/x.json", step: 1 }; });
  assert.ok(denied(browserCall(G, ws, `${DT}click`, { uid: "1" })), "piano fuori dalla cartella del cliente");
});

test("act-classes.mjs coincide con il catalogo product/kb/actions (effetto, rischio, ammissione per ambiente)", () => {
  const cat = loadCatalog();
  assert.deepEqual(Object.keys(ACT).sort(), [...cat.keys()].sort());
  for (const [code, a] of cat) {
    assert.equal(ACT[code].effect, a.effect, code);
    assert.equal(ACT[code].risk, a.risk, code);
    for (const e of ["sandbox", "preprod", "prod"]) assert.equal(ACT[code][e], a.environments[e], `${code}.${e}`);
  }
});
