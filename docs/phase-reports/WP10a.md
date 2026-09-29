# WP10a — Report di fase: comandi, template, README, manuale integrato

Stato: **pronto** (tag `commands-done`). Criterio di uscita G3 "manuale allineato ai comandi": verificato da
`test/docs/manual-alignment.test.mjs` (per ogni famiglia le azioni della tabella §56 di `docs/MANUAL.md` coincidono con
l'`argument-hint` del comando). Report completo con la suite e le decisioni: `.superpowers/sdd/wp10a-report.md`.

## Cosa c'è

| Deliverable | File | Prova |
|-------------|------|-------|
| 8 famiglie di comandi (§44.1 + `admin` di §56.8) | `commands/{vc,use,kb,nrt,cfg,ops,learn,admin}.md` | `test/docs/commands-structure.test.mjs`: frontmatter; ogni `${CLAUDE_PLUGIN_ROOT}/…` esiste; ogni riga di comando resa è semplice (tokenizzatore dei guard) e passa dai guard veri senza deny; ogni script risponde a `--help`; gli agenti instradati sono le 15 foglie |
| Azioni = §44.1/§56.x | argument-hint | `manual-alignment`: vc (status, agents, doctor, watch, why), use (+ show, close-stale), kb 18, nrt 12, cfg 6, ops 7, learn 10 (+ promote), admin 5 |
| Template dell'albero §31.2/§43.3 | `templates/{playwright-spec.ts.tpl, page-object.ts.tpl, contact-sheet.html, defect.md}` + `report-*.md` con testo di riserva; `scripts/lib/templates.mjs` | `test/compile/wp10a-templates.test.mjs`: template e codice producono lo stesso testo; template senza segnaposto obbligatori ignorato |
| README | `README.md` | `test/docs/readme-links.test.mjs` (link, prerequisiti del ruling 6) |
| Manuale integrato | `docs/MANUAL.md` (§55–59, §61, appendici) | `manual-alignment`, `phrases-coverage` (ogni frase riconosciuta dal codice è nel manuale e nel README) |
| Riporti sugli script e sui guard | DR-SHELL-008 ancorata + `allow_help`; `workflow event --payload-file`; `--text-file` di intent e `kb resolve`; doctor `plugin-root`; guard-config-scope: generatori solo per nome | `test/hooks/wp10a-carry-guards.test.mjs`, `test/admin/wp10a-carry-scripts.test.mjs` |

## Instradamento (chi fa il lavoro)

- Script diretti: `vc` e `admin` sempre; le letture e i registri di `kb`; `kb review` (umano); `nrt compile`,
  `evidence`, `push-xray`, `report`; `cfg verify` (generazione), `coverage`, `impact`; `learn outcomes`, `calibrate`,
  `competence-report`, `promote`, `tickets`, `patterns`, `brief`.
- Sub-agenti (`subagent_type: jaggaer-virtual-consultant:<agente>`): `kb ingest` (customer-profiler o scope-extractor →
  scope-digester → cluster-validator), `kb digest`; `nrt plan/run/integration/explore/author` (scope-expert),
  `triage` (failure-triage → root-cause-analyst una volta; defect-reporter), `heal` (test-mechanic, PR con review
  umana); `cfg design` (config-designer), `apply` (scope-expert), `audit` (config-auditor); `ops` (scope-expert,
  analytics-learner); `learn lessons/validate` (lesson-validator), `digest-weekly` (weekly-digest).

## Verifica manuale richiesta (ruling 7)

Claude Code deve sostituire `${CLAUDE_PLUGIN_ROOT}` con il percorso letterale nei corpi dei comandi: le eccezioni a
forma esatta dei guard (purge, retention, promozione, `integrity verify`) ci contano. Il comportamento non è
verificabile dai test automatici (li esegue Claude Code): la prova sul campo è il controllo `plugin-root` di
`vc doctor` (percorso letterale nell'audit dei comandi eseguiti ⇒ verde; segnaposto rimasto ⇒ giallo con la
correzione), descritta nel manuale (§58 e Appendice B). Da eseguire alla prima installazione presso un cliente.

## Decisioni che contano

- **Dati in ingresso solo da file o chiave=valore**: gli script del plugin passano dai guard solo in forma semplice; il
  testo libero dell'utente (intento, domanda) va in un file della sessione (`--text-file`), il payload del workflow in
  `--payload-file`. Rendendo i comandi contro i guard veri è emerso un difetto: `build-report.mjs` e `build-payload.mjs`
  erano negati come "generatori del pacchetto" — corretto (solo i tre generatori per nome).
- **`kb review` diretto** (ruling del controller); **`cfg verify`**: lo script genera il verificatore, l'esecuzione
  in sola lettura sul browser è di `scope-expert`; **`learn digest-weekly`**: il lock lo prende lo script (un lock del
  manager prima lo farebbe rifiutare).
- **§61 nel manuale**: tabella resa per l'utente e legata ai casi golden `61-01…61-16` (versione eseguibile).

## Fuori da questo WP

Le definizioni degli agenti (WP10b) e le skill, compresa `agent-manager` (WP10c): i comandi le nominano; finché non
esistono i dispatch non partono. La prova in Claude Code reale (sostituzione dei segnaposto, sessione completa).


## Giro di correzione 1

Revisione "Needs fixes" (0 critici, 4 importanti, 7 minori), tutti chiusi secondo i ruling del controller.

| Rilievo | Correzione | Prova |
|---------|------------|-------|
| I1 `\promote`, `pro\mote` saltavano la forma esatta della promozione | Nuovo tipo di regola `on: first_arg`: DR-SHELL-008 decide sul primo argomento dopo kb/lifecycle/learn.mjs letto dopo lo scioglimento della shell (backslash, virgolette, `^`, backtick, `bash -c "…"`, jolly nel nome), con `shellCommands` di `hooks/lib/exact-argv.mjs`; l'uso programmatico passa in DR-SHELL-009 | `test/hooks/wp10a-carry-guards.test.mjs` (14 sonde negate, forme benigne ammesse) |
| I2 `templates/` fuori dal manifesto | `templates` in `SCOPE_DIRS`; `integrity.json` rigenerato | `test/admin/integrity.test.mjs`: template alterato ⇒ verify fallisce e i guard negano |
| I3 `build-report` solo con testo e JSON in linea | `--payload-file` (titolo, intento, prossimi, atteso/osservato/errori…) e `--intent-file`/`--assumption-file`/`--next-file`; `/nrt report` li usa | `test/admin/wp10a-fixround1.test.mjs` |
| I4 `kb epistemic <soggetto>` assente | Profilo per soggetto (K, forma, CTR, gap, prossimo passo) in `coverage-report.mjs`; argument-hint e §56.3 | idem |
| Minore 1 `find --cluster`, `ingest --kind` | Implementati; il test G3 confronta anche le opzioni (spec ⊆ argument-hint = manuale) | `test/docs/manual-alignment.test.mjs` |
| Minore 2 file d'ingresso fuori dal workspace | `scripts/lib/text-file.mjs` rifiuta percorsi fuori, `..` e collegamenti (text-file, payload-file, sql-file, report) | `wp10a-fixround1` |
| Minore 3 `plugin-root` troppo sensibile | Contano solo le invocazioni; decide la prova più recente | `wp10a-fixround1` |
| Minore 4 generatori per elenco | Ogni `build-*.mjs` è un generatore salvo i non generatori dichiarati (deny di default) | `wp10a-carry-guards` |
| Minore 5 template non valido ignorato in silenzio | Avviso (`warnings` nel JSON, stderr) con file e segnaposto mancanti | `test/compile/wp10a-templates.test.mjs` |
| Minore 6 righe a forma esatta senza sessione | `--session "${CLAUDE_SESSION_ID}"` su retention, purge e promote; il guard risolve il segnaposto nella sessione della chiamata; riga §58 per due sessioni nello stesso workspace | `wp10a-carry-guards`, `commands-structure` |
| Minore 7 `/vc` senza argomenti = solo `status` | Azioni suggerite dallo stato (`suggested`) in `status.mjs`, `vc.md` e §56.1 | `wp10a-fixround1` |

Suite completa verde, test di tempo dei guard verde, `integrity.json` rigenerato (369 file, con `templates/`).
