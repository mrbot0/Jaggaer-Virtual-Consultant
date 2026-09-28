---
description: Consulente virtuale JAGGAER — diagnosi dell'installazione (doctor), workflow di una sessione (watch), perché di una decisione (why)
argument-hint: doctor [--network] | watch <SES.C.AAAAMMGG.NNN> | why <codice>
allowed-tools: Bash(node *)
---

Comandi diretti agli script del plugin, senza sub-agenti (§56). Esegui con lo strumento Bash, senza modificare gli
argomenti, secondo la prima parola di `$ARGUMENTS`:

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

Qualunque altro sottocomando: mostra la sintassi (`doctor [--network]`, `watch <SES…>`, `why <codice>`). `status` arriva
con scripts/admin/status.mjs (WP09d).
