---
name: field-modeling
description: Metodo per modellare i campi dei documenti come item FLD — la regola di obbligatorietà come regola (kind, in_states, when, by_role) con la sua ragione (reason) e il lineage fra documenti (derived_from, propagates_to, required_by), i cluster CL-FLD / CL-FLD-CHAIN / CL-FLD-MAND, la pipeline per documenti con centinaia di campi a lotti di al più 50, il recupero con kb fields e kb impact. Usala quando digerisci tabelle di campi o regole deontiche, quando progetti una modifica a un form (cosa si rompe a valle), quando generi test di obbligatorietà, quando devi sapere cosa chiedere prima di creare un documento o quando mappi campi verso colonne Analytics.
---

# field-modeling — campi, obbligatorietà, catene, lotti (§19.6)

Un documento configurato può avere centinaia di campi. Trattarli come attributi sparsi produce tre fallimenti: non
si trova il campo, lo si carica con tutti gli altri, non si capisce **perché** è obbligatorio. Il modello dei campi
risolve i tre: un item `FLD` per campo per tipo di documento, una regola di obbligatorietà strutturata, un grafo
delle catene fra documenti.

## L'item FLD: cosa deve contenere (§19.6.2)

Codice `<L>.<C|STD>.<S>.FLD.<SEQ>` (skill `coding-system`); le deviazioni del cliente con `deviates_from`. Schema in
`schemas/fld.schema.json`. I blocchi che contano per il metodo:

| Blocco | Forma | Regola di metodo |
|--------|-------|------------------|
| `document`, `section`, `type`, `options_source` | riferimenti al LCY del documento, alla sezione del form, al tipo (text · number · date · lookup · list · flag · file · table) | la sezione decide il cluster `CL-FLD` |
| `mandatory` | `{ kind: always · conditional · never · undocumented, in_states, when, by_role, reason, source, confirmed_by }` | l'obbligatorietà è una **regola**, non un flag: senza *quando* e *per chi* la domanda "è obbligatorio?" non ha risposta |
| `mandatory.reason` | `{ kind: integration · workflow · legal · business · ui · derived, ref }` | la ragione a valle: è ciò che distingue un elenco da un modello |
| `lineage` | `derived_from`, `propagates_to[{field, document, transform}]`, `required_by[{ref, …}]` | le catene logiche come grafo esplicito |
| `summary` | ≤ 20 parole | il resto si recupera per codice |
| `identity` | la carta d'identità in dodici blocchi | skill `identity-and-keys` |

## Ricavare la regola di obbligatorietà

1. Il testo di obbligatorietà si estrae **verbatim** (tabelle di campi, regole deontiche): non riassumerlo.
2. La modalità si decide con le regole lessicali (skill `doc-ingestion`, §19.10): obbligo → `always`; obbligo con
   condizione → `conditional` con `when` dalla protasi; qualificatori di società, ruolo, stato → `when`, `by_role`,
   `in_states`; facoltà → `never`; raccomandazione → mai promossa a obbligo.
3. **Una regola con modalità non determinata non produce mai un `mandatory.kind`**: l'unità va in residuo
   `ambiguous` per la revisione umana.
4. La ragione si ricava attraversando le fonti: il tracciato di integrazione dichiara il campo obbligatorio →
   `integration` (con `ref` all'INT); un workflow lo richiede per instradare → `workflow`; la norma → `legal`; solo
   la UI → `ui`. **`ui` senza altra ragione è un sospetto di personalizzazione non documentata: diventa una
   domanda**, non una scelta.
5. Manuale e specifica che dicono cose diverse sullo stesso campo → CTR, non una media.

## I cluster dei campi (§19.6.3)

| Famiglia | Per | Appartenenza |
|----------|-----|--------------|
| `CL-FLD` | sezione funzionale del documento (intestazione, righe, contabilità, fiscalità, logistica, …, custom, sistema, testi) | esattamente uno |
| `CL-FLD-CHAIN` | catena logica: i campi di documenti diversi che portano lo stesso dato lungo il processo | zero o più |
| `CL-FLD-MAND` | tipo di obbligatorietà (sempre, per stato, per importo, per categoria/società, per ruolo, per integrazione, non documentata) | esattamente uno, **solo se la regola è parsata** |

Una catena entra solo con ≥ 3 FLD di ≥ 2 documenti; la sua definizione cita la PMP che attraversa.

## La pipeline per documenti grandi (§19.6.4)

Nessun passaggio vede più di qualche decina di campi; il costoso lavora solo sui campi che hanno regole.

| Passo | Chi | Regola |
|-------|-----|--------|
| 1 segmentazione | script (T0) | per sezione, tab, tabella: un grezzo per sezione |
| 2 estrazione tabellare | extractor | una riga per campo: label, nome tecnico, tipo, testo di obbligatorietà com'è, citazione, genere F15 |
| 3 deduplica | script | lo stesso campo in manuale e specifica = **un** item con due fonti (il nome tecnico è la chiave forte) |
| 4 digestione per lotto | digester | **lotti per sezione di al più 50 campi**; parsing della regola in `{ kind, in_states, when, by_role }`, summary ≤ 20 parole; T1 se la regola è semplice, T2 se condizionale |
| 5 ricostruzione delle catene | digester T2, passata separata | **solo** sui campi con `kind ≠ never`, più le INT e i LCY a valle: perché (reason) e verso dove (lineage) |
| 6 validazione | cluster-validator | CL-FLD-MAND solo con regola parsata; catena solo con ≥ 3 FLD di ≥ 2 documenti |
| 7 indicizzazione | reindex | FTS su label e nome tecnico, faccette, grafo lineage in relations |
| 8 conferma per osservazione | l'agente su Chrome, pagina per pagina | attributo required, visibilità, opzioni del form reale → conferma o CTR per campo |

I lotti li prepara lo script (`scripts/kb/digest-fields.mjs` plan: ≤ 50 campi per sezione, budget del documento
80k, riprende da un cursore); il lotto digerito si accetta con la validazione dei FLD, che lo scrive in
`_inbox/<S>/digested/` — mai in `kb/`. Le catene le propone `scripts/kb/chains.mjs`. Ogni FLD si valida prima di
consegnarlo:

    node "${CLAUDE_PLUGIN_ROOT}/scripts/kb/validate-fld.mjs" customers/<C>/_inbox/<S>/digested/<codice>.yaml --json

## Recuperare in pochi token (§19.6.5)

Mai caricare il form intero. Si chiede il sottoinsieme che serve:

    node "${CLAUDE_PLUGIN_ROOT}/scripts/kb/kb.mjs" fields --doc <documento> --mandatory-in <stato> --top 50 --db customers/<C>/knowledge.db --json
    node "${CLAUDE_PLUGIN_ROOT}/scripts/kb/kb.mjs" impact <FLD> --if removed --db customers/<C>/knowledge.db --json

`kb fields` accetta anche `--chain <CL-FLD-CHAIN>`, `--custom`, `--reason ui` (la lista delle domande da fare),
`--company`, `--section`. `kb impact` risponde a "se rendo opzionale o tolgo questo campo, cosa si rompe a valle?".

## Chi ne fa cosa (§19.6.6)

| Compito | Uso del modello |
|---------|-----------------|
| generare test | un negativo per stato, condizione e ruolo della regola; un test di catena per CL-FLD-CHAIN (skill `nrt-authoring`) |
| progettare una configurazione | `kb impact` prima di toccare un campo; i campi `reason: ui` sono domande |
| verificare una configurazione | il verificatore controlla l'obbligatorietà campo per campo |
| operatività | `kb fields --mandatory-in` per sapere cosa chiedere prima di creare un documento |
| Analytics | il nome tecnico è il ponte verso le colonne delle tabelle |
| profilo del cliente | quota di campi custom e di `reason: ui` = quanto il cliente ha personalizzato |

## Errori tipici

- Trasformare "obbligatorio" di una tabella in `always` senza cercare condizioni, stati e ruoli.
- Inventare una `reason` che nessuna fonte dice: è `derived` con la regola che l'ha prodotta, o un gap.
- Lotti oltre 50 campi, o la ricostruzione delle catene su tutti i campi invece che su quelli con obbligo.
- Scrivere FLD direttamente in `kb/`: solo `_inbox`, poi digestione e validazione.
