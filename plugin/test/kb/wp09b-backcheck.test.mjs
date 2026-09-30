// WP09b carry 4 (WP09a): nel back-check il segno di un numero negativo non si perde ("-5" non è confermato da "5") e un
// codice unito da trattini (REQ-CC-1, comune nei codici JAGGAER) resta intero: il prefisso si confronta.
import { test } from "node:test";
import assert from "node:assert/strict";
import { codeTokens, codesIn, supportOf } from "../../scripts/kb/backcheck.mjs";

test("codici: il segno meno di un numero fa parte del token; il trattino interno a un codice no (REQ-CC-1 intero)", () => {
  assert.ok(codeTokens("tolleranza -5 giorni").includes("-5"));
  assert.ok(!codeTokens("REQ-CC-1").includes("-1"));
  assert.ok(codesIn("vedi REQ-CC-1 e -5").includes("REQ-CC-1"));
  assert.ok(codesIn("vedi REQ-CC-1 e -5").includes("-5"));
  assert.ok(codesIn("errore E-51-B").includes("E-51-B"));
  assert.ok(codesIn("data 2026-09-28").includes("2026-09-28"));
  assert.deepEqual(codesIn("sì/no oppure e/o"), [], "parole unite da barre senza cifre non sono codici");
});

test("supportOf: -5 non è supportato da 5; -5 da -5 sì; REQ-CC-1 non è supportato da ABC-CC-1 né da REQ-CC-12, lo è da REQ-CC-1", () => {
  assert.equal(supportOf("La tolleranza è -5 giorni", ["La tolleranza è 5 giorni"]).verdict, "non-supportata");
  assert.deepEqual(supportOf("La tolleranza è -5 giorni", ["La tolleranza è 5 giorni"]).missing_codes, ["-5"]);
  assert.equal(supportOf("La tolleranza è -5 giorni", ["La tolleranza è -5 giorni"]).verdict, "supportata");
  assert.equal(supportOf("Il requisito REQ-CC-1 impone il centro di costo", ["Il requisito ABC-CC-1 impone il centro di costo"]).verdict, "non-supportata");
  assert.equal(supportOf("Il requisito REQ-CC-1 impone il centro di costo", ["Il requisito REQ-CC-12 impone il centro di costo"]).verdict, "non-supportata");
  assert.equal(supportOf("Il requisito REQ-CC-1 impone il centro di costo", ["Il requisito REQ-CC-1 impone il centro di costo"]).verdict, "supportata");
  // compatibilità: un numero isolato resta confermato dal codice che lo contiene (come prima), non viceversa
  assert.equal(supportOf("soglia 50000 euro importo", ["soglia 50.000 euro importo"]).verdict, "supportata");
  assert.equal(supportOf("importo 10 euro soglia", ["importo 100 euro soglia"]).verdict, "non-supportata");
});
