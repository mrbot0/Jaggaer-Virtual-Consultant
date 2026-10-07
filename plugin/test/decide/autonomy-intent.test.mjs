// Ops veloce, Task 8 (spec 2026-10-06 §3.5, §3.6): l'esito dell'intento dipende dal livello di autonomia e dall'ambiente.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseIntent } from "../../scripts/decide/intent.mjs";

test("intento: preprod alto crea ⇒ avvia; con invio ⇒ mostra-piano; basso ⇒ mostra-piano; prod crea ⇒ mostra-piano; prod cancella ⇒ rifiuta; preprod cancella ⇒ mostra-piano", () => {
  const o = (text, autonomy = "alto") => parseIntent(text, { customers: ["ACME"], autonomy }).outcome;
  assert.equal(o("su ACME pre-produzione crea un ordine di 3 sedie"), "avvia");
  assert.equal(o("su ACME pre-produzione crea e invia un ordine di 3 sedie"), "mostra-piano");
  assert.equal(o("su ACME pre-produzione crea un ordine di 3 sedie", "basso"), "mostra-piano");
  assert.equal(o("su ACME produzione crea un ordine di 3 sedie"), "mostra-piano");
  assert.equal(o("su ACME produzione cancella la RdA 10045"), "rifiuta");
  assert.equal(o("su ACME pre-produzione cancella la RdA 10045"), "mostra-piano");
});

test("intento: i motivi dicono il livello e l'ambiente; la cancellazione in prod spiega il rifiuto", () => {
  const p = (text, autonomy) => parseIntent(text, { customers: ["ACME"], autonomy });
  assert.match(p("su ACME produzione crea un ordine di 3 sedie", "medio").reason, /Piano da approvare in prod \(autonomia medio\)/);
  assert.match(p("su ACME pre-produzione crea un ordine di 3 sedie", "alto").reason, /Parte subito con autonomia alto in preprod/);
  assert.match(p("su ACME produzione cancella la RdA 10045", "alto").reason, /in produzione non si cancella mai/i);
  assert.equal(p("su ACME produzione mostra lo stato dell'ordine 4500012345", "basso").outcome, "avvia");
  assert.equal(p("su ACME produzione attiva la notifica di sollecito approvazioni", "alto").outcome, "mostra-piano");
});

test("intento: senza opzione autonomy vale alto (nessuna sessione)", () => {
  assert.equal(parseIntent("su ACME pre-produzione crea un ordine di 3 sedie", { customers: ["ACME"] }).outcome, "avvia");
});

// Revisione finale (I3): run() passa a autonomyLevel i RECORD del registro (non l'oggetto di readApprovals): la frase
// AUTONOMIA BASSA della sessione vale anche per l'intento.
import { join as joinPath } from "node:path";
import { writeFileSync as wf, mkdtempSync as mkd, appendFileSync as af } from "node:fs";
import { tmpdir as tmp } from "node:os";
import { spawnSync as sp } from "node:child_process";
import { envWs } from "../helpers/env-fixture.mjs";
import { runHook, ROOT, cleanEnv } from "../helpers/hook-env.mjs";

const sayIt = (ws, tr, prompt) => { af(tr, `${JSON.stringify({ type: "user", isSidechain: false, userType: "external", message: { role: "user", content: prompt }, timestamp: new Date().toISOString() })}\n`); return runHook("approval-capture", { session_id: "sess-1", cwd: ws, hook_event_name: "UserPromptSubmit", prompt, transcript_path: tr }, { JVC_WORKSPACE: ws, CLAUDE_PLUGIN_ROOT: ROOT }); };
const cli = (ws, text) => JSON.parse(sp(process.execPath, [joinPath(ROOT, "scripts/decide/intent.mjs"), "--text", text, "--workspace", ws, "--session", "sess-1", "--json"], { encoding: "utf8", env: cleanEnv({ JVC_WORKSPACE: ws }) }).stdout);

test("intento run(): AUTONOMIA BASSA nella sessione ⇒ crea in pre-produzione è mostra-piano (senza frase: avvia)", () => {
  const ws = envWs({ env: "preprod", scope: "P2P", autonomy: null });
  const tr = joinPath(mkd(joinPath(tmp(), "ai-")), "t.jsonl"); wf(tr, "");
  assert.equal(cli(ws, "su ACME pre-produzione crea un ordine di 3 sedie").outcome, "avvia");
  sayIt(ws, tr, "AUTONOMIA BASSA");
  const r = cli(ws, "su ACME pre-produzione crea un ordine di 3 sedie");
  assert.equal(r.outcome, "mostra-piano", JSON.stringify(r));
  assert.match(r.reason, /autonomia basso/);
});

test("intento: import massivo in pre-produzione ad alto non chiede approvazioni (come step-check: ACT-BULK ad alto nessuna)", () => {
  const p = (text, autonomy) => parseIntent(text, { customers: ["ACME"], autonomy });
  const a = p("su ACME pre-produzione importa 50 fornitori con il template", "alto");
  assert.deepEqual(a.actions, ["ACT-BULK"]);
  assert.equal(a.outcome, "avvia", a.reason);
  assert.equal(p("su ACME pre-produzione carica in massa 50 fornitori", "alto").outcome, "avvia");
  assert.equal(p("su ACME pre-produzione importa 50 fornitori con il template", "medio").outcome, "mostra-piano");
  assert.equal(p("su ACME sandbox importa 50 fornitori con il template", "medio").outcome, "mostra-piano");
  assert.equal(p("su ACME produzione importa 50 fornitori con il template", "medio").outcome, "mostra-piano");
  // un allegato singolo resta ACT-UPLOAD (R2): in pre-produzione chiede l'approvazione del piano
  assert.equal(p("su ACME pre-produzione allega il preventivo alla RdA 10045", "alto").outcome, "mostra-piano");
});
