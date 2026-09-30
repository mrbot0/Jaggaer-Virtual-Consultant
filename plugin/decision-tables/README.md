# Tabelle di decisione

Un agente non "valuta": applica una tabella (§15.1). Ogni file `DT-0nn.yaml` è
validato da `schemas/dt.schema.json` e valutato da `scripts/decide/dt-eval.mjs`:

```
node scripts/decide/dt-eval.mjs --table DT-002 --inputs inputs.json --priors auto --customer ACME \
  --scope ADM --db knowledge.db --root customers/ACME --write-dec --json
```

Regole comuni:

- punteggio = Σ peso × punteggio dell'input + Σ peso × prior; la somma dei pesi vale 1.0 ± 0.001;
- ordine: `overrides` → banda `[from, to)` (l'ultima include 1) → `outcome_selectors` → esito della banda;
- input fuori dominio o chiave non dichiarata (refuso) → errore (`exit 1`), mai un'approssimazione; input mancante → `null_policy`
  (`error` · `default:<valore>` · `worst` = il valore di punteggio massimo);
- priori dal registro degli esiti (`scripts/digest/outcomes-rates.mjs`); sotto 30 DEC verificate vale
  il `neutral` dichiarato, che per costruzione non sposta il punteggio (0 per un prior diretto, 1 per un
  prior invertito: dt-eval rifiuta altri valori);
- `calibration: spec` = pesi e soglie della spec; `bootstrap` = progettati dal testo della spec; `mixed` = in parte
  dalla spec, in parte progettati (con `calibration_note`); i bootstrap vanno
  ricalibrati sugli esiti (§12.5). Le tabelle cambiano con motivazione e nuova `version`, mai in sessione.

Un prior con peso 0 (DT-017, DT-021, DT-023, DT-025) è dichiarato ma agisce alla calibrazione
mensile delle soglie (o, per DT-025, sull'affidabilità del documento), perché i pesi della spec
sommano già a 1.

## Catalogo

| Codice | Decisione | Priori usati (peso) | Esiti | Calibrazione |
|--------|-----------|---------------------|-------|--------------|
| DT-001 | Classificare un fallimento | Tasso di smentita della categoria sul cluster del soggetto (0.16, invertito) | test-defect · config-drift · product-defect · baseline-change · environment · expected-change · regression | bootstrap |
| DT-002 | Chiedere o procedere | Tasso di smentita di "procedi" su questa forma, questo cliente (0.15) | procedi · procedi-con-assunzione · chiedi · fermati | spec |
| DT-003 | Tier di modello | Tasso di escalation su questo tipo di compito (0.10) | T0 · T1 · T2 | spec |
| DT-004 | Validare una lezione | — | validated · merged · rejected | bootstrap |
| DT-005 | Ammettere in un cluster | Tasso di quarantena della famiglia (0.20) | ammesso · rigettato · quarantena | bootstrap |
| DT-006 | Portabilità | — (è essa stessa un calcolo sui clienti) | universale · condizionata · specifica · ignota | bootstrap |
| DT-007 | Rischio di una modifica di configurazione | Tasso di smentita per area CL-CFG e cliente (0.10) | R0 · R1 · R2 · R3 + perimetro verde/giallo/rosso | mixed (base per area: spec; correttivi: bootstrap) |
| DT-008 | Strategia di localizzazione | Tasso di insuccesso della strategia sul pattern CL-UIB (0.35) | testid · role · label · css | bootstrap |
| DT-009 | Selezione evidenze | — | lista | bootstrap |
| DT-010 | Promuovere a S | Tasso di smentita post-promozione (0.15) | candidato · no | bootstrap |
| DT-011 | Risolvere una contraddizione | Tasso di smentita per genere di fonte vincente sull'area (0.15) | vince-L · vince-C · vince-S · irrisolta | bootstrap |
| DT-012 | Priorità di copertura | Densità di difetti in collaudo (0.15) | punteggio | bootstrap |
| DT-013 | Stadio di checkpoint | Tasso di timeout per stadio e interfaccia (0.30, invertito) | queued_accepted · processed · acknowledged | bootstrap |
| DT-014 | Fermare un'esplorazione | — | continua · ferma | bootstrap |
| DT-015 | Query consegnabile | Tasso di smentita per pattern di query (0.20) | sì · no | bootstrap |
| DT-016 | Sorpresa compatibile o incompatibile | Tasso per tipo di divergenza (0.15) | compatibile · incompatibile | bootstrap |
| DT-017 | Selezione della strategia | Tasso di smentita per strategia e cluster (0, calibrazione) | strategia (STR-…) · nessuna | spec |
| DT-018 | Il precedente è applicabile? | — | replay · orienta · ignora | spec |
| DT-019 | Quale genere di fonte cercare per colmare un gap | Tasso di gap non risolti dal genere preferito (0.30) | tecnica · d'uso · osservazione · utente | bootstrap |
| DT-020 | Tipo di un item digerito | Tasso di riclassificazione per tipo (0.10, invertito) | uno dei tipi del registro · ambiguo | bootstrap |
| DT-021 | Livello S o C di un item | Tasso di smentita per segnale (0, calibrazione) | S · C · ambiguo (chiedi) | spec |
| DT-022 | Completezza di un item digerito | — | digerito · quarantena | bootstrap |
| DT-023 | Profondità di deliberazione | Tasso di smentita per profondità (0, calibrazione) | rapida · standard · profonda | spec |
| DT-024 | Tipo di incertezza | — | epistemica · aleatoria · mista (bisect) | bootstrap |
| DT-025 | Priorità di un documento nel backlog di ingestion | Guadagno realizzato / atteso (0, via affidabilità) | punteggio | spec |
| DT-026 | Classificazione dell'intento (§29.5, fuori dal catalogo §15.2) | — | avvia · mostra-piano · approvazione-3A · rifiuta · chiedi | bootstrap |

`quality-weights.yaml` (K0) non è una DT: sono i pesi del modello di qualità Q per tipo di decisione (§6.5).
