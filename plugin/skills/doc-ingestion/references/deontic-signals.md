# doc-ingestion — riferimenti: segnali deontici, residuo, unità del tenant

Materiale di consultazione della skill `doc-ingestion` (§19.10, §19.15, §19.17). Si carica a richiesta.

## Segnali deontici → modalità → esito (§19.10)

| Segnale nel testo (it / en) | Modalità | Diventa |
|-----------------------------|----------|---------|
| "deve", "è obbligatorio", "è richiesto", "va inserito" / must, required, mandatory | obbligo | `mandatory.kind: always` (se non c'è condizione) |
| "se … deve", "quando … è obbligatorio", "in caso di … è richiesto" / if … must | obbligo condizionale | `mandatory.kind: conditional` con `when` dalla protasi |
| "per la società X", "per il ruolo Y", "nello stato Z" | qualificatore di ambito | `when`, `by_role`, `in_states` |
| "non deve", "non può", "non è consentito" / must not, cannot | divieto | INV o `validation.on_fail: block` |
| "può", "è possibile", "facoltativo" / may, optional | facoltà | `mandatory.kind: never`; in una tabella che dice "obbligatorio" → CTR |
| "si consiglia", "è preferibile", "di norma" / should, recommended | raccomandazione | non obbligatorio; nota nel FLD; **mai** promosso a obbligo |
| "il sistema impedisce", "viene bloccato", "non è salvabile" | comportamento del sistema | `validation` con `on_fail: block`, genere tecnica |
| "viene segnalato", "compare un avviso" | comportamento non bloccante | `validation` con `on_fail: warn` |
| "dopo la conferma non è più modificabile", "una volta approvato" | immutabilità | `immutable_fields_after` nel LCY |
| "deve corrispondere a", "deve esistere in", "codice del gestionale" | vincolo esterno | `cross_system` nella KEY, `mandatory.reason.kind: integration` |
| "salvo", "eccetto", "tranne" | eccezione | ramo `unless`; se la regola base è un obbligo, un `when` negato |
| negazione doppia, "non è vero che non…" | ambiguo | unità `ambiguous`, in residuo per revisione |

Per ogni regola l'estrattore produce `subject` (risolto in un codice se possibile), `modality`, `condition`,
`scope_qualifiers`, `consequence`, `source_unit`. Una regola con modalità non determinata non produce mai un
`mandatory.kind`.

## Classi di residuo (§19.15)

| Classe | Cos'è | Destino |
|--------|-------|---------|
| `irrelevant` | introduzioni, indici, disclaimer, ripetizioni | archiviato; conta come "non pertinente" |
| `duplicate` | unità già coperta da un item (per alias o hash) | legata all'item come fonte aggiuntiva (+1 conferma) |
| `ambiguous` | modalità non determinata, tipo incerto, soggetto non risolto | revisione umana a lotti: è dove il documento è scritto male |
| `unsupported` | item proposto e bocciato al back-check | torna al digester con l'esito |
| `deferred` | unità di uno scope non ancora a bordo | in attesa dell'onboarding dello scope |
| `tacit` | "di solito facciamo così" senza regola formale | candidato L a confidenza bassa con origine dichiarazione-utente; domanda di apprendimento |

Il riepilogo per classe lo dà `scripts/ingest/residue.mjs`; il report di ingestion per documento segue
`templates/ingestion-report.md`.

## Il report di ingestion: cosa deve dire

Unità → item (per tipo) · residuo per classe · back-check al primo passaggio e rifatti come derived · esiti di DT-021
(C, S come conferme, ambigui → domande) · copertura epistemica prodotta · gap più frequenti (una diagnosi sul
documento) · contraddizioni aperte · costo per tier, token e tempo · cosa resta da fare (unità in revisione, domande,
CTR).

## Unità del tenant (§19.17)

| Unità del tenant | Equivale a | Produce |
|------------------|-----------|---------|
| pagina (firma di pagina) | capitolo | inventario delle pagine: DOC di ricognizione con data |
| sezione o tab | sezione | contesto per i campi |
| campo con attributi (required, tipo, opzioni, visibilità) | riga di tabella di campi | FLD di livello L con obbligatorietà **osservata** |
| messaggio di validazione | regola a modalità sistema | `validation` con testo esatto e `on_fail` osservato |
| schermata di setup con valori | tabella di parametri | stato attuale del CFG (conferme successive lo portano a 1.00) |
| export di configurazione | tracciato | CFG ad alta confidenza, con la data dell'export |

Cadenza: ricognizione completa all'onboarding e a ogni release; parziale ogni volta che un compito attraversa una
pagina (la produce comunque l'hook delle osservazioni).
