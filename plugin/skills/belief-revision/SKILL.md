---
name: belief-revision
description: Metodo per reagire a ciò che si scopre durante l'esecuzione — sorpresa, conferma o novità — con la regola di aggiornamento (una osservazione contraria blocca, tre sostituiscono), DT-016 (sorpresa compatibile o incompatibile), il budget di sorprese, il registro delle ipotesi e DT-024 (incertezza epistemica o aleatoria). Usala quando step-check restituisce surprise o novelty, quando un'osservazione contraddice un item su cui poggi il passo, quando conti le sorprese del compito, in diagnosi con più ipotesi aperte o quando un comportamento cambia a ogni ripetizione.
---

# belief-revision — decidere in base a ciò che si scopre (§13)

Il principio: **una singola osservazione può bloccare, mai riscrivere.** Bloccare è reversibile; riscrivere il
modello su un caso isolato è il modo in cui un sistema impara le proprie allucinazioni.

## Sorpresa, conferma, novità: chi le distingue

Non te ne devi "accorgere": dopo ogni passo salvi il risultato dello strumento in un file e lo passi a
`step-check`, che confronta con l'atteso del passo (`expect`, `wait_for`, riferimento dell'Atlas) e classifica.

    node "${CLAUDE_PLUGIN_ROOT}/scripts/decide/step-check.mjs" --plan <piano> --step <n> --snapshot customers/<C>/.sessions/<sid>/work/<task>/step-<n>.txt --run <RUN> --session <sid> --json

| Classificazione | Cos'è | Cosa fai |
|-----------------|-------|----------|
| `ok` (conferma) | l'osservazione coincide con l'atteso | prosegui; l'item guadagna una conferma (a tre → confidenza piena) |
| `surprise` | contraddice un item con W ≥ 0.70 su cui poggia il passo | torna a VALUTARE per quel passo (sotto) |
| `novelty` | qualcosa che nessuna fonte menzionava (un campo, un'opzione in più) | non ferma nulla: candidato in `_inbox/<S>/`, eventuale domanda di apprendimento a fine sessione |

## Cosa succede a una sorpresa (§13.2)

1. Si apre una CTR (item contraddetto ↔ OBS) — la registra lo script, tu la citi.
2. La confidenza **di sessione** dell'item scende a 0.40; quella persistente la ricalcola il reindex.
3. La forma del soggetto di norma diventa `contraddittorio` (skill `epistemic-awareness`).
4. Torni al passo 3 del ciclo **per quel passo**:
   - R0/R1 e sorpresa **compatibile** (es. un'opzione in più) → procedi dichiarando l'assunzione;
   - R ≥ R2, o sorpresa **incompatibile** (elemento mancante, stato diverso) → **fermati**, non eseguire, restituisci
     `needs-input` o `escalate`.
5. La sorpresa conta nel budget del compito e della sessione.
6. La lezione la riporta nelle sezioni 3 (osservato) e 6 (lezione).

"Compatibile" e "incompatibile" non sono giudizi tuoi: li decide DT-016 dal tipo di divergenza (elemento assente ·
stato diverso · attributo diverso · elemento in più · messaggio inatteso · tempo fuori norma) e dal rischio del passo;
step-check te lo restituisce già classificato.

## Il budget di sorprese (§13.3)

| Sorprese nel compito | Effetto |
|----------------------|---------|
| 1 | gestita al passo, continui |
| 2 | continui; il tier sale di uno per il resto del compito (lo segnala step-check) |
| 3 | **ferma il compito**: `status: escalate` con la lista delle CTR — la mappa di questo soggetto è sbagliata |

Tre compiti consecutivi fermati per sorprese sullo stesso scope bloccano lo scope per tutta la sessione (vigilanza
del manager, applicata dal codice): non è una tua decisione, ma è il motivo per cui non devi mai nascondere una
sorpresa.

## La regola di aggiornamento (§13.8)

```
osservazione coerente con l'atteso      confirmed_count + 1; a 3 → confidenza 1.00
contraria, prima volta                  CTR aperta; confidenza di sessione 0.40; persistente invariata
contraria, seconda volta                confidenza persistente × 0.7 (al reindex)
contraria, terza volta                  l'item contrario diventa il riferimento; il vecchio superseded_by
dichiarazione utente contraria          CTR; vince chi ha l'osservazione (§11.5)
esecuzione con esito contrario          una basta per aprire la CTR e bloccare R ≥ R2;
                                        servono due esecuzioni coerenti per sostituire l'item
```

È la semantica di `applyObservation` in `scripts/kb/belief-update.mjs`: ogni CTR aperta blocca le azioni R ≥ R2
sul soggetto. Non "correggi" un item perché l'hai visto diverso una volta: apri la contraddizione e lasci che la
regola faccia il resto.

## Due incertezze, due risposte (§13.7, DT-024)

| Tipo | Segnali | Risposta giusta | Risposta sbagliata |
|------|---------|-----------------|--------------------|
| **epistemica** (non sappiamo) | una divergenza con osservazioni coerenti fra loro | osservare, chiedere, aggiornare il modello | riprovare: darà lo stesso risultato |
| **aleatoria** (il sistema varia) | divergenze che cambiano a ogni ripetizione, timeout intermittenti | riprovare con backoff, marcare flaky, misurare; **non** aggiornare il modello | imparare una regola da un caso singolo |
| **mista** | aleatoria su un passo che maschera un'epistemica su un altro | isolare il passo con `STR-BISECT` prima di classificare | — |

## Il registro delle ipotesi (§13.6)

In deliberazione profonda (diagnosi, soggetti `libresco` o `contraddittorio`, esplorazione) non ragioni con una
sola idea. Il registro sta nel blackboard e nella traccia (`hypotheses`), con forma fissa (`schemas/hypotheses.schema.json`):
`id`, `claim`, `prior`, `evidence_for`, `evidence_against`, `discriminating_test`, `cost_of_test`, `status`.

| Regola | Perché |
|--------|--------|
| almeno **due** ipotesi aperte prima di un test discriminante | una sola ipotesi non si testa: si conferma |
| il test scelto è quello che **discrimina di più al costo minore** | non quello che conferma la preferita |
| un'ipotesi si chiude solo con **evidenza citata** (`refuted` o `supported`) | chiusa senza evidenza = self-check fallito |
| le sopravvissute con evidenza diventano il finding; le rifiutate restano | chi legge vede anche cosa è stato escluso |
| ogni ipotesi ha un **prior dichiarato** (precedenti, contesto, o 1/n) | un prior esplicito si può smentire |

Con un'ipotesi preferita a prior > 0.6 si combina `STR-DISCONFIRM`: prima di concludere, un test progettato per
smentirla; se non ne esiste uno eseguibile la conclusione porta confidenza ridotta di 0.15.

## Errori tipici

- Continuare dopo una sorpresa "perché il resto sembra a posto".
- Aggiornare un item persistente da una sola osservazione (è il reindex che lo fa, con la regola).
- Chiamare sorpresa una novità: una novità non ferma, si registra.
- Riprovare all'infinito un'incertezza epistemica, o imparare da un'incertezza aleatoria.
