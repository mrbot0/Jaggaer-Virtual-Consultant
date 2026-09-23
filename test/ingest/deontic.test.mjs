// K4.3 — parser deontico it/en (§19.10) e Review Focus 5.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { parseRule, parseMandatoryText, MODALITIES } from "../../scripts/ingest/deontic.mjs";

const GOLDEN = YAML.parse(readFileSync(new URL("../golden/deontic/cases.yaml", import.meta.url), "utf8")).cases;
const CLI = fileURLToPath(new URL("../../scripts/ingest/deontic.mjs", import.meta.url));
const ROWS = ["obbligo", "obbligo-condizionale", "qualificatore-ambito", "divieto", "facolta", "raccomandazione", "comportamento-sistema",
  "non-bloccante", "immutabilita", "vincolo-esterno", "eccezione", "ambiguo"];
const OPTIONAL_KEYS = ["validation", "reason", "exception", "condition"];

function mismatch(c, r) {
  const diffs = [];
  const eq = (a, b) => { try { assert.deepEqual(a, b); return true; } catch { return false; } };
  if (r.modality !== c.expect.modality) diffs.push(`modality ${r.modality} ≠ ${c.expect.modality}`);
  if (!eq(r.mandatory ?? null, c.expect.mandatory ?? null)) diffs.push(`mandatory ${JSON.stringify(r.mandatory ?? null)} ≠ ${JSON.stringify(c.expect.mandatory ?? null)}`);
  if ((r.residue ?? null) !== (c.expect.residue ?? null)) diffs.push(`residue ${r.residue ?? null} ≠ ${c.expect.residue ?? null}`);
  for (const k of OPTIONAL_KEYS) if (k in c.expect && !eq(r[k] ?? null, c.expect[k] ?? null)) diffs.push(`${k} ${JSON.stringify(r[k] ?? null)} ≠ ${JSON.stringify(c.expect[k])}`);
  return diffs;
}

test("golden deontico: ≥ 200 frasi (≥ 100 it, ≥ 100 en, bilanciate), ogni riga di §19.10 ≥ 8 volte", () => {
  // 200 del brief + 20 del giro di correzione 1 (revisione WP05, Important #1) + 8 del giro 2 (regressione del lessico)
  assert.equal(GOLDEN.length, 228);
  assert.equal(GOLDEN.filter((c) => c.lang === "it").length, 114);
  assert.equal(GOLDEN.filter((c) => c.lang === "en").length, 114);
  assert.equal(new Set(GOLDEN.map((c) => c.id)).size, GOLDEN.length);
  for (const t of ["Consigliamo di rendere il campo obbligatorio.", "Obbligatorio (consigliato).", "Il campo è obbligatorio se non diversamente configurato.",
    "Il campo è obbligatorio, anche se si consiglia di lasciarlo vuoto salvo casi urgenti.", "It is advised that the cost center be mandatory.",
    "L'invio del documento deve avvenire tramite raccomandata.", "Il Consiglio di amministrazione ha reso obbligatorio il campo."]) {
    assert.ok(GOLDEN.some((c) => c.text === t), `frase della revisione assente: ${t}`);
  }
  for (const row of ROWS) assert.ok(GOLDEN.filter((c) => c.row === row).length >= 8, `riga ${row} < 8`);
  assert.ok(GOLDEN.some((c) => /dovrebbe essere obbligatorio salvo/.test(c.text)), "frase di Review Focus 5 presente");
});

test("golden deontico: 100% (228/228)", () => {
  const failures = [];
  for (const c of GOLDEN) {
    const r = parseRule(c.text, { lang: c.lang });
    const d = mismatch(c, r);
    if (d.length) failures.push(`${c.id} «${c.text}»: ${d.join("; ")}`);
  }
  console.log(`deontic golden: ${GOLDEN.length - failures.length}/${GOLDEN.length}`);
  assert.deepEqual(failures, []);
});

test("Review Focus 5: «dovrebbe essere obbligatorio salvo…» → ambiguo, nessun mandatory.kind, residuo ambiguous", () => {
  for (const text of ["Il campo dovrebbe essere obbligatorio salvo…", "Il campo dovrebbe essere obbligatorio salvo diversa indicazione del cliente.",
    "dovrebbe essere obbligatorio salvo che il fornitore sia estero", "The field should be mandatory unless the supplier is foreign."]) {
    const r = parseRule(text);
    assert.equal(r.modality, "ambiguo", text);
    assert.equal(r.mandatory, undefined, text);
    assert.equal(r.residue, "ambiguous", text);
    assert.ok(r.confidence < 0.5);
  }
});

test("una raccomandazione non produce mai un mandatory.kind, anche con parole di obbligo", () => {
  for (const text of ["Si consiglia che il campo sia obbligatorio.", "Di norma è obbligatorio indicare la commessa.", "The field should be required.",
    "It is recommended that the field is mandatory for company IT01."]) {
    const r = parseRule(text);
    assert.equal(r.modality, "raccomandazione", text);
    assert.equal(r.mandatory, undefined, text);
    assert.equal(r.consequence, "FLD.notes");
  }
});

test("il risultato porta modalità, qualificatori, condizione, conseguenza, confidenza e lingua rilevata", () => {
  const r = parseRule("Per la società IT01, se l'importo supera 1000 EUR, il campo è obbligatorio per il ruolo BUYER.");
  assert.ok(MODALITIES.includes(r.modality));
  assert.equal(r.lang, "it");
  assert.deepEqual(r.scope_qualifiers.companies, ["IT01"]);
  assert.deepEqual(r.scope_qualifiers.roles, ["BUYER"]);
  assert.equal(r.consequence, "FLD.mandatory");
  assert.ok(r.confidence > 0 && r.confidence <= 1);
  assert.equal(parseRule("The VAT code is required.").lang, "en");
  assert.equal(parseRule("").modality, "ambiguo");
  assert.equal(parseRule("Il campo contiene il codice della commessa.").residue, "ambiguous");   // nessun segnale: modalità non determinata
});

test("CLI: --text e --json; testo mancante → exit 1", () => {
  const ok = spawnSync(process.execPath, [CLI, "--text", "Il campo è obbligatorio nello stato APPROVED.", "--json"], { encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr);
  const out = JSON.parse(ok.stdout);
  assert.equal(out.ok, true);
  assert.deepEqual(out.result.mandatory, { kind: "conditional", in_states: ["APPROVED"] });
  const bad = spawnSync(process.execPath, [CLI, "--json"], { encoding: "utf8" });
  assert.equal(bad.status, 1);
  const help = spawnSync(process.execPath, [CLI, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0);
});

test("parseMandatoryText: le celle di tabella Sì/No/X sono regole; il resto passa dal parser deontico", () => {
  for (const t of ["Sì", "si", "SI", "X", "Yes", "Y", "true", "✓"]) assert.deepEqual(parseMandatoryText(t).mandatory, { kind: "always" }, t);
  for (const t of ["No", "N", "-", "false", "—"]) assert.deepEqual(parseMandatoryText(t).mandatory, { kind: "never" }, t);
  assert.equal(parseMandatoryText("").modality, "ambiguo");
  assert.equal(parseMandatoryText("").mandatory, undefined);
  assert.deepEqual(parseMandatoryText("Obbligatorio se importo > 1000").mandatory, { kind: "conditional", when: "importo > 1000" });
  assert.equal(parseMandatoryText("Dovrebbe essere obbligatorio salvo…").residue, "ambiguous");
});

test("stati in linguaggio naturale: «in approvazione», «in bozza», «during approval» → in_states", () => {
  assert.deepEqual(parseRule("Obbligatorio in approvazione").mandatory, { kind: "conditional", in_states: ["PENDING_APPROVAL"] });
  assert.deepEqual(parseRule("Il campo è obbligatorio in bozza e in approvazione.").mandatory, { kind: "conditional", in_states: ["DRAFT", "PENDING_APPROVAL"] });
  assert.deepEqual(parseRule("Mandatory during approval.").mandatory, { kind: "conditional", in_states: ["PENDING_APPROVAL"] });
  assert.deepEqual(parseRule("Required on submission.").mandatory, { kind: "conditional", in_states: ["SUBMITTED"] });
});

test("eccezione indeterminata («salvo eccezioni», «unless otherwise specified») → ambiguo, nessun mandatory", () => {
  for (const t of ["Obbligatorio salvo eccezioni", "Il campo è obbligatorio, salvo diversa indicazione.", "Mandatory unless otherwise specified.",
    "The field is required except in special cases."]) {
    const r = parseRule(t);
    assert.equal(r.modality, "ambiguo", t);
    assert.equal(r.mandatory, undefined, t);
    assert.equal(r.residue, "ambiguous", t);
  }
});

test("giro 2: le raccomandazioni in ogni forma verbale o aggettivale restano raccomandazioni (sonde della rilettura)", () => {
  for (const t of ["We recommend that the field be mandatory.", "It is suggested that the field be mandatory.", "Ideally, the field should be mandatory.",
    "CONSIGLIAMO di rendere obbligatorio il campo.", "Il campo È OBBLIGATORIO (CONSIGLIATO).", "Obbligatorio (raccomandato).", "Obbligatorio (raccomandata).",
    "I would recommend making this field mandatory.", "They recommended that the field become mandatory.", "Si raccomandava di rendere obbligatorio il campo.",
    "Sarebbe consigliabile rendere obbligatorio questo campo.", "It would be advisable to make the field mandatory.", "La compilazione è raccomandata.",
    "La compilazione del campo è fortemente raccomandata.", "Suggerisco di rendere il campo obbligatorio.", "Consiglierei di rendere obbligatorio il campo."]) {
    const r = parseRule(t);
    assert.equal(r.modality, "raccomandazione", t);
    assert.equal(r.mandatory, undefined, t);
  }
});

test("giro 2: i nomi non sono raccomandazioni — raccomandata (posta), Consiglio (organo), advisory, recommendation, suggestions", () => {
  for (const t of ["Il documento va inserito e spedito per raccomandata; il campo Data invio è obbligatorio.", "Il campo Protocollo del Consiglio è obbligatorio.",
    "The advisory note field is required.", "Recommendations must be attached to the report."]) {
    const r = parseRule(t);
    assert.equal(r.modality, "obbligo", t);
    assert.deepEqual(r.mandatory, { kind: "always" }, t);
  }
});
