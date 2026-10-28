// 28/10/2026 (blocco dal vivo su `prep`): l'impronta dell'ambiente (titolo e URL della pagina di login) non esiste dopo
// l'accesso, quindi env-check dava "unknown" e guard-environment negava ogni click ("dichiarato ma non verificato").
// In esplorazione vera (sandbox o pre-produzione, nessun piano attivo) il click passa; fuori dall'esplorazione no.
import { test } from "node:test";
import assert from "node:assert/strict";
import { envWs, patchSession, browserCall } from "../helpers/env-fixture.mjs";
import { decisionOf, reasonOf } from "../helpers/hook-env.mjs";

const DT = "mcp__chrome-devtools__";
const click = (ws) => browserCall("guard-environment", ws, DT + "click", { uid: "1_2" });
const URLS = { preprod: "https://acme-pre.jaggaer.com/esop/analysis-console/ac/analysisnew.do", sandbox: "https://acme-sbx.jaggaer.com/p2p/req/1" };

for (const env of ["preprod", "sandbox"]) {
  test(`${env}: ambiente non verificato — click, navigazione libera e script consentiti in esplorazione; negati con un piano attivo`, () => {
    const ws = envWs({ env, verified: false, scope: "ANL" });
    patchSession(ws, (s) => { s.browser = { current_url: URLS[env], tab: null, updated_by: "browser-origin" }; });
    const r0 = click(ws);
    assert.equal(decisionOf(r0), "deny");
    assert.match(reasonOf(r0), /non verificato/);
    patchSession(ws, (s) => { s.mode = "esplorazione"; });
    assert.notEqual(decisionOf(click(ws)), "deny", reasonOf(click(ws)));
    // un piano attivo toglie il rilassamento
    patchSession(ws, (s) => { s.active_plan = { plan_id: "P1", step: 1 }; });
    assert.equal(decisionOf(click(ws)), "deny");
    // senza piano: navigazione libera, URL ignoto e script nella pagina non bloccano (28/10/2026, decisione dell'utente)
    patchSession(ws, (s) => { delete s.active_plan; s.browser.current_url = "https://altro.example.com/x"; });
    assert.notEqual(decisionOf(click(ws)), "deny", reasonOf(click(ws)));
    patchSession(ws, (s) => { s.browser.current_url = null; });
    assert.notEqual(decisionOf(click(ws)), "deny");
    assert.notEqual(decisionOf(browserCall("guard-environment", ws, DT + "navigate_page", { type: "url", url: "https://qualunque.example.org/x" })), "deny");
    assert.notEqual(decisionOf(browserCall("guard-environment", ws, DT + "evaluate_script", { function: "() => document.title" })), "deny");
    // con un piano attivo (fuori dall'esplorazione) i guard valgono come prima
    patchSession(ws, (s) => { s.active_plan = { plan_id: "P1", step: 1 }; });
    assert.equal(decisionOf(browserCall("guard-environment", ws, DT + "navigate_page", { type: "url", url: "https://qualunque.example.org/x" })), "deny");
    assert.equal(decisionOf(browserCall("guard-environment", ws, DT + "evaluate_script", { function: "() => 1" })), "deny");
  });
}
