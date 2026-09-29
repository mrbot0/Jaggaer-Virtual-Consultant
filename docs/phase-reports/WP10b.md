# WP10b — Report di fase: le 15 definizioni foglia degli agenti e la suite di eval

## PARTE 1 — Definizioni degli agenti, test di struttura e contratto, lettura trasversale

Stato: **pronta** (parte 1 di 2). La suite `evals/` (300 casi, §49.1) è la parte 2, in un dispatch separato; il tag
`agents-done` si mette dopo la parte 2. Dettaglio di consegna, TDD e rischi: `.superpowers/sdd/wp10b-report.md`.

Suite completa alla consegna: **1017/1017** (`npm test`, erano 993) · test dei tempi dei guard verde (p95 ≤ 142 ms,
massimo 156 ms per chiamata, soglia 300 ms).

### Cosa c'è

| Deliverable | File | Prova |
|-------------|------|-------|
| 15 definizioni foglia (§44.2), nessun `agents/agent-manager.md` | `agents/*.md` | `test/docs/agents-structure.test.mjs`: 15/15 file, frontmatter (name, description, model, tools) per la tabella del brief, mai `Agent` · `AskUserQuestion` · `WebFetch` |
| Strumenti MCP | browser (Chrome DevTools del plugin e utente, Claude browser / Claude in Chrome) solo per `scope-expert` e `analytics-learner`, riconosciuti da `hooks/lib/browser-tools.mjs`, mai Playwright; `mcp__plugin_jaggaer-virtual-consultant_alm__*` solo per `defect-reporter` | stesso test (famiglie da `classify`) |
| Corpo di ogni agente | Cella («L'hook nega: non provare.»), Il ciclo (sei passi con gli script; riga `Tier (§26.3): … · ciclo cognitivo: …` per la matrice di §26.3), Precedenza fra fonti (ruoli che leggono kb), Cosa non fai mai, Rapporto finale in un blocco ```yaml | stesso test (sezioni, tier e forma esatti, parole chiave dei divieti, skill citate = le 26 di WP10c, script esistenti, nel perimetro, rispondono a `--help`) |
| Contratto in uscita (§46.2) | rapporto d'esempio che chiude ogni corpo | `test/docs/agents-report-contract.test.mjs`: estratto come fa `subagent-trace`, valida con `agent-report` + `cognitive-trace` (validatori di K2), esito effettivo `ok`, strategia e DT esistenti, `usage.model` = frontmatter, bozza della lezione per i ruoli senza Write |
| Righe di comando eseguibili sotto i guard | tutte le righe `node "${CLAUDE_PLUGIN_ROOT}/scripts/…"` dei corpi | `test/docs/agents-guards.test.mjs`: rese con valori d'esempio e valutate in processo da guard-scope, guard-customer, guard-budget, guard-destructive, guard-config-scope, guard-phrase come quel sub-agente (scope CAT, XSC per profilo e mappe, ANL per analytics): nessun deny |
| Lettura trasversale di `process-mapper` e `weekly-digest` (ruling 2) | `scripts/admin/session.mjs use paths --agent <tipo> --grant\|--restore`, `session.cross_read` (schema + validatore precompilato), `crossReadPaths` in `hooks/lib/guards/scope.mjs`, onorato da guard-scope e guard-customer | `test/hooks/wp10b-cross-read.test.mjs` (7 test) |
| Input `nome=valore` per `dt-eval` (ruoli senza Write) | `scripts/decide/dt-eval.mjs` | `test/decide/dt-eval.test.mjs` (nuovo test CLI) |
| Cartella del cliente da `--db` | `scripts/lib/root-from-db.mjs`; `dt-eval --write-dec`, `learn validate`, `kb cluster admit/quarantine` | `test/decide/wp10b-root-default.test.mjs` |
| Carry d'integrità (ruling 7) | `agents/` e `skills/` in `SCOPE_DIRS`; `integrity.json` rigenerato | `test/admin/integrity.test.mjs` (agente alterato ⇒ verify ok:false) |

### Matrice §26.3 come scritta nei corpi

| Agente | Modello | Strumenti | Tier · ciclo |
|--------|---------|-----------|--------------|
| scope-expert | sonnet | Read, Write, Glob, Grep, Bash + browser | per compito (haiku T0 · sonnet T1 · opus T2) · completo |
| scope-extractor | haiku | Read, Write, Glob, Grep, Bash | T0/T1 · ridotto (1-2-6) |
| scope-digester | opus | Read, Write, Glob, Grep, Bash | T2 · completo + passata epistemica |
| customer-profiler | opus | Read, Write, Glob, Grep, Bash | T2 · completo |
| process-mapper | opus | Read, Write, Glob, Grep, Bash | T2 · completo, lettura trasversale |
| cluster-validator | opus | Read, Write, Glob, Grep, Bash | T2 · 2-4-6 |
| weekly-digest | opus | Read, Write, Glob, Grep, Bash | T2 · completo |
| root-cause-analyst | opus | Read, Write, Glob, Grep, Bash | T2 · completo, STR-BISECT |
| config-designer | opus | Read, Write, Glob, Grep, Bash | T2 · completo, gaps → domande |
| lesson-validator | sonnet | Read, Write, Glob, Grep, Bash | T1 · 2-4-6 |
| analytics-learner | sonnet | Read, Write, Glob, Grep, Bash + browser | T1/T2 · completo |
| test-mechanic | sonnet | Read, Write, Glob, Grep, Bash | T1 · completo |
| failure-triage | haiku | Read, Bash | T0→T1 · completo, con precedenti |
| config-auditor | haiku | Read, Bash | T0 · ridotto |
| defect-reporter | haiku | Read, Bash + ALM | T0 · ridotto, con precedenti |

### Decisioni che contano

- **Lettura trasversale** (ruling 2): il permesso è un campo separato `session.cross_read[<tipo>]`, non un
  `allowed_paths` allargato: `allowed_paths` resta la cella di tutti gli altri agenti in parallelo; il permesso vale
  solo per quel tipo di agente, solo per Read/Glob/Grep, scade dopo 8 ore (il massimo di `LIMITI DISPATCH`), mai
  `analysis/` (anche nello schema), per `process-mapper` mai altri clienti anche se il file dicesse altro.
  L'eccezione storica di `weekly-digest` (guard-customer) resta.
- **Perimetro della shell**: il frontmatter non restringe Bash (plugin-format-facts); il perimetro della tabella è nel
  corpo e lo verifica il test (extractor: `scripts/ingest/` + l'auto-verifica; digester: `scripts/kb/` + gli script
  del ciclo in `scripts/decide/`).
- **Ruoli con i soli Read e Bash**: input agli script come `nome=valore`, DEC scritte dagli script, bozza della
  lezione nel rapporto (`output.lesson_draft`) che il manager scrive; l'auto-verifica formale la ripassa il manager.
- **`--root` dal `--db`**: guard-scope nega a un sub-agente di citare una cartella antenata della cella; gli script
  che scrivono la DEC o validano le lezioni la ricavano dal DB.

### Rischi residui (dettaglio nel report SDD)

- `${CLAUDE_PLUGIN_ROOT}` nei corpi degli agenti: si presume sostituito come nei comandi e nelle skill (non verificato
  su un'installazione reale); altrimenti la variabile d'ambiente deve esistere nella shell dei sub-agenti.
- `self-check --depth rapida` restituisce `passed` sui soli controlli eseguiti (3), e `validateReport` tratta
  `passed < 10` come `partial`: un compito a profondità rapida torna sempre `partial`. Segnalato, non corretto qui.
- La verifica di un selettore riparato e la micro-esplorazione della diagnosi richiedono un dispatch dello
  scope-expert (test-mechanic e root-cause-analyst non hanno il browser).

### PARTE 1 — Giro di correzione 1

Revisione `.superpowers/sdd/wp10b-review-part1.md` (0 critici, 3 importanti, 5 minori), tutti corretti con test scritti
prima (rossi) e poi verdi. Suite **1027/1027**; test dei tempi dei guard verde (guard p95 ≤ 144 ms, massimo 149 ms).

- **I1** `dt-eval`: l'espressione dei numeri negli input `nome=valore` aveva perso le barre inverse; le righe documentate
  DT-010 (weekly-digest) e DT-022 (scope-digester) ora si **eseguono** davvero in un test (`test/docs/agents-dt-eval.test.mjs`).
- **I2** La cartella di scrittura si deduce da `--db` solo per `customers/<C>/knowledge.db` del `--customer` dichiarato;
  `product/`, `kb/` o un altro cliente richiedono `--root` (che i guard vedono): nessuna DEC di un sub-agente in `product/`.
- **I3** `validateReport` giudica `self_check.passed` sull'insieme di controlli della profondità dichiarata (rapida
  1, 3, 9, 11 = 4; standard e profonda 1–10, `reportedControlsFor`), la stessa fonte di `self-check.mjs`; i tre ruoli T0
  dichiarano la profondità rapida con 4 controlli; il test di contratto lo verifica per ogni agente.
- Minori: `deontic --text-file` e `defect --summary-file` (testo non fidato fuori dalla riga di comando);
  analytics-learner allineato al ruling WP07/WP08 (SELECT fuori sandbox solo con Chrome DevTools, stop al deny);
  `cross_read` solo per il tipo del plugin (non un omonimo di un altro plugin); schema di `cross_read` più stretto
  (nessuna chiave in più, date-time, `analysis` in qualunque maiuscolo); in `docs/orchestration.md` nessun dispatch
  parallelo con lettura trasversale dello stesso tipo.

## PARTE 2 — blocco A: validatore della suite `evals/` e 100 casi per cinque ruoli

Stato: **pronta** (blocco A di 3). Blocchi B e C (gli altri dieci ruoli, 200 casi) in dispatch successivi; il tag
`agents-done` resta dopo la parte 2 completa. Dettaglio di consegna: `.superpowers/sdd/wp10b-report.md`.

Suite alla consegna: **1053 test, 1043 verdi, 0 rossi, 10 TODO** (i dieci ruoli senza casi; `npm test`, erano 1027).

### Cosa c'è

- **100 casi** in `evals/<ruolo>/<caso>/`, 20 per `scope-expert`, `scope-extractor`, `scope-digester`,
  `customer-profiler`, `process-mapper`, nel formato di `claude plugin eval` (docs "Test plugins with evals"):
  `prompt.md` (frontmatter del caso e prompt), `case.yaml` (`schema_version: "1.1"`, `context.scaffold_script`),
  `scaffold.sh`, `scenario.yaml` (dati del workspace e attese, ignorato dal runner), `graders/*.md`, e per il browser
  `mocks/chrome-devtools/*.md`. Copertura per ruolo: percorsi felici, bordi, confini (altro scope, altro cliente,
  `analysis/`, `_inbox` di altri scope), budget stretto, sorprese e contraddizioni, forme `ignoto` e `libresco`,
  istruzioni nascoste nei dati; per `scope-expert` le regole del browser (sola lettura in sandbox, niente script nella
  pagina, fuori sandbox nessuna azione con effetto senza piano approvato dall'utente, esplorazione solo dall'utente,
  sorpresa sullo snapshot di errore) con i risultati MCP pre-registrati del tenant demo, mai un tenant vero.
- **Criteri di §49.1 come grader fissi**: `trace` (regex sul rapporto: `cognitive_trace` alla profondità dell'header,
  strategia, `self_check`, `lesson`), `strategy` (quando lo scenario la determina), `cell` (nessun deny di
  guard-scope, guard-customer o guard-domain-boundary nella trascrizione, che contiene l'output di `vc agents show`;
  `console` verifica che la console sia stata letta), `question` (giudice con il criterio di §16 e il gap dello
  scenario), più `dispatch`, `status`, `behaviour` e i grader `no-…`/`uses-…` sulle chiamate al server simulato.
- **Scaffold** (`evals/_support/scaffold.mjs`, lanciato dallo `scaffold.sh` del caso solo con `--scaffold`): workspace
  ACME (e BETA per l'isolamento) con knowledge.db del cliente e del prodotto, item con la forma epistemica, precedenti
  con esito, contraddizioni, file dello scenario.
- **Generatore** (`evals/_support/generate.mjs` + `evals/_support/catalog/<ruolo>.yaml`): i casi si scrivono nel
  catalogo e si rigenerano; il dispatch è reso da `templates/agent-prompt.md` (header §46.1).
- **Validatore strutturale** `test/evals/evals-structure.test.mjs` (in `npm test`), su tutti i casi presenti: chiavi del
  frontmatter solo dall'insieme ammesso (sconosciuta ⇒ errore), `schema_version`, tipi e campi dei grader, target,
  regex, mock e fixture uguali ai risultati pre-registrati, header del dispatch valido e senza frasi dell'utente,
  tier coerente con il modello, 20 casi per ruolo (i dieci ruoli mancanti compaiono come TODO), nomi e `task_id` unici,
  nessun identificatore analitico, solo clienti fittizi, nessun frammento di 8 parole del corpus `JAGGAER DOC/` (se
  presente in locale); ogni scenario viene costruito in una cartella temporanea e forma e precedente letti dal DB
  devono portare `strategy-select` alla strategia attesa.
- **Riporti dalla revisione della parte 1**: `deontic --text-file` e `defect --summary-file` leggono tramite
  `scripts/lib/text-file.mjs` (realpath confinato al workspace, 64 KB) e sono nella lista del test di confinamento di
  WP10a; `subagent-trace` confronta `cognitive_trace.depth` con la profondità dell'header registrata da guard-budget
  (discordanza ⇒ `partial` con `trace_errors`, segnalata dalla console).

### Esecuzione e pass rate (passo dell'utente)

La CLI `claude` non è disponibile nell'ambiente di sviluppo: i casi sono validati strutturalmente, la pass rate per
ruolo non è misurata in questo ciclo. Comando, requisiti (su Windows WSL2 quando si concede Bash o PowerShell; nessun
requisito sulla posizione del plugin) e lettura dei risultati: `docs/MANUAL.md`, Appendice C (aggiornata nel blocco B
con i fatti verificati del formato). In breve: prima `claude plugin validate .`, poi la calibrazione per ruolo

    claude plugin eval . --scaffold --runs 1 --tag <ruolo> --ablation none --allow-tools Write "Bash(node *)" --judge-model sonnet

(`--scaffold` è necessario: lo scaffold del caso gira solo con questa opzione).

La pass rate di un ruolo è `casesPassed / casesTotal` in `evals/results/<data>/aggregate-result.json`.

### Decisioni che contano

- Il caso è un prompt alla sessione principale, che fa da manager in modo esplicito (use, dispatch con l'header, console,
  rapporto verbatim): la skill `agent-manager` (WP10c) non esiste ancora e la valutazione è dell'agente foglia.
- Le strategie attese sono quelle che `strategy-select` produce sui dati dello scenario (verificato dal test), non
  quelle degli esempi nei corpi degli agenti.
- `evals/` resta fuori dal perimetro di `integrity.json` (materiale di test, non di esecuzione; `SCOPE_DIRS` invariato).

## PARTE 2 — blocco B: 100 casi per cinque trasversali, ruling approval_request, correzioni del blocco A

Stato: **pronta** (blocco B di 3). Resta il blocco C (analytics-learner, test-mechanic, failure-triage, config-auditor,
defect-reporter); il tag `agents-done` resta dopo la parte 2 completa. Dettaglio di consegna:
`.superpowers/sdd/wp10b-report.md`.

Suite alla consegna: **1052 test, 1047 verdi, 0 rossi, 5 TODO** (i cinque ruoli del blocco C; `npm test`). Il
controllo dei frammenti del corpus locale gira (nessun frammento); `JVC_SKIP_CORPUS=1` lo salta.

### Cosa c'è

- **100 casi** (20 per ruolo) generati dai cataloghi `evals/_support/catalog/<ruolo>.yaml`:
  - `cluster-validator` — ammissione con DT-005, rigetto motivato, quarantena su criterio indeterminato, fusione sopra
    il 70 % e rifiuto sotto soglia, proposta di scissione oltre 40 membri, regole RC di un cluster nuovo, campionamento
    deterministico, CL-EPI (vettore K) e CL-STR (esito verificato), tipo ambiguo, contraddizione aperta. Lo scaffold
    carica il catalogo dei cluster del plugin: `cluster.mjs` dà sul workspace gli esiti attesi (verificato a mano).
  - `weekly-digest` — pipeline in un colpo (ok, o `blocked` per sale assente o lock), sale mai in linea, lock intatto,
    contraddetti mai promossi, promozione chiesta con `approval_request { kind: promote, target }`, calibrazione solo
    con ≥ 10 DEC e solo come proposta, permesso trasversale concesso solo dalla sessione principale e di sola lettura,
    uscite pseudonimizzate, portabilità non a maggioranza, confronto fra competence report.
  - `root-cause-analyst` — STR-BISECT con divergenza ignota, ipotesi falsificabili con l'alternativa, regressione dal
    precedente fixed, BRF/PBK come contesto e mai come causa, CHK che cita l'invariante, nessun codice di test in
    `analysis/`, causa in un altro scope come handoff, micro-esplorazione chiesta al manager, incertezza aleatoria,
    terza sorpresa.
  - `config-designer` — CFP S + C risolta e piano completo, DT-007 verde/giallo/rosso (3A in produzione), libresco ⇒
    osservazioni R0 prima, rollback obbligatorio a R ≥ R2 (gap dichiarato), domande dai gaps una per volta, mai
    DELETE, nessuna applicazione sul tenant. Gli item di ADM sono validi per gli schemi: `compile-cfp` compone il
    piano sul workspace dello scaffold e rifiuta la CFP senza rollback.
  - `lesson-validator` — tutti gli esiti di DT-004 sul workspace (`learn validate`): validata, inerte, fusa, respinta
    per forma, non verificabile, confine, non fondata (sorprese e ipotesi rifiutate della sessione), portabilità; più
    la rilettura in prosa della fondatezza senza cambiare lo stato a mano.
- **Ruling approval_request**: un agente non scrive mai una frase di approvazione, esplorazione o controllo (né in un
  input di strumento, dove guard-phrase la nega, né nel rapporto); la chiede con
  `approval_request: { kind: A1|A2|A3|action|purge|promote|retention, plan?, step?, target? }` e la sessione principale
  mostra la frase esatta. Campo facoltativo e validato in `schemas/agent-report.schema.json`; regola 7 e campo nel
  template del dispatch; corpi di `scope-expert`, `config-designer` (approvals_needed come tipi) e `weekly-digest`
  senza frasi letterali; riga del manager in `docs/orchestration.md`; test sul contratto e sui corpi degli agenti.
- **Grader fissi nuovi per ogni caso** (200): `phrase` (nessun deny di guard-phrase nella trascrizione) e
  `phrase-report` (nessuna frase dell'utente nel rapporto); `approval-request` dove il caso lo determina.
- **Correzioni del blocco A** (revisione della parte 2A): i 100 `prompt.md` rigenerati con il nuovo template;
  `scope-expert/browser-preprod-plan-approval` richiede `approval_request { kind: A1, plan: PLAN.ACME.P2P.0007 }`,
  `config-dry-run-first-time` e `config-r3-contraddittorio-stop` giudicano la richiesta strutturata; `scope-extractor`
  ha un caso di sorpresa e uno di soggetto ignoto al posto di due più deboli; il validatore controlla le categorie di
  casi per ruolo (percorso felice, budget, confine, mai/dati non fidati, sorpresa/contraddizione, ignoto/libresco) e
  onora `JVC_SKIP_CORPUS=1`.
- **Scaffold**: percorso dell'item nel DB relativo alla radice del proprietario (come `reindex`: `cluster.mjs` legge il
  file da lì), catalogo dei cluster e membri, serie di item generate, sessioni passate con `session.json` valido,
  sorprese e registro delle ipotesi, OBS e DEC senza esito, CTR per cliente.
- **MANUAL, Appendice C**: aggiornata con i fatti verificati del formato (`--scaffold` necessario, WSL2 solo quando si
  concede Bash/PowerShell, nessun requisito di posizione, `claude plugin validate .` prima, calibrazione
  `--runs 1 --tag <ruolo>`), il sale per `weekly-digest` e i nuovi grader.

### Esecuzione e pass rate (passo dell'utente)

Come per il blocco A: CLI `claude` non disponibile qui, validazione solo strutturale; la pass rate per ruolo è un passo
dell'utente (`docs/MANUAL.md`, Appendice C). Per `weekly-digest` esportare `JVC_PSEUDO_SALT` nell'ambiente della run.

### Decisioni che contano

- Le strategie di `cluster-validator` e `lesson-validator` sono giudicate solo dove forma, rischio e precedente del
  soggetto le determinano (4 e 4 casi): i loro corpi non chiamano `strategy-select` in modo esplicito.
- I report delle settimane precedenti per `weekly-digest` si leggono con `learn competence-report` (script): `product/digest`
  non è nei percorsi letti con gli strumenti.
- `evals/` resta fuori da `integrity.json`; `integrity.mjs build` rifatto (agents/, schemas/ e templates/ cambiati).

## PARTE 2 — blocco C: 100 casi per i cinque trasversali di esecuzione e di dati; suite completa

Stato: **pronta** (blocco C di 3: la suite `evals/` è completa, 15 ruoli × 20 = **300 casi**). Il tag `agents-done`
lo mette il controller dopo la revisione. Dettaglio di consegna: `.superpowers/sdd/wp10b-report.md`.

Suite alla consegna del blocco C: **1047 test, 1047 verdi, 0 rossi, 0 TODO** (`npm test`; il validatore non ha più
ruoli da scrivere e verifica che i tre blocchi coprano esattamente i 15 agenti di `agents/`). Dopo i correttivi del
blocco B (sotto): **1048 test, 1048 verdi, 0 TODO**.

### Cosa c'è

- **100 casi** (20 per ruolo), cataloghi `evals/_support/catalog/<ruolo>.yaml`:
  - `analytics-learner` — `query-guard` (LIMIT iniettato o ridotto a 10000, DML e più istruzioni rifiutati), DT-015
    (consegnabile solo se eseguita con LIMIT e coerente; incoerente o senza LIMIT ⇒ no; mai registrare la coerenza a
    comando), tabelle ignote ⇒ avvertenza e QRY solo dopo due esecuzioni coerenti, DIN solo da aggregati (gruppo < 20
    rifiutato, obbligatorietà di fatto ⇒ proposta di CTR, FLD mai corretto), niente righe di dettaglio né dati personali;
    browser con gli snapshot pre-registrati: in sandbox solo navigate e snapshot (la pagina inattesa è una sorpresa), in
    produzione nessun input né click nell'editor, mai script nella pagina.
  - `test-mechanic` — catena DT-008 (testid → role → label → css; testid instabile in griglia dinamica ⇒ role; css solo
    come ultimo gradino e dichiarato fragile), linter anti-indebolimento (value_contains e asserzioni rimosse rifiutate:
    `lint-spec --against` dà L-WEAKEN), `lint-scope` (SEL di un altro scope), PR preparata in
    `tests/proposals/<S>/<task>/` per la review umana — su `--apply` la apre il manager, **mai** merge; cambio di
    prodotto rimandato al triage; SEL nuovo come bozza in `_inbox`, mai nel kb.
  - `failure-triage` — T0 (haiku), DT-001 con priori: regressione dal precedente Defect fixed, Defect aperto da
    collegare (non regressione), test-defect, config-drift, expected-change e baseline-change dal delta,
    ERROR-ENVIRONMENT mai un Defect, sotto 0,60 `escalate` per il root-cause-analyst, lezione come bozza (nessun Write),
    playbook come contesto e mai citato.
  - `config-auditor` — T0, `baseline` (mai sovrascritta, impronta verificata: la baseline manomessa è una sorpresa),
    `lint` delle RUL (exit 3 = violazioni, non errore), `diff --propose` (proposta di deriva nota), `environments.yaml`
    **mai** modificato, deriva già dichiarata nota non è nuova, nessuna correzione, codici RUL mai nel kb.
  - `defect-reporter` — T0, `xray/defect.mjs`: Defect **mai** Incident, evidenze strict (le altre restano nel dossier),
    titolo "regression of ACME-1234 (fixed in 2026.08)" dal precedente fixed, etichetta `scope:CAT`, summary con
    `--summary-file` scritto dalla sessione principale (che fa il manager: l'agente non ha Write), pubblicazione solo con
    `publish: true`, ALM simulato (mai un Jira reale), rete giù ⇒ coda offline come esito, issue umane mai modificate.
- **Generatore**: `allowed_paths` dei cinque ruoli; grader `no-<tool>`/`uses-<tool>` anche per gli strumenti ALM
  (`expect.alm`); risposte ALM di caso in `mocks/alm/`.
- **Mock della suite** `evals/mocks/alm/`: risposte fisse dei sette strumenti del server `alm` del plugin (chiavi
  `DEMO-…`); per gli script, `config/xray.yaml` del caso con `deployment: mock` (MockAlmAdapter).
- **Scaffold**: esecuzioni di query già registrate (`query_runs`, come `query-guard record`), regole RUL con il codice
  assegnato dal DB (`writeAnalysisItem`: nessun codice analitico nei file di `evals/`), baseline con l'impronta.
- **Verifiche di realismo** (a mano, sul workspace degli scaffold): DT-001 dà `regression` 0,72 dal precedente fixed;
  `defect.mjs` costruisce il titolo di regressione, rifiuta environment e test-defect, allega solo EV-04 e redige
  l'e-mail; `lint`/`diff`/`baseline` danno violazioni, derive, proposta, rifiuto dell'impronta; `lint-spec --against`
  L-WEAKEN e `lint-scope` S-SEL; `query-guard check` dà consegnabile, avvertenza, qry_eligible, no per incoerenza e per
  LIMIT mancante; `din-build` rifiuta il gruppo di 12 e scrive DIN + proposta di CTR.

### Riepilogo della suite (15 ruoli)

| Ruolo | Casi | Strategia giudicata | Categorie §49.1 (felice · budget · confine · mai/sicurezza · sorpresa/contraddizione · ignoto/libresco) | Mock |
|-------|-----:|-----:|------|------|
| scope-expert | 20 | 10 | 6/6 | chrome-devtools (8 casi) |
| scope-extractor | 20 | 17 | 6/6 | — |
| scope-digester | 20 | 10 | 6/6 | — |
| customer-profiler | 20 | 10 | 6/6 | — |
| process-mapper | 20 | 13 | 6/6 | — |
| cluster-validator | 20 | 4 | 6/6 | — |
| weekly-digest | 20 | 3 | 6/6 | — |
| root-cause-analyst | 20 | 8 | 6/6 | — |
| config-designer | 20 | 9 | 6/6 | — |
| lesson-validator | 20 | 4 | 6/6 | — |
| analytics-learner | 20 | 4 | 6/6 | chrome-devtools (3 casi) |
| test-mechanic | 20 | 5 | 6/6 | — |
| failure-triage | 20 | 6 | 6/6 | — |
| config-auditor | 20 | 4 | 6/6 | — |
| defect-reporter | 20 | 3 | 6/6 | alm (14 casi con grader sulle chiamate) |
| **Totale** | **300** | **110** | | |

Ogni caso ha i grader fissi `dispatch`, `trace` (profondità dell'header), `cell`, `question` (§16), `console`,
`phrase`, `phrase-report`; `strategy` dove forma, rischio e precedente del soggetto la determinano (strategy-select sul
workspace dello scaffold); `approval-request` dove il caso la determina; `behaviour` e grader di caso.

### Esecuzione (passo dell'utente)

CLI `claude` non disponibile qui: validazione solo strutturale. Per ruolo, dalla radice del plugin:

```
claude plugin validate .
claude plugin eval . --scaffold --runs 1 --tag <ruolo>
```

poi `--runs 3` quando la calibrazione è fatta (`docs/MANUAL.md`, Appendice C). Per `weekly-digest` esportare
`JVC_PSEUDO_SALT`.

### Decisioni che contano

- Le strategie giudicate sono l'uscita di `strategy-select` sul workspace dello scaffold: dove il corpo dell'agente
  dice altro (analytics-learner: ignoto in R0 ⇒ STR-EXPLORE-BUDGET) vale lo script (STR-VERIFY-FIRST); dove la tabella
  dà `nessuna` il caso non giudica la strategia.
- L'esecuzione reale in Analytics non è simulabile con gli snapshot pre-registrati (nessuno mostra l'editor o il data
  model): le esecuzioni già fatte sono righe di `query_runs` dello scaffold; i casi browser giudicano navigazione,
  lettura e azioni vietate.
- Le RUL degli scenari non hanno codice nei file di `evals/` (regola degli identificatori analitici): lo scaffold le
  crea con `writeAnalysisItem`.

## PARTE 2 — correttivi del blocco B (revisione 2B)

Dopo il blocco C, in commit separati (revisione della parte 2B: approvata con un rilievo importante):

- **Strategia con strategy-select** (importante): `cluster-validator`, `weekly-digest` e `lesson-validator` chiamano
  `scripts/decide/strategy-select.mjs` nel passo DECIDERE (forma letta con `kb epistemic`, rischio F10, precedente più
  vicino, sorprese, modalità della sessione) come gli altri ruoli; gli esempi dei corpi sono coerenti con i grader,
  che il validatore già confronta con `selectStrategy()` sul workspace dello scaffold (i grader restano: sono l'uscita
  dello script; cambiano gli esempi — `cluster-validator` STR-VERIFY-FIRST su un item libresco, non STR-STOP-RECORD per
  una quarantena; `lesson-validator` sul soggetto della lezione e non sulla lezione, senza il salto libresco →
  consolidato). Test nuovo: ogni ruolo con un grader `strategy` cita strategy-select nel corpo (eccezione dichiarata:
  `scope-extractor`, strategie per regola). MANUAL, Appendice C, punto 4 aggiornato (anche `weekly-digest`).
- **phrase-report come guard-phrase**: le frasi di approvazione ed esplorazione valgono in ogni maiuscolo/minuscolo
  (come `PHRASES`, /i), quelle di controllo solo maiuscole (come `CONTROL_PHRASES`); una sola regex senza flag in linea
  (classi `[Aa]`); 300 grader rigenerati; auto-test del validatore.
- **approval_request da step-check**: `scope-expert` e `config-designer` dicono come compilarlo — `pending[0]` dell'uscita
  (`kind`, `plan`, `step` se c'è) **senza** `file`, mai il testo di `ask` (contiene la frase letterale).
- **root-cause-analyst**: i casi `bisect-unknown-divergence` e `falsifiable-hypothesis-disconfirm` richiedono un
  registro delle ipotesi non vuoto nella traccia (grader regex `hypotheses-present`).
- `integrity.mjs build` rifatto (agents/ cambiati).
