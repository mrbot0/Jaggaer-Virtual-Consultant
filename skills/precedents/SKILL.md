---
name: precedents
description: Metodo per usare lo storico delle decisioni (kb precedents, distanza di contesto, DT-018 replay · orienta · ignora) senza ripetere né ridecidere da zero. Usala al passo RICHIAMARE quando cerchi decisioni passate sullo stesso soggetto o cluster — triage di un fallimento (una regressione si riconosce dal precedente fixed), Defect, healing di un selettore, configurazione già eseguita, lezione che potrebbe duplicarne una validata, profilo o mappa di un cliente simile — e quando devi decidere se un precedente è applicabile qui.
---

# precedents — decidere in base allo storico, senza ripeterlo (§12)

Una decisione passata con esito verificato vale più di dieci pagine di documentazione: dice cosa è successo
davvero. Ma un precedente si **incorpora**, non si ripete: le sue lezioni sono già diventate CHK, deviazioni o
priori. Il tuo lavoro è riconoscere quanto il precedente è vicino, cosa ha insegnato e se vale qui.

## Richiamare

    node "${CLAUDE_PLUGIN_ROOT}/scripts/kb/kb.mjs" precedents <codice> --top 3 --customer <C> --db customers/<C>/knowledge.db --json
    node "${CLAUDE_PLUGIN_ROOT}/scripts/kb/kb.mjs" precedents <codice> --cluster <CL> --top 3 --customer <C> --db customers/<C>/knowledge.db --json

`--top` lo decide la profondità (rapida 1, standard 3, profonda 5 anche di altri clienti). Il risultato è ordinato
per **distanza di contesto** `d` (0 = identico):

```
d = 0.35 × [stesso soggetto 0 · stesso cluster 0.5 · altro 1]
  + 0.25 × distanza di Hamming sulle faccette F5, F6, F7, F10
  + 0.20 × [stesso cliente 0 · altrimenti 1 − portabilità del soggetto]
  + 0.10 × età in release / 3
  + 0.10 × [stessa forma epistemica allora e ora 0 · altrimenti 1]
```

Non ricalcolare `d`: leggila. Serve a capire **perché** un precedente è lontano (altro cliente? forma diversa?).

## Leggere: prima le smentite

A parità di vicinanza **leggi per primi i precedenti smentiti** e le loro note: sono quelli che hanno prodotto un
`CHK`, una deviazione o un cambio di soglia. Una smentita vicina (d < 0.3) con un CHK nato da lei significa: esegui
quel CHK, non ripetere la vecchia scelta. È la regola di spareggio: smentita prima di conferma.

## Cosa fare con ciò che trovi (§12.4)

| Situazione | Comportamento |
|------------|---------------|
| confermato, d < 0.2, stesso cliente | fast path: `STR-REPLAY`, tier T0, stesse scelte, verifica leggera |
| smentito, d < 0.3 | leggi la nota; se ha prodotto un CHK eseguilo; se no `STR-VERIFY-FIRST`, e la lezione spiega perché stavolta dovrebbe andare diversamente |
| solo altri clienti, portabilità condizionata soddisfatta | come precedenti locali, confidenza × 0.8 |
| solo altri clienti, portabilità non soddisfatta o ignota | **ipotesi**: orientano la strategia, non entrano nel prior |
| nessun precedente | prior neutro: decide la forma epistemica |
| precedenti in contraddizione fra loro | cerca la faccetta che li separa (candidata CL-PRT condizionata); se non c'è, `chiedi` |

## Il precedente è applicabile? DT-018 (§15.4)

Quando la decisione dipende da un precedente, applicala con dt-eval (skill `decision-tables`): input distanza,
esito del precedente, se ha già prodotto un CHK o una deviazione incorporata, età, stessa forma. Esiti: `replay`
(riusa le scelte), `orienta` (informa la strategia, non il prior), `ignora`. La classe del precedente più vicino è
anche l'input `--precedent` di strategy-select e di depth, da passare in forma ASCII: `confermato-d-lt-0.2` ·
`confermato-d-lt-0.5` · `nessuno` · `smentito-d-lt-0.3` (oppure `--precedents <file>` con l'uscita di `kb precedents`
salvata).

## Priori: spostano la soglia, non decidono (§12.2)

I tassi di esito (per tabella, cluster, cliente, forma) entrano nelle tabelle come input di prior con peso
dichiarato: `--priors auto` di dt-eval li legge dal registro. Sotto il numero minimo di DEC verificate il prior
vale il suo `neutral` e non sposta nulla. Non stimare tu un tasso e non passarlo a mano se esiste il registro.

## Esiti: chi li registra

Ogni tua `DEC` con effetti dichiara nella lezione l'**esito atteso** ("mi aspetto che la verifica sia verde entro la
sessione"). Non registri tu l'esito della tua decisione: lo registrano l'esecuzione, un umano, una contraddizione
successiva o il tempo (§12.1). Dichiararlo in modo verificabile è ciò che rende utile il precedente di domani.

## Casi tipici per ruolo

- **Triage**: un `product-defect` il cui precedente è un Defect chiuso come `fixed` è una **regressione**: il
  precedente va citato nel finding e nel Defect.
- **Healing**: le riparazioni passate dello stesso selettore dicono quale strategia di localizzazione ha retto.
- **Validazione di lezioni**: una lezione che duplica una validata non è nuova: si fonde (+1 conferma).
- **Configurazione**: un precedente smentito sulla stessa area CL-CFG alza il rischio e chiede la verifica prima.

## Errori tipici

- Ancoraggio: replicare un precedente con d > 0.25 come se fosse identico (§17.3). `STR-REPLAY` solo con d < 0.2.
- Disponibilità: una smentita recente non cancella dieci conferme; il registro usa finestre ampie.
- Leggere i precedenti di un altro cliente aprendo i suoi file: arrivano solo da `kb precedents`, già pesati.
