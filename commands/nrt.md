---
description: Collaudo NRT su JAGGAER — piano e run per scope sulla corsia guidata via Chrome, integrazioni, esplorazione, triage, healing, evidenze, Xray, report, release-check, casi a richiesta (nrt)
argument-hint: plan <release> [--scope <S>] | run [--suite smoke|full|delta] [--scope <S>] [--dry-run] | compile --scope <S> | integration [--suite <s>] | explore <capability> | triage [<RUN>] | heal [--apply] | evidence --list|--desk|--redact-check [<RUN>] | push-xray [<RUN>] [--dry-run|--retry-queued] | report [<RUN>] | release-check <release> | author "<descrizione>"
allowed-tools: Bash(node *), Read
---

Collaudo (§56.4, §27, §45.3, §45.5). `<C>` è il cliente attivo (`/use show`), `<S>` lo scope, `<RUN>` il codice del run
(`RUN.<C>.<AAAAMMGG>.<HHMM>.<S>`, l'ultimo del cliente se l'utente non lo dà). La prima parola di `$ARGUMENTS` è
l'azione. L'agente agisce su Chrome tramite gli strumenti MCP (corsia guidata); Playwright è solo la corsia compilata,
opzionale, mai il default. Serve un ambiente dichiarato e verificato (`/use env <id>`); fuori dalla sandbox i passi con
effetto si eseguono con Chrome DevTools MCP (il browser di Claude lì legge e naviga soltanto).

## Azioni con sub-agenti

- `plan <release> [--scope <S>]` — piano di collaudo dal delta della release. T0: i casi selezionabili per scope

      node "${CLAUDE_PLUGIN_ROOT}/scripts/run/select-suite.mjs" --suite delta --scope <S> --release <release> --dry-run --json

  poi `Agent(scope-expert, sonnet)` in modalità nrt, uno per scope, compone il piano (casi, ordine DT-012, dati,
  compensazioni). **1 approvazione**: mostra il piano e chiedi conferma all'utente (una domanda, skill asking-the-user).
- `run [--suite smoke|full|delta] [--scope <S>] [--dry-run]` — esecuzione guidata su Chrome, uno shard per scope:

      node "${CLAUDE_PLUGIN_ROOT}/scripts/run/select-suite.mjs" --suite <suite> --scope <S> --json

  (default `smoke`; aggiungi `--dry-run` se richiesto: solo il manifest, nessuna esecuzione). Poi `Agent(scope-expert,
  sonnet)` in modalità nrt per scope con il manifest del run: compila ogni caso (`compile-case`), lo esegue passo per
  passo (step-check), registra evidenze e compensazioni, chiude con il teardown. Approvazioni: nessuna in sandbox per casi
  ≤ R1; R2 per caso (il `sì` dell'utente alla domanda del workflow). A run chiuso: `evidence --list`, `report`.
- `integration [--suite <s>]` — corsia integrazione (§27.2, ADR-13): `Agent(scope-expert, sonnet)` in modalità nrt con
  `scripts/run/integration.mjs` (L1 diff con tolleranze, L2 checkpoint DT-013, L3 stub inbound solo in sandbox).
- `explore <capability>` — esplorazione a budget (STR-EXPLORE-BUDGET), solo sandbox: `Agent(scope-expert, sonnet)` in
  modalità nrt; produce OBS e candidati, mai casi promossi.
- `author "<descrizione>"` — caso a richiesta (§45.3): `Agent(scope-expert, sonnet)` in modalità nrt; scrive il candidato
  in `customers/<C>/tests/cases/<S>/` (lint-spec, negative-generator per i negativi, handoff mediato se tocca un altro
  scope); il candidato entra in shadow, mai direttamente promoted.
- `triage [<RUN>]` — classificazione dei fallimenti (DT-001 con i priori): `Agent(failure-triage, haiku)`; se torna
  `escalate`, **un** nuovo dispatch `Agent(root-cause-analyst, opus)` con l'output parziale (`reply_to` dello stesso
  compito). Un product-defect o una regression → `Agent(defect-reporter, haiku)` costruisce il Defect (mai un Incident):

      node "${CLAUDE_PLUGIN_ROOT}/scripts/xray/defect.mjs" --finding <finding.yaml> --customer <C> --json

  (`--publish` solo dopo che l'utente ha visto il Defect). Un test-defect va a `heal`, un errore d'ambiente mai a Defect.
- `heal [--apply]` — riparazione dei selettori e dei casi fragili: `Agent(test-mechanic, sonnet)` (linter
  anti-indebolimento, `lint-spec --against`). Senza `--apply` propone la patch; con `--apply` apre una PR che richiede la
  **review umana**: nessun merge automatico, mai.

## Azioni dirette (script, nessun sub-agente)

- `compile --scope <S>` — corsia compilata, **opzionale**: page object dall'Atlas, poi uno spec per ogni piano verde
  ≥ 3 volte (gli altri sono rifiutati con exit 3: riportalo, non forzare):

      node "${CLAUDE_PLUGIN_ROOT}/scripts/compile/generate-atlas-po.mjs" --scope <S> --customer <C> --ts --json
      node "${CLAUDE_PLUGIN_ROOT}/scripts/chrome/compile-plan.mjs" --plan <file del piano> --scope <S> --customer <C> --atlas customers/<C>/tests/atlas/<S>.po.json --json

- `evidence --list|--desk|--redact-check [<RUN>]` — evidenze (DT-009):

      node "${CLAUDE_PLUGIN_ROOT}/scripts/evidence/select.mjs" --run <RUN> --customer <C> --json
      node "${CLAUDE_PLUGIN_ROOT}/scripts/evidence/contact-sheet.mjs" --release <release> --run <RUN> --customer <C> --json

  `--list`: la prima (dossier, desk, xray per caso). `--desk`: la seconda, foglio dei provini HTML offline
  (`customers/<C>/evidence/desk/<release>/index.html`; chiedi la release se manca). `--redact-check`: la prima, e riporta
  le evidenze selezionate ma **non** pubblicabili (nel dossier e non nel desk: mascheratura non certa) — restano nel
  dossier, non si pubblicano.
- `push-xray [<RUN>] [--dry-run|--retry-queued]` — pubblicazione per scope (una Test Execution per scope), poi verifica:

      node "${CLAUDE_PLUGIN_ROOT}/scripts/xray/publish.mjs" --run <RUN> --customer <C> --json
      node "${CLAUDE_PLUGIN_ROOT}/scripts/xray/verify.mjs" --run <RUN> --customer <C> --json
      node "${CLAUDE_PLUGIN_ROOT}/scripts/xray/retry-queued.mjs" --customer <C> --json

  `--dry-run`: aggiungi `--dry-run` alla prima (solo il payload). Jira irraggiungibile ⇒ coda offline, exit 0: la run non
  fallisce; più tardi `--retry-queued` (la terza). Le credenziali restano nelle variabili d'ambiente: mai stamparle.
- `report [<RUN>]` — report di test (RPT, §29.8): verdetto per scope, fallimenti con classificazione e azione:

      node "${CLAUDE_PLUGIN_ROOT}/scripts/report/build-report.mjs" --kind test --title <titolo semplice> --run <RUN> --json

  Il titolo è fatto solo di lettere senza accenti, cifre, spazi e `- . _` (es. `Regressione R25.3 CAT`).
- `release-check <release>` — orchestrazione completa della release: `plan` → approvazione del piano → `run --suite
  full` per ogni scope → `triage` dei fallimenti → `evidence --desk` → `push-xray` → `report`; il verdetto finale è
  per scope (pass/fail/blocked) con i Defect proposti. Ogni passo come descritto sopra, nello stesso ordine.

## Regole

- Aggiorna il workflow visibile a ogni passaggio (§29.5) con i dati in un file della sessione, mai JSON in linea:

      node "${CLAUDE_PLUGIN_ROOT}/scripts/admin/workflow.mjs" event --kind <tipo> --payload-file customers/<C>/.sessions/<sessione>/workflow-event.json --json

- In produzione nessuna scrittura di dati: un run in prod è solo di lettura (casi ACT-OBS/ACT-READ); i guard negano il
  resto. Prima di un dispatch leggi la sintesi della console (`/vc agents`); componi il prompt da
  `templates/agent-prompt.md`; `subagent_type` è `jaggaer-virtual-consultant:<agente>`; una sola escalation di tier per
  compito. exit 1: sintassi (argument-hint); exit 3: rifiuto motivato, riportalo e non aggirarlo.
