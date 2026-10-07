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
