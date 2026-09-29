---
name: nrt-authoring
description: Metodo per scrivere casi di test NRT — la tabella di deduzione vincolo → risk mode → genere (NEG, INT, BSL, HND, POS) dagli attributi di KEY, LCY, FLD, INT e HND, le sei strategie di generazione per scope, la nascita del test con epistemic_at_generation (shadow su libresco, esplorazione su ignoto), il caso a richiesta con derivation e boundary. Usala quando generi test dal delta di una release o dalle chiavi di uno scope, quando l'utente chiede un caso con /nrt author, quando componi un caso da FLW e fixture, quando lint-spec o lint-scope rifiutano un caso, quando ripari un caso senza indebolirlo.
---

# nrt-authoring — dedurre i test, non inventarli (§27.2, §27.3, §29.2)

Un test di non regressione vale quanto la regola che verifica. Il metodo è dedurre ogni caso da un attributo di un
item validato (una chiave, un ciclo di vita, un campo, un'interfaccia, un handoff), registrarne la derivazione e il
confine, e non generare mai un caso su ciò che non si conosce.

## La tabella di deduzione (§27.2)

| Condizione sull'item | Risk mode | Genere |
|----------------------|-----------|--------|
| unicità con scope diverso da `none` | collisione | NEG |
| riuso dopo disattivazione vietato | riuso | NEG |
| un canale non coperto dal controllo | aggiramento | NEG / BSL |
| immutabile dopo uno stato | mutazione tardiva | NEG |
| lunghezza massima + trasformazione senza troncamento esplicito | troncamento silenzioso | INT |
| pattern di formato | formato | NEG |
| riferimento esterno non validato localmente | riferimento pendente | INT / BSL |
| impatto bloccante sul documento | propagazione | INT |
| obbligatorio in uno stato | obbligatorio omesso | NEG |
| validazione non documentata | ignoto | BSL |
| FLD obbligatorio **condizionale** con `when` | obbligatorio condizionale non applicato | NEG con la condizione vera e il campo vuoto; POS con la condizione falsa e il campo vuoto |
| FLD obbligatorio **per ruolo** | obbligatorio per ruolo | un NEG per ruolo |
| FLD con ragione `integration` | campo vuoto al tracciato | INT: il messaggio è rifiutato o segnalato, mai silente |
| FLD con `propagates_to` | valore alterato lungo la catena | HND/INT: il dato immesso a monte arriva integro a valle (uno per catena) |
| FLD con ragione solo `ui` | obbligatorietà senza catena | BSL + domanda all'utente: è voluta? |

Questa tabella è codice: lo scheletro dei casi lo produce `scripts/compile/negative-generator.mjs` dagli item della
cella, con `derivation`, `boundary` dall'HND, proprietario del test ed `epistemic_at_generation`. Tu completi,
compili ed esegui; non aggiungi risk mode che nessun attributo giustifica.

## Chi possiede il test

Il proprietario della chiave testa gli invarianti intrinseci; chi possiede l'interfaccia testa la trasformazione;
il consumatore testa solo che arrivi, fermandosi al confine. Una catena di campi appartiene allo scope del documento
di origine (skill `integration-testing`).

## Generare per scope (§27.3)

Sei strategie di generazione: delta di release · vicini (casi simili a quelli toccati) · identità (KEY) · ciclo di
vita (LCY) · contratto di integrazione (INT) · handoff (`asserts` e `does_not_pass`). La priorità **dentro lo scope**
combina criticità, copertura mancante, volatilità, densità di difetti in collaudo e i fattori integrazione, identità
e handoff (DT-012 la applica nella selezione della suite). **Nulla dal dominio analitico**: un test non nasce da un
ticket o da un pattern (skill `domain-boundary`).

## Il test nasce con la sua forma epistemica

| Forma del soggetto alla generazione | Destino del caso |
|-------------------------------------|------------------|
| `consolidato` con precedente di suite verde | salta lo shadow dopo una sola esecuzione coerente |
| `libresco` | in **shadow**, con un'osservazione preliminare |
| `ignoto` | **non si genera il test**: si genera un'esplorazione (`STR-EXPLORE-BUDGET`) |
| `contraddittorio` | prima si risolve la contraddizione |

## Il caso a richiesta (§29.2)

Richiesta dell'utente → risoluzione dei concetti (`kb resolve`) → FLW più handoff più fixture → caso con
`derivation` (da quale item e attributo) e `boundary` (dove si ferma) → se manca una fixture, DT-002 (chiedere o
assumere) → compilazione, shadow, promozione. **Stessa pipeline dei test dal delta: nessuna scorciatoia**, il caso
non entra mai direttamente come promosso.

## Scrivere, verificare, compilare

Un caso (`schemas/nrt-case.schema.json`) ha almeno: id, tipo, titolo, scope, genere, stato, `composition` (FLW,
passi), `derivation`, `boundary`, `epistemic_at_generation`; e, quando servono, fixture, compensazioni, errori
attesi, evidenze, baseline. Prima di consegnarlo:

    node "${CLAUDE_PLUGIN_ROOT}/scripts/compile/lint-scope.mjs" customers/<C>/tests/proposals/<S>/<task>/<caso> --customer <C> --json
    node "${CLAUDE_PLUGIN_ROOT}/scripts/compile/compile-case.mjs" --case <file del caso> --customer <C> --env <ambiente> --run <RUN> --json

Il lint del caso (`lint-spec`) controlla expect su ogni passo, nessun DELETE, compensazione per i passi che creano,
derivation e boundary, nessun codice analitico; `lint-scope` che il caso usi solo SEL e FLW del suo scope o fixture
dichiarate da un handoff. La compilazione produce il piano con la traccia attesa per passo (§10.5).

**Un errore atteso e ricevuto è un successo pieno** (`EXPECTED-ERROR-AS-SUCCESS`, §29.9): un NEG passa quando la
piattaforma rifiuta come previsto. Dichiara l'errore atteso nel caso (`expected_errors`), con il riferimento ERR se
esiste.

## Riparare senza indebolire

Un caso fragile si ripara per **intento semantico** (skill `selector-strategy`), mai indebolendo un'asserzione:
uguaglianza trasformata in contenimento, asserzione rimossa, tolleranza allargata, confine anticipato sono tutte
violazioni che il linter anti-indebolimento rileva confrontando con la versione precedente (`lint-spec --against`).

## Errori tipici

- Un NEG che asserisce il messaggio esatto quando la regola dice solo "bloccato": fragile senza motivo.
- Generare su un soggetto `ignoto`.
- Un caso che crea entità di un altro scope invece di consumarle come fixture.
- Un test dedotto da un pattern di ticket (dominio analitico).
