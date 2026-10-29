# Policy dei guard — capacità per profilo

<!-- generato da scripts/admin/policy-doc.mjs da hooks/lib/policy-profiles.json: non modificare a mano -->

Il profilo della sessione lo decide il codice (`hooks/lib/policy.mjs`): produzione se l'ambiente è di tipo prod; piano se c'è un piano attivo; esplorazione se la modalità è esplorazione in sandbox o pre-produzione; altrimenti standard.

| Profilo | Quando |
|---|---|
| esplorazione | modalità esplorazione aperta dall'utente, ambiente sandbox o pre-produzione, nessun piano attivo |
| piano | un piano attivo (step-check) in sandbox, sviluppo o pre-produzione |
| standard | nessun piano attivo, modalità diversa da esplorazione (nrt, config, ops, diag) |
| produzione | ambiente dichiarato di tipo prod, con o senza piano |

| Capacità | esplorazione | piano | standard | produzione |
|---|---|---|---|---|
| `navigazione_libera` — navigare verso qualunque host, anche fuori da allowed_hosts dell'ambiente | sì | no | no | no |
| `ambiente_non_verificato` — agire anche se env-check non ha verificato l'impronta dell'ambiente | sì | no | no | no |
| `url_ignoto` — agire anche se l'URL della pagina corrente non è noto | sì | no | no | no |
| `scheda_diversa` — agire in una scheda diversa da quella della navigazione registrata | sì | no | no | no |
| `script_nella_pagina` — eseguire script nella pagina (evaluate_script, javascript_tool) | sì | no | no | no |
| `strumenti_non_classificati` — usare strumenti o parametri del browser non classificati | sì | no | no | no |
| `click_liberi` — cliccare e compilare senza snapshot fresco, uid con nome o ref verificato | sì | no | no | no |
| `celle_cliente` — leggere e scrivere la conoscenza di tutti gli scope del cliente attivo (non solo la cella) | sì | no | no | no |
| `dispatch_altro_scope` — invocare un sub-agente su uno scope diverso da quello di sessione | sì | no | no | no |
| `limiti_dispatch_illimitati` — nessun tetto di chiamate o durata per dispatch (salvo LIMITI DISPATCH dell'utente) | sì | no | no | no |
| `cattura_integrale` — salvare il testo di ogni pagina e la mappa del sito in customers/<C>/explore/ | sì | no | no | no |
| `apprendimento_automatico` — atlas-build automatico a fine compito | sì | no | no | no |
| `cancellazioni` — cancellare (Elimina, Cancella, Rimuovi, dialoghi di conferma) senza un passo DELETE del piano | no | no | no | no |
| `caricamento_file` — caricare file locali sul tenant senza un passo UPLOAD del piano | no | no | no | no |
