# Orchestrazione degli agenti — contratto per la skill agent-manager

Documento di riferimento di WP10d (richiesta dell'utente del 28/09/2026: "l'agent manager funge da layer orchestratore?
deve monitorare e coordinare gli agenti e sapere cosa fanno … l'obiettivo è sapere cosa e come fanno gli agenti le cose
e averne il controllo"). La skill `agent-manager` (WP10c) **cita questo documento** e istruisce la sessione principale
a usare la console come descritto qui. Autorità: spec v8.0 §10.1, §13, §23.2, §24, §29.5, §42 M1/M2, §45.3–45.6.

## 1. Tre livelli separati

| Livello | Cos'è | Dove | Può essere scavalcato dal manager? |
|---------|-------|------|------------------------------------|
| **Manager** | LLM nella sessione principale (skill agent-manager). Parla con l'utente, compone i prompt, legge i rapporti. Resta nella sessione principale perché solo lei può lanciare `Agent()` (§42 M1) | `skills/agent-manager/` (WP10c) | — |
| **Regole di orchestrazione** | Codice deterministico: routing e profondità (DT-003, DT-023), escalation (DT-002), budget, vigilanza, handoff, controllo dell'utente | `hooks/lib/guards/{budget,orchestration,control}.mjs`, `scripts/decide/*` | **No**: sono guard fail-closed; il manager le esegue ma non le aggira |
| **Monitor** | Codice deterministico indipendente da manager e agenti: registra ciò che accade e lo aggrega. Non si fida dell'autodichiarazione (né degli agenti né del manager). Sorveglia anche il manager | hook `audit-append`, `guard-budget`, `subagent-trace`, `guard-control`, `stop-integrity`, `observe-append`; console `scripts/admin/agents.mjs` | **No**: i suoi file sono protetti in scrittura; la console si legge fuori banda (`agents watch`) |

## 2. Come il manager usa la console

La console (`/vc agents`, cioè `node scripts/admin/agents.mjs status|show|history --json`) ricava lo stato **solo**
dalle registrazioni degli hook: `invocations.jsonl` (guard-budget), ledger di `session.json` e `blackboard/`
(subagent-trace), audit per `agent_id` (audit-append e deny dei guard), eventi di `step-check`, `observations.jsonl`
(observe-append), `workflow.jsonl`, `control.jsonl` (approval-capture), `agents/<agent_id>.json` (guard-control),
`manager-usage.json` (stop-integrity). Mai contenuti di file: codici e riassunti redatti.

Il contesto riceve già una sintesi senza chiederla: a SessionStart e dopo la compattazione (≤ 5 righe), nel riassunto
di PreCompact e, a ogni prompt dell'utente con agenti in corso o in attesa, una riga `[monitor degli agenti] …`.

| Momento | Cosa fa il manager | Perché |
|---------|--------------------|--------|
| **Prima di instradare** | Legge la sintesi (o `agents status`): agenti in corso e in attesa, scope bloccati dalla vigilanza, pausa/stop dell'utente, limiti per dispatch, compensazioni pendenti. Non ridispaccia un compito in corso; non instrada su uno scope bloccato (lo dice all'utente: «il modello di questo scope va rifatto prima di continuare» e propone il giro di osservazioni); per un secondo dispatch dello stesso compito usa lo stesso `task_id` o `reply_to: <task_id>` | Il guard negherebbe comunque; così il manager spiega invece di sbattere contro un deny |
| **Dopo ogni ritorno di un sub-agente** | `agents show <task_id>` quando il rapporto non è `ok`, quando la riga è `incoerente`, quando ci sono deny dei guard o sorprese. Un compito `incoerente` si tratta come `partial` e lo si dice all'utente con le registrazioni che lo contraddicono. `needs-input` → domanda (§16); `escalate` → **un** nuovo dispatch con tier superiore e l'output parziale (`reply_to`); `aborted-by-user` → nessun nuovo dispatch | Lo stato vero è quello delle registrazioni, non il testo del rapporto |
| **Prima di rispondere all'utente** | Riporta, in coda, la riga di sintesi della console (agenti in corso/in attesa, token usati/totali) e gli avvisi: catena di audit interrotta, registro di controllo manomesso, avvisi sul manager (quota R5 > 15 %, comandi di dominio senza dispatch) | Trasparenza: l'utente sa cosa fanno gli agenti e come |
| **Controllo dell'utente** | Spiega le frasi (§5) se l'utente chiede come fermare o seguire un agente; ne riferisce l'esito (lo registra approval-capture); **non scrive mai** una frase di controllo (guard-phrase la nega in ogni input) e non aggira un agente in pausa o fermato. In passo-passo, quando un agente chiede il `sì`, mostra l'azione (`summary` in `pending.approvals`) e attende | Il controllo è dell'utente, applicato dal codice |
| **Seguire gli agenti dal vivo** | Indica all'utente il terminale separato: `node <plugin>/scripts/admin/agents.mjs watch --session <SES…> --interval 5` | Monitor fuori banda, senza modello |

## 3. Regole applicate dal codice contro istruzioni della skill

| Regola | Applicata da | Esito se violata |
|--------|--------------|------------------|
| Prompt di dispatch con header (task_id, customer, scope, allowed_paths); cliente e scope = session.json | guard-budget | deny |
| Budget di sessione, per compito, per classe; 80 % ⇒ haiku | guard-budget (+ subagent-trace a consuntivo) | deny / `model: haiku` |
| Un sub-agente non invoca `Agent` (M1): ogni richiesta oltre confine passa dal manager | guard-budget (WP10d) | deny |
| **Vigilanza cognitiva** (§23.2): al terzo compito consecutivo sullo stesso scope fermato per sorprese, nessun nuovo dispatch su quello scope | guard-budget (WP10d) | deny «il modello di questo scope va rifatto prima di continuare»; sblocco solo con `SBLOCCA SCOPE <S>` |
| **Una sola escalation di tier per compito** (§23.2, DT-002) | guard-budget (WP10d), sotto il lock della prenotazione | deny «una sola escalation di tier per compito» |
| **Handoff** (§24.2): `kind: handoff` ⇒ `via: agent-manager` e `contract` HND esistente che dichiara lo scope | guard-budget (WP10d) | deny |
| Traccia cognitiva + lezione nel rapporto (§10.1, M2) | subagent-trace | blocco dello stop (max 2), poi `partial` |
| Controllo dell'utente: pausa, stop, passo-passo, limiti per dispatch | guard-control (WP10d), su ogni strumento dei sub-agenti | deny con il motivo |
| Cella, dominio, cliente, ambiente, produzione, 3A, distruttivi, ALM | guard-scope, guard-domain-boundary, guard-customer, guard-environment, guard-production, guard-config-scope, guard-destructive, guard-alm-write | deny |
| Frasi dell'utente (approvazioni, esplorazione, controllo) mai negli input degli strumenti | guard-phrase | deny |
| File del monitor e del controllo non scrivibili da manager e sub-agenti | guard-scope, guard-config-scope | deny |

| Resta istruzione della skill (non verificabile dal codice) | Controllo indiretto del monitor |
|------------------------------------------------------------|--------------------------------|
| Il manager non fa lavoro di dominio (R5), instrada | quota token del manager (stop-integrity) > 15 % e comandi `kb find/get/…` senza dispatch successivo ⇒ avviso nel contesto e nella console (non blocco) |
| Scelta di profondità e tier (DT-023, DT-003), composizione del prompt | l'header registrato è visibile in `agents show` |
| Formulare le domande all'utente (§16), una per volta se dipendenti | — |
| Riportare all'utente lo stato della console e le incoerenze | — |
| Non ridispacciare un compito in corso | stato `in-corso` in console; il budget prenotato limita comunque |

## 4. Definizioni applicate

- **Compito fermato per sorprese**: rapporto chiuso con almeno una sorpresa nella traccia (`cognitive_trace.surprises`)
  e status effettivo diverso da `ok` (`partial`, `blocked`, `needs-input`, `escalate`). Un compito `ok` sullo scope
  azzera il contatore; gli altri esiti (senza sorprese, fermati dall'utente, chiusi a mano o scaduti) **non contano e
  non azzerano**. Si contano solo le chiusure successive all'ultimo `SBLOCCA SCOPE <S>` confermato.
- **Stesso compito** per l'escalation: `reply_to` dell'header, altrimenti `task_id`. Tier: `tier` dell'header (T0 <
  T1 < T2), altrimenti dal modello (haiku < sonnet < opus). Consentito un salto sopra il tier del primo dispatch (anche
  T0 → T2); negato un secondo salto; lo stesso tier già raggiunto resta consentito (ripresa).
- **Legame agente → compito** (guard-control): alla prima chiamata dell'`agent_id`, dal `task_id` dell'header del primo
  prompt nel transcript del sub-agente; senza transcript, l'unico dispatch aperto dello stesso tipo non ancora legato;
  più candidati ⇒ identità ambigua, vale il più restrittivo.
- **Azione con effetto** (passo-passo): strumenti del browser con input, click, upload, invio, script; strumenti MCP
  non di sola lettura (ALM create/update/…, server sconosciuti); Write/Edit/MultiEdit/NotebookEdit e scritture via
  shell (redirezioni, cp/mv/rm, tee, …) fuori dagli `allowed_paths` del dispatch.
- **Limiti per dispatch**: 200 chiamate di strumento e 30 minuti dal dispatch (se l'header dichiara `budget.minutes`,
  vale il minore); li cambia solo l'utente con `LIMITI DISPATCH <chiamate> <minuti>` (al più 5000 e 480). Oltre il
  limite ogni chiamata è negata e l'agente restituisce `partial`.

## 5. Frasi di controllo dell'utente

Scritte dall'utente come **unico testo** del messaggio (maiuscole); le cattura solo approval-capture (UserPromptSubmit)
nel registro `customers/<C>/.sessions/<sid>/control.jsonl` (catena di hash), con audit `actor: user`.

| Frase | Effetto | Protezione | Quando vale |
|-------|---------|-----------|-------------|
| `PAUSA AGENTE <task_id>` · `PAUSA TUTTI` | ogni chiamata dell'agente (o di tutti) negata; nessun nuovo dispatch del compito (o di nessun compito) | aumenta | subito |
| `FERMA AGENTE <task_id>` · `FERMA TUTTI` | chiamate negate, invocazione chiusa subito (`aborted-by-user`, esito ABORTED-BY-USER di K6.6), il compito non si ridispaccia | aumenta | subito |
| `PASSO PASSO <task_id>` · `PASSO PASSO TUTTI` | ogni azione con effetto attende il `sì` dell'utente (una azione, monouso, la stessa chiamata) | aumenta | subito |
| `RIPRENDI AGENTE <task_id>` · `RIPRENDI TUTTI` | riprende l'agente (o tutti) | riduce | dopo la conferma nel transcript |
| `PASSO PASSO OFF` | spegne il passo-passo per tutti | riduce | dopo la conferma nel transcript |
| `SBLOCCA SCOPE <S>` | azzera la vigilanza dello scope | riduce | dopo la conferma nel transcript |
| `LIMITI DISPATCH <chiamate> <minuti>` | cambia i limiti per dispatch | (si conferma sempre) | dopo la conferma nel transcript |

La conferma nel transcript usa `confirmInTranscript` di `scripts/admin/approvals.mjs` (stesse regole della 3A: riga
utente genuina, sha del prompt, orario entro 30 s dal record); la scrive come record `confirm` il primo hook che ci
riesce (approval-capture, guard-budget, guard-control), entro un'ora dal record. Un record non confermato non vale.

## 6. Header del dispatch (agent-prompt, §46.1) — campi usati dalle regole

| Campo | Uso |
|-------|-----|
| `task_id` | identità del compito (legame agente, controllo dell'utente) |
| `tier` | escalation (T0/T1/T2) |
| `reply_to` | nuovo dispatch per lo stesso compito (dopo `escalate` o `needs-input`) |
| `kind: handoff`, `via: agent-manager`, `contract: <HND>` | handoff mediato |
| `budget.minutes` | limite di durata del dispatch (il minore con il limite dell'utente) |
| `allowed_paths` | cartelle di lavoro (passo-passo: scritture dentro non chiedono il `sì`) |

## 7. Rischi residui

- Il legame agente → compito senza transcript del sub-agente è per ordine di dispatch: con dispatch paralleli dello
  stesso tipo l'identità è ambigua e vale il più restrittivo (può negare un agente non in pausa).
- Il passo-passo riconosce le scritture dei comandi di shell con l'analisi esistente (redirezioni, comandi che
  scrivono file); uno script che scrive per conto suo (incluso uno script del plugin) non è un'"azione con effetto".
- I token del manager si misurano dal transcript della sessione principale (righe non sidechain); un formato diverso
  del transcript renderebbe la quota "n/d", non sbagliata.
- La sorveglianza del manager avvisa, non blocca (scelta della spec: R5 è un obiettivo, non un guard).
