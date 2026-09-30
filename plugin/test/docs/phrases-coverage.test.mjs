// WP10a (ruling 5) — ogni frase dell'utente che il plugin riconosce nel codice (approval-capture: 3A, sì, esplorazione,
// approvazioni amministrative; controllo degli agenti) è documentata alla lettera in docs/MANUAL.md e nel README. Le frasi
// si ricavano dal codice (sorgenti delle espressioni regolari e sintassi esportate), non da un elenco copiato.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../helpers/hook-env.mjs";
import { parseApprovalPrompt, EXPLORE_PHRASE, phraseOf } from "../../scripts/admin/approvals.mjs";
import { CONTROL_SYNTAX, parseControlPrompt } from "../../hooks/lib/control.mjs";

const manual = readFileSync(join(ROOT, "docs/MANUAL.md"), "utf8");
const readme = readFileSync(join(ROOT, "README.md"), "utf8");
const approvalsSrc = readFileSync(join(ROOT, "scripts/admin/approvals.mjs"), "utf8");
const controlSrc = readFileSync(join(ROOT, "hooks/lib/control.mjs"), "utf8");

// Parole chiave delle frasi di approvazione nelle espressioni regolari del codice: `^APPROVO <PAROLA>`
const approvalKeywords = () => [...new Set([...approvalsSrc.matchAll(/\^APPROVO ([A-Z]+)/g)].map((m) => `APPROVO ${m[1]}`))];
// Verbi delle frasi di controllo riconosciute: RE_ATTEMPT elenca tutti gli inizi
const controlVerbs = () => /const RE_ATTEMPT = \/\^\(([^)]+)\)/.exec(controlSrc)[1].split("|");

test("le frasi del codice sono riconosciute dal codice (le forme documentate funzionano davvero)", () => {
  assert.deepEqual(approvalKeywords().sort(), ["APPROVO PASSO", "APPROVO PIANO", "APPROVO PROMOZIONE", "APPROVO PROVA", "APPROVO PURGE", "APPROVO RETENTION"]);
  for (const [text, kind] of [["APPROVO PIANO PLAN.ACME.0042", "A1"], ["APPROVO PROVA PLAN.ACME.0042 DA Anna Bianchi", "A2"], ["APPROVO PASSO 4 PLAN.ACME.0042", "A3"],
    ["APPROVO PURGE ACME DA Mario Rossi", "purge"], ["APPROVO PROMOZIONE L.ACME.CAT.FLW.0001", "promote"], ["APPROVO RETENTION ACME", "retention"], ["sì", "yes"], [EXPLORE_PHRASE, "explore"]]) {
    assert.equal(parseApprovalPrompt(text)?.kind, kind, text);
  }
  for (const text of ["PAUSA AGENTE T-0001", "PAUSA TUTTI", "RIPRENDI AGENTE T-0001", "RIPRENDI TUTTI", "FERMA AGENTE T-0001", "FERMA TUTTI", "PASSO PASSO T-0001",
    "PASSO PASSO TUTTI", "PASSO PASSO OFF", "SBLOCCA SCOPE CAT", "LIMITI DISPATCH 300 45"]) assert.ok(parseControlPrompt(text), text);
});

for (const [name, doc] of [["docs/MANUAL.md", manual], ["README.md", readme]]) {
  test(`${name}: ogni frase riconosciuta dal codice è documentata alla lettera`, () => {
    const missing = [];
    for (const k of approvalKeywords()) if (!doc.includes(k)) missing.push(k);
    for (const p of ["APPROVO PIANO <PLAN>", "APPROVO PROVA <PLAN>", "APPROVO PASSO <n> <PLAN>", "DA <Nome Cognome>", "APPROVO PURGE <ID> DA <Nome Cognome>",
      "APPROVO PROMOZIONE <codice>", "APPROVO RETENTION <C>", EXPLORE_PHRASE, "`sì`"]) if (!doc.includes(p)) missing.push(p);
    for (const p of CONTROL_SYNTAX) if (!doc.includes(p)) missing.push(p);
    for (const v of controlVerbs()) if (!doc.includes(v)) missing.push(v);
    for (const p of ["PASSO PASSO TUTTI", "PASSO PASSO OFF"]) if (!doc.includes(p)) missing.push(p);
    assert.deepEqual(missing, []);
  });
}

test("MANUAL: FERMA TUTTI vale solo per gli agenti in corso in quel momento; controllo da un terminale separato con agents watch", () => {
  assert.match(manual, /FERMA TUTTI[^\n]*solo[^\n]*(in corso|esistenti|aperti)/);
  assert.match(manual, /agents\.mjs" watch --session <SES/);
  assert.match(manual, /terminale separato/);
  assert.equal(phraseOf({ kind: "purge", target: "ACME" }), "APPROVO PURGE ACME DA <Nome Cognome>");
});
