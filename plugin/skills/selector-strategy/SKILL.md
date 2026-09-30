---
name: selector-strategy
description: Metodo per localizzare gli elementi della pagina con il Selector Atlas (item SEL) — la catena di strategie in ordine DT-008 (testid → role → label → text → css), le classi di stabilità, il contesto di frame, l'effetto read/write — e per riparare un selettore rotto per intento semantico verificato, con i priori per strategia e senza indebolire il test. Usala quando risolvi il target di un passo del piano, quando un passo fallisce perché l'elemento non si trova, quando prepari una riparazione con /nrt heal, quando una strategia di localizzazione riesce solo al secondo gradino, quando generi page object per la corsia compilata.
---

# selector-strategy — trovare l'elemento giusto e ripararlo senza barare (§27.1)

Un piano dice *cosa* fare su *quale concetto* ("il pulsante di salvataggio del profilo"), non *dove* cliccare. Il
concetto vive nell'Atlas come item SEL con una catena di strategie di localizzazione; il passo risolve il target
dall'Atlas, mai da un selettore scritto a mano nel piano.

## La voce dell'Atlas (`schemas/sel.schema.json`)

| Campo | Significato | Regola |
|-------|-------------|--------|
| `concept` | cosa rappresenta l'elemento | è l'intento: la riparazione deve preservarlo |
| `strategies[]` | catena di `{ kind, value, name? }` con `kind` fra testid · role · label · text · css | almeno due, almeno una **semantica** (role · label · text) |
| `stability` | stable · medium · fragile | css ammesso nella catena, usato per generare codice solo se `fragile` |
| `effect` | read · write | lo leggono i guard (una scrittura in produzione è negata) |
| `role` | ruolo ARIA dell'elemento | idem |
| `frame_context` | frame o shadow host | un elemento in un frame si cerca nel frame |
| `healing_history` | le riparazioni passate | è il precedente della prossima riparazione |

Risolvere un target:

    node "${CLAUDE_PLUGIN_ROOT}/scripts/kb/kb.mjs" get <SEL> --db customers/<C>/knowledge.db --json

## L'ordine della catena e DT-008

L'ordine è **testid → role → label → text → css**: dal più stabile al più fragile. Si usa la prima strategia
disponibile sull'elemento; DT-008 stima il rischio che quella strategia fallisca (stabilità dell'Atlas, pattern
dinamico dell'interfaccia come le validazioni asincrone in griglia, prior di insuccesso della strategia su quel
pattern) e, oltre la soglia, scende al gradino successivo. I valori di stabilità del dominio della tabella li leggi
nel file `decision-tables/DT-008.yaml` (skill `decision-tables`), non li deduci.

Sul browser si legge con gli strumenti di snapshot e di lettura della pagina: **gli script nella pagina sono negati
ovunque** (niente valutazione di JavaScript per trovare un elemento).

## Imparare dalla localizzazione (§20.4)

Un selettore risolto con la strategia 2 invece della 1 è un'informazione: aggiorna la `stability` nell'Atlas e il
prior di DT-008. Non lo aggiorni tu nel kb: lo registra l'osservazione (hook) e lo porta la digestione; una nuova
versione di SEL la proponi come bozza in `_inbox/<S>/digested/`.

## Riparare un selettore rotto: il metodo (§30.4)

1. **Situa**: caso, passo, SEL che non risolve più, intento del passo (dalla FLW), stabilità dichiarata.
2. **Richiama**: la voce SEL con le alternative, lo snapshot della pagina al passo fallito, le riparazioni passate
   dello stesso selettore (skill `precedents`).
3. **Valuta**: l'elemento c'è con un altro nome o posizione (fragilità: riparabile) oppure **è sparito o fa
   un'altra cosa** (cambio di prodotto o di configurazione: non è un difetto del test, torna al triage)? Se lo
   snapshot contraddice l'intento, è una CTR, non una riparazione.
4. **Decidi**: la strategia con DT-008 e i priori; preferisci salire di stabilità (un testid o un ruolo con nome
   accessibile) piuttosto che rattoppare con un css.
5. **Agisci**: scrivi la proposta (nuova catena, diff prima/dopo) e passa i linter — l'anti-indebolimento confronta
   con la versione precedente e il confine dello scope:

       node "${CLAUDE_PLUGIN_ROOT}/scripts/compile/lint-spec.mjs" customers/<C>/tests/proposals/<S>/<task>/<caso> --against customers/<C>/tests/cases/<S>/<caso> --json

6. **Verifica**: la riparazione vale solo se il passo, **rieseguito**, raggiunge l'intento (stesso concetto, stesso
   effetto). Chi non ha il browser la chiede al manager come verifica in shadow; il caso resta candidato finché non è
   verde.

La proposta diventa una PR per la **review umana**: nessun merge automatico, mai.

## Cosa non è una riparazione

- Rimuovere o indebolire un'asserzione per far tornare il verde (il linter lo nega: la proposta non esiste).
- Spostare il confine del test prima del punto che fallisce.
- Puntare un elemento diverso che "fa passare" il passo: l'intento è cambiato.
- Scrivere un selettore nel piano o nel caso invece di aggiornare l'Atlas.

## Corsia compilata (opzionale)

Per gli scope maturi, i page object si generano dall'Atlas (`scripts/compile/generate-atlas-po.mjs`) e gli spec
Playwright solo da piani verdi almeno tre volte: stessa catena di strategie, stesso Atlas. È un acceleratore per la
CI, mai il modo di esecuzione di default.
