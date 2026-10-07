---
name: ops
description: Operatività JAGGAER — creare, importare in blocco con template, approvare, chiudere, pubblicare, cancellare in sandbox e pre-produzione, scrivere in produzione solo con approvazione per passo, e interrogare Analytics in sola lettura (ops)
argument-hint: esplora <modulo> | crea <richiesta|ordine|fornitore|evento|contratto> <dettagli> | approva <riferimento> | chiudi <riferimento> | pubblica <riferimento> | query "<domanda>" | tables | learn-analytics
allowed-tools: Bash(node *), Read
---

Modalità Operativa e Analytics (§56.6, §29, §20.5). `<C>` è il cliente attivo, l'ambiente quello dichiarato con
`/use env` (verificato). La prima parola di `$ARGUMENTS` è l'azione.

## Prima di ogni azione di scrittura (`crea`, `approva`, `chiudi`, `pubblica`, import)

1. Stato di sessione (ambiente, tipo e **livello di autonomia**):

       node "${CLAUDE_PLUGIN_ROOT}/scripts/admin/session.mjs" show --session "${CLAUDE_SESSION_ID}" --json

   Il campo `autonomy` dice livello effettivo, scelto, fonte e tetto dell'ambiente. Il livello è `alto` (predefinito),
   `medio` o `basso`: lo sceglie l'utente con la frase di autonomia (vale per la sessione) o con `default:` in
   `customers/<C>/config/autonomy.yaml` (solo l'utente lo scrive; file illeggibile o valore non valido ⇒ `basso`).
   In produzione il livello effettivo non supera `medio`. **Non lo scegli e non lo proponi tu**: lo leggi e ti
   comporti di conseguenza.
2. Ambiente. Nessun ambiente dichiarato ⇒ chiedilo (`/use env <id>`); non partire mai senza. **In produzione i dati si
   scrivono** solo se l'ambiente ha `policy.write_data: true` in `environments.yaml` (interruttore dell'utente) e **sempre
   con piano approvato e approvazione di ogni passo**; le configurazioni in produzione dipendono invece dalle
   approvazioni (piano, prova, passo), non da `write_data`; le cancellazioni in produzione non esistono. Con
   `write_data: false` rispondi "in produzione i dati si scrivono solo con write_data: true; posso farlo in sandbox
   o pre-produzione" (§52.1, rivisto dalla spec 2026-10-06 §3.6). Con `write_data: false` in **qualunque** ambiente
   (anche sandbox, o una pre-produzione copia dei dati reali) import massivi e cancellazioni sono negati (step-check e
   guard): dillo all'utente, che può accendere `write_data` per quell'ambiente.
3. Intento e dati (DT-026: avvia · mostra-piano · chiedi · rifiuta): scrivi il testo della richiesta dell'utente, così
   com'è, in `customers/<C>/.sessions/<sessione>/intento.txt` (il testo libero non va mai in linea: virgole, accenti e
   punti interrogativi rendono il comando non semplice e i guard lo negano), poi:

       node "${CLAUDE_PLUGIN_ROOT}/scripts/decide/intent.mjs" --text-file customers/<C>/.sessions/<sessione>/intento.txt --session "${CLAUDE_SESSION_ID}" --json

   `avvia` ⇒ al livello corrente nulla richiede approvazione: si parte (comunque con piano mostrato);
   `mostra-piano` ⇒ mostra il piano e attendi le approvazioni che la tabella sotto prevede (ogni scrittura in
   produzione è così); `rifiuta` ⇒ riporta il motivo (cancellare in produzione); `chiedi` ⇒ chiedi i dati mancanti a lotti.

## Cosa si chiede (spec 2026-10-06 §2.2)

Le frasi le scrive solo l'utente; tu le descrivi e **mostri la frase esatta nel tuo messaggio**, mai in un comando.

| | sandbox | pre-produzione | produzione (tetto medio) |
|---|---|---|---|
| creare, aggiornare (R1) | nulla | alto: nulla · medio/basso: approvazione del piano | approvazione del piano **e** di ogni passo che modifica |
| inviare, approvare, trasmettere, pubblicare, chiudere, caricare (R2) | alto/medio: nulla · basso: `sì` per passo | alto/medio: coperti dall'approvazione del piano · basso: `sì` per passo | approvazione del piano e di ogni passo |
| configurazione (ACT-CFG-CHANGE) | alto: approvazione del piano · medio/basso: per policy | alto: approvazione del piano · medio/basso: per policy | piano + ogni passo (+ istantanea prima) |
| import massivi (ACT-BULK) | alto: nulla · medio/basso: piano + ogni passo | alto: nulla · medio/basso: piano + ogni passo | piano + ogni passo, prima del caricamento; oggetti di configurazione: anche l'istantanea dei dati attuali (`--istantanea`) |
| cancellare (ACT-DELETE) | alto: coperte dall'approvazione del piano · medio/basso: + ogni passo | idem | **mai** |

In produzione `sì` non vale: l'approvazione del passo è la frase del passo, monouso e legata al piano. Quando
l'ambiente ha `second_approver_required` (in produzione di norma sì) serve anche l'approvazione della prova da una
persona diversa. Se un agente torna con una richiesta di approvazione (`approval_request`) mostri la frase esatta
all'utente e attendi (skill `agent-manager`, sez. 6). Prima di chiedere l'approvazione di un passo in produzione mostra file, righe e oggetti che toccherà.

## Azioni

- `esplora <modulo>` — esplora e **memorizza** un modulo (menu, pagine, pulsanti, campi, tendine) nella conoscenza
  del cliente: `Agent(scope-expert, sonnet)` in modalità `esplorazione` (l'utente l'ha aperta con `ESPLORA SANDBOX` o
  `ESPLORA PREPROD` — o le varianti `… COMPLETA`, che compilano, salvano e inviano con valori di prova —, poi
  `/use mode esplorazione`); le pagine si registrano da sole e a fine giro l'agente le trasforma
  in mappa con `kb atlas-build`. In pre-produzione solo click
  senza effetto. Mai prod.
- `crea <richiesta|ordine|fornitore|evento|contratto> …` — crea **in bozza** con compensazione registrata prima del
  passo: `Agent(scope-expert, sonnet)` in modalità ops. Sandbox, preprod e — con `write_data: true` e approvazione di
  ogni passo — prod. Si ferma allo stato più conservativo (bozza) se l'utente non dice "fin dove". Nessuna approvazione
  per la sola bozza in sandbox o in pre-produzione con autonomia alta (piano mostrato).
  Il piano lo compone `compose-plan` dalla memoria (procedura FLW già imparata, oppure percorso e campi dell'esplorazione);
  se mancano dati obbligatori li chiede all'utente prima del piano; in pre-produzione
  con autonomia media o bassa l'utente approva il piano e, con bassa, anche l'invio finale. Se mancano pagine, prima `esplora`. A esito
  verde l'agente memorizza la procedura (`kb atlas-write --from-plan`): la volta dopo cambiano solo i dati.
- `approva · chiudi · pubblica <riferimento>` — azioni R2: `Agent(scope-expert, sonnet)` in modalità ops, con
  l'approvazione prevista dal livello (con autonomia bassa il `sì` dell'utente alla domanda del workflow, che mostra
  importo, stato di arrivo e compensazione). In sandbox; in preprod **solo con il referente del cliente**: chiedi
  all'utente di confermare il referente presente e mettilo nei vincoli del prompt. In prod solo con `write_data: true` e
  approvazione di ogni passo.
- `crea` in blocco (`crea N <oggetto>`) — **import massivo con template** (data element, workflow, articoli…): quando per l'oggetto esiste
  un template (`TPL`), la via massiva è sempre preferita a N maschere, anche per un solo record. Ordine:
  1. **Template**: prima quelli dati dall'utente (`customers/<C>/templates-in/`):
     `kb template-learn --file <xlsx> --object "<oggetto>" --scope <S> --page <sig> [--tipo config|dati] --fonte utente`
     (`--page` obbligatorio; `--tipo`: `config`, predefinito, per oggetti di configurazione · `dati` per record di
     business). Il file salvato è sempre senza righe di dati e la voce non conserva valori delle celle; un template con
     l'intestazione su più righe è rifiutato. Se non c'è, l'agente lo scarica dal tenant (click su "scarica template",
     poi `get_network_request` con `responseFilePath` nella cartella della sessione) e lo impara con `--fonte tenant`.
  2. **Compilazione**: `template-fill --tpl <codice> --data <righe.json|yaml> --out runs/<RUN>/import/<file>.xlsx --scope <S>`
     (script `decide/template-fill.mjs`). Controlla ogni riga prima di scrivere (obbligatori, valori ammessi, numeri):
     con errori esce 3 e li elenca, senza toccare il tenant. Stampa percorso, sha256 e righe.
  3. **Piano**: `compose-plan --goal "crea N <oggetto>" … --filled <percorso>:<sha256>:<righe>` (senza `--filled` torna
     la mancanza `fill-template`; `tpl-no-page` ⇒ reimpara il template con `--page`). Passi: pagina di import →
     caricamento → conferma → lettura dell'esito. **Configurazione in produzione** (`TPL` di tipo `config`, anche le
     voci vecchie senza tipo): prima l'export dei dati attuali in `runs/<RUN>/evidence/<file>` (stesso RUN del piano),
     poi `--istantanea runs/<RUN>/evidence/<file>` (senza: mancanza `config-snapshot`); i passi d'import hanno la
     compensazione `restore` su quel file e step-check la verifica prima di ogni passo. In sandbox e pre-produzione
     l'istantanea è facoltativa.
  4. **Esecuzione**: si carica **solo** quel file (percorso assoluto dentro il run attivo, sha256 del piano, un file per
     chiamata); ogni altro file è negato. In produzione il caricamento è ammesso solo in un passo approvato col verbo
     di caricamento.
  5. **Esito**: `import-result (--text-file <file> | --in <log.xlsx>) [--righe <N>]` (script `decide/import-result.mjs`) →
     `ok_rows`, `failed`, `created`, `format_error`, `unrecognized`, `missing`. Una riga "riuscita" con errori,
     avvisi o "ma …" è in `failed`; `unrecognized: true` = nessuna riga né codice riconosciuti: l'esito **non** è un
     successo (rileggi la pagina o il log); `missing` = righe del file (`--righe`) senza esito, da verificare. Righe fallite: si correggono e si reimportano **solo quelle**, al
     massimo 2 volte, poi rapporto. `format_error`: si riscarica il template, lo si reimpara e si ricompila **una volta**,
     poi si chiede all'utente.
  I codici creati entrano nell'elenco finale delle modifiche.
- **Cancellare** (non è un'azione a parte: l'utente lo chiede a parole; solo sandbox e pre-produzione, **mai in
  produzione**, dove l'intento è rifiutato): ammessa solo dentro un passo del piano col verbo di cancellazione e classe ACT-DELETE, **un elemento per passo** (elemento ambiguo
  ⇒ negato; seconda cancellazione nello stesso passo ⇒ negata). Prima del passo: lettura completa dell'oggetto salvata
  in `runs/<RUN attivo>/evidence/` e compensazione `{ kind: restore, ref: runs/<RUN>/evidence/<file> }`. I pulsanti di
  cancellazione di massa (elimina tutti, svuota, purge…) sono sempre negati; l'esplorazione non cancella mai. Se dopo il
  click compare una finestra di conferma nella pagina, è un passo di click a parte, della stessa classe, legato al SEL
  del pulsante di conferma; i dialoghi nativi passano da `handle_dialog` (fuori da un passo ACT-DELETE un dialogo
  che conferma una cancellazione è negato). Un piano di cancellazione **non spunta righe prima**: passi massivi,
  `TOGGLE`/`SELECT` o click su caselle di selezione prima del passo DELETE ⇒ step-check lo nega (più righe ⇒ più
  passi DELETE). Con `write_data: false` per l'ambiente le cancellazioni sono negate.
- `query "<domanda>"` · `tables` · `learn-analytics` — Analytics in **sola lettura**, in tutti gli ambienti (anche prod):
  `Agent(analytics-learner, sonnet)`. Le query passano da `scripts/analytics/query-guard.mjs` (una SELECT con LIMIT,
  testo SQL sempre da file, mai in linea; consegnabile solo se coerente, DT-015); `tables` elenca le TBL note;
  `learn-analytics` impara le tabelle (TBL, join inferiti, DIN con gruppi ≥ 20).

## Regole

- Workflow visibile con i dati da file (mai JSON in linea):

      node "${CLAUDE_PLUGIN_ROOT}/scripts/admin/workflow.mjs" event --kind <tipo> --payload-file customers/<C>/.sessions/<sessione>/workflow-event.json --json

- Ogni azione produce un report (RPT, §29.8) con l'esito classificato; a fine sessione le compensazioni pendenti si
  chiudono con la scelta dell'utente (`compensa tutto` · `lascia <entità>`).
- Prima di un dispatch leggi la sintesi della console (`/vc agents`); prompt da `templates/agent-prompt.md`;
  `subagent_type` è `jaggaer-virtual-consultant:<agente>`. I guard negano comunque ciò che il livello e l'ambiente non
  consentono (scritture in prod senza piano e passo approvati, cancellazioni fuori passo, fuori cella): riporta il
  motivo, non aggirarlo.
- Velocità: `compose-plan` raggruppa i campi di una pagina in un solo passo di compilazione (`fields`, eseguito con
  `fill_form`); click e compilazioni con `includeSnapshot: true` (niente `take_snapshot` separato sulla stessa pagina);
  `step-check` verifica il passo e attiva il successivo nella stessa chiamata (campo `next`): nessun comando in più.
- A fine azione elenca ciò che è stato creato, modificato, importato o cancellato, col livello di autonomia applicato.
