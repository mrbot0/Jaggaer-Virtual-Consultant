---
name: identity-and-keys
description: Metodo per la carta d'identità del dato (i dodici blocchi di §19.20 — nomi, tipo e formato, dominio, vincoli, struttura, relazioni, sistema di riferimento, proprietà, ciclo di vita, sensibilità, errori, evidenza dai dati reali) e per i ruoli degli item KEY (unicità, riuso, mutabilità, formato, cross_system, impatto sul documento) e LCY (stati, transizioni, obbligatorietà per stato, immutabilità, validazioni block · none · undocumented). Usala quando digerisci o completi un FLD o una KEY, quando un'integrazione mappa un campo (system_of_record obbligatorio), quando generi test d'identità o di ciclo di vita, quando decidi cosa mascherare in un'evidenza.
---

# identity-and-keys — cos'è un dato, in ogni dimensione che può farlo fallire (§19.20)

Il modello dei campi (skill `field-modeling`) dice *quando* un campo è obbligatorio e *perché*. Chi tocca un dato
deve anche sapere **cos'è**: tipo, formato, limiti, dominio, chi ne è il sistema di riferimento, da cosa dipende,
chi lo usa a valle, quanto è sensibile. È la carta d'identità del dato, prodotta dalla digestione per ogni FLD e KEY.

## I dodici blocchi e da dove viene ciascuno

| # | Blocco | Contenuto | Fonte tipica |
|---|--------|-----------|--------------|
| 1 | `names` | etichette UI per lingua, nome tecnico, colonna del DB (da Analytics), nome API, nome nel tracciato, alias | form, specifiche, TBL, INT |
| 2 | `datatype` | tipo, formato (pattern), lunghezze, maiuscole, precisione, unità, fuso, codifica | specifica o osservazione |
| 3 | `domain` | lookup/lista, tabella e sistema sorgente, valori osservati, dominio chiuso o no, filtro | tabella o combobox osservata |
| 4 | `constraints` | rimandi a obbligatorietà, unicità, immutabilità, default, validazioni con messaggio (ERR) | LCY, KEY, osservazione |
| 5 | `structure` | entità, livello (testata/riga), cardinalità, copia sulle righe | form, specifica |
| 6 | `relations` | chiavi esterne, riferimenti, derivazioni, propagazioni, dipendenze da CFG | lineage, grafo |
| 7 | `system_of_record` | sistema master, replica, sincronizzazione (direzione, frequenza, interfaccia), regola di conflitto | specifica di integrazione |
| 8 | `ownership` | proprietario di business, data steward, scope proprietario | profilo, documenti di progetto |
| 9 | `lifecycle` | stato di creazione, modificabile fino a, archiviazione, retention | LCY |
| 10 | `sensitivity` | classe, PII, commerciale, finanziario, `redact_in_evidence` | classificazione (skill `data-safety`) |
| 11 | `errors` | codici ERR noti associati | catalogo ERR |
| 12 | `real_data` | tasso di compilazione, valori distinti, concentrazione, vuoti per stato, `de_facto_mandatory` | profili DIN aggregati (mai valori) |

`identity_quality` riassume la copertura dei dodici blocchi, Q e forma.

## Le regole di digestione

| Regola | Perché |
|--------|--------|
| ogni blocco ha **la sua** fonte | un blocco senza fonte è un gap, non un'inferenza |
| `system_of_record` è **obbligatorio** per ogni campo che compare in un mapping INT | spiega la maggior parte degli errori di identità |
| `de_facto_mandatory` nasce dal confronto fra regola documentata e tasso di compilazione reale; se divergono, CTR | un campo "opzionale" compilato quasi sempre è obbligatorio per il processo, e i test devono saperlo |
| `sensitivity` decide la redazione delle evidenze e cosa un profilo DIN può conservare | nessun valore identificativo lascia il tenant |
| i blocchi 2, 3 e 7 sono i primi da confermare per osservazione | sono quelli su cui la documentazione sbaglia più spesso |

`real_data` contiene solo aggregati (tassi, conteggi, quote) calcolati su gruppi abbastanza grandi: mai un valore
che identifichi una persona o un documento.

## Leggere e completare

`kb identity <FLD>` restituisce la carta in forma compatta; `kb identity --doc <documento> --missing <blocco>`
elenca i campi a cui manca un blocco — è la lista di lavoro per completarli (osservazioni da fare o domande). La
copertura dei dodici blocchi entra nel report di copertura epistemica come riga "identità dei dati".

## Il ruolo degli item KEY (§27.1, `schemas/key.schema.json`)

Una KEY descrive l'identità di un campo che fa da chiave:

- `uniqueness` — `scope` (none · document · company · tenant · global), `normalization`, `channels` da cui si può
  creare, `gaps` (canali dove l'unicità non è controllata);
- `reuse_after_deactivation` — allowed · forbidden · unknown;
- `mutability` / `immutable_after` — da quale stato non si modifica più, chi può modificarla;
- `format` — pattern, lunghezza massima, trasformazioni;
- `cross_system` — esistenza e validazione in un sistema esterno (validata localmente o no);
- `document_impact` — cosa succede ai documenti che la usano se è sbagliata (severità);
- canali di enforcement e obbligatorietà per stato.

Gli attributi critici sono unicità e cross_system. **I risk mode dei test si deducono da questi attributi**, non si
inventano: collisione, riuso, aggiramento di un canale, mutazione tardiva, formato, troncamento silenzioso,
riferimento pendente, propagazione (skill `nrt-authoring`).

## Il ruolo degli item LCY (§27.1, `schemas/lcy.schema.json`)

Un LCY descrive il ciclo di vita di un documento: `states`, `transitions` (da, a, azione, ruolo, selettore),
`mandatory_by_state` (quali FLD sono obbligatori in quale stato — lo legge la ricostruzione delle catene),
`immutable_after`, `validations` con esito `block` · `none` · `undocumented`, e i punti di contatto con le
integrazioni. Una validazione `undocumented` genera un test di baseline (BSL), non un'asserzione inventata.

## Errori tipici

- Riempire un blocco per analogia con un campo simile: è un gap finché una fonte non lo dice.
- Dimenticare `system_of_record` su un campo mappato in un'interfaccia.
- Copiare in `real_data` valori campione del tenant invece di aggregati.
- Scrivere una KEY senza i canali: l'aggiramento dell'unicità passa proprio dal canale non controllato.
