// Esplorazione libera (brief 26/10/2026, punto 4): un'unica esplorazione. ESPLORA SANDBOX ed ESPLORA PREPROD si comportano
// come le varianti COMPLETA (che restano valide e sinonime): cliccare tutto, compilare con valori di prova, salvare,
// inviare, approvare, confermare i dialoghi. Restano vietati: cancellazioni (etichetta, domanda di cancellazione nei
// dialoghi), caricamento di file, script nella pagina, strumenti non classificati, produzione.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFileSync, mkdtempSync, appendFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { runHook, runSessionCli, decisionOf, reasonOf, ROOT } from "../helpers/hook-env.mjs";
import { envWs, browserCall, patchSession } from "../helpers/env-fixture.mjs";
import { auditFile } from "../../hooks/lib/audit.mjs";

const DT = "mcp__chrome-devtools__";
const denied = (r) => decisionOf(r) === "deny";
const silent = (r) => r.status === 0 && r.stdout.trim() === "";
const URLS = { preprod: "https://acme-pre.jaggaer.com/p2p/po/new", sandbox: "https://acme-sbx.jaggaer.com/p2p/po/new" };
const NAMES = { "1_1": "Ordini", "1_3": "Salva", "1_4": "Invia per approvazione", "1_5": "Descrizione", "1_6": "Elimina bozza", "1_7": "Approva", "1_8": "Conferma ordine" };

function setup(env, phrase) {
  const ws = envWs({ env, scope: "P2P" });
  const tr = join(mkdtempSync(join(tmpdir(), "xu-")), "t.jsonl"); writeFileSync(tr, "");
  appendFileSync(tr, `${JSON.stringify({ type: "user", isSidechain: false, userType: "external", message: { role: "user", content: phrase }, timestamp: new Date().toISOString() })}\n`);
  runHook("approval-capture", { session_id: "sess-1", cwd: ws, hook_event_name: "UserPromptSubmit", prompt: phrase, transcript_path: tr }, { JVC_WORKSPACE: ws, CLAUDE_PLUGIN_ROOT: ROOT });
  const r = runSessionCli(["use", "mode", "esplorazione", "--session", "sess-1"], { JVC_WORKSPACE: ws });
  const url = URLS[env] ?? URLS.preprod;
  patchSession(ws, (s) => { s.browser = { ...(s.browser ?? {}), current_url: url, tab: "1", snapshot: { obs: "x", url, tab: "1", ts: new Date().toISOString(), refs: Object.fromEntries(Object.keys(NAMES).map((k) => [k, null])), names: NAMES } }; });
  return { ws, status: r.status, c: (t, i) => browserCall("guard-config-scope", ws, t, i, { transcript_path: tr }) };
}

for (const [env, phrase] of [["preprod", "ESPLORA PREPROD"], ["sandbox", "ESPLORA SANDBOX"], ["preprod", "ESPLORA PREPROD COMPLETA"], ["sandbox", "ESPLORA SANDBOX COMPLETA"]]) {
  test(`${phrase}: salva, invia, approva, conferma, compila, Invio e conferma del dialogo consentiti; Elimina, upload, script negati`, () => {
    const { ws, status, c } = setup(env, phrase);
    assert.equal(status, 0);
    for (const uid of ["1_1", "1_3", "1_4", "1_7", "1_8"]) { const r = c(`${DT}click`, { uid, pageId: 1 }); assert.ok(silent(r), `${NAMES[uid]}: ${reasonOf(r)}`); }
    assert.ok(silent(c(`${DT}fill`, { uid: "1_5", value: "TEST JVC", pageId: 1 })), "valori di prova");
    assert.ok(silent(c(`${DT}press_key`, { key: "Enter", pageId: 1 })), "Invio");
    assert.ok(silent(c(`${DT}handle_dialog`, { action: "accept", pageId: 1 })), "conferma del dialogo");
    const del = c(`${DT}click`, { uid: "1_6", pageId: 1 });
    assert.ok(denied(del)); assert.match(reasonOf(del), /cancellazion/i);
    assert.ok(denied(c(`${DT}handle_dialog`, { action: "accept", promptText: "ELIMINA", pageId: 1 })), "dialogo di cancellazione");
    assert.ok(denied(c(`${DT}upload_file`, { uid: "1_5", filePath: "C:/x.pdf", pageId: 1 })), "upload");
    assert.ok(denied(c(`${DT}evaluate_script`, { function: "() => 1", pageId: 1 })), "script");
    assert.ok(denied(c(`${DT}click`, { uid: "9_9", pageId: 1 })), "elemento senza nome nella mappa");
    assert.match(readFileSync(auditFile(ws, "ACME"), "utf8"), /esplorazione/);
  });
}

test("una domanda di cancellazione nella pagina: niente conferme né Invio, Annulla sì", () => {
  const { ws, c } = setup("preprod", "ESPLORA PREPROD");
  patchSession(ws, (s) => { s.browser.snapshot.names = { ...NAMES, "2_1": "Vuoi eliminare la bozza?", "2_2": "Sì", "2_3": "Annulla" }; });
  assert.ok(denied(c(`${DT}click`, { uid: "2_2", pageId: 1 })));
  assert.ok(denied(c(`${DT}handle_dialog`, { action: "accept", pageId: 1 })));
  assert.ok(denied(c(`${DT}press_key`, { key: "Enter", pageId: 1 })));
  assert.ok(silent(c(`${DT}click`, { uid: "2_3", pageId: 1 })));
});

test("produzione: nessuna esplorazione, né semplice né COMPLETA", () => {
  for (const phrase of ["ESPLORA PREPROD", "ESPLORA PREPROD COMPLETA", "ESPLORA SANDBOX"]) {
    const { status, ws } = setup("prod", phrase);
    assert.equal(status, 3, phrase);
    patchSession(ws, (s) => { s.mode = "esplorazione"; });
    assert.ok(denied(browserCall("guard-config-scope", ws, `${DT}click`, { uid: "1_1", pageId: 1 })));
  }
});
