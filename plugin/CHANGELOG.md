# Changelog

Le versioni seguono `x.y.z`. Claude Code tiene i plugin in cache per versione
(`~/.claude/plugins/cache/<marketplace>/<plugin>/<versione>/`): ogni rilascio alza la versione in
`.claude-plugin/plugin.json` e `package.json`, rigenera `integrity.json` (`node scripts/admin/integrity.mjs build`) e
aggiunge qui la sua voce. `doctor` (controllo `plugin-version`) e il contesto di avvio della sessione avvisano quando il
marketplace installato ha una versione più nuova di quella in uso.

## 3.2.0 — 2026-11-19

Cinque cicli di ricerca e bug fixing sui dati reali (ENEL, AVVA), uniti nel ramo `fix/cinque-cicli`.

- **Ingestione T0 e ponte T1** (ciclo 1):
  - ENEL completo in 62 minuti invece di 12,3 ore; la redazione non rilegge più l'ambiente per ogni stringa;
  - unità non più gonfiate dalle tabelle: 111 MB invece di 335;
  - `complete.mjs` accetta i candidati di documento (`R.DOCnnnn.C001`) e le unità oltre la 9999;
  - versioni solo nella stessa cartella: 55 documenti ENEL erano mescolati;
  - una nuova ingestione conserva il lavoro di T1;
  - un file illeggibile non ferma la harvest, e la memoria resta contenuta;
  - e-mail Outlook/Exchange lette, con pulizia dell'HTML a scansione lineare (niente regex quadratiche).
- **Browser, esplorazione e guard** (ciclo 2):
  - pagine con iframe confermate, mappa del sito coerente;
  - nessun falso diniego su `cd` nella cartella corrente, sulle virgolette nel nome del cliente, su `| head -c`, sul plugin installato sotto `~/.claude/plugins`, sulle worktree `.claude/worktrees/<nome>`, sui jolly in comandi di sola lettura e sugli strumenti innocui dell'app desktop.
- **Sessione e amministrazione** (ciclo 3):
  - `use show` senza cliente e `use env` senza `label` non vanno più in errore di sistema;
  - in `doctor` niente rossi spuri (`app_url_pattern`; credenziali Playwright: giallo);
  - i rapporti consegnati con SubagentHandback vengono letti;
  - il cambio di ambiente chiude l'esplorazione;
  - messaggi che dicono cosa fare;
  - `bump-version` rifiuta gli argomenti sconosciuti.
- **Conoscenza e decisioni** (ciclo 4):
  - dalla bozza del digester si arriva a `kb/`: `ensureClusters`, ammissione della bozza, F12 `clusterizzato`, `kb next-code`;
  - back-check senza falsi blocchi su provenienza e vocabolario;
  - node:sqlite con più scrittori (passaggio a IMMEDIATE dopo un SQLITE_BUSY), migrazioni solo se servono;
  - prestazioni:
    - reindex incrementale (AVVA da 140 s a 26 s);
    - `kb fields` indicizzato;
    - atlas-build e compose-plan veloci sui registri reali;
  - lezioni:
    - codici S cercati anche nel kb di prodotto;
    - `code:` accettato come `id:`;
    - contate solo le sorprese dell'agente della lezione.
- **NRT, ALM, apprendimento e report** (ciclo 5):
  - push-xray non si ferma al primo scope;
  - Defect idempotente;
  - `build-payload --scope` fonde i payload;
  - letture e scritture confinate in `runs/` (publish, verify, contact-sheet, baseline, compile-case);
  - digestione settimanale tollerante a un DB rovinato;
  - errori singoli in `report.yaml` accettati;
  - casi esclusi dichiarati nel manifest.
- **Unione e revisione di sicurezza**:
  - `shellSegments` e `readOnlyShell` leggono il comando come lo esegue la shell (`n"o"de` ⇒ node). I jolly su `session.mjs` e l'esclusione di `.claude/plugins` valgono solo per comandi di sola lettura;
  - `\` e `^` davanti a un separatore, una virgoletta o un a capo negano, perché bash, PowerShell e cmd dividono il comando in modi diversi; lo stesso vale per un `\` di escape fra virgolette doppie (`\"`, `\\`, `\$`) e per le virgolette tipografiche, che PowerShell tratta come virgolette (‘ ’ “ ” „); `uniq` e `file` non contano come comandi di sola lettura; un jolly su `session.mjs` insieme al nome di un interprete nega anche fra letture;
  - con `..` non si tolgono i prefissi di worktree o del plugin;
  - l'elenco MCP ammette singoli strumenti (`tools`): capitoli sì, `spawn_task` e `ccd_directory` no;
  - back-check:
    - regex `\s+` corretta;
    - un'affermazione libera senza termini verificabili resta bloccata;
    - gli attributi senza termini verificabili finiscono in `review`.
- **Decisione dell'utente** («in prep non vogliamo più blocchi sui click solo sulle cancellazioni»): nuova capacità `browser_claude_fuori_sandbox` del profilo esplorazione. Il browser di Claude agisce anche in pre-produzione senza piano; cancellazioni e caricamenti restano negati; produzione e piani invariati.
- Altri ritocchi:
  - subagent-trace non registra gli agenti estranei al plugin;
  - la redazione non scambia orari e dimensioni in byte per telefoni;
  - `learn tickets` riconosce gli export Jira e ServiceNow;
  - `environments.yaml` entra negli `allowed_paths`;
  - MANUAL: `next-code`.

## 3.1.0 — 2026-11-18

- Digestione T1 sbloccata (ENEL: 2449 grezzi, 1973 da completare, 0 digeriti dai grezzi; prodotto XSC: 5828 grezzi, 0 digeriti).
  Nuovo `scripts/ingest/complete.mjs` (status, next, apply, ready, mark): lo scope-extractor completa a lotti con il testo
  delle unità senza riscrivere i file grezzi; lo scope-digester prende solo i grezzi pronti e li segna digeriti.
- guard-control non nega più la consegna del rapporto di un sub-agente (SubagentHandback) dopo limiti, pausa o stop: il
  digester si fermava senza consegnare nulla.
- T0 scrive i grezzi senza ancore YAML (oltre 100 alias i lettori si fermavano con «Excessive alias count»).

## 3.0.0 — 2026-10-30

- Versione principale 3 (richiesta dell'utente, 30/10/2026): raccoglie le 0.2.0 e 0.3.0 — policy unica per profilo,
  dispatcher dei guard, esplorazione libera con cattura e mappa del sito, agenti workspace-manager e health-keeper,
  node:sqlite senza dipendenze native, atlas-build che non si ferma al primo errore. Con il numero nuovo la cache di
  Claude Code installa sicuramente la copia aggiornata.
- bump-version: `--set <x.y.z>` per una versione esplicita (sempre maggiore di quella attuale).

## 0.3.0 — 2026-10-29

- atlas-build non si ferma più al primo errore: ogni pagina e ogni item in modalità tollerante; gli errori sono nell'uscita (`errors`) e in `.sessions/<sid>/atlas/build-errors.jsonl`, il resto entra nella conoscenza.
- Riassunto dei campi (FLD) entro le 20 parole di validate-fld per costruzione: etichette e titoli di pagina lunghi si accorciano invece di bloccare (blocco dal vivo su AVVA: 51 pagine esplorate non registrate).

## 0.2.0 — 2026-10-29

- **Esplorazione libera in sandbox e pre-produzione**: niente blocchi su host, ambiente non verificato, URL ignoto e
  script; restano negate solo le cancellazioni.
- **Cattura integrale e mappa del sito**: letture a pezzi che si sommano, snapshot su file per le pagine pesanti, Atlas
  senza tetto per pagina.
- **File di ambiente scrivibili dagli agenti** con ricarica automatica.
- **Nuovi agenti** `workspace-manager` e `health-keeper`.
- **SQLite senza binario nativo**: dopo il ripiego del 28/10 su `node:sqlite`, il plugin usa solo `node:sqlite`
  (incluso in Node; senza flag da 22.13) e non dipende più da `better-sqlite3`.
- **Correzioni Windows**: percorsi assoluti nella forma corta 8.3 dentro il workspace riconosciuti come interni.
- **Versioni**: versione portata a 0.2.0 (era ferma a 0.1.0), controllo `doctor` `plugin-version` e versione in uso nel
  contesto di SessionStart.

## 0.1.0

- Prima versione pre-rilascio.
