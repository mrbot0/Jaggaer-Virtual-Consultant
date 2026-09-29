---
description: Apprendimento JAGGAER — lezioni e validazione, registro degli esiti, calibrazione, digestione settimanale, competence report, promozione a S e dominio analitico dei ticket (learn)
argument-hint: lessons [--session <SES>] | validate [--session <SES>] | outcomes [--week|--session <SES>] [--confirm <DEC>] | calibrate --propose | digest-weekly | competence-report [--week <AAAA-Www>] | promote <codice> | tickets <xlsx> | patterns | brief --scope <S>
allowed-tools: Bash(node *), Read
---

Apprendimento e dominio analitico (§56.7, §12, §21, §22, §45.6). `<C>` è il cliente attivo (`/use show`). La prima
parola di `$ARGUMENTS` è l'azione. Il dominio analitico (ticket, pattern, briefing) non ha sub-agenti (§23.4): solo
script T0.

## Lezioni (sub-agente)

- `lessons [--session <SES>]` — le lezioni della sessione (8 sezioni, §21) e le lacune: `Agent(lesson-validator, sonnet)`
  in sola lettura sulle `customers/<C>/lessons/`; riporta per lezione stato, esiti attesi, cosa non generalizzare.
- `validate [--session <SES>]` — validazione DT-004 delle lezioni proposte: `Agent(lesson-validator, sonnet)`, che usa

      node "${CLAUDE_PLUGIN_ROOT}/scripts/digest/learn.mjs" validate --root customers/<C> --db customers/<C>/knowledge.db --json

  (con `--session <SES>` se richiesto) e verifica che ogni lezione validata porti i suoi esiti attesi.

## Esiti e calibrazione (script diretti)

- `outcomes [--week|--session <SES>]` — DEC con esito atteso ancora da verificare ed esiti registrati:

      node "${CLAUDE_PLUGIN_ROOT}/scripts/digest/learn.mjs" outcomes --db customers/<C>/knowledge.db --root customers/<C> --json

  (aggiungi `--week` o `--session <SES>` come chiesto). `--confirm <DEC>` registra l'esito **solo** su conferma esplicita
  dell'utente, che è chi verifica (mai l'agente che ha preso la DEC: exit 3):

      node "${CLAUDE_PLUGIN_ROOT}/scripts/digest/learn.mjs" outcomes --confirm <DEC> --by umano --db customers/<C>/knowledge.db --root customers/<C> --json

  (`--disprove <DEC>` per "smentita", `--partial <DEC>` per "parziale", sempre su parola dell'utente).
- `calibrate --propose` — proposte di nuove versioni delle DT sui DEC smentiti (≥ 10 DEC verificate); scrive proposte,
  mai la tabella; la decisione è umana:

      node "${CLAUDE_PLUGIN_ROOT}/scripts/digest/learn.mjs" calibrate --propose --db customers/<C>/knowledge.db --json

## Digestione settimanale e competenza

- `digest-weekly` — la sequenza §45.6: `Agent(weekly-digest, opus)` con allowed_paths `customers/*/lessons`,
  `decisions`, `outcomes`, `kb` (lettura) e `product/` (scrittura dei soli candidati); l'agente esegue

      node "${CLAUDE_PLUGIN_ROOT}/scripts/digest/learn.mjs" digest-weekly --json

  che prende il lock `knowledge.lock` su `product/` e su ogni cliente, raccoglie, pseudonimizza (`JVC_PSEUDO_SALT`
  nell'ambiente, mai in chiaro), allinea, calcola portabilità, tassi di esito, proposte di calibrazione e candidati S,
  scrive il competence report, reindicizza tutto e rilascia il lock (il lock lo tiene lo script: non prenderlo prima,
  lo script rifiuterebbe con exit 3). Poi il competence report all'utente e i candidati S in attesa di `promote`.
- `competence-report [--week <AAAA-Www>]` — l'ultimo competence report (o quello della settimana):

      node "${CLAUDE_PLUGIN_ROOT}/scripts/digest/learn.mjs" competence-report --json

- `promote <codice>` — promozione a S (`product/`), solo con l'approvazione dell'utente. L'utente scrive, come unico
  testo del suo messaggio, `APPROVO PROMOZIONE <codice>`; l'hook approval-capture la registra e risponde con il token
  (16 cifre esadecimali, monouso, valido 24 ore). Solo allora, nella forma esatta (i guard la confermano nel transcript):

      node "${CLAUDE_PLUGIN_ROOT}/scripts/digest/learn.mjs" promote <codice> --customer <C> --approval <token> --session "${CLAUDE_SESSION_ID}" --json

  Non scrivere tu la frase e non inventare il token. Solo candidati della digestione (DT-010) senza CTR aperte.

## Dominio analitico (script T0 diretti, nessun sub-agente)

- `tickets <xlsx>` — import dei ticket con pseudonimizzazione all'import (`JVC_PSEUDO_SALT`):

      node "${CLAUDE_PLUGIN_ROOT}/scripts/digest/learn.mjs" tickets <file.xlsx> --customer <C> --write --json

- `patterns` — cluster per firma del sintomo e catena causale → PAT/PBK in `customers/<C>/analysis/`:

      node "${CLAUDE_PLUGIN_ROOT}/scripts/digest/learn.mjs" patterns --customer <C> --write --json

- `brief --scope <S>` — BRF per scope (briefing per il digester):

      node "${CLAUDE_PLUGIN_ROOT}/scripts/digest/learn.mjs" brief --scope <S> --customer <C> --json

## Regole

- exit 1: sintassi (argument-hint); exit 3: rifiuto per policy (autore della DEC, lock attivo, sale assente,
  approvazione mancante o non confermata, confine dei domini): riporta il motivo, non aggirarlo.
- Il dominio analitico non cita i codici NRT e `kb/` non cita PAT PBK BRF RUL (§1.1): lo impongono gli script e i guard.
- Prima di un dispatch leggi la sintesi della console (`/vc agents`); prompt da `templates/agent-prompt.md`;
  `subagent_type` è `jaggaer-virtual-consultant:<agente>`.
