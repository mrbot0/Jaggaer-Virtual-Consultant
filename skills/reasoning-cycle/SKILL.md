---
name: reasoning-cycle
description: Metodo del ciclo cognitivo a sei passi (SITUARE → RICHIAMARE → VALUTARE → DECIDERE → AGIRE → RIFLETTERE) con la traccia che ogni passo lascia nel rapporto. Usala all'inizio di ogni compito ricevuto dal manager con un header agent-prompt (collaudo NRT, configurazione, operatività, diagnosi, estrazione, digestione, validazione, triage, Defect, digestione settimanale), quando devi scegliere quanto a fondo ragionare (profondità dell'header) e prima di scrivere il rapporto finale con cognitive_trace.
---

# reasoning-cycle — il ciclo a sei passi e le sue tracce (§10)

Ogni compito, per ogni ruolo, percorre lo stesso ciclo. Non è uno stile: è la struttura che rende verificabile il
tuo lavoro. Ogni passo produce una parte del blocco `cognitive_trace` del rapporto (§46.2,
`schemas/cognitive-trace.schema.json`); senza traccia il rapporto è respinto da SubagentStop e il manager lo tratta
come `partial` (§10.1, §23.2).

## Il ciclo in una tabella

| Passo | Domanda | Come (strumento) | Traccia prodotta |
|-------|---------|------------------|------------------|
| 1 SITUARE | Che cosa mi si chiede, su quale soggetto, con che rischio? | leggi l'header (`task`, `mode`, `tier`, `depth`, `budget`, `allowed_paths`); se il soggetto non ha codice, `kb resolve` o dichiaralo `ignoto` | riga di situazione (soggetto, azione, rischio F10, modalità, confine) |
| 2 RICHIAMARE | Cosa so, cosa è successo, cosa ho scoperto? | `kb find`/`kb resolve` (semantica), `kb precedents` (episodica), blackboard e OBS di sessione (di lavoro) — sempre troncati | `recalled: { semantic, episodic, working }` |
| 3 VALUTARE | Quanto conosco il soggetto e le memorie concordano? | `kb epistemic <codice>` → forma, vettore K, `gaps` (skill `epistemic-awareness`) | `epistemic: { subject, shape_before }` |
| 4 DECIDERE | Quale strategia, quale esito della tabella? | `strategy-select` (DT-017, skill `strategies`) poi `dt-eval` della DT del caso con i priori (skill `decision-tables`) | `strategy`, `decisions` (codici DEC), `hypotheses` se deliberazione profonda |
| 5 AGIRE | Il passo è andato come atteso? | strumenti del ruolo (browser MCP un passo alla volta con `step-check`, oppure script) | `surprises` (da step-check, mai giudicate a occhio) |
| 6 RIFLETTERE | Il risultato regge? Cosa ho imparato? | `self-check` (bloccante) e lezione a otto sezioni (skill `self-check-and-lesson`) | `self_check`, `epistemic.shape_after`, `lesson`, esiti attesi |

## Come si esegue ogni passo

**1 — Situare.** Riformula il compito in una riga: soggetto (codice), azione, rischio dichiarato, modalità, confine.
Se il compito attraversa un altro scope, lo dici subito: il lavoro oltre confine è un handoff che media il manager
(skill `scope-discipline`). Il `tier` dell'header è quello del modello che gira: non lo cambi tu.

**2 — Richiamare.** Tre chiamate a script, tutte troncate dalla profondità (`--top`): mai file aperti "per
vedere". Esempi dalla forma usata dagli agenti:

    node "${CLAUDE_PLUGIN_ROOT}/scripts/kb/kb.mjs" find --scope <S> --type <TIPO> --top 8 --db customers/<C>/knowledge.db --json
    node "${CLAUDE_PLUGIN_ROOT}/scripts/kb/kb.mjs" precedents <codice> --top 3 --customer <C> --db customers/<C>/knowledge.db --json

La stessa query con gli stessi argomenti non si ripete nel compito: il self-check la conta come spreco (§29.10).

**3 — Valutare.** Leggi prima la forma, poi i `gaps`. Confronta le tre memorie: se il precedente dice "ha
funzionato" e l'osservazione di oggi mostra altro, la memoria di lavoro prevale **per il passo corrente** ma non
cancella le altre: si apre una `CTR` (skill `belief-revision`).

    node "${CLAUDE_PLUGIN_ROOT}/scripts/kb/kb.mjs" epistemic <codice> --db customers/<C>/knowledge.db --json

**4 — Decidere.** Prima la strategia, poi la tabella del caso con i priori (`--priors auto`) e `--write-dec`: la
`DEC` è scritta prima che tu legga l'esito. Esito `chiedi` → `status: needs-input` con la domanda già formulata
(skill `asking-the-user`); esito `escala` o fermati → `status: escalate` con l'output parziale. Mai a metà.
Per un'azione di più passi il piano è una **traccia attesa** (§10.5): ogni passo ha `expect`, e il piano dichiara
prima cosa si può saltare, cosa sostituire e dove abortire (`repair_policy`).

**5 — Agire.** Un passo del piano alla volta. Dopo ogni passo il risultato va allo script che classifica
(`ok · surprise · novelty · approval_required · denied`): la divergenza la decide lui. Una sorpresa riporta al
passo 3 per il passo corrente: non si continua "sperando" (§13.2).

**6 — Riflettere.** Auto-verifica codificata sulla bozza del rapporto, poi la lezione con l'esito atteso di ogni
`DEC` con effetti: è ciò che permette al registro degli esiti di verificare a posteriori (§12.1).

## Quanto pensare: la profondità (DT-023, §10.4)

La profondità arriva nell'header (`depth`), decisa dal manager con DT-023. Tu la rispetti:

| Profondità | Richiamo | Alternative | File oltre i summary | Extra | Auto-verifica |
|-----------|----------|-------------|----------------------|-------|---------------|
| `rapida` | top 3, 1 precedente | nessuna | no | — | controlli 1, 3, 9, 11 |
| `standard` | top 8, 3 precedenti | due sul passo critico | solo se il summary non basta | — | 1–10 |
| `profonda` | top 15, 5 precedenti anche di altri clienti | esplicite con costi e rischi | sì | registro delle ipotesi, `STR-PREMORTEM` | 1–10 |

Forme ridotte del ciclo (§26.3), dichiarate nella definizione del ruolo: **ridotto (1-2-6)** per chi estrae;
**2-4-6** per chi valida (richiami, decidi con la tabella, rifletti); **ridotto** per i ruoli T0 di audit e Defect.
Una forma ridotta toglie passi, non tracce: i campi di `cognitive_trace` restano tutti presenti (liste vuote dove
il passo non si applica, mai inventati).

## La traccia nel rapporto

```yaml
cognitive_trace:
  depth: <rapida | standard | profonda>          # quella dell'header
  recalled: { semantic: [<codici>], episodic: [<DEC>], working: [<OBS>] }
  epistemic: { subject: <codice>, shape_before: <forma>, shape_after: <forma> }
  strategy: STR-<...>
  hypotheses: null                              # oppure il registro (profonda, diagnosi)
  decisions: [<DEC>]
  surprises: []                                 # quelle registrate da step-check o dichiarate
  self_check: { passed: <n>, failed: [] }       # come lo restituisce self-check, mai a mano
lesson: <codice LSN>
```

Solo codici e liste: niente prosa (controllo 8). `self_check.passed` conta i controlli eseguiti e superati — mai
controlli che non hai eseguito.

## Perché costa poco se fatto bene (§10.3)

Su un soggetto `consolidato` con precedente confermato i passi 1–4 sono tre chiamate a script e una tabella: il
ciclo si chiude a T0 in poche centinaia di token. Il ciclo è costoso solo quando **deve** esserlo (forma
`libresco`/`ignoto`, sorprese, contraddizioni). Toglierlo "per risparmiare" toglie ciò che rende il sistema capace
di non ripetere errori (R11 di §26.2).

## Errori tipici da evitare

- Saltare VALUTARE perché "il compito è semplice": la forma epistemica decide la strategia, non l'impressione.
- Decidere a parole: ogni decisione con effetti passa da una tabella e lascia una `DEC` (controllo 4).
- Riempire `surprises` o `self_check` a mano: li producono gli script.
- Continuare dopo una sorpresa incompatibile su R ≥ R2: ci si ferma e si restituisce `needs-input` o `escalate`.
- Chiudere `ok` con domande aperte bloccanti: l'esito effettivo è `partial` (controllo 10).
