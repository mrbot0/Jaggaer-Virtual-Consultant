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
ruolo non è misurata in questo ciclo. Comando, requisiti (WSL2 su Windows: Bash concesso richiede il sandbox del
sistema operativo) e lettura dei risultati: `docs/MANUAL.md`, Appendice C. In breve:

    claude plugin eval . --tag <ruolo> --scaffold --ablation none --allow-tools Write "Bash(node *)" --judge-model sonnet

La pass rate di un ruolo è `casesPassed / casesTotal` in `evals/results/<data>/aggregate-result.json`.

### Decisioni che contano

- Il caso è un prompt alla sessione principale, che fa da manager in modo esplicito (use, dispatch con l'header, console,
  rapporto verbatim): la skill `agent-manager` (WP10c) non esiste ancora e la valutazione è dell'agente foglia.
- Le strategie attese sono quelle che `strategy-select` produce sui dati dello scenario (verificato dal test), non
  quelle degli esempi nei corpi degli agenti.
- `evals/` resta fuori dal perimetro di `integrity.json` (materiale di test, non di esecuzione; `SCOPE_DIRS` invariato).
