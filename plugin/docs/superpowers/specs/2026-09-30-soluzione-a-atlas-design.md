# Soluzione A — mappa di JAGGAER costruita da script e piano composto da script

Stato: **proposta da approvare** · ramo `feature/soluzione-a-atlas` · data 30/09/2026.
Il merge su `main` lo fa l'utente; nessun push dal ramo senza sua richiesta.

## 1. Obiettivo

Oggi (soluzione B) l'agente esplora e **descrive a mano** ciò che vede in una bozza (`kb atlas-write`), e compone a mano
il piano di "crea ordine". Con la soluzione A queste due cose le fa **codice deterministico**:

1. ogni pagina vista in esplorazione viene registrata automaticamente (struttura, non dati) insieme ai click che
   portano da una pagina all'altra;
2. uno script trasforma le registrazioni in selettori (SEL), campi (FLD) e percorsi di navigazione (FLW);
3. uno script compone il piano di un'attività ("crea ordine", "crea contratto") dalla mappa e dai dati dell'utente,
   oppure dice esattamente cosa manca (campi obbligatori senza dato, pagine da esplorare).

Criterio di successo: su un tenant esplorato, "crea ordine <dati>" produce un piano valido **senza che l'agente scriva
selettori o passi**; l'utente approva, l'agente esegue come oggi.

**Non cambia**: controlli di sicurezza, frasi, approvazioni (`APPROVO PIANO`, `sì` all'invio), step-check,
validate-plan, regole degli ambienti. La soluzione B resta come ripiego (bozza a mano con `atlas-write`).

## 2. Componenti

### A1 — Registro dell'esplorazione (hook `observe-append`, esteso)

- A ogni lettura **completa** di una pagina (snapshot) già elaborata da `observe-append`, con sessione e cliente attivi,
  si aggiunge una riga a `customers/<C>/.sessions/<sid>/atlas/pages.jsonl`:
  `{ ts, url_path, page_sig, title, elements: [{ i, parent, role, name, required, disabled, checked, level }] }`.
- A ogni **click** consentito su un elemento dell'ultimo snapshot si aggiunge `{ ts, kind: "click", from_sig,
  target: { role, name } }`; la pagina successiva chiude l'arco (lo ricostruisce lo script A2 dall'ordine delle righe).
- **Solo struttura, mai dati**:
  - nessun `value` dei campi;
  - niente elementi dentro righe e celle di tabelle o griglie, che sono record, salvo le intestazioni di colonna;
  - nomi redatti con il profilo di evidenza dell'ambiente (strict in pre-produzione);
  - URL ridotto al percorso, senza query.
- Limiti: al più 300 elementi per pagina, file ≤ 20 MB per sessione (oltre: righe scartate con un avviso nel log).
- Il file è **protetto in scrittura** dai guard come gli altri file del monitor (né agenti né manager possono
  alterarlo).
- Il registro non modifica mai la decisione del hook: un errore di scrittura è solo un avviso. Il tempo resta nei limiti
  attuali: mediana < 150 ms, verificata da `test:timing`.

### A2 — `atlas-build` (nuovo script, `kb atlas-build`)

`kb atlas-build --session <sid> [--scope <S>]` legge il registro della sessione e scrive nella conoscenza del
cliente, riusando la validazione, i doppioni e i codici di `atlas-write`.

- **SEL**: per ogni pagina, gli elementi interattivi con un nome, per ruolo:
  - pulsanti, link, voci di menu, schede;
  - caselle e opzioni;
  - campi di testo, numero, ricerca, selezione.

  Ogni SEL ha la firma della pagina e l'effetto: `write` se l'etichetta è di un'azione con effetto (lo stesso
  vocabolario dei guard), altrimenti `read`.
- **FLD**: per ogni campo, il documento è il titolo principale della pagina e la sezione il gruppo o l'intestazione
  più vicina. Il tipo si ricava dal ruolo:
  - testo → `text`;
  - numero → `number`;
  - selezione → `list`;
  - casella → `flag`;
  - ricerca → `lookup`.

  L'obbligo è `always` se lo snapshot dice `required`, altrimenti `undocumented`. I valori delle tendine sono le
  opzioni viste a tendina aperta. Ogni FLD è collegato al SEL del suo campo.
- **FLW "Percorso: <pagina>"**: dagli archi dei click, il percorso più breve dalla pagina d'ingresso della sessione a
  ogni pagina raggiunta: `NAVIGATE` all'ingresso, poi un `CLICK` per ogni passaggio, con la firma della pagina attesa
  dopo ogni passo. Un percorso uguale a uno già memorizzato non si riscrive.
- Tutto marcato come osservato (F1 `osservazione-chrome`, F12 `digerito`, F15 `empirica`). L'esito elenca le pagine,
  gli item scritti e quelli scartati come doppioni.

### A3 — `compose-plan` (nuovo script)

`compose-plan --goal "<crea ordine …>" --data <dati.yaml> --scope <S> --env <id> [--fino-a bozza|invio]`

Ordine di ricerca:
1. una **procedura memorizzata** (FLW da un'esecuzione riuscita) il cui titolo corrisponde all'obiettivo: si
   riusano i suoi passi sostituendo i dati;
2. altrimenti la **pagina del modulo**, cioè la pagina il cui titolo corrisponde a oggetto e verbo (ordine/order/PO,
   contratto/contract, richiesta/requisition; crea/nuovo/new). Su quella pagina:
   - il suo percorso;
   - un passo `FILL`/`CHOOSE` per ogni dato, abbinato per etichetta al campo e al suo SEL;
   - `SAVE` sul pulsante di salvataggio della pagina;
   - con `--fino-a invio`, anche `SUBMIT` sul pulsante d'invio.

Il piano ha, per ogni passo, il risultato atteso (pagina, valore del campo) e la compensazione del documento creato
(`cancel`). Viene validato con `validate-plan` prima di essere restituito.

Se qualcosa manca, **nessun piano**: uscita 3 con l'elenco preciso delle mancanze:
- campi obbligatori senza dato → domande per l'utente;
- dati che non corrispondono a nessun campo;
- pagina, percorso o pulsante non ancora visti → "esplora <pagina>".

### A4 — Integrazione

- `scope-expert`, in esplorazione, non scrive più bozze: clicca e, a fine giro, esegue `kb atlas-build`. La bozza a
  mano resta per le correzioni.
- In `ops crea`, prima `compose-plan`; con uscita 3 le mancanze vanno all'utente (domande) o in esplorazione. Poi
  approvazione ed esecuzione come oggi; a esito verde, `atlas-write --from-plan` come oggi.
- Aggiornati `agent-manager`, i comandi `ops`/`kb`, il manuale utente, la guida al primo uso e il manuale di
  riferimento.

## 3. Sicurezza

- Nessun nuovo permesso agli agenti: A2 e A3 sono script del plugin che scrivono solo nella conoscenza del cliente
  attivo (stesso percorso di `atlas-write`) o in `runs/<RUN>/`.
- Il registro A1 è scritto solo dal hook, contiene solo struttura redatta ed è protetto in scrittura.
- Il piano composto passa dagli stessi controlli di un piano scritto a mano: validazione, `APPROVO PIANO`,
  step-check, legame click/SEL, `sì` all'invio. Uno script non può attivare un piano.
- Rischio da verificare dal vivo: JAGGAER può mostrare dati personali anche fuori dalle tabelle (per esempio un nome
  in un'intestazione di pagina). La redazione strict li copre solo se riconoscibili (e-mail, codici…): per questo il
  registro scarta i record delle tabelle e i valori.

## 4. Test

| Parte | Test |
|---|---|
| A1 | snapshot di prova → riga di registro senza valori né righe di tabella, nomi redatti; click → arco; limiti; file protetto in scrittura; tempi di observe-append invariati |
| A2 | registro di prova (pagine "Nuova richiesta", catalogo, impostazioni + click) → SEL, FLD e percorsi attesi; seconda esecuzione senza doppioni |
| A3 | procedura memorizzata → piano con i dati sostituiti; senza procedura → percorso + campi + salva + compensazione; mancanze → uscita 3 con l'elenco; piano valido per `validate-plan` e attivabile da `step-check` in sandbox |
| E2E | esplorazione simulata → `atlas-build` → `compose-plan` → esecuzione simulata come la prova M7 |
| Regressione | suite completa verde, corpus reale compreso, e `test:timing` |

## 5. Consegna e merge

1. Commit locali sul ramo `feature/soluzione-a-atlas`, uno per componente (A1…A4). Nessun push, nessun merge.
2. Prima di consegnare:
   - suite completa verde e `test:timing` verde;
   - integrità rigenerata;
   - revisione di sicurezza indipendente del diff (il hook è la parte delicata), con le correzioni.
3. L'utente riceve il riepilogo (cosa cambia, test, rischi) e **fa lui il merge**.
4. Taratura: le regole di A1/A2 (quali ruoli, come si riconoscono sezioni e tendine) vanno ricontrollate sulle prime
   pagine vere del tenant.

## 6. Rischi e limiti

- Struttura reale delle pagine JAGGAER non ancora vista: iframe, identificativi negli URL, tendine che si caricano solo
  aprendole. Le regole andranno tarate dopo la prima esplorazione vera.
- I valori delle tendine si conoscono solo se l'esplorazione le apre.
- L'abbinamento dati→campi è per etichetta: etichette ambigue o duplicate nella stessa pagina producono una mancanza
  (domanda), mai una scelta a caso.
