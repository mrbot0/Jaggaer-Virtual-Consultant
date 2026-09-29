---
description: Consulente virtuale JAGGAER — stato della sessione (status), console degli agenti (agents), diagnosi dell'installazione (doctor), workflow di una sessione (watch), perché di una decisione (why)
argument-hint: status [--metrics] | agents [show <task_id> | history [--scope <S>] [--last <N>]] | doctor [--network] | watch <SES.C.AAAAMMGG.NNN> | why <codice>
allowed-tools: Bash(node *)
---

Comandi diretti agli script del plugin, senza sub-agenti (§56). Esegui con lo strumento Bash, senza modificare gli
argomenti, secondo la prima parola di `$ARGUMENTS`:

- `status [--metrics]` (§56.1, §48.2; anche senza argomenti):

      node "${CLAUDE_PLUGIN_ROOT}/scripts/admin/status.mjs" --json            (aggiungi --metrics solo se l'utente l'ha chiesto)

  Riporta cliente, ambiente, scope, modalità, budget, pendenze, piano attivo, ultime 5 decisioni, ultime 3 sorprese,
  salute della conoscenza (quarantene oltre 2 settimane) e coda Xray; con --metrics le metriche di §35. **Senza
  argomenti** (`/vc`, il punto di partenza, §56.1) riporta in breve lo stato di sessione e poi le **azioni suggerite**
  (campo `suggested`: cosa fare adesso, in ordine, con il perché), così come le restituisce lo script.
- `agents [show <task_id> | history [--scope <S>] [--last <N>]]` (WP10d, docs/orchestration.md) — la console degli
  agenti: cosa fa ogni sub-agente adesso e cosa ha fatto, ricavato solo dalle registrazioni degli hook (mai dal tuo
  testo né dai rapporti degli agenti):

      node "${CLAUDE_PLUGIN_ROOT}/scripts/admin/agents.mjs" status --session "${CLAUDE_SESSION_ID}" --json            (agents senza argomenti)
      node "${CLAUDE_PLUGIN_ROOT}/scripts/admin/agents.mjs" show <task_id> --session "${CLAUDE_SESSION_ID}" --json    (cronologia completa di un compito)
      node "${CLAUDE_PLUGIN_ROOT}/scripts/admin/agents.mjs" history --session "${CLAUDE_SESSION_ID}" --json           (aggiungi --scope / --last se richiesti)

  Riporta una riga per agente (task_id, tipo, scope, tier, stato, durata, budget/usato, ultima azione, sorprese,
  domande aperte) e la sintesi; segnala in evidenza gli agenti `incoerente` (rapporto diverso dalle registrazioni),
  gli scope bloccati dalla vigilanza, la catena di audit interrotta e gli avvisi sul manager (quota R5, comandi di
  dominio senza dispatch). Per seguire gli agenti mentre lavorano, l'utente usa un terminale separato (sola lettura,
  senza modello):

      node "${CLAUDE_PLUGIN_ROOT}/scripts/admin/agents.mjs" watch --session <SES.C.AAAAMMGG.NNN> --interval 5

  Il controllo sugli agenti lo esercita l'utente scrivendo, come unico testo del suo messaggio, `PAUSA AGENTE <task_id>`,
  `PAUSA TUTTI`, `RIPRENDI AGENTE <task_id>`, `RIPRENDI TUTTI`, `FERMA AGENTE <task_id>`, `FERMA TUTTI`,
  `PASSO PASSO <task_id|TUTTI>` (ogni azione con effetto attende il suo `sì`), `PASSO PASSO OFF`, `SBLOCCA SCOPE <S>`
  (dopo il blocco della vigilanza), `LIMITI DISPATCH <chiamate> <minuti>` (default 200 chiamate e 30 minuti per
  dispatch). Le applicano i guard: tu le spieghi se servono, riferisci l'esito, non scrivere mai tu queste frasi
  (sono negate in ogni input di strumento) e non aggirare un agente in pausa o fermato.
- `doctor [--network]` (§55.2, §58):

      node "${CLAUDE_PLUGIN_ROOT}/scripts/admin/doctor.mjs" --json            (aggiungi --network solo se l'utente l'ha chiesto)

  Riporta una riga per controllo non verde (stato, controllo, dettaglio, correzione) e l'esito. exit 3 = almeno un
  rosso: **non si continua** finché non è corretto (deve essere tutto verde prima di lavorare). Il controllo `browser`
  è sempre giallo (il plugin non può sondare il browser): si verifica in sessione con `/use env <id>` ed env-check.
  `integrity` rosso = pacchetto manomesso: i guard negano tutto, si reinstalla dalla release firmata e non si opera.
  Le credenziali compaiono solo per NOME: non chiedere né mostrare mai i valori. `deps` rosso = dipendenze non
  installate: l'utente esegue `npm install` nella cartella del plugin (i guard le importano e senza negano ogni
  chiamata). `plugin-root` giallo = la sostituzione di `${CLAUDE_PLUGIN_ROOT}` con il percorso letterale nei comandi non
  è ancora provata (nessun comando del plugin in audit: si riesegue dopo un altro comando) o non avviene (segnaposto
  rimasto nei comandi eseguiti: le operazioni a forma esatta — purge, retention, promozione — sono negate; manuale §58).
- `watch <SES.C.AAAAMMGG.NNN>` (sola lettura, anche da un'altra sessione):

      node "${CLAUDE_PLUGIN_ROOT}/scripts/admin/workflow.mjs" watch <codice> --json

- `why <codice>`:

      node "${CLAUDE_PLUGIN_ROOT}/scripts/decide/why.mjs" <codice> --db customers/<cliente attivo>/knowledge.db --root customers/<cliente attivo> --json

Qualunque altro sottocomando: mostra la sintassi (`status [--metrics]`, `agents [show <task_id> | history]`, `doctor [--network]`, `watch <SES…>`, `why <codice>`).
