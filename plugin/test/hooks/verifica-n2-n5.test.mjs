// Rilievi N2–N5 della verifica del 27/10/2026 (ramo esplorazione-libera):
//  N2. una chiamata che ha agito (browser_batch [click, find] del browser di Claude) marca after_action anche sulla mappa
//      tenuta dal ramo del find: il pezzo successivo apre una mappa nuova;
//  N3. mappa completa oltre il limite in byte a ogni lettura: il messaggio del guard non rimanda in loop a rileggere;
//  N5. registro dell'esplorazione: i pezzi letti dopo un'azione non si uniscono alla visita di prima dell'azione.
import { test } from "node:test";
import assert from "node:assert/strict";
import { nextBinding } from "../../hooks/lib/observe-append.mjs";
import { classify } from "../../hooks/lib/browser-tools.mjs";

const CL = "mcp__claude-in-chrome__";
const URL0 = "https://acme-sbx.jaggaer.com/p2p/req/1";

test("N2: browser_batch [click, find] — la mappa tenuta dal ramo del find è marcata after_action", () => {
  const call = classify(CL + "browser_batch", { actions: [{ name: "computer", input: { action: "left_click", ref: "ref_3", tabId: 101 } }, { name: "find", input: { query: "salva", tabId: 101 } }] });
  const prev = { obs: "O1", url: URL0, tab: "101", ts: "t0", refs: { ref_3: null, ref_9: null }, names: { ref_3: "Ordini", ref_9: "Salva" }, family: "claude-browser", hist_keys: ["cl|101"], partial: true, sig: "p2p/req" };
  const r = nextBinding({ snapshot: prev }, { v: 1, tabs: {} }, { call, obs: "O2", ts: "t1", envType: "sandbox", mode: "partial", refs: null, pageUrl: null, labels: [], asked: "101", find: true, sessionMode: "esplorazione" });
  assert.equal(r.browser.snapshot.after_action, true, JSON.stringify(r.browser.snapshot));
  // un find puro (senza azione) non la marca
  const f = classify(CL + "find", { query: "salva", tabId: 101 });
  const r2 = nextBinding({ snapshot: prev }, { v: 1, tabs: {} }, { call: f, obs: "O3", ts: "t2", envType: "sandbox", mode: "partial", refs: null, pageUrl: null, labels: [], asked: "101", find: true, sessionMode: "esplorazione" });
  assert.notEqual(r2.browser.snapshot.after_action, true);
});

// N3 ------------------------------------------------------------------------------------------------------------------
import { writeFileSync, mkdtempSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { envWs, patchSession, browserCall, ROOT } from "../helpers/env-fixture.mjs";
import { runHook, runSessionCli, decisionOf, reasonOf } from "../helpers/hook-env.mjs";

const DT = "mcp__chrome-devtools__";
function explore(env, phrase) {
  const ws = envWs({ env, scope: "P2P" });
  const tr = join(mkdtempSync(join(tmpdir(), "vn-")), "t.jsonl"); writeFileSync(tr, "");
  appendFileSync(tr, `${JSON.stringify({ type: "user", isSidechain: false, userType: "external", message: { role: "user", content: phrase }, timestamp: new Date().toISOString() })}\n`);
  runHook("approval-capture", { session_id: "sess-1", cwd: ws, hook_event_name: "UserPromptSubmit", prompt: phrase, transcript_path: tr }, { JVC_WORKSPACE: ws, CLAUDE_PLUGIN_ROOT: ROOT });
  assert.equal(runSessionCli(["use", "mode", "esplorazione", "--session", "sess-1"], { JVC_WORKSPACE: ws }).status, 0);
  patchSession(ws, (s) => { s.browser = { current_url: "https://acme-pre.jaggaer.com/p2p/req/1", tab: null, updated_by: "browser-origin" }; });
  return { ws, g: (tool, ti) => browserCall("guard-config-scope", ws, tool, ti, { transcript_path: tr }) };
}

// N3 superato (27/10/2026, decisione dell'utente: «rimuoviamo il Guard sulla grandezza, risulta bloccante e inutile»): nessun
// limite in byte della mappa, dei pezzi o della storia; nessun motivo "inutilizzabile" né il suo messaggio nel guard.
test("N3 (guard sulla grandezza tolto): mappa completa, pezzi e storia grandi restano usabili; il guard non ha più il messaggio della pagina troppo grande", () => {
  const call = classify(DT + "take_snapshot", {});
  const refs = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`1_${i}`, null]));
  const names = Object.fromEntries(Object.keys(refs).map((r) => [r, `Voce ${r}`]));
  const base = { call, obs: "O1", ts: "t", envType: "preprod", mode: "complete", refs, pageUrl: URL0, labels: Object.keys(refs).map((r) => [r, `k${r}`]), labelLoc: { url: URL0 }, names, verified: Object.keys(refs), key: "u:x" };
  assert.equal(nextBinding({}, { v: 1, tabs: {} }, { ...base, limits: { mapBytes: 500 } }).browser.snapshot.unusable_reason, undefined);
  assert.equal(nextBinding({}, { v: 1, tabs: {} }, { ...base, limits: { histBytes: 500 } }).browser.snapshot.unusable_reason, undefined);
  const pw = classify("mcp__plugin_playwright_playwright__browser_snapshot", { target: "e1" });
  assert.equal(nextBinding({}, { v: 1, tabs: {} }, { ...base, call: pw, mode: "partial", sessionMode: "esplorazione", limits: { mapBytes: 500 } }).browser.snapshot.unusable_reason, undefined);
  // una mappa lasciata "inutilizzabile" da una versione precedente (refs e nomi vuoti) nega comunque il click: nessun nome
  const { ws, g } = explore("preprod", "ESPLORA PREPROD");
  patchSession(ws, (x) => { x.browser.snapshot = { obs: "x", url: x.browser.current_url, tab: null, ts: "t", refs: {}, names: {}, unusable: true, unusable_reason: "map" }; });
  const r = g(DT + "click", { uid: "1_2" });
  assert.notEqual(decisionOf(r), "deny");   // 28/10/2026: nessun nome non blocca più il click in esplorazione
  assert.doesNotMatch(reasonOf(r), /troppo grande/);
});

// N5 ------------------------------------------------------------------------------------------------------------------
import { readFileSync, existsSync } from "node:fs";
import { buildDrafts } from "../../scripts/kb/atlas-build.mjs";

const PW = "mcp__plugin_playwright_playwright__";
const PURL = "https://acme-pre.jaggaer.com/p2p/req/1";
const pwBody = (body) => `### Page\n- Page URL: ${PURL}\n- Page Title: ACME\n### Snapshot\n\`\`\`yaml\n${body}\n\`\`\``;
let seqN5 = 0;
const postN5 = (ws, tool, ti, text) => {
  const i = { session_id: "sess-1", cwd: ws, hook_event_name: "PostToolUse", tool_name: tool, tool_input: ti, tool_use_id: `toolu_n5_${++seqN5}`, tool_response: [{ type: "text", text }] };
  runHook("browser-origin", i, { JVC_WORKSPACE: ws, CLAUDE_PLUGIN_ROOT: ROOT });
  return runHook("observe-append", i, { JVC_WORKSPACE: ws, CLAUDE_PLUGIN_ROOT: ROOT });
};
const atlasDir = (ws) => join(ws, "customers/ACME/.sessions/sess-1/atlas");
const pagesOf = (ws) => { const f = join(atlasDir(ws), "pages.jsonl"); return existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((l) => l.kind === "page") : []; };

test("N5: un pezzo letto dopo un'azione è marcato after_action nel registro e non eredita i ref dei record della visita di prima", () => {
  const { ws, g } = explore("preprod", "ESPLORA PREPROD");
  postN5(ws, PW + "browser_snapshot", { target: "e1" }, pwBody(`- table "Fornitori" [ref=e4]:\n  - row "Fornitore A" [ref=e5]:\n    - cell "Fornitore A" [ref=e6]\n- link "Ordini" [ref=e13]`));
  postN5(ws, PW + "browser_snapshot", { target: "e2" }, pwBody(`- button "Nuovo" [ref=e14]`));
  const before = pagesOf(ws);
  assert.equal(before.length, 2);
  assert.ok(before.every((p) => p.partial === true && p.after_action === undefined), JSON.stringify(before));
  const lp0 = JSON.parse(readFileSync(join(atlasDir(ws), "last-page.json"), "utf8"));
  assert.ok(lp0.record_refs.includes("e6"), "pezzi della stessa mappa: record_refs sommati");
  assert.ok(decisionOf(g(PW + "browser_click", { ref: "e13", element: "Ordini" })) !== "deny");
  postN5(ws, PW + "browser_click", { ref: "e13", element: "Ordini" }, "### Ran Playwright code\n```js\nawait page.click();\n```");
  postN5(ws, PW + "browser_snapshot", { target: "e20" }, pwBody(`- button "Salva" [ref=e21]`));
  const after = pagesOf(ws);
  assert.equal(after.length, 3);
  assert.equal(after[2].after_action, true, JSON.stringify(after[2]));
  const lp = JSON.parse(readFileSync(join(atlasDir(ws), "last-page.json"), "utf8"));
  assert.deepEqual(lp.record_refs, [], "i ref dei record della visita di prima dell'azione non passano alla mappa nuova");
  // un altro pezzo della stessa mappa nuova (senza azioni in mezzo) si somma: non è marcato
  postN5(ws, PW + "browser_snapshot", { target: "e22" }, pwBody(`- button "Invia" [ref=e23]`));
  assert.equal(pagesOf(ws)[3].after_action, undefined);
});

test("N5: atlas-build non unisce alla visita di prima un pezzo marcato after_action (con o senza click registrato in mezzo)", () => {
  const sig = "p2p/req#richiesta-1";
  const rec = (els, extra = {}) => ({ kind: "page", partial: true, page_sig: sig, title: "Richiesta 1", url_path: "/p2p/req/1", elements: els.map((e, i) => ({ i, parent: null, ...e })), ...extra });
  const p1 = rec([{ role: "heading", name: "Richiesta 1", level: 1 }, { role: "button", name: "Salva", ref: "e3" }]);
  const p2 = rec([{ role: "button", name: "Invia", ref: "e9" }], { after_action: true });
  for (const lines of [[p1, { kind: "click", from_sig: sig, target: { name: "Salva" }, effect: true }, p2], [p1, p2]]) {
    const d = buildDrafts(lines);
    assert.equal(d.pages.get(sig).visits.length, 2, JSON.stringify(d.pages.get(sig).visits));
    assert.deepEqual(d.pages.get(sig).visits[1].map((e) => e.name), ["Invia"]);
  }
  // senza marca (registri precedenti o pezzi della stessa mappa): una visita sola, come prima
  const { after_action: _a, ...p2plain } = p2;
  assert.equal(buildDrafts([p1, p2plain]).pages.get(sig).visits.length, 1);
});
