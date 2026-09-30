// Esplorazione in pre-produzione (richiesta dell'utente, 30/09/2026, soluzione B): con la frase dell'utente
// ESPLORA PREPROD e /use mode esplorazione, senza piano, sono consentiti SOLO click su elementi dell'ultimo snapshot della
// pagina corrente il cui nome non è un'azione con effetto (salva, invia, conferma, approva…). Mai input, invio, dialog,
// upload, script. Produzione e sandbox invariati.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFileSync, mkdtempSync, appendFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { runHook, runSessionCli, decisionOf, reasonOf, ROOT } from "../helpers/hook-env.mjs";
import { envWs, browserCall, patchSession } from "../helpers/env-fixture.mjs";
import { parseApprovalPrompt } from "../../scripts/admin/approvals.mjs";
import { auditFile } from "../../hooks/lib/audit.mjs";

const DT = "mcp__chrome-devtools__";
const denied = (r) => decisionOf(r) === "deny";
const silent = (r) => r.status === 0 && r.stdout.trim() === "";
const URL = "https://acme-pre.jaggaer.com/esop/toolkit/";
const NAMES = { "1_1": "Ordini", "1_2": "Nuovo ordine", "1_3": "Salva", "1_4": "Invia per approvazione", "1_5": "Descrizione", "1_6": "Conferma ordine", "1_7": "Submit" };

function say(ws, tr, prompt) {
  appendFileSync(tr, `${JSON.stringify({ type: "user", isSidechain: false, userType: "external", message: { role: "user", content: prompt }, timestamp: new Date().toISOString() })}\n`);
  return runHook("approval-capture", { session_id: "sess-1", cwd: ws, hook_event_name: "UserPromptSubmit", prompt, transcript_path: tr }, { JVC_WORKSPACE: ws, CLAUDE_PLUGIN_ROOT: ROOT });
}
function setup(env = "preprod") {
  const ws = envWs({ env });
  const tr = join(mkdtempSync(join(tmpdir(), "xp-")), "t.jsonl"); writeFileSync(tr, "");
  const c = (t, i) => browserCall("guard-config-scope", ws, t, i, { transcript_path: tr });
  const snap = () => patchSession(ws, (s) => {
    s.browser = { ...(s.browser ?? {}), current_url: URL, snapshot: { obs: "x", url: URL, tab: "1", ts: new Date().toISOString(), refs: Object.fromEntries(Object.keys(NAMES).map((k) => [k, null])), names: NAMES } };
  });
  return { ws, tr, c, snap };
}

test("frase: ESPLORA PREPROD riconosciuta come esplorazione per la pre-produzione, ESPLORA SANDBOX per la sandbox", () => {
  assert.deepEqual(parseApprovalPrompt("ESPLORA PREPROD"), { kind: "explore", env_type: "preprod" });
  assert.deepEqual(parseApprovalPrompt("ESPLORA SANDBOX"), { kind: "explore", env_type: "sandbox" });
  assert.equal(parseApprovalPrompt("esplora preprod per favore").kind, "attempt");
});

test("pre-produzione: senza la frase dell'utente l'esplorazione non si apre e i click restano negati", () => {
  const { ws, c, snap } = setup();
  assert.equal(runSessionCli(["use", "mode", "esplorazione", "--session", "sess-1"], { JVC_WORKSPACE: ws }).status, 3);
  snap();
  patchSession(ws, (s) => { s.mode = "esplorazione"; });
  assert.ok(denied(c(`${DT}click`, { uid: "1_1", pageId: 1 })));
});

test("pre-produzione con ESPLORA PREPROD: click di navigazione consentiti e in audit; salva/invia/conferma, input, invio, dialog, upload negati", () => {
  const { ws, tr, c, snap } = setup();
  say(ws, tr, "ESPLORA PREPROD");
  const r = runSessionCli(["use", "mode", "esplorazione", "--session", "sess-1"], { JVC_WORKSPACE: ws });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  snap();
  assert.ok(silent(c(`${DT}click`, { uid: "1_1", pageId: 1 })), "menu Ordini");
  assert.ok(silent(c(`${DT}click`, { uid: "1_2", pageId: 1 })), "apre il modulo Nuovo ordine");
  for (const uid of ["1_3", "1_4", "1_6", "1_7"]) {
    const d = c(`${DT}click`, { uid, pageId: 1 });
    assert.ok(denied(d), NAMES[uid]); assert.match(reasonOf(d), /effetto/i);
  }
  const unknown = c(`${DT}click`, { uid: "9_9", pageId: 1 });
  assert.ok(denied(unknown), "elemento non presente nell'ultimo snapshot"); assert.match(reasonOf(unknown), /snapshot/);
  for (const [t, i] of [[`${DT}fill`, { uid: "1_5", value: "x", pageId: 1 }], [`${DT}press_key`, { key: "Enter", pageId: 1 }], [`${DT}handle_dialog`, { action: "accept", pageId: 1 }],
    [`${DT}upload_file`, { uid: "1_5", filePath: "x", pageId: 1 }]]) assert.ok(denied(c(t, i)), t);
  // lo snapshot deve essere della pagina corrente
  patchSession(ws, (s) => { s.browser.current_url = "https://acme-pre.jaggaer.com/altro"; });
  assert.ok(denied(c(`${DT}click`, { uid: "1_1", pageId: 1 })));
  assert.match(readFileSync(auditFile(ws, "ACME"), "utf8"), /esplorazione/);
});

test("la frase vale solo per il suo tipo di ambiente; produzione mai; il modello non può scriverla", () => {
  const sbx = setup("sandbox");
  say(sbx.ws, sbx.tr, "ESPLORA PREPROD");
  assert.equal(runSessionCli(["use", "mode", "esplorazione", "--session", "sess-1"], { JVC_WORKSPACE: sbx.ws }).status, 3, "ESPLORA PREPROD non apre la sandbox");
  const pre = setup("preprod");
  say(pre.ws, pre.tr, "ESPLORA SANDBOX");
  assert.equal(runSessionCli(["use", "mode", "esplorazione", "--session", "sess-1"], { JVC_WORKSPACE: pre.ws }).status, 3, "ESPLORA SANDBOX non apre la pre-produzione");
  const prod = setup("prod");
  say(prod.ws, prod.tr, "ESPLORA PREPROD");
  assert.equal(runSessionCli(["use", "mode", "esplorazione", "--session", "sess-1"], { JVC_WORKSPACE: prod.ws }).status, 3);
  prod.snap(); patchSession(prod.ws, (s) => { s.mode = "esplorazione"; });
  assert.ok(denied(prod.c(`${DT}click`, { uid: "1_1", pageId: 1 })));
  const g = runHook("guard-phrase", { session_id: "sess-1", cwd: pre.ws, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "echo ESPLORA PREPROD" } }, { JVC_WORKSPACE: pre.ws, CLAUDE_PLUGIN_ROOT: ROOT });
  assert.ok(denied(g));
});
