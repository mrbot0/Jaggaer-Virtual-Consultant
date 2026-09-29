---
description: Conoscenza JAGGAER — ingestione e digestione dei documenti (sub-agenti di contesto), revisione umana, ricerca, campi, impatto, registri, indice e migrazioni (kb)
argument-hint: ingest <path> [--scope <S>] [--genre <genere>] [--kind <tipo>] | digest [--scope <S>] [--fields <documento>] | review [--scope <S>] [--only <strato>] | find [--scope <S>] [--type <T>] [--status <s>] [--cluster <CL>] [--facet <K=V>] [--top <n>] | fields [--doc <documento>] [--mandatory-in <stato>] [--chain <CL>] [--custom] [--reason <r>] | identity <FLD> | identity --doc <documento> --missing <blocco> | resolve "<domanda>" | precedents <soggetto> [--top <n>] | epistemic <soggetto> | epistemic --scope <S> [--plan] | impact <codice> [--if "<modifica>"] | graph [--scope <S>] | scopes | handoffs [--validate] | clusters | contradictions [--open] | coverage [--scope <S>] | reindex [--all] | migrate
allowed-tools: Bash(node *), Read
---

Base di conoscenza (§56.3, §44.1). `<C>` è il cliente attivo della sessione (`/use show`), `<S>` lo scope. Il DB del
cliente è `customers/<C>/knowledge.db`, quello del prodotto `product/knowledge.db`. La prima parola di `$ARGUMENTS` è
l'azione. Le azioni di lettura e di registro chiamano lo script direttamente; `ingest` e `digest` invocano i sub-agenti
di contesto; `review` è la coda umana (script diretto: decide l'utente, non un modello). Gli agenti non scrivono mai in
`kb/` né in `product/`: solo gli script dopo la validazione (§29.6).

## Azioni di lettura e di registro (script diretto, nessun sub-agente)

`find`, `fields`, `identity`, `resolve`, `precedents`, `impact`, `graph`, `scopes`, `handoffs`, `clusters`,
`contradictions`, `coverage`, `epistemic` — esegui con lo strumento Bash, senza modificare gli argomenti:

    node "${CLAUDE_PLUGIN_ROOT}/scripts/kb/kb.mjs" $ARGUMENTS --db customers/<C>/knowledge.db --json

- `resolve "<domanda>"`: scrivi la domanda dell'utente in `customers/<C>/.sessions/<sessione>/domanda.txt` e passa
  `resolve --text-file customers/<C>/.sessions/<sessione>/domanda.txt` al posto del testo (punteggiatura e accenti in linea
  rendono il comando non semplice: i guard lo negano). Gli altri argomenti sono codici e opzioni: passali come sono.
- `epistemic <soggetto>`: profilo epistemico di un soggetto (K per genere di fonte, forma, CTR aperte, attributi mancanti,
  prossimo passo: osservazione R0, domanda o CTR da risolvere).
- `epistemic --scope <S> [--plan]`: copertura epistemica per scope (forma, K medi, identità dei dati); con `--plan` le
  osservazioni R0 per i soggetti libreschi e le domande per gli ignoti (§34.2). Proponi le osservazioni all'utente.
- `impact <codice> [--if "mandatory.kind = never" | --if removed]`: cosa si rompe a valle. `graph` e
  `handoffs --validate` escono con 3 se c'è un'incoerenza: riportala, non è un errore del comando.
- `coverage [--scope <S>]` è la matrice CL-CFG × scope con la forma epistemica e la copertura NRT.
- Riporta al più 10 codici con il loro summary (≤ 60 parole, ≤ 20 per i FLD) e `truncated` se la lista è tagliata;
  mai il contenuto intero dei file. Queste chiamate non sono lavoro di dominio del manager: l'utente le ha chieste.

## `review [--scope <S>] [--only <strato>]` — revisione umana stratificata (script diretto)

    node "${CLAUDE_PLUGIN_ROOT}/scripts/kb/review.mjs" queue --root . --customer <C> --scope <S> --json

Mostra la coda per strato (`quarantena`, `dt021`, `r3`, `ctr`, `deontiche` a lotti da 10, `campione`); con `--only`
solo lo strato chiesto (`quarantena` · `ambigui` = dt021 e deontiche · `R3` = r3). Per ogni item l'utente decide; tu
registri **la sua** decisione, una per volta:

    node "${CLAUDE_PLUGIN_ROOT}/scripts/kb/review.mjs" accept <codice> --root . --customer <C> --reviewer <nome>
    node "${CLAUDE_PLUGIN_ROOT}/scripts/kb/review.mjs" correct <codice> <campo>=<valore> --root . --customer <C>
    node "${CLAUDE_PLUGIN_ROOT}/scripts/kb/review.mjs" reject <codice> --payload-file <file.yaml> --root . --customer <C>

Per `reject` (e per un valore con spazi o simboli in `correct`) scrivi prima il file YAML (`rule: …` oppure `field: …`
e `value: …`) nella cartella della sessione `customers/<C>/.sessions/<sessione>/`: mai testo strutturato in linea.
Non accettare né rifiutare nulla di tua iniziativa. `stats` dà il tasso di accettazione al primo passaggio per tipo.

## `ingest <path> [--scope <S>] [--genre tecnica|d'uso|empirica|testimoniale] [--kind <tipo>]` — ingestione (§19, §34.2)

1. T0, script diretto (harvest, profilo DOC, unità, pre-estrazione, piano per l'estrattore, report di ingestion):

       node "${CLAUDE_PLUGIN_ROOT}/scripts/ingest/ingest.mjs" --input <path> --root . --customer <C> --scope <S> --genre <genere> --kind <tipo> --json

   Ometti `--scope`/`--genre`/`--kind` se l'utente non li ha dati (`--kind` forza il tipo di documento di §19.7:
   manuale-utente, guida-admin, spec-integrazione, doc-progetto, release-notes, …; altrimenti lo riconosce lo script). Exit 3 = uscita dentro il repository del plugin: rifiutata.
2. Senza `--scope` (cartella di progetto del cliente): `Agent(customer-profiler, opus)` produce il profilo
   (`documentation_inventory`, `epistemic_summary`) e le domande di apertura; formulale all'utente (skill asking-the-user).
3. Con `--scope`: `Agent(scope-extractor, haiku)` — "cosa dice la fonte" sul piano in `_inbox/<S>/` (≤ 80k token per
   sessione) → `Agent(scope-digester, opus)` — le sei passate e la settima epistemica → `Agent(cluster-validator, opus)`
   sull'ammissione ai cluster (ciclo di validazione §19.5). Un dispatch per volta, nell'ordine; ognuno riceve il
   rapporto del precedente.
4. Riporta il report di ingestion (`_inbox/<S>/reports/`), il residuo classificato e le domande.

## `digest [--scope <S>] [--fields <documento>]` — digestione guidata dagli attributi attesi (§19.11)

- `Agent(scope-digester, opus)` sullo scope: le sette passate, gap come domande, candidati in `_inbox/` (mai `kb/`);
  poi `Agent(cluster-validator, opus)` sull'ammissione.
- `--fields <documento>`: prima il piano dei lotti (≤ 50 campi per lotto, fino al budget del documento):

      node "${CLAUDE_PLUGIN_ROOT}/scripts/kb/digest-fields.mjs" plan <documento> --root customers/<C> --scope <S> --json

  poi un `Agent(scope-digester, opus)` per lotto. Exit 3 = budget del documento raggiunto: si riprende alla sessione
  successiva con `--resume <cursore>` (riportalo all'utente).

## `reindex [--all]` e `migrate` — indice e migrazioni (script diretti)

    node "${CLAUDE_PLUGIN_ROOT}/scripts/kb/reindex.mjs" --root customers/<C> --db customers/<C>/knowledge.db --json
    node "${CLAUDE_PLUGIN_ROOT}/scripts/kb/reindex.mjs" --root product --db product/knowledge.db --json

`reindex` ricostruisce l'indice del cliente attivo (lo scope non restringe: l'indice è del cliente); `--all` anche il
prodotto e ogni cliente in `customers/` (una chiamata per cartella). `migrate` (§49.4, "Knowledge version
incompatibile" in §58):

    node "${CLAUDE_PLUGIN_ROOT}/scripts/kb/kb.mjs" migrate --db customers/<C>/knowledge.db --root customers/<C> --json

Exit 3 di `migrate` = DB più nuovo del plugin: si aggiorna il plugin, non il DB. Un DB bloccato (lock di una digestione
in corso) si vede con `/admin lock`.

## Regole

- exit 1: mostra l'errore e la sintassi dell'azione (argument-hint); exit 2: errore di sistema, riportalo com'è.
- Prima di un dispatch leggi la sintesi della console degli agenti (`/vc agents`): non ridispacciare un compito in
  corso, non instradare su uno scope bloccato dalla vigilanza. Componi il prompt da `templates/agent-prompt.md` (header
  con task_id, cliente, scope, modalità, tier, budget, allowed_paths, output atteso); `subagent_type` è
  `jaggaer-virtual-consultant:<agente>`. Dopo ogni ritorno leggi lo status effettivo (ok, partial, needs-input, escalate).
