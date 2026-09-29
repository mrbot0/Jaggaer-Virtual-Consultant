---
description: Configurazione JAGGAER — progetto della modifica (CFP), applicazione su Chrome con checkpoint e approvazioni 3A, verifica, audit di deriva, copertura e impatto (cfg)
argument-hint: design "<richiesta>" | apply <PLAN> [--dry-run|--resume <n>] | verify <PLAN> | audit [--scope <S>] | coverage | impact <CFG>
allowed-tools: Bash(node *), Read
---

Modalità Configurazione (§56.5, §28, §45.4, §52). `<C>` è il cliente attivo (`/use show`), `<PLAN>` il codice del piano
(`PLAN.…`), `<CFG>` il codice dell'oggetto di configurazione. La prima parola di `$ARGUMENTS` è l'azione.

## `design "<richiesta>"` — piano della modifica (nessuna approvazione)

`Agent(config-designer, opus)`: campo (`kb fields`), catena a valle (`kb impact`), forma epistemica, gap → domande;
composizione S+C della CFP, DT-007 con i priori, strategia, piano con check pre/post e rollback. Su una forma
`libresco` il designer elenca prima le osservazioni R0 necessarie. Riporta piano, rischio (verde · giallo · rosso),
approvazioni che serviranno e le domande (una per volta se dipendenti, skill asking-the-user).

## `apply <PLAN> [--dry-run|--resume <n>]` — esecuzione su Chrome con checkpoint (§45.4)

`Agent(scope-expert, sonnet)` in modalità config, con il piano: prova a secco (SAVE/SUBMIT sostituiti da CAPTURE), check
pre, snapshot (`kb snapshot`), compensazione registrata prima del passo, esecuzione reale con un checkpoint per passo.
`--resume <n>` riparte dal checkpoint `n` con un `READ` di verifica dello stato (idempotenza); un passo senza
approvazione torna `needs-input`: tu formuli la domanda, l'utente risponde, poi un nuovo dispatch (`reply_to`).

Approvazioni (§52.2, §57.2) — le scrive **solo l'utente**, come unico testo del suo messaggio; le registra l'hook
approval-capture; tu non le scrivi mai (i guard le negano in ogni input) e non le riformuli:

| Rischio del piano | Cosa scrive l'utente |
|-------------------|----------------------|
| verde (1) | `APPROVO PIANO <PLAN>` |
| giallo (2) | `APPROVO PIANO <PLAN>` poi `APPROVO PASSO <n> <PLAN>` per ogni passo che lo chiede |
| rosso (3) | `APPROVO PIANO <PLAN>` · `APPROVO PROVA <PLAN>` · `APPROVO PASSO <n> <PLAN>` |
| **produzione, sempre (3A)** | le tre frasi, entro la finestra (60 minuti dalla A1), con `DA <Nome Cognome>`: A2 da una persona diversa da A1 |

Un'azione R2 in sandbox/preprod fuori da un piano di configurazione si approva con `sì` alla domanda del workflow (una
sola azione in attesa). Lo stato della finestra 3A (sola lettura):

    node "${CLAUDE_PLUGIN_ROOT}/scripts/admin/approvals.mjs" status --plan <PLAN> --json

Finestra scaduta o frase diversa ⇒ "Approvazione non valida": si riparte da `APPROVO PIANO <PLAN>`.

## `verify <PLAN>` — verifica della configurazione (sola lettura, ammessa anche in prod, nessuna approvazione)

Genera il verificatore `NRT.<C>.<S>.CFG.<SEQ>` dalla CFP del piano (il campo c'è, obbligatorio campo per campo, valori
accettati):

    node "${CLAUDE_PLUGIN_ROOT}/scripts/compile/compile-cfp.mjs" --cfp <CFP del piano> --verify --customer <C> --env <ambiente> --json

poi lo esegue sul browser, solo passi READ/VERIFY, `Agent(scope-expert, sonnet)` in modalità nrt. Riporta l'esito per
controllo e le evidenze.

## Azioni dirette di lettura

- `audit [--scope <S>]` — lint delle RUL e deriva rispetto alla baseline: `Agent(config-auditor, haiku)` con
  `scripts/config/{baseline,diff,lint}.mjs` (T0). Riporta derive e RUL violate; nessuna correzione automatica.
- `coverage` — matrice CL-CFG × scope con la forma epistemica prevalente:

      node "${CLAUDE_PLUGIN_ROOT}/scripts/kb/coverage.mjs" --customer <C> --json

- `impact <CFG>` — raggio d'azione sul grafo (a valle) e relazioni dell'oggetto:

      node "${CLAUDE_PLUGIN_ROOT}/scripts/kb/kb.mjs" impact <CFG> --db customers/<C>/knowledge.db --json
      node "${CLAUDE_PLUGIN_ROOT}/scripts/kb/kb.mjs" related <CFG> --db customers/<C>/knowledge.db --json

## Regole

- Aggiorna il workflow visibile con i dati da file (mai JSON in linea):

      node "${CLAUDE_PLUGIN_ROOT}/scripts/admin/workflow.mjs" event --kind <tipo> --payload-file customers/<C>/.sessions/<sessione>/workflow-event.json --json

- In produzione: nessuna scrittura di dati, mai; configurazioni solo con la 3A completa (guard-production e
  guard-config-scope la verificano, anche nel transcript). La compensazione resta pendente finché l'utente decide
  (`compensa tutto` · `lascia <entità>` a fine sessione).
- Prima di un dispatch leggi la sintesi della console (`/vc agents`); prompt da `templates/agent-prompt.md`;
  `subagent_type` è `jaggaer-virtual-consultant:<agente>`. exit 1: sintassi; exit 3: rifiuto motivato, non aggirarlo.
