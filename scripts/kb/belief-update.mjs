// Revisione delle credenze (§13): regola di aggiornamento (§13.8), sorprese (DT-016, §13.2),
// tipo di incertezza (DT-024, §13.7), registro delle ipotesi (§13.6).
//
// Il principio (§13.8): una singola osservazione può bloccare, mai riscrivere.
//   osservazione coerente                confirmed_count + 1; a 3 → 1.00
//   contraria, prima volta               CTR aperto; confidenza di sessione 0.40; persistente invariata
//   contraria, seconda volta             confidenza persistente × 0.7 (al reindex: marcata, non applicata qui)
//   contraria, terza volta               l'item contrario diventa il riferimento; il vecchio superseded_by
//   dichiarazione utente contraria       CTR; vince chi ha l'osservazione (§11.5)
//   esecuzione con esito contrario       peso 1.00: una basta per il CTR e il blocco R ≥ R2;
//                                        due esecuzioni coerenti (fra loro) per sostituire l'item
// Ogni CTR aperto blocca le azioni R ≥ R2 sul soggetto (§11.5 punto 4, §13.2).
//
// Funzioni pure: `applyObservation` non modifica lo stato ricevuto e restituisce { state, effects }.
import { evaluate, loadTable } from "../decide/dt-eval.mjs";
import { validateWith } from "../lib/schemas.mjs";

export const KINDS = ["obs", "user", "exec"];
const RISK_RANK = { R0: 0, R1: 1, R2: 2, R3: 3 };
const TIER_RANK = { T0: 0, T1: 1, T2: 2 };

const blankItem = (seed = {}) => ({
  confidence: null, session_confidence: null, confirmed_count: 0, contrary: { obs: 0, user: 0, exec: 0 },
  persistent_factor: 1, reindex: false, superseded_by: null, reference: true, observed: false, ...seed,
});

export function newBeliefState(items = {}) {
  const state = { items: {}, contradictions: [], blocked: [] };
  for (const [code, seed] of Object.entries(items)) state.items[code] = blankItem(seed);
  return state;
}

export function isBlocked(state, item, risk) {
  return (RISK_RANK[risk] ?? 3) >= 2 && state.blocked.includes(item);
}

function openCtr(state, item, withCode, kind, winner = null) {
  let ctr = state.contradictions.find((c) => c.item === item && c.status === "aperto");
  if (!ctr) {
    ctr = { item, with: [withCode].filter(Boolean), kind, status: "aperto", winner };
    state.contradictions.push(ctr);
  } else if (withCode && !ctr.with.includes(withCode)) ctr.with.push(withCode);
  if (!state.blocked.includes(item)) state.blocked.push(item);
  return ctr;
}

function replace(state, item, withCode, effects) {
  const it = state.items[item];
  it.superseded_by = withCode ?? null;
  it.reference = false;
  if (withCode) state.items[withCode] = { ...blankItem({ confidence: 1 }), ...(state.items[withCode] ?? {}), reference: true, supersedes: item };
  for (const c of state.contradictions) if (c.item === item && c.status === "aperto") { c.status = "risolto"; c.winner = withCode ?? "contrario"; }
  state.blocked = state.blocked.filter((x) => x !== item);
  effects.push(`sostituito: ${withCode} diventa il riferimento, ${item} superseded_by`);
}

export class MissingSuccessorError extends Error { constructor(m) { super(m); this.name = "MissingSuccessorError"; } }

export function applyObservation(state, { item, coherent, kind = "obs", with: withCode = null } = {}) {
  if (!KINDS.includes(kind)) throw new Error(`kind '${kind}' non valido (${KINDS.join(" · ")})`);
  if (typeof item !== "string" || !item) throw new Error("item mancante");
  // §13.8: sostituire vuol dire "l'item contrario diventa il nuovo riferimento" — senza il codice del
  // contrario non c'è successore: si rifiuta (lo stato ricevuto non cambia, CTR e blocco restano).
  const prior = state.items?.[item]?.contrary?.[kind] ?? 0;
  const replacing = !coherent && ((kind === "obs" && prior + 1 >= 3) || (kind === "exec" && prior + 1 >= 2));
  if (replacing && !(typeof withCode === "string" && withCode)) {
    throw new MissingSuccessorError(`sostituzione di ${item} senza successore: serve il codice dell'item contrario (with)`);
  }
  const s = structuredClone(state);
  s.items[item] = blankItem(s.items[item]);
  const it = s.items[item];
  const effects = [];
  if (coherent) {
    it.confirmed_count += 1;
    if (kind === "obs" || kind === "exec") it.observed = true;
    effects.push(`confirmed_count ${it.confirmed_count}`);
    if (it.confirmed_count >= 3 && it.confidence !== 1) {
      it.confidence = 1;
      it.session_confidence = 1;
      effects.push("tre conferme: confidenza 1.00");
    }
    return { state: s, effects };
  }
  it.contrary[kind] += 1;
  const n = it.contrary[kind];
  if (kind === "user") {
    // §11.5: non scegliere; registra il CTR; vince chi ha l'osservazione. Senza osservazione: DT-011.
    const winner = it.observed ? "osservazione" : null;
    openCtr(s, item, withCode, kind, winner);
    effects.push("CTR aperto (dichiarazione utente)", winner ? "vince l'osservazione (§11.5)" : "nessuna osservazione: decide DT-011", "blocco R ≥ R2");
    return { state: s, effects };
  }
  if (kind === "exec") {
    if (n === 1) {
      openCtr(s, item, withCode, kind);
      it.session_confidence = 0.4;
      effects.push("CTR aperto (esecuzione, peso 1.00)", "blocco R ≥ R2 immediato", "confidenza di sessione 0.40");
    } else replace(s, item, withCode, effects);
    return { state: s, effects };
  }
  // osservazione contraria
  if (n === 1) {
    openCtr(s, item, withCode, kind);
    it.session_confidence = 0.4;
    effects.push("CTR aperto", "confidenza di sessione 0.40 (persistente invariata)", "blocco R ≥ R2");
  } else if (n === 2) {
    openCtr(s, item, withCode, kind);
    it.persistent_factor = Math.round(it.persistent_factor * 0.7 * 1e6) / 1e6;
    it.reindex = true;
    effects.push("confidenza persistente × 0.7 al reindex");
  } else replace(s, item, withCode, effects);
  return { state: s, effects };
}

// ——— sorprese (§13.2, DT-016) ———
const norm = (s) => String(s ?? "").trim().toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, "-");

export function classifySurprise(divergenceKind, risk, { priors = {} } = {}) {
  const r = evaluate(loadTable("DT-016"), { divergence: norm(divergenceKind), risk }, { priors });
  return {
    outcome: r.outcome,
    action: r.outcome === "compatibile" ? "procedi-dichiarando-l-assunzione" : "ferma-il-passo",
    score: r.score, rule: r.rule,
  };
}

// ——— tipo di incertezza (§13.7, DT-024) ———
const RESPONSES = {
  epistemica: "osservare, chiedere, aggiornare il modello (riprovare darebbe lo stesso risultato)",
  aleatoria: "riprovare con backoff, marcare flaky, misurare la distribuzione; non aggiornare il modello",
  mista: "isolare il passo con STR-BISECT prima di classificare",
};

// observations: [{ step, expected, value, diverged?, err_category?, timing_out? }] in ordine.
export function classifyUncertainty(observations = []) {
  const diverged = (o) => (typeof o.diverged === "boolean" ? o.diverged : JSON.stringify(o.value) !== JSON.stringify(o.expected));
  const bySteps = new Map();
  for (const o of observations) {
    const k = String(o.step ?? "?");
    if (!bySteps.has(k)) bySteps.set(k, []);
    bySteps.get(k).push(o);
  }
  const patterns = [];
  for (const obs of bySteps.values()) {
    const div = obs.filter(diverged);
    if (!div.length) continue;
    const values = new Set(div.map((o) => JSON.stringify(o.value)));
    patterns.push(values.size === 1 && div.length === obs.length ? "coerente" : "variabile");
  }
  if (!patterns.length) return { kind: null, response: "nessuna divergenza dall'atteso", inputs: null };
  const cats = observations.filter(diverged).map((o) => o.err_category).filter(Boolean);
  const freq = cats.reduce((m, c) => m.set(c, (m.get(c) ?? 0) + 1), new Map());
  const err_category = [...freq.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? "nessuno";
  const timing = observations.map((o) => o.timing_out).filter((x) => typeof x === "boolean");
  const inputs = {
    divergence_pattern: patterns.includes("variabile") ? "variabile" : "coerente",
    err_category,
    intermittent_timing: timing.includes(true) && timing.includes(false),
    mixed_steps: patterns.includes("variabile") && patterns.includes("coerente"),
  };
  const r = evaluate(loadTable("DT-024"), inputs);
  return { kind: r.outcome, response: RESPONSES[r.outcome], combined: r.combined, score: r.score, inputs };
}

// ——— registro delle ipotesi (§13.6) ———
const listOf = (h) => (Array.isArray(h) ? h : h?.hypotheses ?? []);

export function validateHypotheses(h, { beforeTest = false, depth } = {}) {
  const doc = Array.isArray(h) ? { hypotheses: h } : h;
  const errors = [];
  const warnings = [];
  const v = validateWith("hypotheses.schema.json", doc);
  if (!v.ok) errors.push(...v.errors.map((e) => `schema: ${e}`));
  const list = listOf(doc);
  const open = list.filter((x) => x.status === "open");
  if (beforeTest && open.length < 2) errors.push(`servono almeno due ipotesi aperte prima di un test discriminante (aperte: ${open.length}): una sola ipotesi non si testa, si conferma`);
  if (depth === "profonda" && list.length < 2) errors.push("chiusura prematura: una sola ipotesi nel registro in deliberazione profonda (§17.3)");
  for (const x of list) {
    if (typeof x.prior !== "number") errors.push(`${x.id ?? "?"}: prior non dichiarato`);
    if (x.status === "supported" && !(x.evidence_for?.length > 0)) errors.push(`${x.id}: supported senza evidenza citata in evidence_for`);
    if (x.status === "refuted" && !(x.evidence_against?.length > 0)) errors.push(`${x.id}: refuted senza evidenza citata in evidence_against (mai per stanchezza)`);
    if (x.status === "supported" && !(x.evidence_against?.length > 0) && x.prior > 0.6) {
      warnings.push(`${x.id}: ipotesi vincente con prior ${x.prior} ed evidence_against vuoto — bias di conferma: STR-DISCONFIRM o confidence −0.15 (§17.3)`);
    }
  }
  const ids = list.map((x) => x.id);
  if (new Set(ids).size !== ids.length) errors.push("id di ipotesi duplicati");
  return { ok: errors.length === 0, errors, warnings };
}

// Il test che discrimina al costo minore: rischio, poi passi, poi tier (§13.6: "H3 costa 3 passi a R0").
export function nextTest(h) {
  const open = listOf(h).filter((x) => x.status === "open");
  if (open.length < 2) return null;
  const candidates = open.filter((x) => x.discriminating_test && x.cost_of_test);
  if (!candidates.length) return null;
  const rank = (x) => [RISK_RANK[x.cost_of_test.risk] ?? 9, x.cost_of_test.steps ?? 999, TIER_RANK[x.cost_of_test.tier] ?? 9];
  candidates.sort((a, b) => {
    const ra = rank(a); const rb = rank(b);
    return ra[0] - rb[0] || ra[1] - rb[1] || ra[2] - rb[2] || String(a.id).localeCompare(String(b.id));
  });
  const best = candidates[0];
  return { id: best.id, test: best.discriminating_test, cost: best.cost_of_test };
}
