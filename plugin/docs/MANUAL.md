# JAGGAER Virtual Consultant — Manuale integrato

Manuale d'uso del plugin per Claude Code (versione 0.1.0). Rende la Parte X della specifica (v8.0, §55–§59 e §61) con
lo stato reale del plugin: i comandi, le frasi e i controlli descritti qui sono quelli del codice. L'allineamento fra
questo manuale e i comandi è verificato da test automatici (`test/docs/manual-alignment.test.mjs`: le azioni di ogni
famiglia in §56 coincidono con l'`argument-hint` del file in `commands/`; `test/docs/phrases-coverage.test.mjs`: ogni
frase che il plugin riconosce è scritta qui alla lettera).

Indice: [55 Installazione e primo avvio](#55-installazione-e-primo-avvio) ·
[56 Riferimento dei comandi](#56-riferimento-dei-comandi) ·
[57 Intenti, approvazioni, workflow, report, agenti](#57-scrivere-un-intento-seguire-il-workflow-leggere-i-report) ·
[58 Risoluzione dei problemi](#58-risoluzione-dei-problemi) · [59 Sintesi](#59-sintesi-in-una-pagina) ·
[60 Verifiche prima del rilascio e dal vivo](#60-verifiche-prima-del-rilascio-e-dal-vivo) ·
[61 Catalogo degli intenti](#61-catalogo-degli-intenti-per-modalità) · [Appendici](#appendice-a--template-personalizzabili)

---

## 55. Installazione e primo avvio

### 55.1 Prerequisiti

- **Claude Code** (desktop o CLI) con un browser collegato: il browser integrato di Claude (Claude in Chrome) oppure
  **Chrome DevTools MCP**. Fuori dalla sandbox (pre-produzione, produzione, sviluppo) il browser di Claude può solo
  leggere e navigare: ogni azione con effetto (click, testo, upload, invio) si esegue con **Chrome DevTools MCP**, che
  va quindi installato per configurare o operare in pre-produzione. In sandbox vanno bene entrambi.
- **Node 22** o successivo, **git**, accesso al repository di conoscenza, le variabili d'ambiente del cliente dal vault
  (credenziali `NRT_<ENV>_*`, `XRAY_*`, `JIRA_*`; per la digestione settimanale e i ticket anche `JVC_PSEUDO_SALT`).
- **`npm ci` nella cartella del plugin** (non nel workspace; non `npm install`): i guard di sicurezza importano le
  dipendenze di runtime (`ajv`, `ajv-formats`, `better-sqlite3`, `yaml`) e senza di esse negano ogni chiamata (sono
  fail-closed). `npm ci` installa esattamente le versioni di `package-lock.json`, che è nel perimetro d'integrità:
  `npm install` può riscrivere il lockfile e allora il controllo d'integrità fallisce e i guard negano tutto
  (`node_modules` resta fuori dal perimetro, §55.1.2). `doctor` segnala le dipendenze mancanti con il controllo `deps`
  rosso e la correzione "npm ci nel plugin".
- **Playwright non è richiesto**: si installa solo se si attiva la corsia compilata (`npx playwright install chromium`).
  Il server MCP `playwright` dichiarato in `.mcp.json` è la **corsia opzionale di esplorazione** del manager (§44.6):
  nessun agente lo usa (gli agenti agiscono su Chrome con Chrome DevTools MCP o con il browser di Claude) e i guard lo
  trattano come ogni altro strumento del browser.

### 55.1.1 Sicurezza: cosa il plugin non può fare da solo

Chi installa il plugin deve sapere quattro cose.

1. **Gli hook sono difese testuali, non una sandbox.** I guard analizzano il testo delle chiamate agli strumenti
   (comandi di shell, percorsi, strumenti del browser) e negano ciò che viola le regole, con molte viste del comando
   (virgolette tolte, variabili sostituite, codifiche decodificate). Non isolano il processo. Per una difesa in
   profondità rendere **in sola lettura a livello di sistema operativo** la cartella del plugin e `~/.claude`, oppure
   usare le **impostazioni gestite** (managed settings) di Claude Code, così che nemmeno un comando sfuggito ai guard
   possa modificarli.
2. **Le credenziali nelle variabili d'ambiente sono leggibili da ogni shell** che il modello avvia. I guard negano la
   lettura dei file di segreti (`.env*`, `.auth/`) e il plugin non stampa mai i valori, ma una variabile d'ambiente è
   per natura visibile ai processi figli: esportare solo le credenziali dell'ambiente su cui si lavora, con utenze di
   collaudo a privilegi minimi.
3. **`JVC_DEV` non va mai impostata sulle macchine degli utenti.** È la variabile dello sviluppo del plugin: salta il
   controllo d'integrità del pacchetto e la protezione del codice. I guard negano di impostarla o citarla dalla
   sessione; va comunque lasciata non definita nel sistema.
4. **`${CLAUDE_PLUGIN_ROOT}`**: Claude Code sostituisce questo segnaposto con il percorso letterale del plugin nei corpi
   dei comandi. Le operazioni a forma esatta (purge, retention, promozione, `integrity verify`) contano su questa
   sostituzione: un `$` rimasto nel comando lo renderebbe "non semplice" e i guard lo negherebbero (blocco, non
   rischio). La verifica è nell'[Appendice B](#appendice-b--verificare-la-sostituzione-di-claude_plugin_root).

### 55.1.2 Rischi residui dichiarati

Oltre ai quattro punti sopra (difese testuali e credenziali nelle variabili d'ambiente comprese), il plugin **non**
impone da solo quanto segue. Ogni voce dice cosa fare.

1. **Canali che consegnano un vero prompt dell'utente.** Il `sendPrompt` di un widget e il `send_message` di una
   sessione verso se stessa arrivano all'hook `approval-capture` come un prompt autentico dell'utente. Se la frase di
   approvazione vi arriva offuscata, `guard-phrase` non la vede. Con un ambiente dichiarato, l'allow-list dei server MCP
   nega questi strumenti; **senza ambiente dichiarato restano aperti**, e bastano per le approvazioni che non chiedono un
   ambiente (purge, retention, promozione). Aggiungere questi strumenti a `permissions.deny` del `.claude/settings.json`
   del workspace e non usare widget o sessioni che scrivono nella conversazione.
2. **Il nome del secondo approvatore è dichiarato, non autenticato.** `DA <Nome Cognome>` è ciò che la persona scrive:
   il plugin confronta i nomi (spazi e maiuscole normalizzati, nessun controllo di caratteri simili di altri alfabeti) e
   non verifica chi sta scrivendo. La regola delle due persone (3A in produzione, purge) è una regola **organizzativa**:
   il secondo approvatore scrive la frase lui stesso, dalla sua postazione o in presenza.
3. **Il referente della pre-produzione è un avviso.** La colonna `referent` di un'azione in pre-produzione produce un
   avviso in `validate-plan`, non un blocco: il plugin non contatta nessuno. Avvisare il referente prima di approvare.
4. **Token salati di un cliente cancellato.** Dopo `admin customer purge` i token pseudonimi `CUST-`/`RIF-` di quel
   cliente restano nei report di `product/digest/` e sono ricalcolabili da chi possiede `JVC_PSEUDO_SALT` (i codici
   cliente hanno 4 caratteri). Il titolare dei dati decide se rigenerare quei report con un sale nuovo.
5. **Ancora di fiducia della firma e dipendenze.** La chiave pubblica che verifica `integrity.json.sig` viaggia nel
   pacchetto: chi può sostituire il pacchetto può sostituire anche la chiave (toglierla dà `signature: absent`).
   `node_modules` è fuori dal perimetro d'integrità (che copre `hooks/`, `scripts/`, `commands/`, `agents/`, `skills/`,
   `product/`, `clusters/`, `decision-tables/`, `strategies/`, `policy/`, `schemas/`, `mcp/`, `templates/`, `.mcp.json`,
   il manifest, `NETWORK.md`, `package.json` e `package-lock.json`). Installare solo da una release, confrontarne
   l'impronta con quella pubblicata fuori dal pacchetto, e usare `npm ci` con il lockfile.
6. **Vocabolario del browser.** Le etichette distruttive riconosciute nel browser (elimina, cancella, delete, remove, …)
   sono in italiano e in inglese; "cestino", "archivia", altre lingue, selettori camelCase e click a sole coordinate non
   sono riconosciuti. Il rischio è solo in sandbox: fuori dalla sandbox ogni azione con effetto passa da un passo di
   piano sul selettore dell'Atlas.
7. **Allow-list dei server MCP.** Con un ambiente dichiarato ogni strumento MCP di un server non in allow-list è negato
   ("server MCP … non ammesso con un ambiente dichiarato", §58): è voluto. Altri server si usano senza ambiente dichiarato, o si aggiungono con una
   release del plugin.
8. **Stato di sessione dopo un aggiornamento.** Una versione del plugin con uno schema di `session.json` più severo vede
   le sessioni vive come non valide ("session.json non valido", "stato di sessione illeggibile") e i guard negano. Si ripara con
   `/jaggaer-virtual-consultant:use customer <ID>` (copia di riserva `session.json.corrupt-<data>`); le compensazioni
   pendenti restano in `customers/<C>/runs/<RUN>/compensations.yaml` e si ricontrollano con `vc status`.
9. **`auth-setup` lascia il file di origine.** `run/auth-setup.mjs register --file <storageState>` copia lo stato di
   autenticazione in `.auth/` e **non** cancella il file di partenza: cancellarlo a mano, e non tenerlo mai dentro il
   repository di conoscenza (fuori da `.auth/` non è protetto e finirebbe in git).
10. **Ritentativi verso Jira.** Il server ALM ritenta dopo un timeout o un 502/503/504 anche le richieste POST: una
    creazione riuscita sul server ma scaduta sul client può creare un Defect o una Test Execution doppi. Dopo un
    ritentativo controllare in Jira con `nrt push-xray --dry-run` / `xray verify` e chiudere il doppione.
11. **Puntatore di sessione stantio e CI.** Gli script senza `--session` usano `.jvc/current-session`: un puntatore
    lasciato da una sessione chiusa fa usare alle esecuzioni in CI una sessione che non è la loro (e le blocca). In CI passare sempre
    `--session <id>` (o `JVC_SESSION_ID`), oppure lavorare su un checkout pulito senza `.jvc/`.
12. **Jira Server/DC on-premise.** Il suo host va aggiunto alla categoria `alm` di `NETWORK.md`, che è sotto integrità:
    serve una release del plugin; fino ad allora quel cliente non pubblica su Jira.
13. **Redazione all'ingestion: limiti.** `kb ingest` redige le unità, il documento normalizzato
    (`_inbox/<S>/parsed/`, l'ingresso di scope-extractor) e i grezzi: dati personali e segreti riconosciuti dagli schemi,
    codici degli altri clienti del workspace (senza distinzione di maiuscole, salvo i codici che sono anche parole comuni
    — `DATA`, `NOTE`, `TEST`, `DEMO`, … elenco `COMMON_WORD_CODES` di `scripts/ingest/redact.mjs` — riconosciuti solo
    in maiuscolo esatto), autori e importi nel livello S. Nomi di persona nel testo libero e nomi di campi custom che non
    contengono il codice del cliente non sono riconosciuti (revisione a campione). L'hash di un'unità è calcolato sul
    testo **redatto**: aggiungere al workspace un cliente il cui codice compare in un documento già ingerito cambia
    l'hash, e quindi il codice, delle unità che lo citano alla successiva ingestion (§19.16: diventano unità nuove).
    Anche il **nome del file di origine** è redatto con le stesse regole: manifesto `_manifest.json`, `meta.source` del
    documento normalizzato, identificativo del documento, profilo DOC, tabella `doc_profiles`, residuo ed esito di
    `kb ingest`. Il percorso grezzo resta solo in memoria per l'identità fra versioni: quando il nome contiene dati da
    redigere si conserva la chiave redatta con un'impronta di quella grezza. Come nel testo, un nome di persona senza
    e-mail o altro schema riconoscibile (per esempio `Note riunione Mario Rossi.docx`) non è riconosciuto: dare ai file
    nomi neutri. Il comando `profile-doc` usato da solo su un documento già normalizzato vede solo il nome redatto.
14. **Scritture della conoscenza con un interprete in linea.** La sessione principale non scrive in `product/**` né in
    `customers/*/kb/**` né con gli strumenti di file né con la shell (redirezioni, `tee`, `cp`/`mv`, `Set-Content`,
    `sed -i`, …), né con il codice in linea di un interprete che cita quelle cartelle insieme a una primitiva di
    scrittura (`node -e "…writeFileSync('product/…')"`, `python -c "open('customers/…/kb/…','w')…"`: negati da
    guard-config-scope; le letture restano). Lo fanno solo gli script del plugin dopo la validazione. Resta fuori ciò
    che le difese testuali non vedono (punto 1 di §55.1.1: nomi costruiti a runtime, moduli importati; un
    `python -c "open('product/…')"` di sola lettura è negato per eccesso di prudenza — si legge con Read): rivedere
    `git diff` di `product/` e `kb/` prima di ogni commit della conoscenza.

### 55.2 Installazione

```
1  Installare il plugin dal marketplace privato (o da cartella locale); nella cartella del plugin: npm ci
2  Clonare il repository di conoscenza e aprirlo come workspace di Claude Code
3  Copiare templates/settings.template.json del plugin in .claude/settings.json del workspace (plugin abilitato, permessi minimi)
4  Esportare le variabili d'ambiente del cliente (NRT_<ENV>_*, XRAY_*, JIRA_*)
5  Avviare Claude Code nel workspace
6  /jaggaer-virtual-consultant:vc doctor         → deve essere tutto verde prima di continuare
```

`doctor` verifica: versione di Node e dipendenze del plugin (`deps`), versione del plugin e della conoscenza,
integrità del pacchetto, DB apribili, `environments.yaml` valido (regole di produzione comprese), host raggiungibili e
solo quelli (`--network`), credenziali presenti (solo i nomi, mai i valori), browser (sempre giallo: il plugin non può
sondarlo, si verifica in sessione con `use env`), Jira raggiungibile o coda offline abilitata, compensazioni pendenti da
sessioni precedenti, checklist di hardening, catena dell'audit, sostituzione di `${CLAUDE_PLUGIN_ROOT}`
(`plugin-root`). Esito: verde; giallo = da verificare; rosso = non si lavora finché non è corretto (exit 3).

### 55.3 Il primo cliente

```
/jaggaer-virtual-consultant:use customer ACME --new        crea customers/ACME/, knowledge.db, config/
(compilare customers/ACME/config/environments.yaml — fuori sessione, con il referente)
/jaggaer-virtual-consultant:use env sandbox
/jaggaer-virtual-consultant:vc doctor                 verifica l'ambiente: impronta, host, credenziali
/jaggaer-virtual-consultant:kb ingest data/ACME/progetto/  → profilo del cliente, domande di apertura
/jaggaer-virtual-consultant:kb ingest data/ACME/manuali/ --scope P2P
/jaggaer-virtual-consultant:kb digest --scope P2P
/jaggaer-virtual-consultant:kb review --scope P2P
/jaggaer-virtual-consultant:kb epistemic --scope P2P --plan   → cosa osservare per sapere di più
```

`use env <id>` dichiara l'ambiente; resta **non verificato** (solo navigazione e lettura) finché il plugin non ne
verifica l'impronta sulla pagina (≥ 2 segnali, env-check): il comando lo fa aprendo `base_url` con il browser.

### 55.4 Il primo intento

Basta scrivere, nella conversazione:

> Su ACME sandbox, apri la richiesta d'acquisto più recente e dimmi chi l'ha creata e in che stato è.

Il plugin risolve l'ambiente, verifica l'impronta, avvia (`ACT-OBS`, nessuna approvazione), mostra il workflow, produce
il report.

---

## 56. Riferimento dei comandi

Tutti i comandi si invocano come `/jaggaer-virtual-consultant:<famiglia> <azione> [opzioni]`. Le opzioni comuni:
`--scope <id>`, `--env <id>`, `--json`, `--dry-run`, `--budget <n>`. Otto famiglie, un file ciascuna in `commands/`:
`vc` (stato, diagnostica, console degli agenti), `use` (contesto), `kb` (conoscenza), `nrt` (collaudo), `cfg`
(configurazione), `ops` (operatività e Analytics), `learn` (apprendimento e dominio analitico), `admin` (operazioni).

**Chi fa il lavoro.** Il manager è la sessione principale di Claude Code con la skill `agent-manager`: non fa lavoro di
dominio, instrada. Le azioni di lettura, di registro e amministrative chiamano direttamente uno script del plugin; le
azioni che ragionano sul dominio invocano un sub-agente foglia (`Agent(<agente>, <modello>)`, prompt composto da
`templates/agent-prompt.md`). La colonna "Chi" indica cosa succede.

**Regola dei dati in ingresso.** Gli script del plugin si invocano solo in forma semplice: niente JSON in linea, niente
virgole, parentesi, `$`, `@`, graffe o testo libero con punteggiatura e accenti sulla riga di comando (i guard la
negano). I comandi passano i dati strutturati e il testo dell'utente da un file della sessione
(`customers/<C>/.sessions/<sessione>/…`: `--payload-file`, `--text-file`, `--finding`, `--sql-file`; per il report
`--payload-file` con titolo, intento, prossimi passi, atteso/osservato/errori, oppure `--intent-file`,
`--assumption-file`, `--next-file`) o come `chiave=valore`.

**Confinamento dei file d'ingresso.** I file d'ingresso degli script si risolvono nel **workspace degli hook** —
`JVC_WORKSPACE`, altrimenti la radice del progetto (`CLAUDE_PROJECT_DIR`), altrimenti la cartella di avvio — e **mai** nel
`--workspace`/`--root` scelto da chi invoca lo script. Il percorso reale (collegamenti risolti, anche di una cartella
intermedia) deve stare dentro quel workspace: percorsi assoluti fuori, `..` che escono o collegamenti che portano fuori
sono rifiutati ("file fuori dal workspace"). Tetti: 64 KB per i testi (`--text-file`, `--summary-file`,
`--query-file`), 256 KB per i payload (`--payload-file`) e per `--sql-file`, 16 MB per gli altri. Confinati, per script:

| Script | File d'ingresso confinati |
|---|---|
| `admin/workflow` · `report/build-report` | `--payload-file` · `--payload-file`, `--intent-file`, `--assumption-file`, `--next-file` |
| `admin/agent-report` | il rapporto (posizionale) |
| `analytics/query-guard` · `analytics/din-build` | `--sql-file` (o posizionale) · `--input` |
| `analysis/cluster` | `--input` |
| `chrome/capture` · `chrome/compile-plan` · `chrome/env-check` · `chrome/survey` · `chrome/annotate` | `--snapshot`, `--spec` · `--atlas`, `--spec` · `--snapshot`, `--env-file` · `--snapshots` (cartella) · `--evidence` |
| `compile/compile-case` · `compile/compile-cfp` · `compile/lint-spec` · `compile/lint-scope` | `--case` · `--cfp`, `--client` (se non sono codici), `--params` · i file posizionali, `--against` · i file posizionali |
| `config/baseline` · `config/lint` | `--input` · `--baseline` |
| `decide/depth` · `decide/strategy-select` · `decide/dt-eval` | `--input`, `--precedents` · `--input`, `--precedents` · `--inputs`, `--priors` (se non sono JSON in linea o `auto`) |
| `decide/intent` · `decide/self-check` · `decide/step-check` · `decide/validate-plan` | `--text-file` · `--report`, `--session`, `--audit`, `--plan`, `--lesson`, `--observations` · `--snapshot`, `--why` · il piano (posizionale), `--catalog` |
| `ingest/aliases` · `ingest/deontic` · `ingest/doc-diff` · `ingest/extract` · `ingest/field-table` · `ingest/profile-doc` · `ingest/redact` | `--registry`, `--rows-file`, `--doc-lang-file`, `--payload-file` · `--text-file` · `--old`, `--new`, `--release-notes` · `--units`, `--doc`, `--profile` · `--doc` · `--parsed` · `--text-file` |
| `kb/kb` · `kb/backcheck` · `kb/compensation` · `kb/digest-fields` · `kb/digest-plan` · `kb/review` · `kb/validate-codes` · `kb/validate-env` | `--text-file`, `--query-file` · `--item` · `--payload-file` · il lotto (posizionale), `--digested` · `--answers-file` · `--payload-file` · i percorsi posizionali · il file (posizionale) |
| `run/baseline` · `run/checks-run` · `run/fixtures` · `run/integration` · `run/promotion` · `run/select-suite` | `--observed` · `--cfp` (se non è un codice), `--probe`, `--plan` · `--case`, `--payload-file` · `--golden`, `--actual`, `--int` (se non è un codice) · `--case` · `--changed` |
| `xray/build-payload` · `xray/publish` · `xray/defect` | `--outcomes` · `--outcomes` · `--finding`, `--summary-file` |

I piani passati come `--plan` a capture, compile-plan, step-check e build-report sono relativi alla cartella del
cliente (`customers/<C>/`, niente assoluti né `..`). **Eccezioni dichiarate** — le **sorgenti da importare**, lette anche
da fuori perché il loro scopo è portare un documento nel workspace: la cartella di `kb ingest <path>`
(`ingest/ingest.mjs` e `ingest/harvest.mjs --input`), il file dei parser (`--in`), il file dei ticket di
`learn tickets <xlsx>` (`analysis/ticket-import.mjs`) e lo storageState di `run/auth-setup.mjs register --file`. `--db`
sono database e `--out`/`--out-dir` destinazioni, non file d'ingresso: un `--out` dentro `product/` o
`customers/<C>/kb/` è negato da guard-scope (la conoscenza la scrivono solo gli script che validano, nelle loro cartelle).

**Script e moduli (§44.5).** La spec elenca gli script per nome ("tutti con `--json` e `--help`"). Molti sono **moduli di
libreria dietro un dispatcher** e non hanno una CLI propria: `kb.mjs` (find, fields, epistemic, units, assign-seq…),
`ingest.mjs` (parse-*, segment, dedupe, profile-doc), `digest/weekly.mjs` (collect, align, portability,
promote-candidates, report), `chrome/capture.mjs` (con la redazione di `chrome/redact.mjs`). Il dispatcher ha `--help`
e `--json`; il modulo si usa solo attraverso di lui. Hanno una CLI anche `kb/validate-codes.mjs` (codici validi, uguali
al nome del file, nessun codice rivendicato da due file), `kb/lifecycle.mjs --help` (promote, deprecate) e
`ingest/redact.mjs` (la redazione dell'ingestion su un testo).

### 56.1 `vc` — stato, diagnostica e console degli agenti (virtual consultant)

| Azione | Cosa fa | Chi · Note |
|--------|---------|------------|
| *(nessuna)* | Stato di sessione (cliente, ambiente, scope, modalità, budget, pendenze) e **azioni suggerite**: cosa fare adesso, in ordine, con il perché (dichiarare l'ambiente, verificarne l'impronta, chiudere le compensazioni, dare l'approvazione attesa, rivedere le quarantene, ripubblicare la coda Xray, oppure scrivere un intento) | Il punto di partenza · script `admin/status.mjs` |
| `status [--metrics]` | Stato di sessione: cliente, ambiente, scope, modalità, budget, pendenze, piano attivo, ultime decisioni e sorprese, salute della conoscenza, coda Xray; con `--metrics` le metriche di §35 | script `admin/status.mjs` |
| `agents [show <task_id> \| history [--scope <S>] [--last <N>]]` | Console degli agenti: cosa fa ogni sub-agente adesso e cosa ha fatto, dalle sole registrazioni degli hook (vedi §57.5) | script `admin/agents.mjs` · sola lettura |
| `doctor [--network]` | Diagnostica completa dell'installazione e dell'ambiente (§55.2) | script `admin/doctor.mjs` · verde obbligatorio prima di operare |
| `watch <SES.C.AAAAMMGG.NNN>` | Il workflow di una sessione in corso, con la sezione agenti | script `admin/workflow.mjs watch` · sola lettura, anche da un'altra sessione |
| `why <codice>` | Spiega una decisione (`DEC`), un item o un report: tabella, input, priori, strategia, esito, cosa cambierebbe idea | script `decide/why.mjs` |

### 56.2 `use` — contesto di sessione

| Azione | Cosa fa | Note |
|--------|---------|------|
| `customer <ID> [--new]` | Attiva un cliente (crea la struttura con `--new`) | Rifiuta il cambio se il cliente precedente ha compensazioni pendenti o sotto-compiti aperti |
| `env <sandbox\|preprod\|prod>` | Dichiara l'ambiente da `environments.yaml`; poi il plugin ne verifica l'impronta (env-check) | Obbligatorio prima di qualunque azione sul browser; cambiarlo azzera la verifica |
| `scope <ID>` | Cella attiva (CAT SRC VEN CON P2P INV QLT ANL ADM XSC) | Ricalcola i percorsi ammessi |
| `mode <nrt\|config\|ops\|diag\|esplorazione>` | Modalità | L'intento la deduce; il comando la forza. `esplorazione` (in pre-produzione con Chrome DevTools; click solo su elementi con nome, mai a coordinate; pagine pesanti: `take_snapshot` con `filePath`): un'unica esplorazione senza piano, in sandbox (dopo la frase `ESPLORA SANDBOX`) e in pre-produzione (dopo `ESPLORA PREPROD`; le varianti `… COMPLETA` sono sinonime): clicca tutto, compila, salva, invia, approva con valori di prova; mai cancellazioni, upload, script, produzione; nessun tetto di azioni per agente; in pre-produzione un invio può mandare davvero e-mail ai fornitori o dati all'ERP |
| `budget <n>` | Budget di sessione in token (es. `200k`) | Registrato in audit; l'unico modo per alzarlo, solo su richiesta dell'utente |
| `show` | Stato corrente della sessione, compreso il **livello di autonomia** (campo `autonomy`: effettivo, scelto, fonte, tetto dell'ambiente) | Sola lettura. Il livello non si imposta con `use`: lo sceglie l'utente con `AUTONOMIA ALTA` · `AUTONOMIA MEDIA` · `AUTONOMIA BASSA` o con `default:` in `customers/<C>/config/autonomy.yaml` (§57.2) |
| `close-stale` | Chiude a mano i sotto-compiti rimasti aperti (dispatch mai chiusi) | Solo su richiesta; senza, scadono da soli dopo 2 ore, o dopo il limite di dispatch confermato (`LIMITI DISPATCH`) se è più lungo |

### 56.3 `kb` — conoscenza

| Azione | Cosa fa | Chi |
|--------|---------|-----|
| `ingest <path> [--scope --genre tecnica\|d'uso\|empirica\|testimoniale --kind …]` | Profila e segmenta i documenti; **redige le unità** prima di scriverle (dati personali, segreti, codici degli altri clienti; profilo strict — anche importi e autori — per il livello S senza cliente); estrae i grezzi in `_inbox`; report di ingestion | script `ingest/ingest.mjs`, poi `customer-profiler` (cartella di progetto) o `scope-extractor` → `scope-digester` → `cluster-validator` |
| `digest [--scope] [--fields <documento>]` | Digestione guidata dagli attributi attesi; campi a lotti ≤ 50 | `scope-digester` (e `cluster-validator`); `--fields`: piano dei lotti con `kb/digest-fields.mjs` |
| `review [--scope] [--only quarantena\|ambigui\|R3]` | Revisione umana stratificata: accetta, correggi, rifiuta | script `kb/review.mjs` (decide l'utente) |
| `find --scope --type --status --cluster --facet --top` | Recupero per faccette, ordinato per W, con Q | script `kb/kb.mjs` |
| `fields --doc <documento> [--mandatory-in <stato>] [--chain <CL>] [--custom] [--reason ui]` | Il modello dei campi | script |
| `identity <FLD> · identity --doc <documento> --missing <blocco>` | Carta d'identità del dato | script |
| `resolve "<domanda>"` | Codici pertinenti, senza LLM (la domanda passa da file) | script |
| `precedents <soggetto> [--top]` | Decisioni passate con esito e distanza | script |
| `epistemic <soggetto> · epistemic --scope <id> [--plan]` | Copertura epistemica di un soggetto (K, forma, gap, prossimo passo) o dello scope; piano di osservazioni R0 e domande | script `kb/coverage-report.mjs` |
| `impact <codice> [--if "<modifica>"]` | Raggio d'azione sul grafo | script |
| `graph [--scope]` | Coerenza, handoff mancanti | script |
| `scopes · handoffs [--validate] · clusters · contradictions [--open]` | Registri | script |
| `coverage [--scope]` | Copertura per tipo, forma epistemica, identità dei dati | script `kb/coverage.mjs` |
| `template-learn --file <xlsx> --object <oggetto> --scope <S> --page <sig> [--tipo config\|dati] [--modulo <M>] [--fonte utente\|tenant]` | Impara un template di caricamento massivo (colonne, obbligatori, liste di valori) e lo salva come voce `TPL` del cliente con il file vuoto: sempre ripulito delle righe sotto l'intestazione, nessun valore di cella nella voce (`example` null); `--page` obbligatorio; `--tipo config` (predefinito, oggetti di configurazione: in produzione l'import chiede l'istantanea) o `dati`; intestazione su più righe ⇒ rifiutato (exit 1) | script `kb/template-learn.mjs` |
| `reindex [--all]` · `migrate` | Indice (del cliente; `--all` anche prodotto e ogni cliente) e migrazioni | script `kb/reindex.mjs`, `kb migrate` |

### 56.4 `nrt` — collaudo

| Azione | Cosa fa | Approvazioni · Chi |
|--------|---------|--------------------|
| `plan <release> [--scope]` | Piano di collaudo dal delta | 1 (piano) · `scope-expert` per scope |
| `run [--suite smoke\|full\|delta] [--scope] [--dry-run]` | Esecuzione guidata su Chrome; shard per scope | nessuna in sandbox per casi ≤ R1; R2 per caso · `scope-expert` |
| `compile --scope <id>` | **Opzionale**: genera spec Playwright dai piani verdi ≥ 3 volte | — · script `chrome/compile-plan.mjs` |
| `integration [--suite]` | Corsia integrazione | — · `scope-expert` |
| `explore <capability>` | Esplorazione a budget (sandbox) | — · `scope-expert` |
| `triage [RUN]` · `heal [--apply]` | Classificazione (escalation una volta all'analista); riparazione con PR | PR: review umana, mai merge automatico · `failure-triage` → `root-cause-analyst`, `defect-reporter`; `test-mechanic` |
| `evidence --list\|--desk\|--redact-check [RUN]` | Evidenze: selezione, foglio dei provini, controllo della mascheratura | — · script |
| `push-xray [RUN] [--dry-run\|--retry-queued]` | Pubblicazione per scope, verifica, coda offline | — · script |
| `report [RUN]` · `release-check <release>` · `author "<descrizione>"` | Report di test; orchestrazione completa della release; caso a richiesta | script; sequenza completa; `scope-expert` |

### 56.5 `cfg` — configurazione

| Azione | Cosa fa | Approvazioni · Chi |
|--------|---------|--------------------|
| `design "<richiesta>"` | Piano: CFP composta, impatto, rischio, check, rollback, domande dai gap | — · `config-designer` |
| `apply <PLAN> [--dry-run\|--resume <n>]` | Esecuzione su Chrome con checkpoint | verde 1 · giallo 2 · rosso 3 · **prod: sempre 3 (3A)** · `scope-expert` |
| `verify <PLAN>` | Genera e riesegue il verificatore `NRT.*.CFG`; su una CFP del cliente verifica la configurazione **effettiva** (campi di S sostituiti o saltati dalle deviazioni, campi dichiarati dal cliente, passi deviati o inseriti); le deviazioni che non sono campi (un click, un salvataggio) sono dichiarate in `does_not_assert` | — (sola lettura, anche in prod) · script `compile/compile-cfp.mjs --verify`, poi `scope-expert` in lettura |
| `audit [--scope]` · `coverage` · `impact <CFG>` | Lint e deriva; matrice; raggio | — · `config-auditor`; script |

### 56.6 `ops` — operatività e Analytics

| Azione | Cosa fa | Ambienti · Chi |
|--------|---------|----------------|
| `esplora <modulo>` | Esplora e memorizza menu, pagine, pulsanti, campi (pagine registrate da sole, mappa con `kb atlas-build`); salva e invia con valori di prova, mai cancellazioni; le pagine pesanti si leggono a pezzi ([guida](GUIDA-PRIMO-USO.md)) | sandbox (`ESPLORA SANDBOX`), preprod (`ESPLORA PREPROD`) — **mai prod** · `scope-expert` |
| `crea <richiesta\|ordine\|fornitore\|evento\|contratto> …` | Crea in bozza con compensazione; piano da `compose-plan` (se mancano dati obbligatori li chiede; i campi di una pagina in un solo passo `fill_form`), a esito verde la procedura si memorizza. **Import massivo**: se per l'oggetto esiste un `TPL`, `crea N <oggetto>` usa la via massiva (`kb template-learn` con template dell'utente o scaricato dal tenant → `template-fill` → `compose-plan --filled` (in produzione, per un `TPL` di configurazione, anche `--istantanea runs/<RUN>/evidence/<file>`: compensazioni `restore`) → caricamento del solo file del run (`runs/<RUN>/import/`) con sha256 → `import-result [--righe N]` (righe riuscite «con errori/avvisi» = fallite; `unrecognized` se nessuna riga è riconosciuta; `missing` = righe senza esito) → reimport delle sole righe fallite, al massimo 2 volte). Con `write_data: false` in qualunque ambiente import massivi e cancellazioni sono negati | sandbox, preprod; prod solo con `write_data: true` e approvazione per passo (anche del caricamento) · `scope-expert` |
| `approva · chiudi · pubblica …` | R2 con le approvazioni del livello di autonomia (`sì` per passo solo con autonomia bassa; in produzione `APPROVO PASSO`) | sandbox, preprod (il referente è un avviso, non un blocco: §55.1.2); prod con `write_data: true` e approvazione per passo · `scope-expert` |
| `query "<domanda>"` · `tables` · `learn-analytics` | Analytics | tutti (sola lettura) · `analytics-learner` |

### 56.7 `learn` — apprendimento

| Azione | Cosa fa | Chi |
|--------|---------|-----|
| `lessons [--session]` · `validate` | Lezioni e validazione (DT-004) | `lesson-validator` |
| `outcomes [--week\|--session] [--confirm <DEC>]` | Registro degli esiti; conferma umana | script `digest/learn.mjs outcomes` |
| `calibrate --propose` | Proposte di nuove versioni delle DT sui DEC smentiti | script |
| `digest-weekly` · `competence-report` · `promote <codice>` | Digestione settimanale (§45.6), competence report, promozione a S (frase `APPROVO PROMOZIONE <codice>`) | `weekly-digest`; script; script a forma esatta |
| `tickets <xlsx>` · `patterns` · `brief --scope` | Dominio analitico (ticket pseudonimizzati, PAT/PBK, BRF) | script T0 (nessun sub-agente) |

### 56.8 `admin` — operazioni (fuori dal lavoro quotidiano)

| Azione | Cosa fa | Approvazioni |
|--------|---------|--------------|
| `retention [--apply]` | Applica le retention (prima un elenco a secco) | 1: `APPROVO RETENTION <C>` |
| `customer purge <ID>` | **L'unica cancellazione**: rimuove un cliente; certificato (i token salati nei report di `product/digest/` restano: §55.1.2) | 2 con frase, da due persone: `APPROVO PURGE <ID> DA <Nome Cognome>` |
| `lock [--clear-expired] · session [close-stale] · integrity` | Lock, sessioni, verifica del pacchetto | — |

Sempre script diretti, mai un sub-agente. Le righe di comando di purge, retention e promozione sono le sole forme
ammesse dai guard, che confermano ogni approvazione nel transcript.

---

## 57. Scrivere un intento, seguire il workflow, leggere i report

### 57.1 Come si scrive un intento

Un intento efficace ha quattro elementi; se uno manca, il plugin lo chiede prima di partire.

| Elemento | Esempio | Se manca |
|----------|---------|----------|
| **Cliente e ambiente** | "su ACME sandbox" | Chiede; non parte mai senza ambiente |
| **Cosa fare** (verbi del catalogo) | "crea una richiesta", "verifica che", "configura", "dimmi" | Chiede quale classe di azione |
| **Su cosa** (entità, con dati) | "10 monitor da catalogo, CdC IT-0442" | Chiede i dati mancanti a lotti |
| **Fin dove** | "e portala in approvazione", "solo in bozza" | Si ferma allo stato più conservativo (bozza) |

Esempi:

- *"Su ACME sandbox, crea una RdA di prova per 5 sedie da catalogo, CdC IT-0442, lasciala in bozza."* → `ACT-OBS` +
  `ACT-CREATE`, parte subito, nessuna approvazione.
- *"Su ACME pre-produzione, rendi obbligatorio il campo Codice progetto sopra 10.000 €."* → `cfg design` → piano → 2
  approvazioni (giallo) → esecuzione.
- *"Su ACME produzione, dimmi perché l'ordine 4500012345 è fermo."* → `ACT-OBS`/`ACT-QRY` in prod, sola lettura,
  diagnosi, fascicolo di evidenze strict.
- *"Su ACME produzione, crea un ordine di test."* → ammesso dal catalogo **solo** se l'ambiente ha `write_data: true`
  (interruttore dell'utente in `environments.yaml`) e con approvazione per ogni passo; con `write_data: false` il
  plugin risponde "in produzione i dati si scrivono solo con write_data: true; posso farlo in sandbox o pre-produzione".

#### Il catalogo delle azioni per ambiente (§29.4, rivisto da spec 2026-10-06 §3.3)
| Classe | Sandbox | Pre-produzione | Produzione |
|---|---|---|---|
| `ACT-OBS` · `ACT-READ` · `ACT-QRY` · `ACT-CFG-READ` | libera | libera | libera |
| `ACT-CREATE` · `ACT-UPDATE` · `ACT-UPLOAD` · `ACT-SUBMIT` · `ACT-CLOSE` | libera | libera | con approvazione per passo (`write_data: true`) |
| `ACT-APPROVE` · `ACT-TRANSMIT` · `ACT-PUBLISH` | libera | con referente | con approvazione per passo (`write_data: true`) |
| `ACT-CFG-CHANGE` | con approvazione | con approvazione | con approvazione, tre per passo; rosso solo per oggetti in `prod_allowed_red` |
| `ACT-BULK` (import, massivi: file compilato del run, verbo `UPLOAD`) | con approvazione | con approvazione | con approvazione, tre per passo |
| `ACT-DELETE` (verbo `DELETE`) | con approvazione | con approvazione | **mai** |

In produzione si scrive solo con `write_data: true` e approvazione per passo; il rosso solo per oggetto in
`prod_allowed_red` (§52.1 superato dalla spec 2026-10-06 §3.6). La cancellazione esiste in sandbox e pre-produzione:
l'ADR-06 («mai delete») vale ora solo per la produzione, dove si compensa con `close`/`cancel`.

### 57.2 Le frasi di approvazione

Le frasi si scrivono **come unico testo del messaggio**, con le parole chiave in maiuscolo (spazi e un punto finale
tollerati, anche dopo uno spazio: `APPROVO PIANO <PLAN> .`). Le riconosce e le registra l'hook `approval-capture` nel registro della sessione (catena di hash), con
l'orario; i guard le confermano nel transcript. Il modello **non** può scriverle al posto dell'utente: i guard negano
queste frasi in ogni input di strumento. Una frase diversa, un piano sbagliato o una finestra scaduta danno
"Approvazione non valida" con la frase attesa.

| Situazione | Cosa scrivere |
|-----------|---------------|
| Azione R2 in sandbox/preprod **con autonomia bassa** | `sì` (oppure `si`, `yes`) alla domanda del workflow, che mostra importo, stato di arrivo, compensazione; vale per UNA azione in attesa. Con autonomia alta o media non si chiede; in produzione `sì` è rifiutato |
| Livello di autonomia (per la sessione) | `AUTONOMIA ALTA` · `AUTONOMIA MEDIA` · `AUTONOMIA BASSA` (valgono finché non se ne scrive un'altra). Alternativa: `default: alto\|medio\|basso` in `customers/<C>/config/autonomy.yaml`, scritto dall'utente; predefinito alto; tetto medio in produzione; file illeggibile o valore non valido ⇒ basso. Vedi la tabella sotto |
| Pre-produzione con autonomia media o bassa; piani con invii, configurazione o cancellazioni | `APPROVO PIANO <PLAN>` (con autonomia alta un piano di sola creazione o import parte senza frase) |
| Configurazione verde | `APPROVO PIANO <PLAN>` |
| Configurazione giallo | `APPROVO PIANO <PLAN>` poi `APPROVO PASSO <n> <PLAN>` |
| Configurazione rosso | `APPROVO PIANO <PLAN>` · `APPROVO PROVA <PLAN>` · `APPROVO PASSO <n> <PLAN>` |
| **Produzione, scrittura di dati o import** (con `write_data: true`) | `APPROVO PIANO <PLAN>`, poi `APPROVO PASSO <n> <PLAN>` prima di **ogni** passo che modifica o carica (monouso, legata al piano); `APPROVO PROVA <PLAN> DA <Nome Cognome>` da una persona diversa se `second_approver_required` (preimpostato in produzione). Prima di ogni passo il manager mostra file, righe e oggetti toccati |
| **Produzione, qualunque configurazione** | A1 + passo (`APPROVO PIANO <PLAN>`, `APPROVO PASSO <n> <PLAN>`) entro la finestra (60 minuti dalla A1), più A2 (`APPROVO PROVA <PLAN> DA <Nome Cognome>`, da una persona diversa dalla A1, con `DA <Nome Cognome>` anche in A1) se è richiesto il secondo approvatore (`second_approver_required`, preimpostato in produzione) |
| Esplorazione senza piano (un'unica esplorazione, sandbox o pre-produzione: clicca, compila, salva, invia, approva con valori di prova; mai cancellazioni, upload, script; elenco delle azioni con effetto a fine giro; in pre-produzione un invio può mandare davvero e-mail ai fornitori o dati all'ERP; [guida](GUIDA-PRIMO-USO.md)) | `ESPLORA SANDBOX` · `ESPLORA PREPROD` (sinonimi: `ESPLORA SANDBOX COMPLETA` · `ESPLORA PREPROD COMPLETA`), poi `/jaggaer-virtual-consultant:use mode esplorazione` entro 10 minuti |
| Promozione di un item a S (`learn promote`) | `APPROVO PROMOZIONE <codice>` (valida 24 ore, monouso) |
| Retention (`admin retention --apply`) | `APPROVO RETENTION <C>` (valida 60 minuti, monouso) |
| Cancellazione di un cliente (`admin customer purge`) | `APPROVO PURGE <ID> DA <Nome Cognome>`, due volte, da due persone diverse, nella sessione di quel cliente (60 minuti) |
| Alzare il budget | `/jaggaer-virtual-consultant:use budget <n>` |
| Compensare a fine sessione | `compensa tutto` · `lascia <entità>` (risposta alla domanda del manager sulle compensazioni pendenti) |

Cosa si chiede, per livello e ambiente (spec 2026-10-06 §2.2; produzione con tetto medio):

| | sandbox | pre-produzione | produzione (tetto medio) |
|---|---|---|---|
| creare, aggiornare (R1) | nulla | alto: nulla · medio/basso: `APPROVO PIANO` | `APPROVO PIANO` + `APPROVO PASSO <n>` prima di ogni passo che modifica |
| inviare, approvare, trasmettere, pubblicare, chiudere, caricare (R2) | alto/medio: nulla · basso: `sì` per passo | alto/medio: coperti da `APPROVO PIANO` · basso: `sì` per passo | `APPROVO PIANO` + `APPROVO PASSO <n>` |
| configurazione (`ACT-CFG-CHANGE`) | alto: `APPROVO PIANO` · medio/basso: per policy (A1/A3/A2) | idem | `APPROVO PIANO` + `APPROVO PASSO <n>` (+ istantanea prima) |
| import massivi (`ACT-BULK`) | alto: nulla · medio/basso: `APPROVO PIANO` + `APPROVO PASSO <n>` | idem | `APPROVO PIANO` + `APPROVO PASSO <n>` prima del caricamento; oggetti di configurazione: anche l'istantanea dei dati attuali (`compose-plan --istantanea`) |
| cancellare (`ACT-DELETE`) | alto: coperte da `APPROVO PIANO` · medio/basso: + `APPROVO PASSO <n>` | idem | **mai** |

Resta a ogni livello: `APPROVO PROVA` da una persona diversa quando l'ambiente ha `second_approver_required`; compensazione
registrata prima di creare, aggiornare, inviare, importare; per configurazioni e cancellazioni la lettura completa (istantanea)
degli oggetti toccati salvata prima; ogni click legato al SEL del passo; nessuno script nella pagina; elenco finale di ciò
che è stato creato, modificato, importato o cancellato con il livello applicato. In produzione le scritture di dati richiedono
inoltre `policy.write_data: true` per quell'ambiente (interruttore dell'utente); le configurazioni in produzione sono
regolate dalle approvazioni, non da `write_data`; un caricamento è ammesso solo in un passo approvato col verbo `UPLOAD`;
letture e navigazione restano libere. Con `policy.write_data: false` in **qualunque** ambiente (anche sandbox o una
pre-produzione copia della produzione) import massivi e cancellazioni sono negati da step-check e da guard-config-scope.

**Cancellazioni** (solo sandbox e pre-produzione): ammesse solo dentro un passo `DELETE` di classe `ACT-DELETE`, un
elemento per passo (elemento ambiguo o seconda cancellazione nello stesso passo ⇒ negato); prima del passo la lettura
completa dell'oggetto in `runs/<RUN>/evidence/` e la compensazione `restore` che la richiama; i pulsanti di massa (elimina
tutti, svuota, purge…) sono sempre negati e l'esplorazione non cancella mai; la finestra di conferma nella pagina è un passo
`CLICK` a parte, di classe `ACT-DELETE`, legato al SEL del pulsante di conferma (i dialoghi nativi passano da
`handle_dialog`; fuori da un passo `ACT-DELETE` un dialogo che conferma una cancellazione — testo del dialogo o domanda
nella pagina — è negato in ogni ambiente). Un piano di cancellazione non spunta righe prima: un passo `ACT-BULK`,
`TOGGLE`/`SELECT` o un `CLICK` su un SEL di ruolo checkbox (o non risolto) prima del passo `DELETE` ⇒ step-check nega il
`DELETE` (più righe ⇒ più passi `DELETE`).

Le frasi di approvazione riconosciute sono quindi: `AUTONOMIA ALTA`, `AUTONOMIA MEDIA`, `AUTONOMIA BASSA`, `APPROVO PIANO`, `APPROVO PROVA`, `APPROVO PASSO`, `APPROVO
PROMOZIONE`, `APPROVO RETENTION`, `APPROVO PURGE` (con `DA <Nome Cognome>` dove serve), `sì`, `ESPLORA SANDBOX`, `ESPLORA PREPROD`, `ESPLORA SANDBOX COMPLETA`, `ESPLORA PREPROD COMPLETA`.
Per le approvazioni amministrative l'hook risponde con un **token** (le prime 16 cifre esadecimali dell'hash del
record): il manager lo usa nella riga di comando; non va copiato né inventato altrove.

### 57.3 Leggere il workflow

Il blocco in fondo alla conversazione ha sempre: intestazione (sessione, cliente, **ambiente con banner**, scope,
modalità, budget usato/totale), una riga per passo (agente, classe di azione, descrizione, stato ▶ in corso · ✓ fatto ·
⏸ attende · ✗ fermato · · pianificato, evidenza), e una riga di totali (sorprese, errori, evidenze). Una riga ⏸ è sempre
seguita dalla domanda. Una riga ✗ è sempre seguita dal motivo e da cosa serve per riprendere. In produzione il banner è
`⚠ PRODUZIONE — ogni passo che scrive si approva; dati e import solo con write_data`, con lo stato della 3A. Da un'altra finestra:
`/jaggaer-virtual-consultant:vc watch <SES.C.AAAAMMGG.NNN>`.

### 57.4 Leggere i report

I report di azione (§29.8) si leggono dall'alto: **Esito** e **Entità** dicono cosa è successo e cosa è pendente;
**Esecuzione** dice come; **Lezione** e **Prossimi** dicono cosa fare dopo. I report di test si leggono dal
**Verdetto** per scope e dai **Fallimenti**: ogni fallimento porta la classificazione e l'azione già intrapresa
(Defect, PR, quarantena). Le evidenze sono nella cartella su disco indicata (release → scope → caso) e, per i test, su
Xray. Gli esiti possibili: SUCCESS, EXPECTED-ERROR-AS-SUCCESS (l'errore atteso è un successo), ERROR-AS-LESSON,
ERROR-BLOCKING, ERROR-ENVIRONMENT (mai un Defect), ABORTED-BY-USER. Un passo fermato da una sorpresa **incompatibile**
(step-check, DT-016) è ERROR-BLOCKING (Xray FAILED), non PARTIAL: il compito non ha fatto ciò che doveva.

### 57.5 Seguire e controllare gli agenti

Il manager instrada il lavoro ai sub-agenti; un monitor indipendente (gli hook del plugin) registra cosa fa ciascuno.
Il contratto completo è in [`docs/orchestration.md`](orchestration.md).

- **Console**: `/jaggaer-virtual-consultant:vc agents` — una riga per agente (task_id, tipo, scope, tier, stato,
  durata, budget usato, ultima azione, sorprese, domande aperte); `vc agents show <task_id>` la cronologia di un compito;
  `vc agents history` i compiti chiusi. Un agente `incoerente` (rapporto diverso dalle registrazioni) si tratta come
  `partial`. La console segnala anche gli scope bloccati dalla vigilanza, la catena di audit interrotta e gli avvisi
  sul manager.
- **Dal vivo, da un terminale separato** (sola lettura, senza modello, si aggiorna da sé):

      node "<cartella del plugin>/scripts/admin/agents.mjs" watch --session <SES.C.AAAAMMGG.NNN> --interval 5

  cioè `node "${CLAUDE_PLUGIN_ROOT}/scripts/admin/agents.mjs" watch --session <SES.C.AAAAMMGG.NNN> --interval 5` con il
  percorso del plugin al posto del segnaposto.

**Frasi di controllo**, scritte dall'utente come unico testo del messaggio (maiuscole). Le applicano i guard su ogni
chiamata dei sub-agenti; il modello non può scriverle (negate in ogni input). Quelle che **aumentano** la protezione
valgono subito; quelle che la **riducono** valgono dopo la conferma nel transcript.

- `PAUSA AGENTE <task_id>` · `PAUSA TUTTI` — ogni chiamata dell'agente (o di tutti) è negata e nessun nuovo dispatch del
  compito (o di nessun compito). Vale subito.
- `FERMA AGENTE <task_id>` · `FERMA TUTTI` — chiamate negate, invocazione chiusa subito (`aborted-by-user`, esito
  ABORTED-BY-USER), il compito non si ridispaccia. FERMA TUTTI vale solo per gli agenti in corso in quel momento (i dispatch aperti quando scrivi la frase): quelli avviati dopo non sono toccati. Vale subito.
- `PASSO PASSO <task_id|TUTTI>` (cioè `PASSO PASSO <task_id>` o `PASSO PASSO TUTTI`) — ogni azione con effetto
  dell'agente attende il `sì` dell'utente (una azione alla volta: il manager la mostra e attende). Vale subito.
- `RIPRENDI AGENTE <task_id>` · `RIPRENDI TUTTI` — riprende l'agente in pausa (o tutti). Vale dopo la conferma.
- `PASSO PASSO OFF` — spegne il passo-passo per tutti. Vale dopo la conferma.
- `SBLOCCA SCOPE <S>` — azzera la vigilanza dello scope: dopo tre compiti consecutivi fermati per sorprese lo scope è
  bloccato ("il modello di questo scope va rifatto prima di continuare"); si sblocca solo così, dopo il giro di
  osservazioni proposto. Vale dopo la conferma.
- `LIMITI DISPATCH <chiamate> <minuti>` — cambia i limiti per dispatch (default 200 chiamate di strumento e 30 minuti, che
  in modalità esplorazione non si applicano: vale solo il budget di token della sessione, salvo limiti dichiarati con questa frase;
  al più 5000 e 480). Vale dopo la conferma.

### 57.6 Le skill: come ragionano il manager e gli agenti

Le skill (`skills/`, §44.3) dicono **come** si lavora; la conoscenza (`kb/`, `product/`) dice **cosa**. Non contengono
fatti di prodotto né dati di clienti, e non concedono strumenti: gli agenti le caricano quando il compito le richiede
(la `description` di ciascuna dichiara quando usarla) e le definizioni in `agents/` citano quelle del loro lavoro — tutte
tranne `jaggaer-domain`, che nessun agente cita: la attiva solo la sua description, come mappa per orientarsi.

- **`agent-manager`** — la skill della sessione principale, caricata all'avvio (il contesto di SessionStart lo chiede).
  Fa della sessione il manager: legge la console prima di instradare, dopo ogni ritorno e prima di rispondere;
  compone i prompt da `templates/agent-prompt.md` con tier e modello concordi (DT-003) e profondità (DT-023); media gli
  handoff; porta all'utente le domande e le frasi di approvazione esatte richieste dagli agenti; concede e toglie la
  lettura trasversale a `process-mapper` e `weekly-digest`; scrive le lezioni dei ruoli senza scrittura; non fa lavoro
  di dominio (≤ 15 % dei token). Contratto: [`docs/orchestration.md`](orchestration.md). Un sub-agente non la usa.
- **Cognizione**: `reasoning-cycle` (i sei passi e le tracce, citata da ogni agente) · `epistemic-awareness` (forma e
  precedenza fra fonti) · `strategies` (DT-017) · `self-check-and-lesson` (dalla quasi totalità) · `precedents` ·
  `decision-tables` (`dt-eval`) · `asking-the-user` (dai ruoli che formulano domande) · `belief-revision` (sorprese,
  conferme, ipotesi: dai ruoli che eseguono, digeriscono o diagnosticano).
- **Struttura della conoscenza**: `field-modeling` · `coding-system` · `faceting-and-weights` · `clustering-rules` ·
  `token-economy`.
- **Dominio e collaudo**: `jaggaer-domain` · `identity-and-keys` · `integration-testing` · `nrt-authoring` ·
  `selector-strategy` · `evidence-and-xray`.
- **Sicurezza e confini**: `data-safety` · `doc-ingestion` · `failure-forensics` · `jaggaer-configuration` ·
  `domain-boundary` · `scope-discipline` · `customer-isolation`.

Le skill sono nel perimetro dell'integrità del pacchetto (`integrity.json`): modificarle richiede una nuova build.

---

## 58. Risoluzione dei problemi

| Sintomo | Causa probabile | Cosa fare |
|---------|-----------------|-----------|
| "Nessun ambiente dichiarato" | `/use env` mancante | Dichiararlo, o includerlo nell'intento |
| "Ambiente non riconosciuto (1 segnale su 2)" | Impronta cambiata (nuova release, banner diverso) | `doctor`; aggiornare `fingerprint` con il referente; **non** forzare |
| "Host non in allow-list" | Redirect SSO o CDN non dichiarati | Aggiungere l'host in `environments.yaml` fuori sessione |
| "Azione negata: produzione" | Scrittura in prod senza `write_data: true` o fuori da un passo di piano approvato (piano e passo), cancellazione, caricamento fuori da un passo `UPLOAD` | È corretto: attivare `write_data` (a cura dell'utente) e approvare piano e passo, oppure usare sandbox/preprod; la cancellazione in produzione non esiste |
| Il plugin chiede approvazioni che prima non chiedeva, o non ne chiede | Livello di autonomia diverso da quello atteso (frase di sessione, `autonomy.yaml`, tetto medio in produzione, file illeggibile ⇒ basso) | `use show` mostra livello, fonte e tetto; `AUTONOMIA ALTA`/`MEDIA`/`BASSA` lo cambia (la scrive l'utente) |
| Import: "errore di formato" · righe fallite | Template del tenant cambiato; dati non validi | Riscarica e reimpara il template (`kb template-learn`), ricompila una volta; righe fallite: correggi e reimporta solo quelle (al massimo 2 volte) |
| Import: `unrecognized` · `missing` | Nessuna riga né codice riconosciuti nel testo dell'esito; righe del file (`--righe`) senza esito | Non è un successo: rileggi la pagina o scarica il log (`--in`); le righe mancanti vanno verificate |
| Import di configurazione in prod: `config-snapshot` | Manca l'istantanea dei dati attuali | Scarica l'export dell'oggetto in `runs/<RUN>/evidence/` e ripassa `compose-plan --istantanea` |
| `tpl-no-page` · template "intestazione su più righe" | Voce `TPL` senza pagina di import; template con gruppi sopra le colonne | Reimpara con `--page <firma>`; semplifica l'intestazione a una riga |
| "write_data: false … niente import massivi né cancellazioni" | L'ambiente (anche sandbox o pre-produzione) ha le scritture spente | Decisione dell'utente: accendere `write_data` in `environments.yaml` |
| "Approvazione non valida" | Frase diversa da quella richiesta, o finestra scaduta | Scrivere la frase esatta (§57.2); se scaduta, ripartire da A1 |
| "Budget esaurito" | Compito più costoso del previsto | `use budget` se giustificato; altrimenti ridisegnare il compito (meno passi, più replay) |
| "Risultato respinto: traccia cognitiva mancante" | Il sub-agente ha saltato il ciclo | Automatico: il sub-agente completa; se persiste, `learn lessons --session` e segnalare |
| "Compensazioni pendenti" all'avvio | Sessione precedente interrotta | `vc status` → `compensa tutto` o `lascia` |
| "Integrità del pacchetto fallita" | Plugin modificato o manomesso (il perimetro comprende anche `commands/`, `product/`, `clusters/`, `package.json`, `package-lock.json`) | Reinstallare dalla release firmata (`npm ci`); non operare. La chiave della firma viaggia nel pacchetto: confrontare l'impronta della release con quella pubblicata (§55.1.2) |
| "Knowledge version incompatibile" | Plugin aggiornato, conoscenza no | `kb migrate` |
| "Jira irraggiungibile" | Rete o credenziali | La run non fallisce; `nrt push-xray --retry-queued` più tardi |
| "DB bloccato" | Reindex o digest in corso | Attendere; `admin lock` per vedere chi lo tiene |
| Troppe domande | Copertura epistemica bassa sullo scope | `kb epistemic --scope --plan` ed eseguire le osservazioni R0 suggerite |
| Troppe sorprese | Modello del cliente disallineato (sandbox non aggiornata, doc vecchia) | Ricognizione del tenant; verificare `alignment`; ri-digerire le fonti aggiornate |
| Ogni chiamata negata, `doctor` con `deps` rosso | Dipendenze del plugin non installate (i guard sono fail-closed) | `npm ci` nella cartella del plugin (non `npm install`: può riscrivere `package-lock.json`, sotto integrità), poi `vc doctor` |
| Purge, retention o promozione negate "forma esatta"; nella riga di comando si vede `${CLAUDE_PLUGIN_ROOT}` | Claude Code non ha sostituito il segnaposto con il percorso del plugin | `vc doctor`: controllo `plugin-root` (Appendice B); aggiornare Claude Code. Nessun rischio: l'operazione è solo bloccata |
| "pagina troppo grande" / uscita troncata nello strumento del browser | La risposta supera il limite di uscita degli strumenti MCP di Claude Code (variabile d'ambiente `MAX_MCP_OUTPUT_TOKENS`) o il `max_chars` di `read_page` | Nessun blocco. Chrome DevTools (l'unico per esplorare in pre-produzione): `take_snapshot` con `filePath` assoluto nella cartella `customers/<C>/.sessions/<sid>/snapshots/` (la scrive solo lo strumento: Write, Edit e la shell vi sono negati), il plugin legge il file scritto in quella chiamata come lettura completa e l'agente lo legge a pezzi con Read; browser di Claude (sandbox): `read_page` con `ref_id`/`depth` o `max_chars` più alto, i pezzi della stessa pagina si sommano nella mappa e nel registro (anche un pezzo troncato scrive il suo record parziale, ma non aggiunge ref alla mappa; un find tiene la mappa senza aggiungervi nulla). Nessun tetto sul numero di elementi; se la mappa supera il limite in byte dello stato di sessione i click sono negati con "mappa della pagina troppo grande": navigare di nuovo alla pagina. In alternativa alzare `MAX_MCP_OUTPUT_TOKENS` |
| Click di esplorazione negato "non ha un nome" o "a coordinate" | Ogni click di esplorazione vuole un elemento con nome dell'ultima lettura della pagina corrente, per uid/ref; i click a coordinate del browser di Claude sono negati anche in sandbox | Rileggere la pagina (o il pezzo) e cliccare per uid/ref |
| "azione con effetto del browser di Claude … negata" fuori dalla sandbox | Il browser di Claude fuori sandbox legge e naviga soltanto | Installare e usare Chrome DevTools MCP per i passi con effetto |
| "comando non semplice" / "cita il plugin insieme a un interprete" | Testo libero o JSON in linea nella riga di comando di uno script del plugin | I dati vanno in un file della sessione (`--payload-file`, `--text-file`, `--finding`) |
| Un agente non risponde più / tutto negato a un agente | Pausa, stop o limiti per dispatch attivi | `vc agents`; `RIPRENDI AGENTE <task_id>` o `LIMITI DISPATCH <chiamate> <minuti>` |
| "il modello di questo scope va rifatto prima di continuare" | Vigilanza: tre compiti consecutivi fermati per sorprese | Giro di osservazioni proposto dal manager, poi `SBLOCCA SCOPE <S>` |
| "una sola escalation di tier per compito" | Seconda escalation dello stesso compito | Riformulare il compito o dividerlo; chiedere all'utente |
| Purge, retention o promozione: "approvazione mancante" (exit 3) con la frase appena scritta, due sessioni aperte nello stesso workspace | L'approvazione vive nel registro della sessione in cui è stata scritta; un comando senza la sessione giusta cerca in quella corrente (`.jvc/current-session`) | Scrivere la frase e lanciare il comando **nella stessa sessione** (le righe dei comandi passano `--session "${CLAUDE_SESSION_ID}"`); chiudere o non usare in parallelo l'altra sessione sullo stesso workspace |
| "server MCP … non ammesso con un ambiente dichiarato" | Strumento di un server MCP che non è né una famiglia del browser né nell'allow-list del plugin | È voluto (§55.1.2): usarlo senza ambiente dichiarato, o chiederne l'aggiunta con una release |
| Dopo un aggiornamento del plugin ogni chiamata negata: "session.json non valido" o "stato di sessione illeggibile" | Schema della sessione più severo nella nuova versione | `/jaggaer-virtual-consultant:use customer <ID>` (ripara, con copia di riserva); le compensazioni pendenti restano in `runs/<RUN>/compensations.yaml`: `vc status` |
| In CI uno script usa la sessione sbagliata o si ferma | Puntatore `.jvc/current-session` lasciato da una sessione chiusa | Passare `--session <id>` (o `JVC_SESSION_ID`); checkout pulito senza `.jvc/` |
| "file fuori dal workspace" | Un file d'ingresso fuori dal workspace degli hook (anche se dentro il `--workspace` passato allo script) | Metterlo nella cartella della sessione (`customers/<C>/.sessions/<sessione>/`) e passarlo relativo (§56) |
| "passo N del piano … completato; il passo M è stato negato" | Il gate del passo successivo è stato negato (compensazione mancante, classe fuori catalogo): il piano resta fermo sul passo verificato | Correggere il piano e riattivarlo con `step-check --resume`, oppure chiuderlo con `--close` |
| Defect o Test Execution doppi in Jira | Ritentativo di un POST scaduto sul client ma riuscito sul server | Chiudere il doppione in Jira; `xray verify` sulla run (§55.1.2) |
| Jira Server/DC del cliente irraggiungibile per policy | Host on-premise non nella categoria `alm` di `NETWORK.md` | Serve una release del plugin con l'host aggiunto |
| Verificare gli agenti dopo un aggiornamento del plugin o del modello | Eval degli agenti di §49.1 (a ogni release) | `claude plugin eval .` con lo scaffold: [Appendice C](#appendice-c--verificare-gli-agenti-con-la-suite-evals) |

---

## 59. Sintesi in una pagina

```
 TRE PARTIZIONI       dominio × scope × cliente (S / C / L) — imposte da tre guard
 UNA CELLA PER AGENTE

 CONOSCENZA           codice → 15 faccette (F15 = genere: tecnica · d'uso · empirica · testimoniale)
                      → confidenza → cluster ammessi → W → `kb` troncato
                      campi: FLD con obbligatorietà come regola, ragione, lineage; a lotti ≤ 50
                      per soggetto: copertura epistemica K → forma (consolidato · libresco · empirico · ignoto · contraddittorio) → gaps

 PENSARE              quanto pensare: DT-023 (rapida · standard · profonda)
                      situare → richiamare (so · è successo · vedo) → valutare (forma, concordanza)
                      → decidere (strategia DT-017 · DT con priori · piano = traccia attesa per passo)
                      → agire (su Chrome via MCP; step-check; sorpresa → ripianifica; epistemica ≠ aleatoria)
                      → riflettere (self-check · guardie anti-bias · lezione · esito atteso · why)
                      profondo: registro delle ipotesi (≥ 2, test discriminante più economico) · pre-mortem · cerca la smentita
                      precedenza: progettare = tecnica > storico > scoperto · eseguire = scoperto > storico > d'uso
                      R ≥ R2 richiede due generi concordi, o una domanda dai gaps
                      una osservazione blocca, mai riscrive; tre sostituiscono; la confidenza dichiarata si calibra (Brier)

 AGIRE                l'agente agisce su Chrome tramite il plugin (MCP): piano codificato → passo → step-check →
                      observe-append (OBS, ERR) → sorpresa? · Playwright solo compilato, opzionale, per la CI
                      catalogo delle azioni (ACT-*) decide rischio · ambienti · approvazioni · evidenze · report · scritture · budget
                      intento in linguaggio naturale → DT-026 → avvio automatico (≤ R1 in sandbox, R0 ovunque) → workflow visibile
                      ogni azione → RPT · esito: SUCCESS · EXPECTED-ERROR-AS-SUCCESS · ERROR-AS-LESSON · ERROR-BLOCKING …

 AMBIENTI             dichiarato + rilevato (≥ 2 segnali) + verificato a ogni origine · host sconosciuto = negato
                      produzione: scritture solo con write_data: true e approvazione per passo (spec 2026-10-06 §3.6) · cancellazioni mai · configurazioni con piano + passo (+ prova da una seconda persona se second_approver_required)
                      autonomia (alto · medio · basso): AUTONOMIA ALTA|MEDIA|BASSA o autonomy.yaml · predefinito alto · tetto medio in produzione · tabella §57.2 · import massivi con template · cancellazioni in sandbox/preprod dentro un passo DELETE
                      qualità parametrica Q (16 parametri, decadimento per tipo) → classe d'uso → cosa si può fare con un'informazione

 ACQUISIRE            profilo del DOC (affidabilità calcolata) → parsing per formato → unità di significato tipizzate
                      → estrazione per schema (modalità deontica: obbligo · condizionale · divieto · facoltà · raccomandazione)
                      → digestione guidata dagli attributi attesi (banca di domande; i gap sono gratis)
                      → alias e versioni → DT-020/021/022 (tipo · S/C · completezza) → back-check T0 ("il testo lo dice?")
                      → residuo classificato → report per documento → revisione stratificata
                      incrementale per hash di unità · il tenant è un documento · backlog per guadagno epistemico

 STORICO              DEC → esito verificato → tassi per (DT, cluster, cliente, forma, strategia) → priori
                      precedenti a distanza di contesto: replay · orienta · ignora; smentite incorporate come CHK
                      calibrazione mensile delle tabelle su ≥ 10 DEC, con umano

 STRATEGIE            REPLAY · VERIFY-FIRST · TRIANGULATE · DRY-RUN · MIN-CHANGE · BISECT
                      EXPLORE-BUDGET · ASK-EARLY · GENERALIZE-CAUTIOUSLY · STOP-RECORD

 AGENTI               1 manager (skill agent-manager) · 3 ruoli parametrici × scope · 12 trasversali = 15 foglie · ≥ 18 script
                      messaggi codificati con traccia cognitiva · tier per invocazione · de-escalation
                      console e controllo dell'utente: vc agents · PAUSA / FERMA / PASSO PASSO / RIPRENDI · SBLOCCA SCOPE

 CRESCITA             osservazione · esecuzione · utente → lezione (8 sezioni) → validazione → cluster
                      → digestione settimanale → portabilità → promozione a S (umano) → competence report

 ECONOMIA             il costo del ragionamento è proporzionale a ciò che non si sa:
                      consolidato + precedente = T0 in poche centinaia di token
```

---

## 60. Verifiche prima del rilascio e dal vivo

I test automatici (`npm test`, `npm run test:timing`, la validazione strutturale di `evals/`) provano il codice con
input simulati. Le voci che seguono si possono provare **solo** in una sessione vera di Claude Code, su un tenant
JAGGAER e su un Jira veri, o con dati reali di un cliente pilota. Vanno fatte prima del rilascio (o alla prima occasione
dal vivo) e registrate con l'esito.

**Installazione e piattaforma Claude Code**

1. **Hook caricati una volta sola.** Dopo l'installazione, `claude plugin validate .` e poi `/hooks` in una sessione:
   ogni registrazione di `hooks/hooks.json` compare **una sola volta** (il manifest non dichiara più `hooks` né
   `mcpServers`: i file predefiniti si caricano comunque) e nessun avviso "Duplicate hooks file"; lo stesso per i server
   di `.mcp.json` in `/mcp`.
2. **`${CLAUDE_PLUGIN_ROOT}` nei corpi di skill e agenti** (non solo dei comandi, Appendice B): le righe di comando di
   `skills/agent-manager/SKILL.md`, `skills/*/references/*.md` e `agents/*.md` devono arrivare a Bash con il percorso
   letterale del plugin; altrimenti falliscono o i guard le negano.
3. **`${CLAUDE_SESSION_ID}`** sostituito nei comandi e nelle skill (le righe di purge, retention e promozione passano
   `--session "${CLAUDE_SESSION_ID}"`): controllare nel riquadro Bash che compaia l'id della sessione.
4. **Semantica dei matcher degli hook e nomi degli strumenti MCP**: gli strumenti dei server del plugin si chiamano
   `mcp__plugin_jaggaer-virtual-consultant_<server>__<strumento>` e i matcher di `hooks/hooks.json` li intercettano
   (una chiamata di prova negata in audit per ciascuna famiglia: alm, chrome-devtools, playwright, browser di Claude).
5. **Formato del transcript**: l'intestazione del dispatch nel transcript del sub-agente (F3), i campi di origine umana
   dei prompt (N4) e le righe di sidechain che contano la quota del manager (`docs/orchestration.md` §7).
6. **Legame sub-agente ↔ compito** (WP10d): con due agenti dello stesso tipo in parallelo `vc agents` li mostra ciascuno
   sul suo `task_id`; le chiamate del manager dalla sessione principale passano dai guard veri (WP10c).
7. **Scoperta dei casi eval annidati**: `claude plugin eval .` deve trovare i casi in `evals/<ruolo>/<caso>/` e ignorare
   `evals/_support/` e `evals/mocks/` (Appendice C); contare i casi scoperti (300).

**Browser e tenant**

8. **Back con bfcache** in Chrome reale: dopo un "indietro" il plugin non lega più gli elementi della pagina precedente
   (observe-append rilegge la pagina prima dell'azione successiva).
9. **Marcatori di risposta per famiglia** del browser ("Successfully navigated", `Tab Context`/"Navigated to",
   "Page URL") sulle versioni fissate dei server.
10. **Versioni fissate dei server MCP**: `npm view chrome-devtools-mcp@1.9.0` e `npm view @playwright/mcp@0.0.41`
    esistono e funzionano con il Claude Code installato.
11. **Impronta dell'ambiente sul tenant reale** (≥ 2 segnali, §55.3) e primo **R2 CFP** sul tenant (criterio C1:
    VERIFY-FIRST → DRY-RUN → esecuzione, prove M12–M16).
12. **Casi eval con effetto sul browser sotto un piano approvato**: la suite `evals/` non li copre; provarli a mano in
    sandbox.

**Jira e Xray**

13. **Formato Xray Server/DC (M13)**: stati PASS/FAIL, `evidences`, stati personalizzati del cliente; la Test Execution
    è leggibile dal responsabile QA (`xray verify` dopo la prima `xray publish`).
14. **Host Jira on-premise**: se il cliente ha Jira Server/DC, il suo host va in `NETWORK.md` con una release (§55.1.2).
15. **Chiave del marketplace nel template delle impostazioni** (`jaggaer-vc` in `templates/settings.template.json`)
    uguale a quella del marketplace privato reale.

**Criteri misurati su dati reali** (pilota; per ciascuno il valore misurato e la data)

16. **K4 — catene di campi corrette ≥ 80 %** dopo la prima digestione reale, con la revisione di un consulente.
17. **F1′ — ≥ 60 % dei soggetti critici consolidati o libreschi** sul pilota, dopo digestione e revisione umana.
18. **C1 — prima CFP R2 sul tenant**: vedi la voce 11.
19. **G1 — secondo cliente**: ≥ 30 % di REPLAY e costo ≤ 30 % del primo.
20. **G2 — DEC smentite ≤ 8 %** e prima calibrazione su ≥ 10 DEC.
21. **Pass rate degli eval per ruolo** (Appendice C): `casesPassed / casesTotal` per ciascuno dei 15 ruoli, con la
    soglia scelta per il rilascio.
22. **Origine del corpus**: per ogni documento del corpus di partenza decidere se è del fornitore (livello S) o materiale
    di un cliente (livello C), e reingerire di conseguenza.
23. **Tempi sulla macchina di installazione**: `npm run test:timing` (guard: mediana del costo proprio < 150 ms e p95
    < 250 ms oltre l'avvio di node; observe-append mediana < 150 ms; `kb fields` < 1 s; SessionStart < 2 s).

---

## 61. Catalogo degli intenti per modalità

Esempi di intenti in linguaggio naturale, con ciò che il sistema ne ricava (`DT-026`, `scripts/decide/intent.mjs`) e
come si comporta. La versione eseguibile di questo catalogo sono i casi golden `61-01`…`61-16` di
[`test/golden/intent/cases.yaml`](../test/golden/intent/cases.yaml) (più i casi limite 17–33), verificati a ogni
esecuzione dei test.

| Intento (esempio) | Modalità · scope | Classi di azione | Ambiente ammesso | Approvazioni | Cosa produce |
|-------------------|------------------|------------------|------------------|--------------|--------------|
| "Su ACME sandbox apri l'ultima RdA e dimmi chi l'ha creata" | operativa · P2P | `ACT-OBS` | tutti | nessuna | Risposta + `RPT` breve, 1 evidenza |
| "Su ACME sandbox crea una RdA di prova per 5 sedie da catalogo, CdC IT-0442, in bozza" | operativa · CAT+P2P | `ACT-OBS`, `ACT-CREATE` | sandbox, preprod | nessuna (piano mostrato) | Entità `NRT-…`, compensazione pendente, `RPT` |
| "…e mandala in approvazione" | operativa · P2P | + `ACT-SUBMIT` | sandbox, preprod | 1 (`sì` al workflow) | Stato `PENDING_APPROVAL`, catena approvatori letta |
| "Su ACME sandbox approva come MANAGER la RdA NRT-…-REQ-001" | operativa · P2P | `ACT-APPROVE` | sandbox; preprod con referente | 1 | Transizione, evidenza `transition` |
| "Su ACME sandbox esegui la regressione del catalogo per la release R25.3" | NRT · CAT | corsia guidata | sandbox, preprod | piano (1) | Run per scope, dossier, Xray, verdetto |
| "Genera un test che verifichi che un fornitore disattivato non sia invitabile a una gara" | NRT · SRC (handoff VEN) | generazione + shadow | sandbox | nessuna | Caso `NRT.*.HND.*` candidato → shadow |
| "Perché la RdA 4500012345 su ACME produzione è ferma in approvazione?" | diagnosi · P2P | `ACT-OBS`, `ACT-QRY` | **prod, sola lettura** | nessuna | Finding con fascicolo strict, nessuna scrittura |
| "Quali campi sono obbligatori per inviare una RdA in ACME, e perché?" | conoscenza · P2P | nessuna (solo `kb`) | — | nessuna | 12 `FLD` con `mandatory.reason`, in 20 parole ciascuno |
| "Su ACME pre-produzione rendi obbligatorio il Codice progetto sopra 10.000 €" | configurazione · ADM (handoff da P2P) | `ACT-CFG-CHANGE` R2 | preprod | 2 (piano, passo) | `CFP` composta, dry-run, esecuzione, `NRT.*.CFG`, `RPT` |
| "Su ACME produzione attiva la notifica di sollecito approvazioni" | configurazione · ADM | `ACT-CFG-CHANGE` verde | **prod** | **3 (3A)** | Piano → prova in preprod + a vuoto in prod → passi approvati → verifica |
| "Su ACME produzione crea un ordine di test" | operativa · P2P | `ACT-CREATE` | **prod con `write_data: true`**; altrimenti rifiutato | piano + passo (mostra-piano) | Con `write_data: false`: "in produzione i dati si scrivono solo con write_data: true; posso farlo in sandbox o pre-produzione"; con `true`: piano da approvare, ogni passo approvato prima |
| "Quanti ordini sopra 50k€ ha fatto ACME negli ultimi 90 giorni?" | Analytics · ANL | `ACT-QRY` | tutti | nessuna | Query eseguita con LIMIT, risultato, `QRY` salvata se coerente |
| "Impara le tabelle di Analytics di ACME" | apprendimento · ANL | `ACT-OBS` | tutti | nessuna | `TBL` enumerate, join inferiti, `DIN` aggiornati |
| "Cosa sappiamo poco dello scope Sourcing di ACME?" | conoscenza · SRC | nessuna | — | nessuna | Report di copertura epistemica + piano di osservazioni R0 |
| "Confronta la configurazione ADM di ACME con la baseline di giugno" | audit · ADM | `ACT-CFG-READ` | tutti | nessuna | Deriva rilevata, `RUL` violate |
| "Cancella la RdA NRT-…-REQ-001" | operativa · P2P | `ACT-DELETE` | sandbox, preprod (dentro un piano); **rifiutato in produzione** | alto: coperta dal piano · medio/basso: + passo | Lettura completa salvata, compensazione `restore`, un elemento per passo; in produzione: "In produzione non si cancella mai; in sandbox e pre-produzione sì, dentro un piano" |

Regole trasversali visibili negli esempi: l'ambiente è sempre nell'intento o attivo in sessione; le scritture partono
da sole quando al livello di autonomia in corso nulla richiede approvazione (`avvia`), altrimenti si mostra il piano
(`mostra-piano`: ogni scrittura in produzione); la produzione è sola lettura sui dati salvo `write_data: true` con piano e
ogni passo approvati; "cancella" è ammesso in sandbox e pre-produzione dentro un piano e rifiutato in produzione.

---

## Appendice A — Template personalizzabili

La cartella `templates/` del plugin (§31.2, §43.3) contiene i modelli dei documenti prodotti. Gli script li usano se ci
sono; senza il file (o se un template perde un segnaposto obbligatorio) generano dal codice lo stesso testo. Si
personalizzano con una release del plugin (la cartella del plugin è in sola lettura durante le sessioni). `templates/` è
nel manifesto d'integrità: dopo una personalizzazione si rigenera `integrity.json` (nel repository del plugin), altrimenti
il pacchetto risulta manomesso e i guard negano tutto. Un template che perde un segnaposto obbligatorio è ignorato con un
avviso (campo `warnings` e messaggio su stderr) e il documento si genera dal codice.

| File | Documento | Script | Segnaposto obbligatori |
|------|-----------|--------|------------------------|
| `playwright-spec.ts.tpl` | Spec Playwright della corsia compilata | `chrome/compile-plan.mjs` | `{{hash}}`, `{{body}}` |
| `page-object.ts.tpl` | Page object dall'Atlas | `compile/generate-atlas-po.mjs --ts` | `{{selectors}}`, `{{atlas_entries}}` |
| `contact-sheet.html` | Foglio dei provini (desk) | `evidence/contact-sheet.mjs` | `{{sections}}` |
| `report-action.md` · `report-test.md` | Report di azione e di test (RPT) | `report/build-report.mjs` | — |
| `defect.md` | Descrizione del Defect | `xray/defect.mjs` | `{{header_line}}`, `{{dossier_line}}` |
| `agent-prompt.md` · `workflow.md` · `ingestion-report.md` · `lesson.md` · `settings.template.json` | Prompt dei sub-agenti, banner del workflow, report di ingestion, lezione, impostazioni del workspace | manager, `admin/workflow.mjs`, `ingest/*`, sub-agenti, installazione (§55.2) | — |

## Appendice B — Verificare la sostituzione di `${CLAUDE_PLUGIN_ROOT}`

I corpi dei comandi del plugin scrivono `node "${CLAUDE_PLUGIN_ROOT}/scripts/…"`; Claude Code sostituisce il
segnaposto con il percorso letterale del plugin prima di eseguire il comando. Le eccezioni a forma esatta dei guard
(purge, retention, promozione, `integrity verify`) lo presuppongono. Per verificarlo:

1. eseguire un comando qualsiasi del plugin, per esempio `/jaggaer-virtual-consultant:vc status`;
2. eseguire `/jaggaer-virtual-consultant:vc doctor` e leggere il controllo **`plugin-root`**:
   - verde — l'audit contiene comandi del plugin con il percorso letterale: la sostituzione avviene;
   - giallo "segnaposto non sostituito" — nei comandi eseguiti è rimasto `${CLAUDE_PLUGIN_ROOT}`: aggiornare Claude
     Code; nel frattempo le operazioni a forma esatta restano negate (blocco, non rischio);
   - giallo "nessun comando del plugin in audit" — ripetere dal passo 1.
3. Controllo visivo equivalente: nel riquadro dello strumento Bash la riga di comando deve mostrare il percorso reale
   del plugin, non `${CLAUDE_PLUGIN_ROOT}`.

## Appendice C — Verificare gli agenti con la suite `evals/`

La piramide di test (§49.1) ha un livello "eval degli agenti": 20 compiti per ruolo, ognuno giudicato su quattro
criteri — traccia cognitiva presente, strategia attesa, nessuna violazione di cella, domanda solo con un gap reale
(§16). La suite è in `evals/<ruolo>/<caso>/` nel formato di `claude plugin eval` (Claude Code ≥ 2.1.269): tutti i
15 ruoli, 20 casi ciascuno (300). Ogni caso usa un workspace sintetico del cliente fittizio ACME (più BETA per i casi
di isolamento), costruito dallo scaffold del caso; per il browser solo i risultati pre-registrati del tenant demo
(`evals/mocks/chrome-devtools/`), per l'ALM solo il server `alm` del plugin simulato (`evals/mocks/alm/`, e
`config/xray.yaml` con `deployment: mock` per gli script): mai un tenant o un Jira veri.

**Validazione strutturale** (senza modello, anche in CI): `node --test test/evals/evals-structure.test.mjs` (fa parte di
`npm test`; `JVC_SKIP_CORPUS=1` salta il controllo dei frammenti del corpus locale). Controlla il formato dei file, i
quattro criteri per caso, le categorie di casi per ruolo, lo scaffold di ogni scenario e che forma epistemica e
precedenti del workspace portino davvero alla strategia attesa.

**Esecuzione** (costa chiamate al modello: ogni caso gira 3 volte, più il giudice dei grader `llm`):

1. Requisiti: Claude Code ≥ 2.1.269, git ≥ 2.31. I casi concedono Bash agli agenti: su Windows, quando si concede
   Bash (o PowerShell), `claude plugin eval` richiede WSL2 — usare WSL2 (o Linux/macOS), con una copia del plugin su
   cui si è eseguito `npm ci` in quell'ambiente (better-sqlite3 è un modulo nativo). Non c'è un requisito sulla
   posizione del plugin. Per i casi di `weekly-digest` la variabile `JVC_PSEUDO_SALT` deve essere nell'ambiente della
   run (il sale della pseudonimizzazione non sta mai in un file): senza, la pipeline esce con 3 e i casi che la
   eseguono si chiudono `blocked`, come previsto dai loro grader.
2. Prima il controllo della sintassi del plugin (l'eval non ha una modalità di sola validazione):

       claude plugin validate .

   poi la calibrazione, un ruolo alla volta (i casi hanno il ruolo fra i tag) con una sola esecuzione:

       claude plugin eval . --scaffold --runs 1 --tag scope-expert --ablation none --allow-tools Write "Bash(node *)" --judge-model sonnet --no-publish

   e infine la suite intera con le tre esecuzioni di default e la soglia scelta per il rilascio:

       claude plugin eval . --scaffold --ablation none --allow-tools Write "Bash(node *)" --judge-model sonnet --threshold 0.8 --trust-plugin --json evals/results/ultimo.json

   `--scaffold` è obbligatorio: lo `scaffold_script` del caso (che costruisce il workspace ACME) gira solo con questa
   opzione, come l'utente e fuori dal sandbox, nella cartella vuota della run; senza, il workspace è vuoto e
   `use customer ACME` fallisce. `--ablation none` perché senza il plugin gli agenti non esistono (il braccio di
   confronto darebbe solo "Agent type … not found").
3. Leggere i risultati: la tabella finale ha `SCORE` e `PASS%` per caso; il dettaglio è in
   `evals/results/<data>/report.html` e `aggregate-result.json` (cartella esclusa da git). La pass rate di un ruolo è
   `casesPassed / casesTotal` della sua esecuzione con `--tag <ruolo>`. Nel report, per ogni esecuzione, i grader sono:
   `dispatch` (è stato invocato l'agente giusto), `trace` (rapporto con `cognitive_trace` alla profondità dell'header e
   `lesson`), `strategy` (strategia attesa, quando lo scenario la determina), `cell` e `console` (nessun deny di
   guard-scope, guard-customer o guard-domain-boundary nella trascrizione, con la console `vc agents show`), `phrase` e
   `phrase-report` (nessun deny di guard-phrase nella trascrizione e nessuna frase dell'utente nel rapporto: gli agenti
   chiedono le approvazioni con il campo `approval_request`), `approval-request` (dove il caso richiede
   un'approvazione: tipo e piano o target attesi), `question` (giudice con il criterio di §16), `status`, `behaviour`
   (criterio specifico del caso), qualche `file_exists`/regex su file (nessuna scrittura dove non si deve) e, per il
   browser e per l'ALM, `no-…`/`uses-…` sulle chiamate registrate dai server simulati. La colonna `NOTES` mostra il grader fallito
   più pesante.
4. Prima calibrazione, cosa guardare: nei casi `boundary-*`/`confine` un agente che prova una volta la lettura negata e
   poi rinuncia fallisce `cell` (è un tentativo fuori cella: il criterio lo conta); se accade spesso, valutare il peso
   di `cell` in quei casi. La strategia è giudicata solo dove forma, rischio e precedente del soggetto la determinano
   con `strategy-select` sul workspace dello scaffold (110 casi su 300); ogni agente giudicato sulla strategia chiama
   `strategy-select` nel passo DECIDERE — anche `cluster-validator`, `weekly-digest` e `lesson-validator`, dove i casi
   giudicati sono pochi (4, 3 e 4) — e il validatore lo verifica. Se in calibrazione un agente registra
   sistematicamente un'altra strategia, prima si controlla l'uscita dello script nella trascrizione, poi il corpo.
   `scope-extractor` fa eccezione: le sue strategie sono per regola (STR-VERIFY-FIRST, STR-STOP-RECORD a budget
   esaurito).

| Sintomo nell'eval | Causa probabile | Cosa fare |
|-------------------|-----------------|-----------|
| Tutti i casi a 0, "cliente inesistente: ACME" | Suite lanciata senza `--scaffold` | Rilanciare con `--scaffold` |
| Bash o Write segnalati "not granted" | Strumenti non concessi alla run | `--allow-tools Write "Bash(node *)"` |
| Ogni run rifiutata su Windows | Bash concesso fuori da WSL2 | Eseguire in WSL2 |
| `W/OUT` a zero, "Agent type … not found" | Braccio senza plugin | `--ablation none` |
| `weekly-digest` sempre `blocked` | `JVC_PSEUDO_SALT` assente nell'ambiente della run | Esportarlo prima di lanciare l'eval (mai in un file del workspace) |
| `phrase` fallito | L'agente ha scritto una frase dell'utente in un input di strumento (anche la bozza del rapporto) | Correggere il corpo dell'agente: l'approvazione si chiede con `approval_request` |
| Verdetti `llm` instabili fra run | Giudice piccolo su un rapporto lungo | `--judge-model sonnet`; tre esecuzioni prima di concludere |
| Un caso cambiato non corrisponde al catalogo | Casi rigenerati a mano | Modificare `evals/_support/catalog/<ruolo>.yaml` e `node evals/_support/generate.mjs <ruolo>`, poi `npm test` |
