# JAGGAER Virtual Consultant

Un consulente tecnico senior JAGGAER in forma di **plugin per Claude Code**: una piattaforma di agenti che lavora per
più clienti e su tutti i moduli JAGGAER, agendo direttamente sul tenant tramite il browser (Chrome DevTools MCP o il
browser di Claude). Prima di agire richiama ciò che sa (conoscenza codificata), ciò che è successo (storico ed esiti) e
ciò che vede sulla pagina, valuta quanto conosce il soggetto e ne ricava la strategia; ogni azione con effetto passa da
guard di sicurezza che sanno in quale ambiente si trovano e chiedono le approvazioni giuste.

## Cosa fa

| Area | Cosa significa in pratica |
|---|---|
| **Collaudo NRT** | Test di non regressione delle release: casi deterministici ed esplorativi, evidenze, risultati e difetti su Xray/Jira |
| **Configurazione** | Procedure standard di configurazione adattate al custom del cliente, eseguite su Chrome con istantanea prima, verifica dopo e approvazione |
| **Operatività** | Ordini, contratti, richieste, fornitori, documenti, query Analytics su richiesta, con un piano verificabile passo per passo |
| **Esplorazione** | Impara il tenant navigandolo: registra pagine, campi, pulsanti e percorsi e costruisce la mappa del cliente (`ESPLORA SANDBOX` / `ESPLORA PREPROD`, anche in versione `COMPLETA`) |
| **Import massivi** | Impara i template di caricamento (`kb template-learn`), li compila da script (`template-fill`), li carica e legge l'esito (`import-result`); per creare molti elementi insieme è la via preferita |
| **Conoscenza dai documenti** | Ingest di manuali, specifiche, matrici di campi e procedure (PDF, DOCX, XLSX, HTML, XML…) in unità revisionabili, poi digestione e promozione nella conoscenza |
| **Apprendimento** | Esiti, lezioni e calibrazione delle tabelle di decisione migliorano le scelte successive |

## Struttura del repository

```
.
├── plugin/                     il plugin Claude Code (si installa da qui)
│   ├── agents/                 15 agenti specializzati (scope-expert, config-designer, test-mechanic, …)
│   ├── skills/                 27 skill (agent-manager, jaggaer-domain, selector-strategy, data-safety, …)
│   ├── commands/               8 famiglie di comandi: vc · use · kb · nrt · cfg · ops · learn · admin
│   ├── hooks/                  20 hook: guard di sicurezza fail-closed, osservazione, audit, integrità
│   ├── scripts/                logica deterministica (kb, ingest, decide, chrome, admin, digest, xray, …)
│   ├── decision-tables/        tabelle di decisione (DT-0xx) usate dagli agenti e dagli script
│   ├── strategies/ · clusters/ · policy/ · schemas/ · templates/
│   ├── product/                conoscenza di prodotto di partenza (livello S) inclusa nel pacchetto
│   ├── docs/                   manuale, guida al primo uso, specifiche e piani, checklist di avanzamento
│   ├── test/                   suite node --test (oltre 1300 test, golden, fixture sintetiche)
│   └── integrity.json          manifest d'integrità del pacchetto (i guard negano tutto se non torna)
├── knowledge/                  il workspace della conoscenza (si apre in Claude Code come cartella di lavoro)
│   ├── product/                livello S: kb/, sources/units/, knowledge.db
│   ├── customers/<C>/          livello C per cliente: config/, kb/ (mappa, procedure, template), runs/, evidence/
│   └── _inbox/<scope>/         uscite dell'ingest da revisionare, mai promosse senza validazione
└── .claude-plugin/marketplace.json   marketplace privato `jaggaer-vc`
```

Il plugin installato è un pacchetto protetto (integrità, hook inattivi nella sua cartella, copia nella cache di Claude
Code a ogni installazione): la conoscenza cresce fuori da esso, in `knowledge/`, nello stesso repository.

## Requisiti

- **Claude Code** (desktop o CLI) e un browser: Chrome con **Chrome DevTools MCP** (necessario per le azioni con effetto
  fuori dalla sandbox) oppure il browser di Claude.
- **Node 22** o successivo, git.
- Nella cartella `plugin/`: **`npm ci`** (mai `npm install`: `package-lock.json` è sotto integrità).
- Le variabili d'ambiente del cliente dal vault (`NRT_<ENV>_*`, `XRAY_*`, `JIRA_*`), solo quelle dell'ambiente su cui si
  lavora, con utenze di collaudo a privilegi minimi.

## Installazione rapida

```
1  Installare il plugin (marketplace privato jaggaer-vc o la cartella plugin/ in locale); in plugin/: npm ci
2  Aprire knowledge/ (o il proprio workspace di conoscenza) come cartella di lavoro di Claude Code
3  Copiare plugin/templates/settings.template.json in .claude/settings.json del workspace
4  Esportare le variabili d'ambiente del cliente
5  /jaggaer-virtual-consultant:vc doctor        → tutto verde prima di continuare
6  /jaggaer-virtual-consultant:use customer ACME --new, poi compilare customers/ACME/config/environments.yaml
7  /jaggaer-virtual-consultant:use env sandbox
```

La procedura completa, dalla A alla Z, è nel [manuale utente](plugin/MANUALE-UTENTE.md); il primo uso su un tenant reale
(esplorare e memorizzare, poi creare ordini e contratti) è nella [guida passo passo](plugin/docs/GUIDA-PRIMO-USO.md).

## Come si usa

Si scrive l'intento nella conversazione, per esempio:

> Su ACME pre-produzione crea 30 data element dal file allegato.

Il plugin riconosce cliente, ambiente e azione (tabella DT-026), compone un piano dalla mappa del cliente (o dice
esattamente cosa manca), lo valida, chiede le approvazioni previste dal livello di autonomia e lo esegue passo per passo,
confrontando ogni pagina con ciò che si aspetta.

**Comandi**: `/jaggaer-virtual-consultant:<famiglia> <azione>` con le famiglie `vc` (stato, doctor, agenti), `use`
(cliente, ambiente, scope, modalità, budget), `kb` (ingest, digest, review, template-learn, atlas…), `nrt` (collaudo),
`cfg` (configurazione), `ops` (operatività), `learn` (lezioni), `admin` (manutenzione). Riferimento: [manuale, §56](plugin/docs/MANUAL.md).

**Frasi dell'utente** (scritte come unico testo del messaggio; il modello non può scriverle):

| Frase | Effetto |
|---|---|
| `AUTONOMIA ALTA` · `AUTONOMIA MEDIA` · `AUTONOMIA BASSA` | Livello di autonomia della sessione (predefinito alto; in produzione al massimo medio) |
| `APPROVO PIANO <PLAN>` | Approva un piano (con autonomia alta basta una volta per tutto il piano, salvo produzione) |
| `APPROVO PASSO <n> <PLAN>` | Approva un singolo passo (in produzione prima di ogni passo che modifica o carica) |
| `APPROVO PROVA <PLAN> DA <Nome Cognome>` | Seconda approvazione da una persona diversa, dove l'ambiente la richiede |
| `sì` | Con autonomia bassa, conferma un'azione d'invio in attesa (mai in produzione) |
| `ESPLORA SANDBOX` · `ESPLORA PREPROD` (+ ` COMPLETA`) | Apre l'esplorazione senza piano |
| `PAUSA` / `RIPRENDI` / `FERMA AGENTE <id>` · `… TUTTI` · `PASSO PASSO` · `LIMITI DISPATCH` | Controllo degli agenti in corso |

## Ambienti e sicurezza

| | Sandbox | Pre-produzione | Produzione |
|---|---|---|---|
| Autonomia massima | alta | alta | media |
| Creare, aggiornare, inviare | sì (alto: senza frasi) | sì (alto: sola creazione senza frasi, altrimenti una `APPROVO PIANO`) | solo con `write_data: true` e `APPROVO PIANO` + `APPROVO PASSO` per ogni passo |
| Configurazione | con `APPROVO PIANO` | con `APPROVO PIANO` | piano + passo (+ seconda persona), istantanea prima |
| Import massivi | sì | sì | come le scritture; per la configurazione serve l'istantanea dei dati attuali |
| Cancellazioni | un elemento per passo, lettura salvata prima | idem | **mai** |
| Esplorazione | sì | sì (semplice: solo click) | no |

Principi: i guard sono **fail-closed** (nel dubbio negano); le frasi le scrive solo l'utente e ogni approvazione è
confermata nella conversazione e legata all'impronta del piano; ogni click è legato al selettore del passo; prima di
creare o modificare si registra la compensazione; l'upload accetta solo il file compilato del run con l'impronta del
piano; con `write_data: false` un ambiente non riceve né import massivi né cancellazioni. Gli hook sono difese
testuali, non una sandbox del sistema operativo: i rischi residui sono dichiarati nel [manuale, §55.1.2](plugin/docs/MANUAL.md).

## Sviluppo

```bash
cd plugin
npm ci
npm test                 # suite completa (circa 15 minuti: include il test sul corpus di documentazione locale)
npm run test:timing      # test dei tempi dei guard
node scripts/admin/integrity.mjs build   # da eseguire prima di ogni commit che tocca il pacchetto
```

- Lavoro su branch `feature/…` e merge su `main` tramite pull request (il merge lo fa il responsabile del repository).
- Le specifiche e i piani di ogni sviluppo sono in [`plugin/docs/superpowers/`](plugin/docs/superpowers/); lo stato è in
  [`plugin/docs/IMPLEMENTATION-CHECKLIST.md`](plugin/docs/IMPLEMENTATION-CHECKLIST.md).
- La CI GitHub (`.github/workflows/plugin-ci.yml`) esegue la suite su Linux, Windows e macOS; con l'account senza
  credito i job non partono: in quel caso fa fede la suite eseguita in locale.
- `JVC_DEV` è la variabile dello sviluppo del plugin (salta integrità e protezione del codice): mai sulle macchine degli
  utenti.

## Stato e prossimi passi

Fatto: la piattaforma completa (17 pacchetti di lavoro), la mappa del tenant costruita dall'esplorazione, l'esplorazione
completa e **Ops veloce** (autonomia, scritture controllate in produzione, cancellazioni, import massivi con template,
esecuzione più rapida).

Prossimi passi:
- trasformare le procedure lette nei documenti in piani eseguibili dagli agenti;
- agenti in parallelo su schede diverse del browser;
- prova dal vivo sul tenant e verifiche elencate nel [manuale, §60](plugin/docs/MANUAL.md).

## Documentazione

- [Manuale utente](plugin/MANUALE-UTENTE.md): installazione, comandi, agenti, skill, frasi
- [Guida al primo uso](plugin/docs/GUIDA-PRIMO-USO.md): esplorare, memorizzare, operare su un tenant reale
- [Manuale tecnico](plugin/docs/MANUAL.md) · [Rete e allow-list](plugin/NETWORK.md) · [README del plugin](plugin/README.md)

## Riservatezza

`knowledge/` contiene estratti della documentazione JAGGAER (materiale proprietario) e, col tempo, dati dei clienti: il
repository deve restare **privato**. La documentazione originale (`plugin/JAGGAER DOC/`) non è mai versionata. Licenza:
UNLICENSED — uso riservato.
