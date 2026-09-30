// L'insieme dei controlli del self-check (§17.1 + #11 di §29.6 + rilevatori di spreco di §29.10): unica
// fonte per self-check.mjs (quali controlli esegue) e depth.mjs (quali controlli annuncia per profondità).
export const CONTROLS = {
  1: "ogni codice citato esiste",
  2: "nessuna lettura fuori cella (audit)",
  3: "ogni entità creata ha compensazione registrata",
  4: "ogni decisione con effetti ha una DEC con tabella e strategia; ogni passo del piano ha un expect",
  5: "ogni DEC con effetti ha un esito atteso dichiarato",
  6: "le sorprese di sessione sono tutte in CTR",
  7: "forma epistemica iniziale e finale registrate",
  8: "risultato in YAML compatto con codici, non prosa",
  9: "la lezione esiste, con otto sezioni e la sezione 7 non vuota",
  10: "esito ok con open_questions solo non bloccanti",
  11: "ogni azione ha un report (RPT)",
  12: "spreco: nessuna query kb ripetuta con gli stessi argomenti",
  13: "spreco: nessuno snapshot ripetuto della stessa pagina senza azione in mezzo",
};

// Profondità rapida (§10.4): auto-verifica ridotta ai controlli 1, 3, 9, più il #11 (RPT obbligatorio, §29.6).
export const SELF_CHECK_CONTROLS = Object.freeze({
  rapida: Object.freeze([1, 3, 9, 11]),
  full: Object.freeze(Object.keys(CONTROLS).map(Number)),
});

export const controlsFor = (depth) => [...(depth === "rapida" ? SELF_CHECK_CONTROLS.rapida : SELF_CHECK_CONTROLS.full)];

// WP10b giro 1 (I3): i controlli che cognitive_trace.self_check.passed conta (lo schema lo limita a 10): rapida
// 1, 3, 9, 11 (4); standard e profonda 1–10. validateReport giudica `passed` su questo insieme, self-check lo produce.
export const reportedControlsFor = (depth) => controlsFor(depth).slice(0, 10);
