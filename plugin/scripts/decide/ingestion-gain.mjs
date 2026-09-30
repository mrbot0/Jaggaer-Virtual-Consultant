// Guadagno epistemico atteso di un documento (§19.18), formula della spec:
//
//   guadagno(DOC) = Σ_soggetti ( peso_soggetto × gap_corrente × affidabilità_DOC ) / costo_stimato(DOC)
//     peso_soggetto = criticità della capability × (1 + raggio d'impatto sul grafo / 10)
//     gap_corrente  = 1 − K_level del soggetto sul genere del DOC
//     affidabilità  = reliability.score del profilo del documento
//     costo         = unità stimate × tier medio per tipo di documento
//
// DT-025 riceve `gain_normalized` = guadagno / guadagno massimo del backlog:
// la normalizzazione è relativa al backlog e preserva esattamente l'ordine.
// Funzioni pure.
export function subjectWeight({ criticality, impactRadius = 0 }) {
  return criticality * (1 + impactRadius / 10);
}

export function ingestionGain({ subjects, reliability, units, avgTier }) {
  const cost = units * avgTier;
  if (!(cost > 0)) throw new RangeError("costo stimato del documento non positivo");
  const sum = subjects.reduce((a, s) => a + subjectWeight(s) * (1 - s.kLevel) * reliability, 0);
  return sum / cost;
}

export function backlogPriorities(docs) {
  const withGain = docs.map((d) => ({ ...d, gain: ingestionGain(d) }));
  const max = Math.max(0, ...withGain.map((d) => d.gain));
  return withGain
    .map((d) => ({ ...d, gain_normalized: max > 0 ? Math.round((d.gain / max) * 1e6) / 1e6 : 0 }))
    .sort((a, b) => b.gain - a.gain || String(a.id).localeCompare(String(b.id)));
}
