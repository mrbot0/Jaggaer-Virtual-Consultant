---
description: Consulente virtuale JAGGAER — stato della sessione (status), diagnosi dell'installazione (doctor), workflow di una sessione (watch), perché di una decisione (why)
argument-hint: status [--metrics] | doctor [--network] | watch <SES.C.AAAAMMGG.NNN> | why <codice>
allowed-tools: Bash(node *)
---

Comandi diretti agli script del plugin, senza sub-agenti (§56). Esegui con lo strumento Bash, senza modificare gli
argomenti, secondo la prima parola di `$ARGUMENTS`:

- `status [--metrics]` (§56.1, §48.2; anche senza argomenti):

      node "${CLAUDE_PLUGIN_ROOT}/scripts/admin/status.mjs" --json            (aggiungi --metrics solo se l'utente l'ha chiesto)

  Riporta cliente, ambiente, scope, modalità, budget, pendenze, piano attivo, ultime 5 decisioni, ultime 3 sorprese,
  salute della conoscenza (quarantene oltre 2 settimane) e coda Xray; con --metrics le metriche di §35.
- `doctor [--network]` (§55.2, §58):

      node "${CLAUDE_PLUGIN_ROOT}/scripts/admin/doctor.mjs" --json            (aggiungi --network solo se l'utente l'ha chiesto)

  Riporta una riga per controllo non verde (stato, controllo, dettaglio, correzione) e l'esito. exit 3 = almeno un
  rosso: **non si continua** finché non è corretto (deve essere tutto verde prima di lavorare). Il controllo `browser`
  è sempre giallo (il plugin non può sondare il browser): si verifica in sessione con `/use env <id>` ed env-check.
  `integrity` rosso = pacchetto manomesso: i guard negano tutto, si reinstalla dalla release firmata e non si opera.
  Le credenziali compaiono solo per NOME: non chiedere né mostrare mai i valori.
- `watch <SES.C.AAAAMMGG.NNN>` (sola lettura, anche da un'altra sessione):

      node "${CLAUDE_PLUGIN_ROOT}/scripts/admin/workflow.mjs" watch <codice> --json

- `why <codice>`:

      node "${CLAUDE_PLUGIN_ROOT}/scripts/decide/why.mjs" <codice> --db customers/<cliente attivo>/knowledge.db --root customers/<cliente attivo> --json

Qualunque altro sottocomando: mostra la sintassi (`status [--metrics]`, `doctor [--network]`, `watch <SES…>`, `why <codice>`).
