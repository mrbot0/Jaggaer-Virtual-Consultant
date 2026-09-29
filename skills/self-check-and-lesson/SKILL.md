---
name: self-check-and-lesson
description: Metodo per chiudere un compito — auto-verifica codificata con self-check (i dieci controlli di §17.1, il controllo 11 sul report RPT e i rilevatori di spreco) e lezione a otto sezioni da templates/lesson.md con gli esiti attesi di ogni DEC con effetti. Usala al passo RIFLETTERE di ogni compito, prima di emettere il rapporto finale; quando un controllo fallisce o il self-check esce con codice 3; quando il ruolo ha solo Read e Bash e la lezione va come bozza in output.lesson_draft; quando validi lezioni altrui (DT-004 legge frontmatter e sezioni 6-7).
---

# self-check-and-lesson — auto-verifica e riflessione (§17, §21)

Un risultato non verificato e una lezione non scritta rendono il compito inutile per chi viene dopo. Entrambi sono
obbligatori, entrambi sono controllati dal codice: SubagentStop respinge un rapporto senza `cognitive_trace` e
`lesson`, e il self-check blocca l'invio se un controllo fallisce.

## 1. L'auto-verifica: uno script, non un prompt (§17.1)

Scrivi la bozza del rapporto in un file della tua cartella di lavoro, poi:

    node "${CLAUDE_PLUGIN_ROOT}/scripts/decide/self-check.mjs" --report customers/<C>/.sessions/<sid>/work/<task>/report.yaml --session customers/<C>/.sessions/<sid>/session.json --audit customers/<C>/audit/<mese>.jsonl --db customers/<C>/knowledge.db --lesson customers/<C>/lessons/<LSN>.md --depth <profondità> --json

(aggiungi `--plan <piano>` se hai eseguito un piano). Uscita: `{ passed, failed[], blocked, status_effective,
trace_self_check }`. `trace_self_check` va **così com'è** in `cognitive_trace.self_check`.

| # | Controllo | Se fallisce |
|---|-----------|-------------|
| 1 | ogni codice citato esiste | blocco |
| 2 | nessuna lettura fuori cella (dall'audit) | blocco e segnalazione |
| 3 | ogni entità creata ha compensazione registrata | blocco |
| 4 | ogni decisione con effetti ha una DEC con tabella e strategia; ogni passo del piano ha un `expect` | blocco |
| 5 | ogni DEC con effetti ha un esito atteso dichiarato | blocco |
| 6 | le sorprese di sessione sono tutte in CTR | blocco |
| 7 | forma epistemica iniziale e finale registrate | blocco |
| 8 | risultato in YAML compatto con codici, non prosa | riformatta |
| 9 | la lezione esiste, con otto sezioni e la sezione 7 non vuota | blocco |
| 10 | esito `ok` con `open_questions` solo non bloccanti | riclassifica `partial` |
| 11 | ogni azione ha un report (RPT, §29.8) | blocco |
| — | spreco (§29.10): stessa query kb ripetuta, snapshot ripetuti senza azione | controllo fallito |

La profondità decide quali controlli girano: `rapida` 1, 3, 9, 11; `standard` e `profonda` tutti. `self_check.passed`
del rapporto conta i controlli eseguiti e superati (al più 10) — mai quelli che non hai eseguito.

**Exit 3 = bloccato**: non inviare `ok`. Correggi ciò che il controllo indica (una DEC senza esito atteso, una
compensazione mancante, una sezione 7 vuota) e riesegui; se non è correggibile nel compito, l'esito è `partial` con
il controllo fallito dichiarato.

## 2. La lezione a otto sezioni (§21.1)

Parti da `templates/lesson.md` (frontmatter + otto sezioni) e scrivila in `customers/<C>/lessons/<LSN>.md` con il
codice che ti dà l'header (`inputs.lesson_code`) o il successivo libero; `status: proposed` (lo cambia solo la
validazione).

| Sezione | Cosa ci va | Da dove |
|---------|-----------|---------|
| frontmatter | agente, sessione, compito, scope, modalità, `decision_refs`, strategia, forma prima/dopo, sorprese, **`expected_outcomes`**, confidenza, ipotesi di portabilità, cluster proposto | la traccia |
| 1 Contesto | soggetto, azione, rischio, modalità come situati | passo 1 |
| 2 Cosa ho tentato | strategia e passi, con i codici | passi 4–5 |
| 3 Cosa ho osservato | sorprese e novità con codici OBS/CTR; ipotesi escluse e perché | passo 5 |
| 4 Decisioni prese | una riga per DEC: tabella, input principali, prior, punteggio, strategia | dt-eval |
| 5 Esito | status del compito ed esito atteso di ogni DEC con effetti | passo 6 |
| 6 Lezione | le tre domande obbligatorie (sotto) | riflessione |
| 7 Cosa NON generalizzerei | le scelte che dipendono da faccette del cliente (F5, F6, F7) e quelle che no | **mai vuota** |
| 8 Domande aperte | ciò che resta da chiarire | gaps residui |

Le tre domande della sezione 6 (§17.2):

- cosa mi ha sorpreso, e cosa avrei dovuto sapere per non esserne sorpreso? (di norma un gap: un'osservazione o una
  domanda da fare prima);
- quale precedente mi ha aiutato, e quale mi avrebbe fuorviato? (alimenta DT-018);
- quale controllo, eseguito prima, avrebbe reso questo compito banale? (un CHK candidato).

**Esiti attesi**: per ogni DEC con effetti una riga `{ decision: <DEC>, expect: "<fatto verificabile>" }`. "Andrà
bene" non è verificabile; "la verifica di configurazione del piano è verde entro la sessione" sì. Senza esiti attesi
la validazione rifiuta la lezione (`rejected: non verificabile`).

Le lezioni di successo sono brevi (sezioni 3–5 in tre righe) ma esistono: sono le conferme che alzano la
portabilità (R10 di §26.2).

## 3. Ruoli con soli Read e Bash: la bozza nel rapporto

Chi non ha Write (ruoli T0 di triage, audit e Defect) non scrive file: mette la lezione come bozza a otto sezioni in
`output.lesson_draft`, con il codice di `inputs.lesson_code`, ed esegue l'auto-verifica ridotta ragionando sul
rapporto (controlli 1, 3, 9, 11). Il manager scrive il file della lezione da `templates/lesson.md` e ripassa il
rapporto con lo script: la bozza deve quindi essere completa e con gli esiti attesi, non un riassunto.

## 4. Validare le lezioni altrui (DT-004, §21.2)

Chi valida legge **prima** frontmatter e sezioni 6–7, poi il resto. Controlli e rifiuti: forma (otto sezioni,
frontmatter completo, codici esistenti); fondatezza (ogni affermazione della 6 sostenuta da OBS, DEC o esecuzione);
novità (una lezione che duplica una validata si fonde, +1 conferma); confini (niente `analysis/`, altri clienti,
fuori scope senza handoff); portabilità (sezione 7 coerente con l'ipotesi); **esiti attesi** per ogni DEC con
effetti; azionabilità (almeno un artefatto candidato, altrimenti `validated: inerte`). Il confronto con il registro
delle ipotesi e con le OBS della sessione smaschera la narrazione a posteriori (§17.3).

## Errori tipici

- Compilare `self_check` a mano o con controlli non eseguiti.
- Una sezione 7 generica ("dipende dal cliente"): nomina le faccette.
- Esiti attesi non verificabili o assenti per DEC con effetti.
- Una lezione che racconta una linea retta quando la sessione ha registrato sorprese e ipotesi scartate.
