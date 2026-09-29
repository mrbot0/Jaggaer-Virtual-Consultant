// Revisione finale (Important A#1; §31.2, §44.5, T3 §48.3): redazione all'ingestion. Le unità sono scritte (file e DB)
// solo redatte: profilo strict per il livello S (ingestion senza cliente), standard per il livello C; i codici degli
// altri clienti diventano [cliente]; strict maschera anche gli autori. Dati personali SINTETICI.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { ingestFolder } from "../../scripts/ingest/ingest.mjs";
import { openDb } from "../../scripts/kb/db.mjs";
import { makeUnitRedactor, redactUnits, ingestionProfile, knownCustomers } from "../../scripts/ingest/redact.mjs";
import { ROOT, cleanEnv } from "../helpers/hook-env.mjs";

// dati personali sintetici (nessuna persona reale): e-mail, codice fiscale, IBAN, telefono, partita IVA, importo
const PII = {
  email: "mario.rossi@example.com", cf: "RSSMRA80A01H501U", iban: "IT60X0542811101000000123456",
  tel: "+39 02 1234 5678", piva: "IT01234567890", amount: "€ 1.250,00",
};
const DOC = `Guida alla configurazione del fornitore

Per assistenza scrivere a ${PII.email} oppure chiamare il ${PII.tel}.

Il referente del cliente BETA ha il codice fiscale ${PII.cf} e l'IBAN ${PII.iban}.

La partita IVA del fornitore di prova è ${PII.piva}; la soglia di approvazione è ${PII.amount}.

Il campo Centro di costo è obbligatorio quando la richiesta supera la soglia.
`;

function workspace() {
  const ws = mkdtempSync(join(tmpdir(), "jvc-redact-"));
  for (const c of ["ACME", "BETA"]) mkdirSync(join(ws, "customers", c), { recursive: true });
  const src = mkdtempSync(join(tmpdir(), "jvc-redact-src-"));
  writeFileSync(join(src, "Guida_fornitore.txt"), DOC);
  return { ws, src };
}
const allText = (dir) => readdirSync(dir, { recursive: true }).filter((f) => /\.ya?ml$/.test(f)).map((f) => readFileSync(join(dir, f), "utf8")).join("\n");

test("ingest livello S (senza cliente): unità redatte con il profilo strict prima della scrittura — file, DB e grezzi senza dati personali", () => {
  const { ws, src } = workspace();
  // una tabella di campi: le righe grezze per la digestione (_inbox/<S>/fields) passano anch'esse redatte
  writeFileSync(join(src, "Campi_richiesta.csv"), `Campo,Tipo,Obbligatorio,Descrizione\nReferente,testo,sì,Contatto ${PII.email}\nIBAN fornitore,testo,no,Esempio ${PII.iban}\n`);
  const r = ingestFolder(src, { root: ws, scope: "P2P", today: "2026-09-29" });
  assert.equal(r.documents.errors, 0, JSON.stringify(r.errors));
  const db = openDb(join(ws, "product", "knowledge.db"));
  const texts = db.prepare("select text from units").all().map((x) => x.text).join("\n");
  db.close();
  const files = allText(join(ws, "product", "sources", "units")) + allText(join(ws, "_inbox", "P2P"));
  for (const [k, v] of Object.entries(PII)) {
    assert.ok(!texts.includes(v), `DB: ${k} non redatto`);
    assert.ok(!files.includes(v), `file: ${k} non redatto`);
  }
  assert.match(texts, /\[email\]/); assert.match(texts, /\[cf\]/); assert.match(texts, /\[iban\]/); assert.match(texts, /\[importo\]/);
  assert.match(texts, /\[cliente\]/, "i codici dei clienti del workspace nel livello S sono redatti (T3)");
  assert.ok(!/\bBETA\b/.test(texts));
  assert.match(texts, /Centro di costo è obbligatorio/, "il contenuto tecnico resta");
  const guida = r.docs.find((d) => /Guida_fornitore/.test(d.source));
  assert.equal(guida.redaction.profile, "strict");
  assert.ok(guida.redaction.units_redacted >= 3);
  assert.ok(r.docs.every((d) => d.redaction.profile === "strict"));
});

test("ingest livello C (cliente ACME): profilo standard — dati personali redatti, importi conservati, il codice di un altro cliente redatto, il proprio no", () => {
  const { ws, src } = workspace();
  writeFileSync(join(src, "Guida_fornitore.txt"), `${DOC}\nIl cliente ACME usa la stessa soglia.\n`);
  const r = ingestFolder(src, { root: ws, scope: "P2P", customer: "ACME", today: "2026-09-29" });
  assert.equal(r.documents.errors, 0, JSON.stringify(r.errors));
  const db = openDb(join(ws, "customers", "ACME", "knowledge.db"));
  const texts = db.prepare("select text from units").all().map((x) => x.text).join("\n");
  db.close();
  for (const k of ["email", "cf", "iban", "tel", "piva"]) assert.ok(!texts.includes(PII[k]), `${k} non redatto`);
  assert.ok(texts.includes("1.250,00"), "standard: l'importo resta");
  assert.ok(!/\bBETA\b/.test(texts), "un altro cliente è redatto");
  assert.match(texts, /cliente ACME usa/, "il cliente dell'ingestion resta");
  assert.equal(r.docs[0].redaction.profile, "standard");
});

test("versioni: la redazione avviene prima dell'hash, i codici delle unità invariate restano stabili", () => {
  const { ws, src } = workspace();
  const a = ingestFolder(src, { root: ws, scope: "P2P", today: "2026-09-29" });
  writeFileSync(join(src, "Guida_fornitore.txt"), `${DOC}\nUn paragrafo nuovo della versione due.\n`);
  const b = ingestFolder(src, { root: ws, scope: "P2P", today: "2026-09-30" });
  assert.equal(b.docs[0].code, `${a.docs[0].code}.v2`);
  assert.equal(b.docs[0].diff.nuove, 1);
  assert.equal(b.docs[0].diff.modificate ?? 0, 0);
});

test("redattore: autori mascherati nello strict (campo e testo); chiavi, id, hash e contesto intatti; profilo per livello", () => {
  const u = { id: "U.X.0001", doc: "S.STD.P2P.DOC.0001", type: "nota", hash: "sha256:" + "0".repeat(64), context: { section_path: "1" },
    text: `Commento di Anna Bianchi (2026-01-10): chiedere a ${PII.email}`, comment: { author: "Anna Bianchi", date: "2026-01-10" },
    row: { headers: ["Campo", "Valore"], cells: ["Referente", PII.email], columns: { Campo: "Referente", Valore: PII.email } } };
  const { unit, masks } = makeUnitRedactor({ profile: "strict", names: ["BETA"] })(u);
  assert.equal(unit.text, "Commento di [autore] (2026-01-10): chiedere a [email]");
  assert.equal(unit.comment.author, "[autore]");
  assert.deepEqual(unit.row.columns, { Campo: "Referente", Valore: "[email]" });
  assert.deepEqual([unit.id, unit.doc, unit.hash, unit.context], [u.id, u.doc, u.hash, u.context]);
  assert.deepEqual(masks.sort(), ["autore", "email"]);
  assert.equal(makeUnitRedactor({ profile: "standard" })(u).unit.comment.author, "Anna Bianchi", "standard: gli autori restano");
  assert.equal(ingestionProfile({ level: "S" }), "strict");
  assert.equal(ingestionProfile({ level: "C", customer: "ACME" }), "standard");
  assert.equal(redactUnits([u, { ...u, text: "nulla da redigere", comment: undefined, row: undefined }], { profile: "strict" }).stats.units_redacted, 1);
  const { ws } = workspace();
  assert.deepEqual(knownCustomers(ws).sort(), ["ACME", "BETA"]);
});

test("CLI redact: --text-file nel workspace, --json con le maschere; --help", () => {
  const { ws } = workspace();
  writeFileSync(join(ws, "t.txt"), `scrivere a ${PII.email}, importo ${PII.amount}`);
  const run = (args) => spawnSync(process.execPath, [join(ROOT, "scripts/ingest/redact.mjs"), ...args], { encoding: "utf8", env: cleanEnv({ JVC_WORKSPACE: ws }) });
  const r = run(["--text-file", "t.txt", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.profile, "strict");
  assert.equal(j.text, "scrivere a [email], importo [importo]");
  assert.equal(run(["--help"]).status, 0);
  assert.equal(run(["--json"]).status, 1);
});
