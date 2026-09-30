# JAGGAER Virtual Consultant

Plugin per Claude Code: un consulente tecnico senior in forma di piattaforma di agenti, per più clienti e per tutti i
moduli JAGGAER. Fa tre cose — **collaudo NRT** delle release (test deterministici ed esplorazione, evidenze, Xray),
**configurazione** dei moduli (procedure standard adattate al custom del cliente, eseguite su Chrome con snapshot,
verifica e approvazione) e **operatività** a richiesta (ordini, documenti, fornitori, casi di test, query Analytics) —
ragionando come un consulente: prima di agire richiama ciò che sa, ciò che è successo e ciò che vede sulla pagina,
valuta quanto conosce il soggetto e ne ricava la strategia. Gli agenti agiscono direttamente su Chrome tramite gli
strumenti MCP; sa in quale ambiente si trova e **in produzione non scrive mai dati**.

Tutto il resto è nel manuale integrato: [docs/MANUAL.md](docs/MANUAL.md).

## Prerequisiti

- Claude Code (desktop o CLI) con un browser: il browser di Claude oppure **Chrome DevTools MCP**. Fuori dalla sandbox
  il browser di Claude può solo leggere e navigare: le azioni con effetto (click, testo, invio) richiedono Chrome
  DevTools MCP.
- Node 22 o successivo, git, accesso al repository di conoscenza, variabili d'ambiente del cliente dal vault
  (`NRT_<ENV>_*`, `XRAY_*`, `JIRA_*`; `JVC_PSEUDO_SALT` per la digestione settimanale e i ticket).
- **`npm ci` nella cartella del plugin** (non `npm install`: `package-lock.json` è sotto integrità e `npm install` può
  riscriverlo, e allora i guard negano tutto): i guard di sicurezza importano le dipendenze di runtime e senza di esse
  negano ogni chiamata; `/jaggaer-virtual-consultant:vc doctor` lo segnala (controllo `deps`).
- Playwright non serve, salvo la corsia compilata opzionale (`npx playwright install chromium`).

Da sapere prima di installare:

- **Gli hook sono difese testuali, non una sandbox**: rendere in sola lettura a livello di sistema operativo la
  cartella del plugin e `~/.claude`, oppure usare le impostazioni gestite (managed settings) di Claude Code.
- **Le credenziali nelle variabili d'ambiente sono leggibili da ogni shell** che il modello avvia: esportare solo
  quelle dell'ambiente su cui si lavora, con utenze di collaudo a privilegi minimi.
- **`JVC_DEV` non va mai impostata sulle macchine degli utenti** (è la variabile dello sviluppo del plugin: salta
  l'integrità e la protezione del codice).
- Claude Code sostituisce `${CLAUDE_PLUGIN_ROOT}` con il percorso del plugin nei comandi: `vc doctor` lo verifica
  (controllo `plugin-root`, [manuale, Appendice B](docs/MANUAL.md#appendice-b--verificare-la-sostituzione-di-claude_plugin_root)).
- **Rischi residui dichiarati** ([manuale, §55.1.2](docs/MANUAL.md#5512-rischi-residui-dichiarati)): i canali che
  consegnano un vero prompt dell'utente (`sendPrompt` di un widget, `send_message` di una sessione) sono aperti finché
  non si dichiara un ambiente — negarli nelle impostazioni del workspace; il nome del secondo approvatore è dichiarato,
  non autenticato (la regola delle due persone è organizzativa); il referente della pre-produzione è solo un avviso; i
  token salati di un cliente cancellato restano in `product/digest/`; la chiave della firma viaggia nel pacchetto e
  `node_modules` è fuori dal perimetro d'integrità (usare `npm ci`); il vocabolario distruttivo del browser è solo
  italiano e inglese (sandbox); con un ambiente dichiarato i server MCP fuori dall'allow-list sono negati; dopo un
  aggiornamento una sessione viva si ripara con `use customer <ID>`; `auth-setup` lascia il file di origine; un POST
  ritentato verso Jira può creare un doppione; in CI passare sempre `--session`; un Jira on-premise richiede una
  release (`NETWORK.md`).
- **Prima del rilascio e dal vivo**: le verifiche che solo una sessione vera, un tenant e un Jira reali o i dati di un
  pilota possono fare sono elencate nel [manuale, §60](docs/MANUAL.md#60-verifiche-prima-del-rilascio-e-dal-vivo)
  (per prima: `/hooks` dopo l'installazione, ogni hook registrato una sola volta).

## Installazione

**Manuale utente completo** (installazione del plugin e del workspace della conoscenza, comandi, agenti, skill, frasi): [MANUALE-UTENTE.md](MANUALE-UTENTE.md).

Primo uso su un tenant reale (esplorare e memorizzare, poi creare ordini e contratti): [guida passo passo](docs/GUIDA-PRIMO-USO.md).

```
1  Installare il plugin (marketplace privato o cartella locale); nella cartella del plugin: npm ci
2  Clonare il repository di conoscenza e aprirlo come workspace di Claude Code
3  Copiare templates/settings.template.json del plugin in .claude/settings.json del workspace
4  Esportare le variabili d'ambiente del cliente (NRT_<ENV>_*, XRAY_*, JIRA_*)
5  Avviare Claude Code nel workspace
6  /jaggaer-virtual-consultant:vc doctor         → tutto verde prima di continuare
```

## Il primo cliente

```
/jaggaer-virtual-consultant:use customer ACME --new
(compilare customers/ACME/config/environments.yaml — fuori sessione, con il referente)
/jaggaer-virtual-consultant:use env sandbox
/jaggaer-virtual-consultant:vc doctor
/jaggaer-virtual-consultant:kb ingest data/ACME/progetto/
/jaggaer-virtual-consultant:kb ingest data/ACME/manuali/ --scope P2P
/jaggaer-virtual-consultant:kb digest --scope P2P
/jaggaer-virtual-consultant:kb review --scope P2P
```

## Il primo intento

Basta scrivere nella conversazione:

> Su ACME sandbox, apri la richiesta d'acquisto più recente e dimmi chi l'ha creata e in che stato è.

Il plugin risolve l'ambiente, ne verifica l'impronta, avvia (sola lettura, nessuna approvazione), mostra il workflow e
produce il report.

## Comandi e frasi

Otto famiglie di comandi: `vc`, `use`, `kb`, `nrt`, `cfg`, `ops`, `learn`, `admin`
(`/jaggaer-virtual-consultant:<famiglia> <azione>`; riferimento completo nel [manuale, §56](docs/MANUAL.md#56-riferimento-dei-comandi)).

Le frasi che il plugin riconosce si scrivono **come unico testo del messaggio**; solo l'utente può scriverle.

- Approvazioni: `sì` (un'azione R2 in attesa) · `APPROVO PIANO <PLAN>` · `APPROVO PROVA <PLAN>` ·
  `APPROVO PASSO <n> <PLAN>` (in produzione con `DA <Nome Cognome>`, la prova da una persona diversa) ·
  `ESPLORA SANDBOX` · `ESPLORA PREPROD` · `APPROVO PROMOZIONE <codice>` · `APPROVO RETENTION <C>` ·
  `APPROVO PURGE <ID> DA <Nome Cognome>` (due persone diverse).
- Controllo degli agenti: `PAUSA AGENTE <task_id>` · `PAUSA TUTTI` · `RIPRENDI AGENTE <task_id>` · `RIPRENDI TUTTI` ·
  `FERMA AGENTE <task_id>` · `FERMA TUTTI` (solo gli agenti in corso in quel momento) · `PASSO PASSO <task_id|TUTTI>`
  (o `PASSO PASSO TUTTI`) · `PASSO PASSO OFF` · `SBLOCCA SCOPE <S>` · `LIMITI DISPATCH <chiamate> <minuti>`.
  Console: `/jaggaer-virtual-consultant:vc agents`; dal vivo, da un terminale separato,
  `node <cartella del plugin>/scripts/admin/agents.mjs watch --session <SES…> --interval 5`
  ([orchestrazione](docs/orchestration.md)).

## Stato

Avanzamento della costruzione e prove per fase: [docs/phase-reports/](docs/phase-reports/).

## Licenza

UNLICENSED — uso riservato.
