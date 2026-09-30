import { test } from "node:test";
import assert from "node:assert/strict";
import YAML from "yaml";
import {
  applyObservation, newBeliefState, isBlocked, classifySurprise, classifyUncertainty, validateHypotheses, nextTest,
} from "../../scripts/kb/belief-update.mjs";
import { validateWith } from "../../scripts/lib/schemas.mjs";

const ITEM = "C.ACME.ADM.CFG.0019";
const base = () => newBeliefState({ [ITEM]: { confidence: 0.81 } });

test("§13.8 osservazione coerente: confirmed_count + 1; a 3 → confidenza 1.00 (§13.4)", () => {
  let s = base();
  for (let i = 1; i <= 2; i++) {
    s = applyObservation(s, { item: ITEM, coherent: true, kind: "obs", with: `L.ACME.ADM.OBS.000${i}` }).state;
    assert.equal(s.items[ITEM].confirmed_count, i);
    assert.equal(s.items[ITEM].confidence, 0.81);
  }
  const r = applyObservation(s, { item: ITEM, coherent: true, kind: "obs", with: "L.ACME.ADM.OBS.0003" });
  assert.equal(r.state.items[ITEM].confirmed_count, 3);
  assert.equal(r.state.items[ITEM].confidence, 1);
  assert.equal(r.state.items[ITEM].session_confidence, 1);
  assert.ok(r.effects.some((e) => /1\.00/.test(e)));
});

test("§13.8 1 osservazione contraria blocca, non riscrive; 3 sostituiscono", () => {
  const s0 = base();
  const r1 = applyObservation(s0, { item: ITEM, coherent: false, kind: "obs", with: "L.ACME.ADM.OBS.0231" });
  const i1 = r1.state.items[ITEM];
  assert.equal(r1.state.contradictions.length, 1);
  assert.equal(r1.state.contradictions[0].status, "aperto");
  assert.equal(i1.session_confidence, 0.4);
  assert.equal(i1.confidence, 0.81, "la confidenza persistente non cambia");
  assert.equal(i1.superseded_by, null, "una sola osservazione non riscrive");
  assert.equal(isBlocked(r1.state, ITEM, "R2"), true, "blocca R ≥ R2");
  assert.equal(isBlocked(r1.state, ITEM, "R1"), false);
  assert.deepEqual(s0.items[ITEM].session_confidence, null, "funzione pura: lo stato di partenza non cambia");

  const r2 = applyObservation(r1.state, { item: ITEM, coherent: false, kind: "obs", with: "L.ACME.ADM.OBS.0240" });
  const i2 = r2.state.items[ITEM];
  assert.equal(i2.reindex, true);
  assert.equal(i2.persistent_factor, 0.7);
  assert.equal(i2.confidence, 0.81, "×0.7 applicato al reindex, non in sessione");
  assert.equal(i2.superseded_by, null);
  assert.equal(r2.state.contradictions.length, 1, "lo stesso CTR resta aperto");

  const r3 = applyObservation(r2.state, { item: ITEM, coherent: false, kind: "obs", with: "L.ACME.ADM.OBS.0251" });
  const i3 = r3.state.items[ITEM];
  assert.equal(i3.superseded_by, "L.ACME.ADM.OBS.0251");
  assert.equal(i3.reference, false);
  assert.equal(r3.state.items["L.ACME.ADM.OBS.0251"].reference, true);
  assert.equal(r3.state.contradictions[0].status, "risolto");
  assert.equal(isBlocked(r3.state, ITEM, "R3"), false, "risolto il CTR, il blocco cade: vale il nuovo riferimento");
});

test("§13.8 dichiarazione utente contraria: CTR, vince chi ha l'osservazione (§11.5); nessuna riscrittura", () => {
  let s = applyObservation(base(), { item: ITEM, coherent: true, kind: "obs", with: "L.ACME.ADM.OBS.0231" }).state;
  const r = applyObservation(s, { item: ITEM, coherent: false, kind: "user", with: "L.ACME.ADM.CFG.0044" });
  assert.equal(r.state.contradictions[0].winner, "osservazione");
  assert.equal(r.state.items[ITEM].superseded_by, null);
  assert.equal(r.state.items[ITEM].confidence, 0.81);
  assert.equal(isBlocked(r.state, ITEM, "R2"), true, "mai agire sul soggetto finché il CTR è aperto");
  // senza osservazione sul soggetto: nessun vincitore, decide DT-011
  const r0 = applyObservation(base(), { item: ITEM, coherent: false, kind: "user", with: "L.ACME.ADM.CFG.0044" });
  assert.equal(r0.state.contradictions[0].winner, null);
  assert.ok(r0.effects.some((e) => /DT-011/.test(e)));
});

test("§13.8 esecuzione con esito contrario: una basta per CTR e blocco R ≥ R2; due coerenti per sostituire", () => {
  const r1 = applyObservation(base(), { item: ITEM, coherent: false, kind: "exec", with: "RUN.ACME.20260922.1130.ADM" });
  assert.equal(r1.state.contradictions.length, 1);
  assert.equal(isBlocked(r1.state, ITEM, "R2"), true);
  assert.equal(r1.state.items[ITEM].superseded_by, null);
  const r2 = applyObservation(r1.state, { item: ITEM, coherent: false, kind: "exec", with: "RUN.ACME.20260923.0900.ADM" });
  assert.equal(r2.state.items[ITEM].superseded_by, "RUN.ACME.20260923.0900.ADM");
  assert.throws(() => applyObservation(base(), { item: ITEM, coherent: false, kind: "sogno" }), /kind/);
});

test("§13.2 DT-016 per tipo di divergenza e rischio: compatibile → procedi dichiarando; incompatibile → ferma", () => {
  const expectAt = {
    "elemento-in-piu": ["compatibile", "incompatibile"], "tempo-fuori-norma": ["compatibile", "incompatibile"],
    "attributo-diverso": ["compatibile", "incompatibile"], "messaggio-inatteso": ["compatibile", "incompatibile"],
    "stato-diverso": ["incompatibile", "incompatibile"], "elemento-assente": ["incompatibile", "incompatibile"],
  };
  for (const [kind, [r1, r2]] of Object.entries(expectAt)) {
    assert.equal(classifySurprise(kind, "R1").outcome, r1, `${kind} R1`);
    assert.equal(classifySurprise(kind, "R2").outcome, r2, `${kind} R2`);
  }
  const ok = classifySurprise("elemento in più", "R0");
  assert.equal(ok.outcome, "compatibile");
  assert.equal(ok.action, "procedi-dichiarando-l-assunzione");
  assert.equal(classifySurprise("Elemento assente", "R0").action, "ferma-il-passo");
  assert.throws(() => classifySurprise("colore diverso", "R1"));
});

test("§13.7 DT-024: una divergenza coerente → epistemica; divergenze che cambiano → aleatoria; miste → STR-BISECT", () => {
  const epi = classifyUncertainty([
    { step: 4, expected: "SENT", value: "TRANSMITTING", err_category: "integration" },
    { step: 4, expected: "SENT", value: "TRANSMITTING", err_category: "integration" },
    { step: 4, expected: "SENT", value: "TRANSMITTING", err_category: "integration" },
  ]);
  assert.equal(epi.kind, "epistemica");
  assert.match(epi.response, /osservare/);
  const alea = classifyUncertainty([
    { step: 7, expected: "ok", value: "timeout", err_category: "timeout", timing_out: true },
    { step: 7, expected: "ok", value: "ok", timing_out: false },
    { step: 7, expected: "ok", value: "errore 503", err_category: "timeout", timing_out: true },
  ]);
  assert.equal(alea.kind, "aleatoria");
  assert.match(alea.response, /backoff/);
  const mixed = classifyUncertainty([
    { step: 3, expected: "ok", value: "timeout", err_category: "timeout", timing_out: true },
    { step: 3, expected: "ok", value: "ok", timing_out: false },
    { step: 5, expected: "2 righe", value: "3 righe" },
    { step: 5, expected: "2 righe", value: "3 righe" },
  ]);
  assert.equal(mixed.kind, "mista");
  assert.deepEqual(mixed.combined, ["STR-BISECT"]);
  assert.equal(classifyUncertainty([{ step: 1, expected: "a", value: "a" }]).kind, null);
});

const REGISTRY = YAML.parse(`
hypotheses:
  - id: H1
    claim: "Lo stato passa a SENT all'accettazione del middleware, non all'esito"
    prior: 0.45
    evidence_for: [L.ACME.P2P.OBS.0240]
    evidence_against: []
    discriminating_test: "ordine che il middleware rifiuta all'accettazione: se resta TRANSMITTING H1 regge"
    cost_of_test: { risk: R1, steps: 6, tier: T1 }
    status: open
  - id: H2
    claim: "Il messaggio è stato rielaborato"
    prior: 0.30
    evidence_for: []
    evidence_against: ["nessun secondo messaggio con la stessa correlazione (OBS.0241)"]
    discriminating_test: "conteggio messaggi per correlation_id"
    cost_of_test: { risk: R0, steps: 2, tier: T0 }
    status: refuted
  - id: H3
    claim: "Lo stato SENT è impostato da un job schedulato"
    prior: 0.25
    evidence_for: []
    evidence_against: []
    discriminating_test: "timestamp del cambio stato vs timestamp di accettazione"
    cost_of_test: { risk: R0, steps: 3, tier: T0 }
    status: open
`);

test("§13.6 registro delle ipotesi: schema, due aperte prima del test, chiuse con evidenza, prior dichiarato; nextTest = H3", () => {
  assert.ok(validateWith("hypotheses.schema.json", REGISTRY).ok);
  const v = validateHypotheses(REGISTRY, { beforeTest: true });
  assert.deepEqual(v.errors, []);
  assert.equal(v.ok, true);
  const t = nextTest(REGISTRY);
  assert.equal(t.id, "H3");
  assert.deepEqual(t.cost, { risk: "R0", steps: 3, tier: "T0" });

  const one = structuredClone(REGISTRY);
  one.hypotheses[2].status = "refuted";
  one.hypotheses[2].evidence_against = ["L.ACME.P2P.OBS.0402"];
  const v1 = validateHypotheses(one, { beforeTest: true });
  assert.equal(v1.ok, false);
  assert.ok(v1.errors.some((e) => /due ipotesi aperte/.test(e)));
  assert.equal(nextTest(one), null, "una sola ipotesi non si testa: si conferma");

  const tired = structuredClone(REGISTRY);
  tired.hypotheses[0].status = "supported";                   // chiusa senza evidenza "per stanchezza"… ha evidence_for
  tired.hypotheses[2].status = "refuted";                      // … questa no
  const v2 = validateHypotheses(tired);
  assert.ok(v2.errors.some((e) => /H3/.test(e) && /evidenza/.test(e)));

  const noPrior = structuredClone(REGISTRY);
  delete noPrior.hypotheses[0].prior;
  assert.equal(validateHypotheses(noPrior).ok, false);
  // evidenza senza un codice citato → invalida per lo schema
  const prose = structuredClone(REGISTRY);
  prose.hypotheses[0].evidence_for = ["l'ho visto io"];
  assert.equal(validateWith("hypotheses.schema.json", prose).ok, false);
  // §17.3 conferma: ipotesi vincente senza evidence_against e prior > 0.6 → avviso STR-DISCONFIRM
  const conf = structuredClone(REGISTRY);
  Object.assign(conf.hypotheses[0], { status: "supported", prior: 0.7 });
  assert.ok(validateHypotheses(conf).warnings.some((w) => /STR-DISCONFIRM/.test(w)));
});
