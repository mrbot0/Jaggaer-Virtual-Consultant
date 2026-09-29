---
name: token-economy
description: Metodo per lavorare dentro budget rigidi — tier di modello (script, T0 haiku, T1 sonnet, T2 opus) e DT-003, le tredici leve di risparmio, i limiti per classe d'azione, per compito, per sessione (80% ⇒ haiku) e per documento (80k, 3k per unità), i rilevatori di spreco. Usala quando pianifichi un compito e ne stimi il costo, quando il budget dell'header si avvicina, quando scegli fra aprire un file o usare il summary, quando una digestione di documento si ferma al budget, quando decidi il tier di un dispatch o valuti una de-escalation.
---

# token-economy — pensare quanto serve, spendere quanto è permesso (§25, §29.10)

I budget non sono stime: sono **limiti**, imposti da hook e script, e nessun agente li alza. Un compito che non ci
sta nel budget si **ridisegna** (meno passi, più `STR-REPLAY`, meno esplorazione), non si finanzia.

## I tier (§25.1)

| Tier | Modello | Per cosa |
|------|---------|----------|
| −1 | nessuno (script) | tutto ciò che è codificato: check, step-check, osservazioni, Xray, compilazione, dt-eval, self-check, reindex, lint |
| T0 | haiku | parsing, naming, classificazione con regole chiuse, triage non ambiguo, Defect da finding, summary, forma delle lezioni, `STR-REPLAY` |
| T1 | sonnet | estrazione strutturata, generazione da template, healing, validazione di lezioni, query standard, esecuzione di configurazioni progettate, `STR-VERIFY-FIRST`, `STR-DRY-RUN` |
| T2 | opus | digestione, profilazione, mappa dei processi, ammissione ai cluster, progettazione, root cause, digestione settimanale, contraddizioni, `STR-TRIANGULATE`, terza sorpresa |

La prima leva è non usare un modello: se uno script sa farlo, lo fa lo script.

## Scegliere il tier: DT-003 (§25.2)

Input: rischio, novità del compito (≥ 3 esiti ok · 1–2 · mai), **forma epistemica del soggetto**, necessità di
sintesi (codice/lista · artefatto · giudizio/progetto), volume, e il prior del tasso di escalation su quel tipo di
compito. Bande: < 0.30 T0 · 0.30–0.60 T1 · > 0.60 T2. Il tier lo sceglie il manager prima del dispatch; tu lo
ricevi nell'header e non lo cambi. **Escalation**: una sola per compito, con l'output parziale; la seconda diventa
una domanda all'utente. **De-escalation**: un compito eseguito tre volte a un tier con esiti confermati e output
diventati artefatti codificati scende di tier.

## Le tredici leve (§25.3), come comportamenti

1. Script al posto del modello, sempre quando esiste.
2. Contesto per cella: leggi solo la tua cella (skill `scope-discipline`).
3. Recupero per codice, troncato per W, summary di 60 parole (20 per un FLD): mai file interi "per sicurezza".
4. Il tier giusto per l'attività.
5. De-escalation dei compiti ripetuti.
6. Messaggi con codici: il manager non accumula prosa.
7. Cache su hash: un'unità di documento invariata non si ri-digerisce.
8. Lezioni lette per sezione (frontmatter, 6, 7 prima).
9. Evidenze dichiarate: si cattura ciò che il piano dichiara, non tutto.
10. Digestione a lotti.
11. Budget e stop all'80%.
12. YAML compatto in uscita.
13. `STR-REPLAY` sui soggetti consolidati con precedente: il ragionamento è proporzionale a ciò che non si sa.

## I limiti rigidi (§29.10)

| Livello | Limite | Chi lo impone | Al superamento |
|---------|--------|---------------|----------------|
| per classe di azione | il budget della classe nel catalogo delle azioni (ridotto dal moltiplicatore dell'ambiente) | guard-budget al dispatch, subagent-trace a consuntivo | il sub-agente si ferma, il compito torna `partial` |
| per compito | somma delle azioni del piano + 20% | guard-budget | come sopra |
| per sessione | 200k di default, lo cambia solo l'utente | guard-budget | all'80% il dispatch passa a haiku e il manager chiede se continuare; al 100% nessuna nuova invocazione |
| per documento | 80k per documento, 3k per unità | lo script di digestione | si ferma al lotto corrente e riprende dal cursore alla sessione successiva |

Gli script accettano solo di **abbassare** questi limiti, mai di alzarli.

## Da sub-agente: auto-limitarti

- Il budget del compito è nell'header (`budget.tokens`, `budget.minutes`). Prima di un passo costoso chiediti se ci
  sta; se no, restituisci `status: partial` con ciò che hai e il piano per il resto, **prima** di superarlo.
- Non chiedere più budget e non cercare di cambiarlo: il comando che lo cambia è negato ai sub-agenti.
- Oltre al budget valgono i limiti per dispatch (chiamate di strumento e minuti) fissati dall'utente: oltre, ogni
  chiamata è negata e il compito torna `partial`.

## I rilevatori di spreco (self-check e manager)

| Spreco | Effetto |
|--------|---------|
| la stessa query kb ripetuta con gli stessi argomenti nel compito | controllo fallito: usa il risultato precedente |
| un file aperto quando il summary bastava (nessun campo usato nel risultato) | segnalato; spinge DT-023 verso "rapida" |
| snapshot della stessa pagina ripetuti senza azione in mezzo | controllo fallito |
| deliberazione profonda su un soggetto consolidato con precedente | declassamento alla prossima invocazione |
| escalation di tier su un compito ripetitivo | calibrazione mensile di DT-003 |
| report o lezione più lunghi del template | riformattazione |

## Gli indicatori (§25.4)

Quota di lavoro T0 più script ≥ 70%; costo per artefatto promosso decrescente; costo di un compito ripetuto rispetto
alla prima volta ≤ 0.3; token del manager ≤ 15% (R5). Se il tuo compito è ripetitivo e costa come la prima volta,
qualcosa manca: un precedente non letto, un CHK non eseguito, una strategia sbagliata.

## Errori tipici

- "Ho già speso molto, finisco": è il bias del costo affondato; all'80% si ferma e si chiede.
- Aprire l'Atlas o un documento interi invece di chiedere per codice.
- Rilanciare la stessa ricerca con parole diverse invece di usare `kb resolve` una volta con una domanda chiara.
