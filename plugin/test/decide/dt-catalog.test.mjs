import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { evaluate, loadTable, validateTable, TABLES_DIR } from "../../scripts/decide/dt-eval.mjs";
import { ingestionGain, backlogPriorities } from "../../scripts/decide/ingestion-gain.mjs";

const REGISTRY = JSON.parse(readFileSync(new URL("../../schemas/registry.json", import.meta.url), "utf8"));
const approx = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);
const STR = ["STR-REPLAY", "STR-VERIFY-FIRST", "STR-GENERALIZE-CAUTIOUSLY", "STR-TRIANGULATE", "STR-DRY-RUN",
  "STR-EXPLORE-BUDGET", "STR-ASK-EARLY", "STR-STOP-RECORD", "STR-BISECT"];

// Esiti del catalogo §15.2 (DT-026: §29.5 e §61, fuori dal catalogo §15.2).
const EXPECTED = {
  "DT-001": ["test-defect", "config-drift", "product-defect", "baseline-change", "environment", "expected-change", "regression"],
  "DT-002": ["procedi", "procedi-con-assunzione", "chiedi", "fermati"],
  "DT-003": ["T0", "T1", "T2"],
  "DT-004": ["validated", "merged", "rejected"],
  "DT-005": ["ammesso", "rigettato", "quarantena"],
  "DT-006": ["universale", "condizionata", "specifica", "ignota"],
  "DT-007": ["R0", "R1", "R2", "R3"],
  "DT-008": ["testid", "role", "label", "css"],
  "DT-009": ["lista"],
  "DT-010": ["candidato", "no"],
  "DT-011": ["vince-L", "vince-C", "vince-S", "irrisolta"],
  "DT-012": ["punteggio"],
  "DT-013": ["queued_accepted", "processed", "acknowledged"],
  "DT-014": ["continua", "ferma"],
  "DT-015": ["sì", "no"],
  "DT-016": ["compatibile", "incompatibile"],
  "DT-017": ["nessuna", ...STR],
  "DT-018": ["replay", "orienta", "ignora"],
  "DT-019": ["tecnica", "d'uso", "osservazione", "utente"],
  "DT-020": [...Object.keys(REGISTRY.types), "ambiguo"],
  "DT-021": ["S", "C", "ambiguo"],
  "DT-022": ["digerito", "quarantena"],
  "DT-023": ["rapida", "standard", "profonda"],
  "DT-024": ["epistemica", "aleatoria", "mista"],
  "DT-025": ["punteggio"],
  "DT-026": ["avvia", "mostra-piano", "rifiuta", "chiedi"],
};
const SPEC_CALIBRATED = new Set(["DT-002", "DT-003", "DT-017", "DT-018", "DT-021", "DT-023", "DT-025"]);
const MIXED = new Set(["DT-007"]);  // rischio base per area dalla spec, correttivi progettati

test("ogni file di decision-tables/ valida; DT-001 … DT-026 tutte presenti", () => {
  const files = readdirSync(TABLES_DIR).filter((f) => /^DT-\d{3}\.yaml$/.test(f)).sort();
  assert.deepEqual(files.map((f) => f.slice(0, 6)), Object.keys(EXPECTED));
  for (const f of files) {
    const t = YAML.parse(readFileSync(join(TABLES_DIR, f), "utf8"));
    const v = validateTable(t);
    assert.ok(v.ok, `${f}: ${v.errors.join("; ")}`);
    assert.equal(t.id, f.slice(0, 6));
  }
});

test("gli esiti di ogni tabella sono esattamente quelli del catalogo (§15.2)", () => {
  for (const [id, outcomes] of Object.entries(EXPECTED)) {
    assert.deepEqual([...loadTable(id).outcomes].sort(), [...outcomes].sort(), id);
  }
});

test("calibrazione: spec dove la spec dà pesi/soglie, bootstrap altrove", () => {
  for (const id of Object.keys(EXPECTED)) {
    const t = loadTable(id);
    assert.equal(t.calibration, SPEC_CALIBRATED.has(id) ? "spec" : MIXED.has(id) ? "mixed" : "bootstrap", id);
    if (t.calibration === "mixed") assert.ok(t.calibration_note, `${id}: mixed richiede calibration_note`);
  }
});

test("DT-001 §18.2: product-defect con precedente fixed → regression (§30.1), confidenza .88 (.79 senza precedente)", () => {
  const base = { candidate_category: "product-defect", evidence_consistency: "univoca", delta_crosscheck: "assente", err_catalog: "non-noto" };
  const r = evaluate(loadTable("DT-001"), { ...base, precedent: "confermato-stessa-categoria", precedent_fixed_defect: true }, { priors: { category_disproved: 0 } });
  assert.equal(r.outcome, "regression");
  approx(r.score, 0.88);
  const without = evaluate(loadTable("DT-001"), { ...base, precedent: "nessuno", precedent_fixed_defect: false }, { priors: { category_disproved: 0 } });
  assert.equal(without.outcome, "product-defect");
  approx(without.score, 0.79);
});

test("DT-003 §25.2: pesi e soglie della spec", () => {
  const t = loadTable("DT-003");
  assert.deepEqual(t.inputs.map((i) => i.weight), [0.25, 0.20, 0.25, 0.15, 0.05]);
  assert.equal(t.priors[0].weight, 0.10);
  const consolidato = evaluate(t, { risk: "R0", task_novelty: "ok-3+", shape: "consolidato", synthesis: "codice-lista", volume: "<5k" });
  assert.equal(consolidato.outcome, "T0");
  const libresco = evaluate(t, { risk: "R2", task_novelty: "ok-1-2", shape: "libresco", synthesis: "artefatto", volume: "5-30k" });
  approx(libresco.score, 0.175 + 0.1 + 0.15 + 0.075 + 0.025);   // .525
  assert.equal(libresco.outcome, "T1");
  const deep = evaluate(t, { risk: "R3", task_novelty: "mai", shape: "ignoto", synthesis: "giudizio-progetto", volume: ">30k" });
  assert.equal(deep.outcome, "T2");
});

test("DT-007 §28.5: rischio base per area CL-CFG, correttivi, R2 su libresco → R3; perimetro", () => {
  const t = loadTable("DT-007");
  const ok = { rollback_exists: true, graph_radius_gt5: false, in_window: true, mature: true, shape: "consolidato" };
  const r2 = evaluate(t, { area: "010", ...ok }, { priors: { disproved_area_customer: 0 } });
  assert.equal(r2.outcome, "R2");
  assert.equal(r2.annotation, "giallo");
  assert.equal(evaluate(t, { area: "010", ...ok, shape: "libresco" }).outcome, "R3");
  const r1 = evaluate(t, { area: "008", ...ok });
  assert.equal(r1.outcome, "R1");
  assert.equal(r1.annotation, "verde");
  const r3 = evaluate(t, { area: "015", ...ok });
  assert.equal(r3.outcome, "R3");
  assert.equal(r3.annotation, "rosso");
  // R1 senza rollback, raggio > 5 nodi, fuori finestra: i correttivi alzano il rischio
  assert.equal(evaluate(t, { area: "006", rollback_exists: false, graph_radius_gt5: true, in_window: false, mature: false, shape: "empirico" }).outcome, "R2");
  for (const [area, cls] of Object.entries({ "001": "R3", "002": "R2/R3", "005": "R2", "006": "R1", "020": "R2/R3" })) {
    const s = { R1: 0.3, R2: 0.6, "R2/R3": 0.75, R3: 0.95 }[cls];
    assert.equal(t.inputs[0].domain.enum[area], s, `area ${area}`);
  }
});

test("DT-016 §13.2: elemento in più su R1 compatibile; elemento assente o R ≥ R2 incompatibile", () => {
  const t = loadTable("DT-016");
  assert.equal(evaluate(t, { divergence: "elemento-in-piu", risk: "R1" }).outcome, "compatibile");
  assert.equal(evaluate(t, { divergence: "elemento-assente", risk: "R0" }).outcome, "incompatibile");
  assert.equal(evaluate(t, { divergence: "stato-diverso", risk: "R1" }).outcome, "incompatibile");
  assert.equal(evaluate(t, { divergence: "elemento-in-piu", risk: "R2" }).outcome, "incompatibile");
});

test("DT-020/021/022 §18.5: CFG con confidenza ≥ .70; livello C; digerito con gaps", () => {
  const t20 = evaluate(loadTable("DT-020"), { candidate_type: "CFG", position: true, unit_form: true, lexicon: true, technical_name: true, external_ref: false });
  assert.equal(t20.outcome, "CFG");
  approx(t20.score, 0.85);   // prior senza dati: neutral, nessuno spostamento
  const t20p = evaluate(loadTable("DT-020"), { candidate_type: "CFG", position: true, unit_form: true, lexicon: true, technical_name: true, external_ref: false }, { priors: { reclassification_rate: 0 } });
  approx(t20p.score, 0.95);  // tasso di riclassificazione misurato 0 → confidenza piena
  assert.equal(evaluate(loadTable("DT-020"), { candidate_type: "CFG", position: true, unit_form: false, lexicon: false, technical_name: true }).outcome, "ambiguo");
  const t21 = evaluate(loadTable("DT-021"), { customer_origin: true, deictic_lexicon: true, s_item_different_values: true, s_item_same_values: false, in_customer_export: false });
  assert.equal(t21.outcome, "C");
  assert.equal(evaluate(loadTable("DT-021"), { customer_origin: false, deictic_lexicon: false, s_item_different_values: false, s_item_same_values: true, in_customer_export: false }).outcome, "S");
  assert.equal(evaluate(loadTable("DT-021"), { customer_origin: true, deictic_lexicon: false, s_item_different_values: false, s_item_same_values: false, in_customer_export: false }).outcome, "ambiguo");
  // 5/7 attributi coperti, impacts e rollback (critici per R ≥ R2) mancanti, location e options presenti
  const t22 = evaluate(loadTable("DT-022"), { coverage_deficit: 2 / 7, critical_missing: false, r2_critical_missing: true, below_type_threshold: false });
  assert.equal(t22.outcome, "digerito");
  assert.deepEqual(t22.combined, ["non-in-uso-R2+", "gaps-dichiarati"]);
  assert.equal(evaluate(loadTable("DT-022"), { coverage_deficit: 0.2, critical_missing: true, r2_critical_missing: false, below_type_threshold: false }).outcome, "quarantena");
  // sotto la soglia del tipo ma senza attributi critici mancanti → digerito con gaps, non in uso per R ≥ R2 (§19.13)
  const low = evaluate(loadTable("DT-022"), { coverage_deficit: 0.9, critical_missing: false, r2_critical_missing: false, below_type_threshold: true });
  assert.equal(low.outcome, "digerito");
  assert.deepEqual(low.combined, ["non-in-uso-R2+", "gaps-dichiarati"]);
  const full = evaluate(loadTable("DT-022"), { coverage_deficit: 0, critical_missing: false, r2_critical_missing: false, below_type_threshold: false });
  assert.deepEqual(full.combined, []);
});

test("DT-023 §10.4 e §18.4: profondità", () => {
  const t = loadTable("DT-023");
  assert.deepEqual([...t.inputs.map((i) => i.weight).filter((w) => w > 0)], [0.30, 0.30, 0.15, 0.15, 0.10]);
  assert.equal(evaluate(t, { risk: "R1", shape: "consolidato", surprises: 0, precedent: "confermato-d<0.2", graph_radius_gt5: false }).outcome, "rapida");
  assert.equal(evaluate(t, { risk: "R1", shape: "libresco", surprises: 0, precedent: "nessuno", graph_radius_gt5: false }).outcome, "standard");
  assert.equal(evaluate(t, { risk: "R2", shape: "libresco", surprises: 0, precedent: "nessuno", graph_radius_gt5: false }).outcome, "profonda");
  assert.equal(evaluate(t, { risk: "R0", shape: "consolidato", surprises: 2, precedent: "nessuno", graph_radius_gt5: false }).outcome, "profonda");
  // §18.4: "DT-023 → profonda (R0 ma forma contraddittoria: due CTR aperti su INV)"
  assert.equal(evaluate(t, { risk: "R0", shape: "contraddittorio", surprises: 0, precedent: "nessuno", graph_radius_gt5: false }).outcome, "profonda");
});

test("DT-024 §13.7: epistemica, aleatoria, mista", () => {
  const t = loadTable("DT-024");
  assert.equal(evaluate(t, { divergence_pattern: "coerente", err_category: "validation", intermittent_timing: false }).outcome, "epistemica");
  assert.equal(evaluate(t, { divergence_pattern: "variabile", err_category: "timeout", intermittent_timing: true }).outcome, "aleatoria");
  assert.equal(evaluate(t, { divergence_pattern: "variabile", err_category: "timeout", intermittent_timing: true, mixed_steps: true }).outcome, "mista");
  // timeout sistematico (coerente a ogni ripetizione) non è aleatorio (§20.6.4)
  assert.equal(evaluate(t, { divergence_pattern: "coerente", err_category: "timeout", intermittent_timing: false }).outcome, "epistemica");
});

test("DT-025 §19.18: guadagno epistemico atteso, formula della spec", () => {
  // spec di integrazione breve su interfaccia critica vs manuale lungo su funzioni già consolidate
  const spec = { subjects: [{ criticality: 1, impactRadius: 10, kLevel: 0.2 }], reliability: 0.9, units: 40, avgTier: 2 };
  approx(ingestionGain(spec), (1 * 2 * 0.8 * 0.9) / 80);
  const manual = { subjects: [{ criticality: 0.5, impactRadius: 0, kLevel: 0.9 }, { criticality: 0.5, impactRadius: 0, kLevel: 0.9 }], reliability: 0.7, units: 600, avgTier: 1 };
  const b = backlogPriorities([{ id: "manuale", ...manual }, { id: "spec", ...spec }]);
  assert.deepEqual(b.map((d) => d.id), ["spec", "manuale"]);
  assert.equal(b[0].gain_normalized, 1);
  const r = evaluate(loadTable("DT-025"), { gain_normalized: b[1].gain_normalized });
  assert.equal(r.outcome, "punteggio");
  approx(r.score, b[1].gain_normalized);
});

test("DT-026 §29.5/§61 + spec 2026-10-06 §3.5-§3.6: avvio se R0 o se il piano non chiede approvazioni; prod ⇒ piano; DELETE in prod ⇒ rifiuta", () => {
  const t = loadTable("DT-026");
  const base = { critical_missing: false, action_class_allowed: true, config_change: false };
  const o = (v) => evaluate(t, { ...base, ...v }).outcome;
  // needs_approval assente ⇒ default true (null_policy): come prima per sandbox/pre-produzione
  assert.equal(o({ max_risk: "R1", environment: "sandbox" }), "avvia");
  assert.equal(o({ max_risk: "R0", environment: "prod" }), "avvia");
  assert.equal(o({ max_risk: "R1", environment: "preprod" }), "mostra-piano");
  assert.equal(o({ max_risk: "R2", environment: "sandbox" }), "mostra-piano");
  assert.equal(o({ max_risk: "R1", environment: "sandbox", critical_missing: true }), "chiedi");
  // nessuna approvazione col livello attuale ⇒ avvia (anche R2 in pre-produzione)
  assert.equal(o({ max_risk: "R1", environment: "preprod", needs_approval: false }), "avvia");
  assert.equal(o({ max_risk: "R2", environment: "preprod", needs_approval: false }), "avvia");
  assert.equal(o({ max_risk: "R1", environment: "preprod", needs_approval: true }), "mostra-piano");
  // produzione: scrittura e configurazione ⇒ piano da approvare (non più rifiuto né 3A); solo ACT-DELETE è rifiutata
  assert.equal(o({ max_risk: "R1", environment: "prod" }), "mostra-piano");
  assert.equal(o({ max_risk: "R2", environment: "prod" }), "mostra-piano");
  assert.equal(o({ max_risk: "R1", environment: "prod", config_change: true }), "mostra-piano");
  assert.equal(o({ max_risk: "R2", environment: "prod", config_change: true }), "mostra-piano");
  assert.equal(o({ max_risk: "R3", environment: "prod" }), "mostra-piano");
  assert.equal(o({ max_risk: "R3", environment: "sandbox", needs_approval: true }), "mostra-piano");
  assert.equal(o({ max_risk: "R1", environment: "prod", action_class_allowed: false }), "rifiuta");
  assert.equal(o({ max_risk: "R1", environment: "prod", critical_missing: true, action_class_allowed: false }), "chiedi");
});

test("DT-023: 'rapida' solo con consolidato × R ≤ R1 × precedente confermato × 0 sorprese (§10.4)", () => {
  const t = loadTable("DT-023");
  const probe1 = evaluate(t, { risk: "R0", shape: "empirico", surprises: 0, precedent: "nessuno", graph_radius_gt5: false });
  approx(probe1.score, 0.195);
  assert.equal(probe1.outcome, "standard");
  const probe2 = evaluate(t, { risk: "R1", shape: "consolidato", surprises: 0, precedent: "nessuno", graph_radius_gt5: false });
  approx(probe2.score, 0.165);
  assert.equal(probe2.outcome, "standard");
  assert.equal(evaluate(t, { risk: "R1", shape: "consolidato", surprises: 1, precedent: "confermato-d<0.2", graph_radius_gt5: false }).outcome, "standard");
  assert.equal(evaluate(t, { risk: "R0", shape: "consolidato", surprises: 0, precedent: "confermato-d<0.5", graph_radius_gt5: false }).outcome, "rapida");
});

test("DT-017: la terza sorpresa (STR-STOP-RECORD) prevale su STR-BISECT (§13.3)", () => {
  const r = evaluate(loadTable("DT-017"), { shape: "consolidato", risk: "R0", precedent: "nessuno", surprises: 3, diagnosis_unknown_divergence: true });
  assert.equal(r.outcome, "STR-STOP-RECORD");
});

test("DT-011: prior sul GENERE della fonte vincente e sul cluster (§15.2, §11.5)", async () => {
  const { openDb } = await import("../../scripts/kb/db.mjs");
  const { autoPriors } = await import("../../scripts/decide/dt-eval.mjs");
  const t = loadTable("DT-011");
  assert.deepEqual(t.priors[0].source.match_inputs, ["winner_genre"]);
  assert.deepEqual(t.priors[0].source.by, ["cluster"]);
  const db = openDb(":memory:");
  const dec = db.prepare("insert into decisions(code,table_code,subject_cluster,inputs,outcome) values (?,?,?,?,?)");
  const out = db.prepare("insert into outcomes(decision_code,result) values (?,?)");
  for (let i = 1; i <= 40; i++) {
    const code = `L.ACME.ADM.DEC.${String(i).padStart(4, "0")}`;
    const genre = i <= 30 ? "testimoniale" : "empirica";
    dec.run(code, "DT-011", "CL-CFG-020", JSON.stringify({ winner_genre: genre, candidate_winner: "vince-L" }), "vince-L");
    out.run(code, i <= 12 ? "smentita" : "confermata");   // 12 dichiarazioni smentite su 30
  }
  const inputs = { candidate_winner: "vince-L", winner_genre: "testimoniale", winner_evidence: "dichiarazione", genre_fit: true, confidence_gap: 0.2, user_answer: "nessuna" };
  const p = autoPriors(db, t, inputs, { cluster: "CL-CFG-020" });
  assert.equal(p.winner_genre_disproved.n, 30);
  assert.equal(p.winner_genre_disproved.value, 0.4);
  const few = autoPriors(db, t, { ...inputs, winner_genre: "empirica" }, { cluster: "CL-CFG-020" });
  assert.equal(few.winner_genre_disproved.sufficient, false);   // 10 DEC < 30
  const r = evaluate(t, inputs, { priors: p });
  assert.equal(r.prior_used[0].applied, "auto");
});

test("tabelle con outcome_from, selettori e combinazioni: casi rappresentativi", () => {
  assert.equal(evaluate(loadTable("DT-004"), { form_ok: true, grounded: true, boundaries_ok: true, portability_ok: true, expected_outcomes_declared: true, novel: false, actionable: true }).outcome, "merged");
  assert.equal(evaluate(loadTable("DT-004"), { form_ok: true, grounded: true, boundaries_ok: true, portability_ok: true, expected_outcomes_declared: false, novel: true, actionable: true }).outcome, "rejected");
  assert.deepEqual(evaluate(loadTable("DT-004"), { form_ok: true, grounded: true, boundaries_ok: true, portability_ok: true, expected_outcomes_declared: true, novel: true, actionable: false }).combined, ["inerte"]);
  assert.equal(evaluate(loadTable("DT-006"), { p_value: 0.9, enough_customers: true, contradictions: false, facet_explains: false }).outcome, "universale");
  assert.equal(evaluate(loadTable("DT-006"), { p_value: 0.4, enough_customers: true, contradictions: true, facet_explains: true }).outcome, "condizionata");
  assert.equal(evaluate(loadTable("DT-006"), { p_value: 0.4, enough_customers: true, contradictions: true, facet_explains: false }).outcome, "specifica");
  assert.equal(evaluate(loadTable("DT-006"), { p_value: 1, enough_customers: false, contradictions: false, facet_explains: false }).outcome, "ignota");
  assert.equal(evaluate(loadTable("DT-008"), { first_available: "testid", stability: "stabile", dynamic_pattern: false }).outcome, "testid");
  assert.equal(evaluate(loadTable("DT-008"), { first_available: "testid", stability: "instabile", dynamic_pattern: true }).outcome, "role");
  assert.equal(evaluate(loadTable("DT-011"), { candidate_winner: "vince-L", winner_genre: "empirica", winner_evidence: "osservazione-confermata", genre_fit: true, confidence_gap: 0.3, user_answer: "nessuna" }).outcome, "vince-L");
  assert.equal(evaluate(loadTable("DT-011"), { candidate_winner: "vince-C", winner_genre: "tecnica", winner_evidence: "documento", genre_fit: true, confidence_gap: 0.1, user_answer: "non-lo-so" }).outcome, "irrisolta");
  const q = evaluate(loadTable("DT-013"), { blocking_impact: false, silence_possible: false, latency_declared: true });
  assert.equal(q.outcome, "queued_accepted");
  assert.equal(q.score, 0);              // prior invertito senza dati: neutral = nessuno spostamento (non +0.30)
  assert.equal(q.prior_used[0].applied, "neutral");
  assert.equal(evaluate(loadTable("DT-014"), { budget_used: 0.3, novelty_recent: "alta", surprises: 0, system_errors: false, budget_exhausted: false, next_risk: "R1" }).outcome, "ferma");
  assert.equal(evaluate(loadTable("DT-015"), { coherence: "coerente", tables_knowledge: "validate", pattern_known: true, executed_with_limit: false }).outcome, "no");
  assert.equal(evaluate(loadTable("DT-019"), { preferred_genre: "tecnica", preferred_available: false, observable_r0: true }).outcome, "osservazione");
  assert.equal(evaluate(loadTable("DT-010"), { portability_class: "universale", p_value: 1, quality_class: "operativa", p_ge_08: true, open_product_ctr: false }).outcome, "candidato");
  assert.equal(evaluate(loadTable("DT-010"), { portability_class: "specifica", p_value: 1, quality_class: "operativa", p_ge_08: true, open_product_ctr: false }).outcome, "no");
});
