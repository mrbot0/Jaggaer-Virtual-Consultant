---
name: evidence-and-xray
description: Metodo per le evidenze e l'ALM — i sette tipi di punto di evidenza (failure sempre attivo) e la selezione con DT-009, la cattura di regione con mascheratura prima dello scatto, i tre sink (dossier, desk, Xray con una Test Execution per run e per scope), il contratto AlmAdapter (nessuna cancellazione, nessun Incident, coda offline), il Defect da un finding, l'ordine di lettura dei report di azione e di test. Usala quando catturi un'evidenza durante un passo, quando selezioni o pubblichi le evidenze di un run, quando costruisci o apri un Defect, quando pubblichi su Xray o riprovi la coda, quando leggi un report di test o d'azione.
---

# evidence-and-xray — evidenze, ALM, report (§27.5, §29.8, §46.5)

Un'evidenza serve a chi deve fidarsi di un esito senza rifare il lavoro. Si cattura ciò che il piano dichiara (non
tutto), si maschera **prima** di scrivere, si pubblica solo ciò che è certamente pulito.

## I punti di evidenza e la selezione (DT-009)

Sette tipi di punto: `failure` (sempre attivo, vale sempre) · `transition` · `assertion` · `integration` ·
`snapshot` · `input` · `entry`. Ogni passo del piano dichiara i suoi punti (`evidence: [{ at, kind, capture, region,
caption, redact }]`); le classi d'azione dichiarano le evidenze minime (skill `jaggaer-configuration` per le
configurazioni). DT-009 assegna a ogni candidata un punteggio (tipo di punto, richiesta dalla classe d'azione,
citata da un finding, non duplicata): la lista tiene le candidate sopra soglia, in ordine.

## Catturare: regione, maschere, poi lo scatto

1. `capture prepare` calcola i parametri dello screenshot di regione per lo strumento MCP del browser e le
   **maschere** richieste (campi sensibili per selettore dalla carta d'identità; e-mail, partite IVA, codici
   fiscali, IBAN, telefoni; importi in profilo strict):

       node "${CLAUDE_PLUGIN_ROOT}/scripts/chrome/capture.mjs" prepare --plan <piano> --step <n> --run <RUN> --json

2. lo screenshot lo fa lo strumento MCP del browser, con quei parametri (nessuno script nella pagina);
3. `capture record` applica maschere e contorno sul file, calcola lo sha256 e scrive i metadati EVD.

Profilo **strict** sempre in produzione e verso Jira. Ciò che non si riesce a mascherare con certezza resta nel
dossier e **non** si pubblica (skill `data-safety`).

## I tre sink

| Sink | Cosa contiene | Regola |
|------|---------------|--------|
| **dossier** | tutte le evidenze del run | sempre, su disco nel run |
| **desk** | le pubblicabili, in un foglio dei provini HTML offline release → scope → caso | niente risorse esterne |
| **xray** | le pubblicabili, profilo strict, un numero massimo per caso | **una Test Execution per run e per scope**, evidenze sul passo, formato nativo |

La selezione la fa `scripts/evidence/select.mjs` (scrive la selezione nel run); il foglio dei provini
`scripts/evidence/contact-sheet.mjs`; la pubblicazione `scripts/xray/publish.mjs` e la verifica di rilettura
`scripts/xray/verify.mjs`. Jira irraggiungibile ⇒ **coda offline** e uscita 0: il run non fallisce per l'ALM;
`scripts/xray/retry-queued.mjs` la riprova più tardi. Le credenziali stanno solo nelle variabili d'ambiente: mai
stamparle, mai chiederle.

## Il contratto AlmAdapter (§46.5)

L'adattatore espone: autenticazione, lettura e ricerca di test, creazione di una Test Execution, import dei
risultati, **creazione di un Defect**, collegamento fra issue. **Sono assenti per costruzione**: ogni cancellazione,
l'aggiornamento di risultati altrui, la creazione di un Incident. Due implementazioni (cloud, server) scelte dalla
configurazione del cliente; un mock per i test di contratto. Un solo ruolo ha gli strumenti MCP dell'ALM (chi
costruisce i Defect); gli altri pubblicano tramite gli script.

## Dal finding al Defect (§30.4)

Un Defect nasce da un finding classificato `product-defect` o `regression`, **mai un Incident**, mai per un errore
d'ambiente o per un test difettoso. Contiene: evidenze strict, passi minimi per riprodurre, riferimento alla fonte
tecnica o d'uso del comportamento atteso, etichetta `scope:<S>`, e — se il precedente è un Defect chiuso come fixed —
"regression of <chiave> (fixed in <release>)". Si costruisce con lo script dal file del finding; il testo libero non
passa mai sulla riga di comando (`--summary-file` con un file preparato):

    node "${CLAUDE_PLUGIN_ROOT}/scripts/xray/defect.mjs" --finding customers/<C>/runs/<RUN>/findings/<id>.yaml --customer <C> --json

Si apre nell'ALM solo dopo che l'utente l'ha visto e il manager ha dato il via. Un Defect **aperto** con lo stesso
sintomo esiste già? Allora non se ne crea un altro: si propone di aggiungere le evidenze a quello.

## Leggere i report (§29.8)

**Report d'azione** (operatività, configurazione), in quest'ordine: ambiente (e impronta verificata) → intento →
piano (classi d'azione, strategia) → approvazioni → esecuzione passo per passo con evidenze e compensazioni →
sorprese, novità, errori → **esito** con l'atteso dichiarato → entità create e compensazioni pendenti → budget →
lezione → prossimi passi.

**Report di test** (NRT): **verdetto per scope** → esiti (pass, fail, flaky, inconcludenti, errori attesi ricevuti)
→ fallimenti con la classificazione e l'azione intrapresa (Defect, PR di healing, quarantena) → errori della
piattaforma attesi e inattesi → copertura (capability del delta, handoff, risk mode) → evidenze e Test Execution →
budget → lezioni. Niente narrativa: verdetto, Defect, PR, lacune di copertura — le tre cose che decidono una release.

Gli esiti hanno una tassonomia chiusa (§29.9): un errore atteso e ricevuto è `EXPECTED-ERROR-AS-SUCCESS` (pass
pieno); un errore d'ambiente è `ERROR-ENVIRONMENT` e non diventa mai un Defect.

## Errori tipici

- Catturare tutta la pagina "per sicurezza" invece della regione dichiarata.
- Pubblicare un'evidenza con testo libero lungo non mascherabile.
- Aprire un Defect prima che l'utente l'abbia visto, o un Incident.
- Trattare la coda offline come un fallimento del run.
