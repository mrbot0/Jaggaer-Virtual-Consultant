# WP10d — Report di fase: layer di orchestrazione dell'Agent Manager (console, vigilanza, monitor, controllo dell'utente)

Stato: **pronto**. Richiesta dell'utente del 28/09/2026 ("l'agent manager funge da layer orchestratore? … sapere cosa e
come fanno gli agenti le cose e averne il controllo"). Architettura a tre livelli separati (manager LLM · regole di
orchestrazione deterministiche · monitor indipendente), descritta in `docs/orchestration.md`, che la skill
`agent-manager` (WP10c) cita come contratto.

Suite completa alla consegna e tempi: `.superpowers/sdd/wp10d-report.md`.

## Cosa c'è

| Deliverable | File | Prova |
|-------------|------|-------|
| D1 Console degli agenti (`status`, `history`, `--json`) | `scripts/admin/agents.mjs`, `hooks/lib/agents-model.mjs`; `guard-budget` registra l'header del dispatch (tier, compito, modalità, allowed_paths, output atteso, redatti); `subagent-trace` aggiunge scope, tier, sorprese al ledger e richiamo/forma epistemica/why al blackboard | `test/admin/agents-console.test.mjs` (fixture: 2 agenti paralleli, uno chiuso partial, uno in corso, uno scaduto) |
| D2 Vigilanza, escalation, handoff in `guard-budget` (fail-closed) | `hooks/lib/guards/orchestration.mjs`, `hooks/lib/invocations.mjs` (`vigilanceStreak`), `scripts/admin/control.mjs` (`SBLOCCA SCOPE`), `hooks/lib/guards/phrase.mjs` | `test/hooks/wp10d-vigilance.test.mjs` |
| D3 Monitoraggio nel contesto | `session-context`, `precompact-save`, `approval-capture` (riga per prompt), `workflow watch` | `test/hooks/wp10d-context.test.mjs` |
| D4 `/vc agents` | `commands/vc.md` (famiglia vc, §44.1) | `test/admin/wp10d-command.test.mjs` |
| D5 Contratto della skill | `docs/orchestration.md` | `test/admin/wp10d-command.test.mjs` (allineamento a messaggi e limiti del codice) |
| D6 Indipendenza del monitor | `agents watch` (sola lettura), incoerenze rapporto/registrazioni, `hooks/lib/manager-usage.mjs` (token del manager da `stop-integrity`), protezione dei file del monitor, catena di audit | `test/admin/wp10d-monitor.test.mjs` |
| D7 `agents show <task_id>` | `scripts/admin/agents.mjs` (`showTask`, `renderShow`) | `test/admin/agents-console.test.mjs` |
| D8 Controllo dell'utente | `hooks/scripts/guard-control.mjs` + `hooks/lib/guards/control.mjs` (PreToolUse `.*`), `hooks/lib/control.mjs` (registro `control.jsonl`), `scripts/admin/control.mjs` (cattura), `subagent-trace` (adozione dello stop) | `test/hooks/wp10d-control.test.mjs` |

## Test richiesti dal brief

| Brief | Test |
|-------|------|
| D2: terzo compito consecutivo fermato per sorprese ⇒ deny con il messaggio esatto; ok azzera; sblocco solo dall'utente | `wp10d-vigilance`: vigilanza (3 test) |
| D2: secondo tier superiore per lo stesso compito ⇒ deny | `wp10d-vigilance`: escalation |
| D2: handoff senza `via: agent-manager` o senza HND esistente ⇒ deny | `wp10d-vigilance`: handoff |
| D6: né manager né sub-agenti alterano audit, invocations, workflow, blackboard (e controllo, stato agenti, OBS, uso del manager) | `wp10d-monitor`: file del monitor |
| D6: catena di audit interrotta rilevata | `wp10d-monitor`: verifyChain |
| D8: pausa ⇒ prossima chiamata negata, altri agenti non toccati; ripresa ⇒ consentita | `wp10d-control`: PAUSA AGENTE |
| D8: stop ⇒ invocazione chiusa e rapporto aborted | `wp10d-control`: FERMA AGENTE |
| D8: passo-passo ⇒ click negato senza conferma e consentito dopo il sì | `wp10d-control`: PASSO PASSO |
| D8: il modello che scrive `PAUSA AGENTE` in un input è negato da guard-phrase | `wp10d-vigilance`: guard-phrase |

## Decisioni che contano

- **Frasi che aumentano o riducono la protezione** (ruling del controller): PAUSA, FERMA, PASSO PASSO valgono dal prompt
  catturato; RIPRENDI, SBLOCCA SCOPE, PASSO PASSO OFF e LIMITI DISPATCH valgono solo dopo `confirmInTranscript` (quella
  di `approvals.mjs`, nessuna copia), registrata come record `confirm` dal primo hook che ci riesce.
- **Fermato per sorprese**: sorprese ≥ 1 nella traccia e status effettivo ≠ ok; solo `ok` azzera; gli altri esiti non
  contano e non azzerano (un `partial` per budget in mezzo non dimostra che il modello dello scope sia giusto).
- **Escalation**: consentito un salto sopra il tier del primo dispatch (anche T0 → T2); il secondo è negato; stesso tier
  consentito (ripresa dopo `needs-input`). Compito = `reply_to` o `task_id`.
- **Limiti per dispatch**: 200 chiamate e 30 minuti (nessun valore nella spec); se l'header dichiara `budget.minutes`
  vale il minore (il manager può restringere, mai allargare); li cambia solo l'utente (`LIMITI DISPATCH`).
- **Passo-passo con il meccanismo R2**: richiesta in `pending.approvals` (`plan: PLAN.PASSO.<compito>`, impronta
  dell'azione), `sì` di approval-capture, conferma nel transcript e consumo monouso sulla stessa azione. Vale anche in
  produzione (il sì non approva dati: guard-production valuta comunque l'azione).
- **`/vc agents`** nella famiglia `vc` (§44.1: stato della sessione), non un `admin agents`.
- **Sorveglianza del manager**: avviso nel contesto e nella console, mai blocco (R5 è un obiettivo di §25, non un guard).

## Fuori da questo WP

La skill `agent-manager` (WP10c) che istruisce la sessione a usare la console; le prove con sub-agenti reali in Claude
Code (formato reale dei transcript dei sub-agenti per il legame agente → compito e per i token del manager).
