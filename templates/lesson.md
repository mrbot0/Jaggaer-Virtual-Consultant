---
id: L.<CLIENTE>.<SCOPE>.LSN.<SEQ>
agent: <agente>
session: <SES.CLIENTE.AAAAMMGG.NNN>
task: "<il compito in una riga>"
scope: <SCOPE>
mode: <nrt|config|ops|diag>
decision_refs: []            # [L.<C>.<S>.DEC.nnnn, …] — le DEC prese nel compito
strategy: <STR-…>
epistemic_before: <forma>    # consolidato · libresco · empirico · ignoto · contraddittorio
epistemic_after: <forma>
surprises: 0
expected_outcomes: []        # [{ decision: L.<C>.<S>.DEC.nnnn, expect: "…" }] per ogni DEC con effetti
status: proposed             # lo cambia solo `learn validate` (DT-004)
confidence: 0.0
portability_hypothesis: { class: ignota }   # universale · condizionata (+ condition) · specifica · ignota
cluster_proposal: null       # CL-… o null
---
## 1. Contesto
<!-- soggetto (codice), azione, rischio, modalità; il compito come è stato situato -->

## 2. Cosa ho tentato
<!-- strategia e passi, con i codici -->

## 3. Cosa ho osservato
<!-- sorprese e novità, con codici OBS/CTR; le ipotesi escluse e perché -->

## 4. Decisioni prese
<!-- DT, input, priori, punteggio, strategia: una riga per DEC -->

## 5. Esito
<!-- status del compito ed esito atteso di ogni DEC con effetti -->

## 6. Lezione
<!-- cosa mi ha sorpreso e cosa avrei dovuto sapere per non esserne sorpreso;
     quale precedente ha aiutato o fuorviato; quale controllo avrebbe reso il compito banale -->

## 7. Cosa NON generalizzerei
<!-- obbligatoria: quali scelte dipendono da faccette del cliente (F5, F6, F7) e quali no -->

## 8. Domande aperte
<!-- non bloccanti, o marcate come bloccanti -->
