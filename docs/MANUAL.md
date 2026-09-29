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
- **`npm install` nella cartella del plugin** (non nel workspace): i guard di sicurezza importano le dipendenze di
  runtime (`ajv`, `ajv-formats`, `better-sqlite3`, `yaml`) e senza di esse negano ogni chiamata (sono fail-closed).
  `doctor` lo segnala con il controllo `deps` rosso e la correzione "npm install nel plugin".
- **Playwright non è richiesto**: si installa solo se si attiva la corsia compilata (`npx playwright install chromium`).

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

### 55.2 Installazione

```
1  Installare il plugin dal marketplace privato (o da cartella locale); nella cartella del plugin: npm install
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
`--assumption-file`, `--next-file`) o come `chiave=valore`. I file d'ingresso stanno **dentro il workspace**: percorsi
assoluti fuori, `..` che escono o collegamenti che portano fuori sono rifiutati.

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
| `mode <nrt\|config\|ops\|diag\|esplorazione>` | Modalità | L'intento la deduce; il comando la forza. `esplorazione`: solo sandbox, click e input senza piano (mai invio o salvataggio), solo dopo la frase `ESPLORA SANDBOX` dell'utente |
| `budget <n>` | Budget di sessione in token (es. `200k`) | Registrato in audit; l'unico modo per alzarlo, solo su richiesta dell'utente |
| `show` | Stato corrente della sessione | Sola lettura |
| `close-stale` | Chiude a mano i sotto-compiti rimasti aperti (dispatch mai chiusi) | Solo su richiesta; senza, scadono da soli dopo 2 ore |

### 56.3 `kb` — conoscenza

| Azione | Cosa fa | Chi |
|--------|---------|-----|
| `ingest <path> [--scope --genre tecnica\|d'uso\|empirica\|testimoniale --kind …]` | Profila e segmenta i documenti; estrae i grezzi in `_inbox`; report di ingestion | script `ingest/ingest.mjs`, poi `customer-profiler` (cartella di progetto) o `scope-extractor` → `scope-digester` → `cluster-validator` |
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
| `verify <PLAN>` | Genera e riesegue il verificatore `NRT.*.CFG` | — (sola lettura, anche in prod) · script `compile/compile-cfp.mjs --verify`, poi `scope-expert` in lettura |
| `audit [--scope]` · `coverage` · `impact <CFG>` | Lint e deriva; matrice; raggio | — · `config-auditor`; script |

### 56.6 `ops` — operatività e Analytics

| Azione | Cosa fa | Ambienti · Chi |
|--------|---------|----------------|
| `crea <richiesta\|ordine\|fornitore\|evento\|contratto> …` | Crea in bozza con compensazione | sandbox, preprod — **mai prod** (rifiutato prima di ogni dispatch) · `scope-expert` |
| `approva · chiudi · pubblica …` | R2 con approvazione (`sì`) | sandbox, preprod con referente · `scope-expert` |
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
| `customer purge <ID>` | **L'unica cancellazione**: rimuove un cliente; certificato | 2 con frase, da due persone: `APPROVO PURGE <ID> DA <Nome Cognome>` |
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
- *"Su ACME produzione, crea un ordine di test."* → **rifiutato** dal catalogo: "in produzione non si scrivono dati;
  posso farlo in sandbox o pre-produzione".

### 57.2 Le frasi di approvazione

Le frasi si scrivono **come unico testo del messaggio**, con le parole chiave in maiuscolo (spazi e un punto finale
tollerati). Le riconosce e le registra l'hook `approval-capture` nel registro della sessione (catena di hash), con
l'orario; i guard le confermano nel transcript. Il modello **non** può scriverle al posto dell'utente: i guard negano
queste frasi in ogni input di strumento. Una frase diversa, un piano sbagliato o una finestra scaduta danno
"Approvazione non valida" con la frase attesa.

| Situazione | Cosa scrivere |
|-----------|---------------|
| Azione R2 in sandbox/preprod | `sì` (oppure `si`, `yes`) alla domanda del workflow, che mostra importo, stato di arrivo, compensazione; vale per UNA azione in attesa |
| Configurazione verde | `APPROVO PIANO <PLAN>` |
| Configurazione giallo | `APPROVO PIANO <PLAN>` poi `APPROVO PASSO <n> <PLAN>` |
| Configurazione rosso | `APPROVO PIANO <PLAN>` · `APPROVO PROVA <PLAN>` · `APPROVO PASSO <n> <PLAN>` |
| **Produzione, qualunque configurazione** | le tre frasi, entro la finestra (60 minuti dalla A1), con `DA <Nome Cognome>` in coda: la A2 (`APPROVO PROVA <PLAN> DA <Nome Cognome>`) da una persona diversa dalla A1 |
| Esplorazione senza piano (solo sandbox) | `ESPLORA SANDBOX`, poi `/jaggaer-virtual-consultant:use mode esplorazione` entro 10 minuti |
| Promozione di un item a S (`learn promote`) | `APPROVO PROMOZIONE <codice>` (valida 24 ore, monouso) |
| Retention (`admin retention --apply`) | `APPROVO RETENTION <C>` (valida 60 minuti, monouso) |
| Cancellazione di un cliente (`admin customer purge`) | `APPROVO PURGE <ID> DA <Nome Cognome>`, due volte, da due persone diverse, nella sessione di quel cliente (60 minuti) |
| Alzare il budget | `/jaggaer-virtual-consultant:use budget <n>` |
| Compensare a fine sessione | `compensa tutto` · `lascia <entità>` (risposta alla domanda del manager sulle compensazioni pendenti) |

Le frasi di approvazione riconosciute sono quindi: `APPROVO PIANO`, `APPROVO PROVA`, `APPROVO PASSO`, `APPROVO
PROMOZIONE`, `APPROVO RETENTION`, `APPROVO PURGE` (con `DA <Nome Cognome>` dove serve), `sì`, `ESPLORA SANDBOX`.
Per le approvazioni amministrative l'hook risponde con un **token** (le prime 16 cifre esadecimali dell'hash del
record): il manager lo usa nella riga di comando; non va copiato né inventato altrove.

### 57.3 Leggere il workflow

Il blocco in fondo alla conversazione ha sempre: intestazione (sessione, cliente, **ambiente con banner**, scope,
modalità, budget usato/totale), una riga per passo (agente, classe di azione, descrizione, stato ▶ in corso · ✓ fatto ·
⏸ attende · ✗ fermato · · pianificato, evidenza), e una riga di totali (sorprese, errori, evidenze). Una riga ⏸ è sempre
seguita dalla domanda. Una riga ✗ è sempre seguita dal motivo e da cosa serve per riprendere. In produzione il banner è
`⚠ PRODUZIONE — sola lettura sui dati`, con lo stato della 3A. Da un'altra finestra:
`/jaggaer-virtual-consultant:vc watch <SES.C.AAAAMMGG.NNN>`.

### 57.4 Leggere i report

I report di azione (§29.8) si leggono dall'alto: **Esito** e **Entità** dicono cosa è successo e cosa è pendente;
**Esecuzione** dice come; **Lezione** e **Prossimi** dicono cosa fare dopo. I report di test si leggono dal
**Verdetto** per scope e dai **Fallimenti**: ogni fallimento porta la classificazione e l'azione già intrapresa
(Defect, PR, quarantena). Le evidenze sono nella cartella su disco indicata (release → scope → caso) e, per i test, su
Xray. Gli esiti possibili: SUCCESS, EXPECTED-ERROR-AS-SUCCESS (l'errore atteso è un successo), ERROR-AS-LESSON,
ERROR-BLOCKING, ERROR-ENVIRONMENT (mai un Defect), ABORTED-BY-USER.

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
- `LIMITI DISPATCH <chiamate> <minuti>` — cambia i limiti per dispatch (default 200 chiamate di strumento e 30 minuti;
  al più 5000 e 480). Vale dopo la conferma.

---

## 58. Risoluzione dei problemi

| Sintomo | Causa probabile | Cosa fare |
|---------|-----------------|-----------|
| "Nessun ambiente dichiarato" | `/use env` mancante | Dichiararlo, o includerlo nell'intento |
| "Ambiente non riconosciuto (1 segnale su 2)" | Impronta cambiata (nuova release, banner diverso) | `doctor`; aggiornare `fingerprint` con il referente; **non** forzare |
| "Host non in allow-list" | Redirect SSO o CDN non dichiarati | Aggiungere l'host in `environments.yaml` fuori sessione |
| "Azione negata: produzione" | Si sta chiedendo una scrittura in prod | È corretto: usare sandbox/preprod |
| "Approvazione non valida" | Frase diversa da quella richiesta, o finestra scaduta | Scrivere la frase esatta (§57.2); se scaduta, ripartire da A1 |
| "Budget esaurito" | Compito più costoso del previsto | `use budget` se giustificato; altrimenti ridisegnare il compito (meno passi, più replay) |
| "Risultato respinto: traccia cognitiva mancante" | Il sub-agente ha saltato il ciclo | Automatico: il sub-agente completa; se persiste, `learn lessons --session` e segnalare |
| "Compensazioni pendenti" all'avvio | Sessione precedente interrotta | `vc status` → `compensa tutto` o `lascia` |
| "Integrità del pacchetto fallita" | Plugin modificato o manomesso | Reinstallare dalla release firmata; non operare |
| "Knowledge version incompatibile" | Plugin aggiornato, conoscenza no | `kb migrate` |
| "Jira irraggiungibile" | Rete o credenziali | La run non fallisce; `nrt push-xray --retry-queued` più tardi |
| "DB bloccato" | Reindex o digest in corso | Attendere; `admin lock` per vedere chi lo tiene |
| Troppe domande | Copertura epistemica bassa sullo scope | `kb epistemic --scope --plan` ed eseguire le osservazioni R0 suggerite |
| Troppe sorprese | Modello del cliente disallineato (sandbox non aggiornata, doc vecchia) | Ricognizione del tenant; verificare `alignment`; ri-digerire le fonti aggiornate |
| Ogni chiamata negata, `doctor` con `deps` rosso | Dipendenze del plugin non installate (i guard sono fail-closed) | `npm install` nella cartella del plugin, poi `vc doctor` |
| Purge, retention o promozione negate "forma esatta"; nella riga di comando si vede `${CLAUDE_PLUGIN_ROOT}` | Claude Code non ha sostituito il segnaposto con il percorso del plugin | `vc doctor`: controllo `plugin-root` (Appendice B); aggiornare Claude Code. Nessun rischio: l'operazione è solo bloccata |
| "azione con effetto del browser di Claude … negata" fuori dalla sandbox | Il browser di Claude fuori sandbox legge e naviga soltanto | Installare e usare Chrome DevTools MCP per i passi con effetto |
| "comando non semplice" / "cita il plugin insieme a un interprete" | Testo libero o JSON in linea nella riga di comando di uno script del plugin | I dati vanno in un file della sessione (`--payload-file`, `--text-file`, `--finding`) |
| Un agente non risponde più / tutto negato a un agente | Pausa, stop o limiti per dispatch attivi | `vc agents`; `RIPRENDI AGENTE <task_id>` o `LIMITI DISPATCH <chiamate> <minuti>` |
| "il modello di questo scope va rifatto prima di continuare" | Vigilanza: tre compiti consecutivi fermati per sorprese | Giro di osservazioni proposto dal manager, poi `SBLOCCA SCOPE <S>` |
| "una sola escalation di tier per compito" | Seconda escalation dello stesso compito | Riformulare il compito o dividerlo; chiedere all'utente |
| Purge, retention o promozione: "approvazione mancante" (exit 3) con la frase appena scritta, due sessioni aperte nello stesso workspace | L'approvazione vive nel registro della sessione in cui è stata scritta; un comando senza la sessione giusta cerca in quella corrente (`.jvc/current-session`) | Scrivere la frase e lanciare il comando **nella stessa sessione** (le righe dei comandi passano `--session "${CLAUDE_SESSION_ID}"`); chiudere o non usare in parallelo l'altra sessione sullo stesso workspace |
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
                      produzione: NESSUNA scrittura di dati, mai · configurazioni solo con 3 approvazioni (piano · prova · passo)
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
| "Su ACME produzione crea un ordine di test" | — | `ACT-CREATE` | **rifiutato** | — | "In produzione non si scrivono dati; posso farlo in sandbox o pre-produzione" |
| "Quanti ordini sopra 50k€ ha fatto ACME negli ultimi 90 giorni?" | Analytics · ANL | `ACT-QRY` | tutti | nessuna | Query eseguita con LIMIT, risultato, `QRY` salvata se coerente |
| "Impara le tabelle di Analytics di ACME" | apprendimento · ANL | `ACT-OBS` | tutti | nessuna | `TBL` enumerate, join inferiti, `DIN` aggiornati |
| "Cosa sappiamo poco dello scope Sourcing di ACME?" | conoscenza · SRC | nessuna | — | nessuna | Report di copertura epistemica + piano di osservazioni R0 |
| "Confronta la configurazione ADM di ACME con la baseline di giugno" | audit · ADM | `ACT-CFG-READ` | tutti | nessuna | Deriva rilevata, `RUL` violate |
| "Cancella la RdA NRT-…-REQ-001" | — | `ACT-DELETE` | **rifiutato ovunque** | — | "Non cancello: posso annullarla (compensazione `cancel`)" |

Regole trasversali visibili negli esempi: l'ambiente è sempre nell'intento o attivo in sessione; le scritture partono
da sole solo se ≤ R1 in sandbox; la produzione è sola lettura sui dati; il verbo "cancella" non esiste.

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
(§16). La suite è in `evals/<ruolo>/<caso>/` nel formato di `claude plugin eval` (Claude Code ≥ 2.1.269). Oggi ci sono
i casi di dieci ruoli (200): `scope-expert`, `scope-extractor`, `scope-digester`, `customer-profiler`,
`process-mapper`, `cluster-validator`, `weekly-digest`, `root-cause-analyst`, `config-designer` e `lesson-validator`;
gli altri cinque ruoli seguono. Ogni caso usa un workspace sintetico del cliente fittizio ACME (più BETA per i casi di
isolamento), costruito dallo scaffold del caso, e, per il browser, solo i risultati pre-registrati del tenant demo
(`evals/mocks/chrome-devtools/`): mai un tenant vero.

**Validazione strutturale** (senza modello, anche in CI): `node --test test/evals/evals-structure.test.mjs` (fa parte di
`npm test`; `JVC_SKIP_CORPUS=1` salta il controllo dei frammenti del corpus locale). Controlla il formato dei file, i
quattro criteri per caso, le categorie di casi per ruolo, lo scaffold di ogni scenario e che forma epistemica e
precedenti del workspace portino davvero alla strategia attesa.

**Esecuzione** (costa chiamate al modello: ogni caso gira 3 volte, più il giudice dei grader `llm`):

1. Requisiti: Claude Code ≥ 2.1.269, git ≥ 2.31. I casi concedono Bash agli agenti: su Windows, quando si concede
   Bash (o PowerShell), `claude plugin eval` richiede WSL2 — usare WSL2 (o Linux/macOS), con una copia del plugin su
   cui si è eseguito `npm install` in quell'ambiente (better-sqlite3 è un modulo nativo). Non c'è un requisito sulla
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
   browser, `no-…`/`uses-…` sulle chiamate registrate dal server simulato. La colonna `NOTES` mostra il grader fallito
   più pesante.
4. Prima calibrazione, cosa guardare: nei casi `boundary-*`/`confine` un agente che prova una volta la lettura negata e
   poi rinuncia fallisce `cell` (è un tentativo fuori cella: il criterio lo conta); se accade spesso, valutare il peso
   di `cell` in quei casi. Per `cluster-validator` e `lesson-validator` la strategia è giudicata solo in pochi casi
   (quelli in cui forma, rischio e precedente del soggetto la determinano con `strategy-select`).

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
