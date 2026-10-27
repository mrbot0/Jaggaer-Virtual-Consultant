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

test("N3: mappa completa oltre il limite in byte — motivo registrato e messaggio che non rimanda a rileggere per intero", () => {
  const call = classify(DT + "take_snapshot", {});
  const refs = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`1_${i}`, null]));
  const names = Object.fromEntries(Object.keys(refs).map((r) => [r, `Voce ${r}`]));
  const base = { call, obs: "O1", ts: "t", envType: "preprod", mode: "complete", refs, pageUrl: URL0, labels: Object.keys(refs).map((r) => [r, `k${r}`]), labelLoc: { url: URL0 }, names, verified: Object.keys(refs), key: "u:x" };
  assert.equal(nextBinding({}, { v: 1, tabs: {} }, { ...base, limits: { mapBytes: 500 } }).browser.snapshot.unusable_reason, "map");
  assert.equal(nextBinding({}, { v: 1, tabs: {} }, { ...base, limits: { histBytes: 500 } }).browser.snapshot.unusable_reason, "history");
  const pw = classify("mcp__plugin_playwright_playwright__browser_snapshot", { target: "e1" });
  assert.equal(nextBinding({}, { v: 1, tabs: {} }, { ...base, call: pw, mode: "partial", sessionMode: "esplorazione", limits: { mapBytes: 500 } }).browser.snapshot.unusable_reason, "pieces");

  const reason = (why) => {
    const { ws, g } = explore("preprod", "ESPLORA PREPROD");
    patchSession(ws, (x) => { x.browser.snapshot = { obs: "x", url: x.browser.current_url, tab: null, ts: "t", refs: {}, names: {}, unusable: true, ...(why ? { unusable_reason: why } : {}) }; });
    const r = g(DT + "click", { uid: "1_2" });
    assert.equal(decisionOf(r), "deny");
    return reasonOf(r);
  };
  for (const why of ["map", null]) {
    const m = reason(why);
    assert.match(m, /troppo grande per essere mappata/, m);
    assert.match(m, /a pezzi/);
    assert.match(m, /sezion/);
    assert.match(m, /solo in esplorazione/);
    assert.doesNotMatch(m, /naviga di nuovo|rileggila/, "nessun invito a rileggere per intero: darebbe lo stesso esito");
  }
  assert.match(reason("pieces"), /pezzi/);
  assert.doesNotMatch(reason("pieces"), /rileggila/);
  assert.match(reason("history"), /naviga/, "la storia si azzera con una navigazione");
});
