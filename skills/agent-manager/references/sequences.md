# agent-manager — le sequenze di runtime come esempi lavorati (§45.2–45.6)

Riferimento della skill `agent-manager`: si segue alla lettera. `<C>` cliente attivo, `<S>` scope, `<sid>` cartella
della sessione, `<SES>` codice di sessione, `<task>` il task_id. Le regole applicate dal codice (vigilanza, escalation
unica, handoff, limiti per dispatch) sono in `docs/orchestration.md` §3: qui compaiono solo dove scattano.

## §45.2 — Avvio di sessione

```
utente apre Claude Code nel workspace
  → SessionStart (session-context): stato di sessione, pendenze, sorprese recenti, sintesi della console (≤ 5 righe),
    istruzione "carica la skill agent-manager"
  → tu: carichi questa skill (sessione principale), poi
      node "${CLAUDE_PLUGIN_ROOT}/scripts/admin/status.mjs" --json
    e saluti con lo stato in 6 righe: cliente, ambiente (verificato o no), scope, modalità, budget usato/totale,
    pendenze (compensazioni, approvazioni, domande) — più le azioni suggerite dello script. Poi attendi.
  → nessun cliente attivo: dici di eseguire /jaggaer-virtual-consultant:use customer <ID> (con --new per crearlo).
```

Dopo una compattazione il riassunto (20 righe) è reiniettato dall'hook: riparti dal blackboard e dalla console, non
dalla memoria della conversazione.

## §45.3 — Dispatch di un compito (esempio: `/nrt author "<descrizione>"`)

```
1 agents status (nessun compito in corso sullo stesso soggetto, scope non bloccato, nessuna pausa)
2 profondità (DT-023) e tier (DT-003):
      node "${CLAUDE_PLUGIN_ROOT}/scripts/decide/depth.mjs" --risk <R> --shape <forma> --surprises <n> --precedent <classe> --graph-radius <n> --never-executed-here <true-false> --json
      node "${CLAUDE_PLUGIN_ROOT}/scripts/decide/dt-eval.mjs" --table DT-003 risk=<R> task_novelty=<novità> shape=<forma> synthesis=<sintesi> volume=<volume> --priors auto --customer <C> --scope <S> --db customers/<C>/knowledge.db --session <SES> --agent agent-manager --subject <codice> --write-dec --json
   (la forma e il rischio per instradare li prendi dalla richiesta e dal codice del soggetto; se non li sai, il primo
    sotto-compito è di un agente, non tuo)
3 budget del sotto-compito: classi d'azione del catalogo + 20 %, entro il residuo di sessione
4 prompt da templates/agent-prompt.md:
      task_id: <task>        customer: <C>      scope: <S>      mode: nrt      tier: T1      depth: standard
      budget: { tokens: <n>, minutes: <m> }      allowed_paths: [<cartelle della cella e della sessione>]
      task: "<la richiesta in una riga>"          inputs: { <codici> }       expected_output: { type: nrt-cases, … }
      constraints: [no-analysis, scope-only, derivation-required, trace-required]      resume: null
5 Agent(subagent_type: "jaggaer-virtual-consultant:scope-expert", model: sonnet, prompt)      ← T1 ⇔ sonnet
     guard-budget: header, budget, vigilanza, controllo → allow (o deny motivato: lo riporti)
     sub-agente: ciclo cognitivo, candidati in tests/cases/<S>/, lezione, rapporto
     SubagentStop (subagent-trace): traccia e lezione presenti? ledger, blackboard, audit
6 rapporto: salvi e validi (agent-report.mjs); agents status; agents show <task> se non ok
     needs-input → formuli la domanda (asking-the-user) → risposta dell'utente → nuovo Agent con reply_to: <task>
     escalate    → un nuovo Agent con model superiore (e tier coerente), output parziale, reply_to: <task>
7 risposta all'utente: codici + summary, riga di sintesi della console, avvisi
```

## §45.4 — Applicazione di una CFP (`/cfg apply <PLAN>`), con ripresa

```
1 agents status; il piano c'è e l'ambiente è dichiarato e verificato
2 Agent(scope-expert, sonnet, mode: config, inputs: { plan: <PLAN> })
     l'agente: piano con traccia attesa → prova a vuoto (SAVE/SUBMIT → CAPTURE) con step-check per passo
3 fuori sandbox l'attivazione chiede l'A1: il rapporto torna needs-input con approval_request { kind: A1, plan }
     tu: mostri rischi e assunzioni, poi i passi, poi la frase che l'utente deve scrivere (A1) — e attendi
4 dopo la frase dell'utente: nuovo Agent(scope-expert, reply_to: <task>)
     0 sorprese → check pre → snapshot → compensazione registrata → esecuzione reale con checkpoint per passo
     passo R2 senza approvazione → guard-config-scope nega → needs-input con approval_request { kind: A3, plan, step }
5 tu: mostri il passo (cosa cambia, come si torna indietro) e la frase A3; attendi
6 nuovo Agent(scope-expert, reply_to: <task>, resume: { checkpoint: <n> })
     riprende dal checkpoint → passi rimanenti → verificatore NRT…CFG verde → evidenze → lezione con esito atteso
7 tu: stato aggiornato (la compensazione resta pendente finché l'utente decide), risposta, riga della console
```

Se il browser muore al passo n: il checkpoint n−1 e lo snapshot esistono; la ripresa `--resume n` riparte da una
lettura dello stato per decidere se il salvataggio era avvenuto (idempotenza). In produzione vale la 3A completa (A1,
A2 con `DA <Nome Cognome>`, A3 per passo, entro la finestra): la frase per ogni `kind` la ricavi come `phraseOf`.

## §45.5 — Run NRT in CI (e diagnosi headless)

```
pipeline di CI (nessun modello): validazioni → select-suite --scope <S> → autenticazione → corsia compilata
  opzionale (o esecuzione guidata headless) → teardown (compensazioni) → build-report → pubblicazione Xray per scope
  (coda offline se Jira è giù) → upload del dossier
job di diagnosi, solo su fallimento: sessione headless con lo stesso plugin, /jaggaer-virtual-consultant:nrt triage <RUN>
  tu (manager headless): Agent(failure-triage, haiku, inputs: { run, lesson_code })
     → per ogni fallimento: classe DT-001; confidenza < 0.60 → escalate
     → escalate: un Agent(root-cause-analyst, opus, reply_to: <task del triage>)
     → product-defect o regression: Agent(defect-reporter, haiku, inputs: { finding, summary_file, lesson_code })
       (in CI senza utente: niente publish; il Defect resta proposto nel dossier)
     → test-defect: proposta di heal (test-mechanic), mai merge
  per i ruoli con soli Read e Bash scrivi tu la lezione da output.lesson_draft e riesegui self-check
```

## §45.6 — Digestione settimanale (`/learn digest-weekly`)

```
1 agents status: nessun altro weekly-digest in corso (il permesso è per tipo)
2 concedi la lettura trasversale:
      node "${CLAUDE_PLUGIN_ROOT}/scripts/admin/session.mjs" use paths --agent weekly-digest --grant --session "${CLAUDE_SESSION_ID}" --json
3 Agent(weekly-digest, opus, allowed_paths: lessons, decisions, outcomes, kb dei clienti in lettura; product/ solo
  per i candidati)
     l'agente esegue la pipeline con lo script, che prende lui il lock knowledge.lock su product/ e su ogni cliente
     (non prenderlo prima tu: lo script rifiuterebbe), pseudonimizza, allinea, calcola portabilità ed esiti, propone
     calibrazioni e candidati S, scrive il competence report, reindicizza e rilascia il lock
4 al ritorno togli il permesso:
      node "${CLAUDE_PLUGIN_ROOT}/scripts/admin/session.mjs" use paths --agent weekly-digest --restore --session "${CLAUDE_SESSION_ID}" --json
5 tu: competence report all'utente; candidati S in attesa di /learn promote <codice>, ciascuno con la frase di
  promozione che l'utente scrive (kind promote) e il token che l'hook gli restituisce
```

Nota di conformità: la spec (§45.6) mette il lock in mano al manager; il codice (WP09d, `commands/learn.md`) lo fa
prendere allo script della pipeline, sotto lo stesso nome e per la stessa durata. Si segue il codice.
