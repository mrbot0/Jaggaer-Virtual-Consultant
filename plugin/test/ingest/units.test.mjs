// WP09a-B — segmentUnits (§19.9): unità tipizzate ≤ 300 parole con intestazione di contesto, hash sha256 del
// testo normalizzato, codice U.<DOCID>.<nnnn> stabile fra versioni quando l'hash non cambia (§19.16).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateWith } from "../../scripts/lib/schemas.mjs";
import { segmentUnits, unitHash, detectUnitLang, docIdToken, MAX_PROCEDURE_STEPS } from "../../scripts/ingest/segment.mjs";
import { parseDocx } from "../../scripts/ingest/parse-docx.mjs";
import { parseXsd } from "../../scripts/ingest/parse-xsd.mjs";
import { parseEmail } from "../../scripts/ingest/parse-email.mjs";
import { parseTranscript } from "../../scripts/ingest/parse-transcript.mjs";
import { parseScreenshot } from "../../scripts/ingest/parse-screenshots.mjs";

const FIX = new URL("../fixtures/docs/", import.meta.url);
const buf = (n) => readFileSync(new URL(n, FIX));
const fpath = (n) => new URL(n, FIX).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const sec = (path, title, paragraphs = [], tables = [], level = 1) => ({ path, title, level, page: null, paragraphs, tables, figures: [] });
const doc = (sections, id = "demo") => ({ id, title: "Demo", format: "docx", sections });

test("DOCX di prova → tipi di §19.9 con contesto, lingua, hash; ogni unità valida contro unit.schema.json", () => {
  const { units } = segmentUnits(parseDocx(buf("sample.docx"), { id: "demo-docx" }), { docCode: "S.STD.XSC.DOC.0007" });
  const types = new Set(units.map((u) => u.type));
  for (const t of ["definizione", "regola", "nota", "riga-tabella-campi", "procedura", "esempio", "riferimento", "figura", "tabella"]) assert.ok(types.has(t), `manca il tipo ${t}`);
  for (const u of units) {
    const v = validateWith("unit.schema.json", u);
    assert.ok(v.ok, `${u.id}: ${v.errors.join("; ")}`);
    assert.match(u.id, /^U\.DOC0007\.\d{4}$/);
    assert.equal(u.hash, unitHash(u.text));
    assert.ok(u.words <= 300);
  }
  const first = units[0];
  assert.equal(first.context.prev, null);
  assert.equal(first.context.next, units[1].id);
  assert.equal(units.at(-1).context.next, null);
  const rif = units.find((u) => u.type === "riferimento");
  assert.deepEqual(rif.refs_out, [units.find((u) => u.context.section_path === "2.1").id], "«vedi §2.1» punta alla prima unità della sezione 2.1");
  const reg = units.find((u) => u.type === "regola" && /50\.000/.test(u.text));
  assert.equal(reg.context.chapter, "2 Approvazioni");
  assert.ok(units.some((u) => u.source_kind === "commento") && units.some((u) => u.source_kind === "revisione"), "commenti e revisioni DOCX diventano note");
  assert.ok(units.every((u) => u.lang === "it"));
});

test("hash stabile e codici conservati fra versioni: invariate stesso codice, modificate e nuove codici nuovi, sparite assenti", () => {
  const v2 = doc([sec("1", "Uno", ["Il campo A deve essere compilato.", "Testo descrittivo che resta uguale nella versione tre del documento.", "Paragrafo che sparirà nella versione successiva, con parole diverse."])]);
  const a = segmentUnits(v2, { docCode: "C.ACME.XSC.DOC.0003" }).units;
  const v3 = doc([sec("1", "Uno", ["Il campo A deve essere compilato entro la data di consegna.", "Testo   descrittivo che resta uguale nella versione tre del documento.", "Un paragrafo nuovo di zecca con informazioni aggiuntive per il lettore."])]);
  const b = segmentUnits(v3, { docCode: "C.ACME.XSC.DOC.0003", previous: a.map((u) => ({ id: u.id, hash: u.hash })) }).units;
  const same = b.find((u) => /descrittivo/.test(u.text));
  assert.equal(same.id, a.find((u) => /descrittivo/.test(u.text)).id, "spazi diversi, stesso testo normalizzato ⇒ stesso hash ⇒ stesso codice");
  const maxA = Math.max(...a.map((u) => Number(u.id.split(".").pop())));
  for (const u of b.filter((x) => x !== same)) assert.ok(Number(u.id.split(".").pop()) > maxA, `${u.id} è nuova: numero oltre quelli della v2`);
  assert.equal(unitHash("A  b\nC"), unitHash("a b c"));
  assert.equal(docIdToken("S.STD.XSC.DOC.0042"), "DOC0042");
  assert.equal(docIdToken("guida-utente-1a2b"), "GUIDAUTENTE1A2B");
});

test("procedura: ≤ 15 passi; oltre si spezza per blocchi con il passo di confine in entrambe e ogni passo diventa un'unità `passo`", () => {
  const steps = Array.from({ length: 20 }, (_, i) => `${i + 1}. Selezionare la voce numero ${i + 1}.`);
  const { units } = segmentUnits(doc([sec("1", "Configurare il catalogo", ["Per configurare:", ...steps])]));
  const procs = units.filter((u) => u.type === "procedura");
  assert.equal(procs.length, 2);
  assert.ok(procs.every((p) => p.steps.length <= MAX_PROCEDURE_STEPS));
  assert.equal(procs[0].steps.at(-1), procs[1].steps[0], "il passo di confine appartiene a entrambe");
  assert.equal(units.filter((u) => u.type === "passo").length, 20);
  const short = segmentUnits(doc([sec("1", "S", ["1. Aprire.", "2. Salvare."])])).units;
  assert.equal(short.filter((u) => u.type === "passo").length, 0, "passo solo se la procedura è spezzata");
  const bullets = segmentUnits(doc([sec("1", "S", ["- Click Save.", "- Select the supplier."])])).units;
  assert.equal(bullets[0].type, "procedura", "elenco puntato di imperativi = procedura");
});

test("tabelle: ≤ 40 righe per unità (blocchi uguali); tabella-dataset > 400 righe → campione + overflow; glossario → definizioni; righe di campi → 1 unità per riga", () => {
  const rows = (n) => Array.from({ length: n }, (_, i) => [`P${i}`, `V${i}`]);
  const t100 = segmentUnits(doc([sec("1", "T", [], [{ headers: ["Parametro", "Valore"], rows: rows(100) }])])).units;
  assert.deepEqual(t100.map((u) => u.table.rows.length), [34, 34, 32]);
  const big = segmentUnits(doc([sec("1", "T", [], [{ headers: ["Codice", "Descrizione"], rows: rows(1000) }])]));
  assert.equal(big.units.length, 1);
  assert.equal(big.units[0].table.sample, true);
  assert.equal(big.overflow[0].rows_total, 1000);
  const gl = segmentUnits(doc([sec("1", "Glossario", [], [{ headers: ["Termine", "Definizione"], rows: [["CdC", "Centro di costo"], ["RdA", "Richiesta di acquisto"]] }])])).units;
  assert.deepEqual(gl.map((u) => [u.type, u.term]), [["definizione", "CdC"], ["definizione", "RdA"]]);
  const f = segmentUnits(doc([sec("1", "Campi", [], [{ headers: ["Campo", "Tipo", "Obbligatorio"], rows: [["A", "testo", "Sì"], ["B", "data", "No"]] }])])).units;
  assert.deepEqual(f.map((u) => u.type), ["riga-tabella-campi", "riga-tabella-campi"]);
});

test("regola con la frase precedente se pronominale; ≤ 300 parole (oltre si spezza sul confine di frase); lingua it/en", () => {
  const u = segmentUnits(doc([sec("1", "S", ["Il campo Centro di costo si trova in testata. Esso deve essere compilato prima dell'invio."])])).units;
  const r = u.find((x) => x.type === "regola");
  assert.equal(r.text, "Il campo Centro di costo si trova in testata. Esso deve essere compilato prima dell'invio.");
  const long = Array.from({ length: 80 }, (_, i) => `Questa è la frase descrittiva numero ${i} del paragrafo.`).join(" ");
  const parts = segmentUnits(doc([sec("1", "S", [long])])).units;
  assert.ok(parts.length > 1 && parts.every((p) => p.words <= 300));
  assert.equal(detectUnitLang("The field must be filled before the requisition is submitted."), "en");
  assert.equal(detectUnitLang("Il campo deve essere compilato prima dell'invio della richiesta."), "it");
});

test("tracciato da XSD (1 elemento), decisione da e-mail con data e autore, tacito da trascrizione, schermata + regola di sistema da screenshot", () => {
  const x = segmentUnits(parseXsd(buf("sample.xsd"), { id: "xsd" })).units;
  assert.ok(x.every((u) => u.type === "tracciato"));
  assert.ok(x.some((u) => u.record.path === "/OrderMessage/CostCenter" && /obbligatorio/.test(u.text)));
  const e = segmentUnits(parseEmail(buf("thread.eml"), { id: "eml" })).units;
  const d = e.find((u) => u.type === "decisione");
  assert.equal(d.decision.author, "Laura Bianchi <laura@example.invalid>");
  assert.match(d.decision.date, /10 Mar 2026/);
  assert.equal(e.filter((u) => u.type === "decisione").length, 1, "la decisione non è duplicata");
  const t = segmentUnits(parseTranscript(buf("training.vtt"), { id: "vtt" })).units;
  assert.ok(t.some((u) => u.tacit === true && u.timestamp === "00:00:06.000"));
  const s = segmentUnits(parseScreenshot(buf("screen.png"), { id: "scr", path: fpath("screen.png") })).units;
  assert.ok(s.some((u) => u.type === "schermata" && u.record.elements.some((el) => el.kind === "field")));
  assert.ok(s.some((u) => u.type === "regola" && u.system_message === true));
  assert.ok(s.some((u) => u.type === "riga-tabella-campi" && /Centro di costo/.test(u.text)));
});
