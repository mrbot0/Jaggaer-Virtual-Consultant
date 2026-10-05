// Esplorazione completa — revisione di sicurezza (05/10/2026): ogni finding Critical/Important riprodotto (RED prima).
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFileSync, mkdtempSync, appendFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { runHook, runSessionCli, decisionOf, ROOT } from "../helpers/hook-env.mjs";
import { envWs, browserCall, patchSession, readSession } from "../helpers/env-fixture.mjs";
import { isDeleteLabel } from "../../hooks/lib/effect-labels.mjs";
import { sessionTtlMs } from "../../hooks/lib/invocations.mjs";
import { parseSnapshot } from "../../scripts/chrome/snapshot-parse.mjs";
import { pageRecord } from "../../hooks/lib/atlas-log.mjs";
import { buildDrafts } from "../../scripts/kb/atlas-build.mjs";

const DT = "mcp__chrome-devtools__";
const denied = (r) => decisionOf(r) === "deny";
const silent = (r) => r.status === 0 && r.stdout.trim() === "";
const URL = "https://acme-pre.jaggaer.com/p2p/po/new";

function say(ws, tr, prompt) {
  appendFileSync(tr, `${JSON.stringify({ type: "user", isSidechain: false, userType: "external", message: { role: "user", content: prompt }, timestamp: new Date().toISOString() })}\n`);
  return runHook("approval-capture", { session_id: "sess-1", cwd: ws, hook_event_name: "UserPromptSubmit", prompt, transcript_path: tr }, { JVC_WORKSPACE: ws, CLAUDE_PLUGIN_ROOT: ROOT });
}
function full(names, { phrases = ["ESPLORA PREPROD COMPLETA"] } = {}) {
  const ws = envWs({ env: "preprod", scope: "P2P" });
  const tr = join(mkdtempSync(join(tmpdir(), "xr-")), "t.jsonl"); writeFileSync(tr, "");
  for (const p of phrases) say(ws, tr, p);
  const use = runSessionCli(["use", "mode", "esplorazione", "--session", "sess-1"], { JVC_WORKSPACE: ws });
  patchSession(ws, (s) => { s.browser = { ...(s.browser ?? {}), current_url: URL, tab: "1", snapshot: { obs: "x", url: URL, tab: "1", ts: new Date().toISOString(), refs: Object.fromEntries(Object.keys(names).map((k) => [k, null])), names } }; });
  return { ws, tr, use, c: (t, i) => browserCall("guard-config-scope", ws, t, i, { transcript_path: tr }) };
}
const post = (ws, tool, ti, text) => runHook("observe-append", { session_id: "sess-1", cwd: ws, hook_event_name: "PostToolUse", tool_name: tool, tool_input: ti, tool_response: [{ type: "text", text }] }, { JVC_WORKSPACE: ws, CLAUDE_PLUGIN_ROOT: ROOT });

test("C1: cancellazioni riconosciute anche in camelCase, con trattini bassi, sinonimi e in coda a nomi lunghi", () => {
  for (const n of ["btnDelete", "ico_delete", "Cestino", "Eliminazione bozza", "Scarta bozza", "Scollega fornitore", "Offerta fornitore Alfa Beta Gamma 2026 - Elimina", "Move to trash", "Discard draft"]) assert.equal(isDeleteLabel(n), true, n);
  for (const n of ["Salva", "Invia per approvazione", "Ordini", "Nuovo ordine", "Approva", "Binario"]) assert.equal(isDeleteLabel(n), false, n);
});

test("C1: i nomi nello stato del browser non sono troncati (il guard vede '… - Elimina')", () => {
  const ws = envWs({ env: "preprod", scope: "P2P" });
  patchSession(ws, (s) => { s.browser = { current_url: URL, tab: "1", updated_by: "browser-origin" }; });
  const long = "Offerta fornitore Alfa Beta Gamma Delta Epsilon 2026 - Elimina";
  post(ws, `${DT}take_snapshot`, { pageId: 1 }, `## Latest page snapshot\nuid=1_0 RootWebArea "X" url="${URL}"\n  uid=1_1 button "${long}"\n`);
  assert.match(String(readSession(ws).browser?.snapshot?.names?.["1_1"] ?? ""), /Elimina$/);
});

test("C1: in modalità completa negati click su btnDelete, compilazione di un campo 'Elimina riga', trascinamento su 'Cestino'", () => {
  const { c } = full({ "1_1": "btnDelete", "1_2": "Elimina riga", "1_3": "Cestino", "1_4": "Riga 1" });
  assert.ok(denied(c(`${DT}click`, { uid: "1_1", pageId: 1 })));
  assert.ok(denied(c(`${DT}fill`, { uid: "1_2", value: "x", pageId: 1 })));
  assert.ok(denied(c(`${DT}drag`, { from_uid: "1_4", to_uid: "1_3", pageId: 1 })));
});

test("I1: dialogo con testo ELIMINA o finestra di conferma di una cancellazione ⇒ negato; un dialogo normale ⇒ consentito", () => {
  let { c } = full({ "1_1": "Salva" });
  assert.ok(denied(c(`${DT}handle_dialog`, { action: "accept", promptText: "ELIMINA", pageId: 1 })));
  assert.ok(silent(c(`${DT}handle_dialog`, { action: "accept", pageId: 1 })));
  ({ c } = full({ "1_1": "Eliminare l'evento?", "1_2": "Conferma" }));
  assert.ok(denied(c(`${DT}click`, { uid: "1_2", pageId: 1 })), "Conferma dentro la conferma di una cancellazione");
  assert.ok(denied(c(`${DT}handle_dialog`, { action: "accept", pageId: 1 })));
});

test("I2: in esplorazione senza limiti dell'utente il TTL delle invocazioni è lungo (12 ore), non 2", () => {
  const dir = mkdtempSync(join(tmpdir(), "ttl-"));
  writeFileSync(join(dir, "session.json"), JSON.stringify({ mode: "esplorazione" }));
  assert.equal(sessionTtlMs(dir), 12 * 60 * 60 * 1000);
  writeFileSync(join(dir, "session.json"), JSON.stringify({ mode: "ops" }));
  assert.equal(sessionTtlMs(dir), 2 * 60 * 60 * 1000);
});

test("I3: dopo COMPLETA e poi la frase semplice vale solo l'ultima: nessun recupero della completa", () => {
  const { ws, use, c } = full({ "1_3": "Salva" }, { phrases: ["ESPLORA PREPROD COMPLETA", "ESPLORA PREPROD"] });
  assert.equal(use.status, 0, use.stderr + use.stdout);
  assert.ok(denied(c(`${DT}click`, { uid: "1_3", pageId: 1 })), "modalità semplice");
  assert.notEqual(runSessionCli(["use", "mode", "esplorazione", "--session", "sess-1"], { JVC_WORKSPACE: ws }).status, 0, "la completa precedente non si recupera");
});

test("I4: nessun valore di esempio per password/chiavi o valori ad alta entropia; elenchi di persone senza valori di esempio", () => {
  const snap = `uid=1_0 RootWebArea "X" url="https://h/x"\n  uid=1_1 textbox "Password SFTP" value="Segreta123"\n  uid=1_2 textbox "Riferimento" value="sk_live_8f9a7b6c5d4e3f2a1b0c9d8e"\n  uid=1_3 textbox "Descrizione" value="Sedie"\n`;
  const r = pageRecord(parseSnapshot(snap), { pageSig: "x", profile: "standard", env: {} });
  const by = (n) => r.elements.find((e) => e.name === n);
  assert.equal(by("Password SFTP").sample, undefined);
  assert.equal(by("Riferimento").sample, undefined);
  assert.equal(by("Descrizione").sample, "Sedie");
  const d = buildDrafts([{ kind: "page", page_sig: "p#f", title: "T", url_path: "/p", elements: [{ i: 0, parent: null, role: "combobox", name: "Richiedente", sample: "Mario Rossi" }] }]);
  assert.equal(d.fields[0].samples, undefined);
});

test("I5: due effetti prima della pagina successiva ed effetto finale senza pagina: tutti nell'elenco", () => {
  const p = (sig, h) => ({ kind: "page", page_sig: sig, title: h, url_path: "/x", elements: [{ i: 0, parent: null, role: "heading", name: h, level: 1 }] });
  const d = buildDrafts([p("a#a", "Nuovo ordine"), { kind: "click", from_sig: "a#a", target: { name: "Salva" }, effect: true },
    { kind: "click", from_sig: "a#a", target: { name: "(conferma del dialogo)" }, effect: true }, p("b#b", "Ordine 1"),
    { kind: "click", from_sig: "b#b", target: { name: "Invia" }, effect: true }]);
  assert.deepEqual(d.effects.map((e) => [e.action, e.result]), [["Salva", "Ordine 1"], ["(conferma del dialogo)", "Ordine 1"], ["Invia", null]]);
});

test("I5: un click con effetto la cui risposta è un errore si registra come incerto", () => {
  const ws = envWs({ env: "preprod", scope: "P2P" });
  patchSession(ws, (s) => { s.browser = { current_url: URL, tab: "1", updated_by: "browser-origin" }; });
  post(ws, `${DT}take_snapshot`, { pageId: 1 }, `## Latest page snapshot\nuid=1_0 RootWebArea "X" url="${URL}"\n  uid=1_1 heading "X" level="1"\n  uid=1_2 button "Salva"\n`);
  post(ws, `${DT}click`, { uid: "1_2", pageId: 1 }, "Error: timeout waiting for navigation");
  const lines = readFileSync(join(ws, "customers/ACME/.sessions/sess-1/atlas/pages.jsonl"), "utf8").trim().split(/\r?\n/).map((l) => JSON.parse(l));
  const eff = lines.find((l) => l.kind === "click" && l.target?.name === "Salva");
  assert.equal(eff?.effect, true, JSON.stringify(lines));
  assert.equal(eff?.uncertain, true);
});

test("I6: stato delle osservazioni del browser illeggibile ⇒ anche in modalità completa niente click", () => {
  const { ws, c } = full({ "1_3": "Salva" });
  patchSession(ws, (s) => { s.browser.obs_pending = "illeggibile"; });
  assert.ok(denied(c(`${DT}click`, { uid: "1_3", pageId: 1 })));
});
