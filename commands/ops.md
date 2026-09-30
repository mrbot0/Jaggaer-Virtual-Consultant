---
name: ops
description: Operatività JAGGAER — creare in bozza con compensazione, approvare, chiudere, pubblicare (mai in produzione) e interrogare Analytics in sola lettura (ops)
argument-hint: esplora <modulo> | crea <richiesta|ordine|fornitore|evento|contratto> <dettagli> | approva <riferimento> | chiudi <riferimento> | pubblica <riferimento> | query "<domanda>" | tables | learn-analytics
allowed-tools: Bash(node *), Read
---

Modalità Operativa e Analytics (§56.6, §29, §20.5). `<C>` è il cliente attivo, l'ambiente quello dichiarato con
`/use env` (verificato). La prima parola di `$ARGUMENTS` è l'azione.

## Prima di ogni azione di scrittura (`crea`, `approva`, `chiudi`, `pubblica`)

1. Stato di sessione (ambiente e tipo):

       node "${CLAUDE_PLUGIN_ROOT}/scripts/admin/session.mjs" show --session "${CLAUDE_SESSION_ID}" --json

2. **Rifiuta prima di ogni dispatch** se `env.type` è `prod`: "In produzione non si scrivono dati; posso farlo in sandbox
   o pre-produzione" (§52.1). Nessun ambiente dichiarato ⇒ chiedilo (`/use env <id>`); non partire mai senza.
3. Intento e dati (DT-026: avvia · mostra-piano · chiedi · rifiuta): scrivi il testo della richiesta dell'utente, così
   com'è, in `customers/<C>/.sessions/<sessione>/intento.txt` (il testo libero non va mai in linea: virgole, accenti e
   punti interrogativi rendono il comando non semplice e i guard lo negano), poi:

       node "${CLAUDE_PLUGIN_ROOT}/scripts/decide/intent.mjs" --text-file customers/<C>/.sessions/<sessione>/intento.txt --session "${CLAUDE_SESSION_ID}" --json

   `rifiuta` ⇒ riporta il motivo; `chiedi` ⇒ chiedi i dati mancanti a lotti; la parola "cancella" non esiste
   (proponi la compensazione `cancel`).

## Azioni

- `esplora <modulo>` — esplora e **memorizza** un modulo (menu, pagine, pulsanti, campi, tendine) nella conoscenza
  del cliente: `Agent(scope-expert, sonnet)` in modalità `esplorazione` (l'utente l'ha aperta con `ESPLORA SANDBOX` o
  `ESPLORA PREPROD`, poi `/use mode esplorazione`); l'agente scrive con `kb atlas-write`. In pre-produzione solo click
  senza effetto. Mai prod.
- `crea <richiesta|ordine|fornitore|evento|contratto> …` — crea **in bozza** con compensazione registrata prima del
  passo: `Agent(scope-expert, sonnet)` in modalità ops. Sandbox e preprod; **mai prod**. Si ferma allo stato più
  conservativo (bozza) se l'utente non dice "fin dove". Nessuna approvazione per la sola bozza in sandbox (piano mostrato).
  Il piano si compone dalla memoria (procedura FLW già imparata, oppure SEL/FLD dell'esplorazione); in pre-produzione
  l'utente scrive `APPROVO PIANO <PLAN>` e poi `sì` prima dell'invio finale. Se mancano pagine, prima `esplora`. A esito
  verde l'agente memorizza la procedura (`kb atlas-write --from-plan`): la volta dopo cambiano solo i dati.
- `approva · chiudi · pubblica <riferimento>` — azioni R2: `Agent(scope-expert, sonnet)` in modalità ops, con
  approvazione (il `sì` dell'utente alla domanda del workflow, che mostra importo, stato di arrivo e compensazione).
  In sandbox; in preprod **solo con il referente del cliente**: chiedi all'utente di confermare il referente presente e
  mettilo nei vincoli del prompt. Mai prod.
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
  `subagent_type` è `jaggaer-virtual-consultant:<agente>`. I guard negano comunque le scritture in prod e fuori cella:
  riporta il motivo, non aggirarlo.
