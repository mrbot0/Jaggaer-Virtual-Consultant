---
name: epistemic-awareness
description: Metodo per leggere la copertura epistemica di un soggetto (vettore K, forma consolidato · libresco · empirico · ignoto · contraddittorio, gaps) e scegliere quale fonte del giudizio pesa di più adesso. Usala al passo VALUTARE di ogni compito, quando devi decidere se agire, osservare prima, chiedere o risolvere una contraddizione, quando progetti (tecnica > storico > scoperto) o esegui (scoperto > storico > d'uso), quando fonti di genere diverso non concordano, quando l'utente e l'osservazione dicono cose diverse o quando vorresti usare ciò che vale per un altro cliente.
---

# epistemic-awareness — quanto so, di cosa, da dove (§9, §11)

La prima domanda di ogni compito non è "cosa faccio" ma "quanto conosco questo soggetto, e da quale genere di
fonte". La risposta è calcolata da script, non stimata da te: tu la leggi e ne tieni conto.

    node "${CLAUDE_PLUGIN_ROOT}/scripts/kb/kb.mjs" epistemic <codice> --db customers/<C>/knowledge.db --json

## Leggere l'uscita, in quest'ordine

1. **Forma** — una parola che riassume il vettore; è ciò che guida la strategia.
2. **`gaps`** — gli attributi attesi del tipo che nessuna fonte copre: è ciò che sai di non sapere. Le domande
   (skill `asking-the-user`) e le osservazioni R0 nascono da qui, non dall'incertezza generica.
3. **Vettore K** — `k_tech` (spec e configurazione), `k_use` (manuali, guide), `k_obs` (osservato su Chrome),
   `k_exec` (esercitato con esito), `k_user` (dichiarato dall'utente). Serve a capire *quale* genere manca.
4. **`k_level_for`** — la sintesi pesata per tipo di decisione: per progettare pesa K_tech, per eseguire K_obs e
   K_exec (§6.4). Due compiti diversi sullo stesso soggetto possono avere livelli diversi.

Gli attributi attesi per tipo stanno in `schemas/expected-attributes.yaml`: è ciò che rende K calcolabile.

## Le cinque forme e il comportamento che inducono (§9.3)

Valutazione nell'ordine: contraddittorio → ignoto → consolidato → libresco → empirico; vince la prima che vale.

| Forma | Significa | Cosa fai |
|-------|-----------|----------|
| `consolidato` | so com'è fatto, come si usa, l'ho visto e fatto | agisci; il precedente è un fast path; tier economico |
| `libresco` | so cosa dovrebbe fare, non l'ho mai visto qui | **osserva prima**: un'osservazione R0 mirata ai gaps prima di qualunque passo R ≥ R1 |
| `empirico` | so come si comporta qui, non perché né se è voluto | agisci qui con cautela (R ≤ R1); **non generalizzare**; chiedi se è voluto; cerca la fonte tecnica |
| `ignoto` | nulla di affidabile | esplora a budget (R0) o chiedi; mai R ≥ R2 |
| `contraddittorio` | le fonti non concordano | **risolvi prima** (DT-011); se irrisolvibile chiedi; mai R ≥ R2 finché aperta |

La forma letta all'inizio va in `cognitive_trace.epistemic.shape_before`, quella a fine compito in `shape_after`
(controllo 7). Una forma può cambiare durante il compito: un `libresco` confermato da osservazione diventa
`consolidato` in sessione (§13.4).

## Le quattro fonti del giudizio (§11.1)

| Fonte | Risponde a | Genere |
|-------|-----------|--------|
| lo **storico** | cosa è successo le altre volte (DEC con esito, run, lezioni) | empirica (esiti) |
| il **noto** | cosa dicono le fonti (item S/C/L) | tecnica, d'uso, testimoniale |
| lo **scoperto** | cosa vedo adesso (OBS di sessione, risposte) | empirica (osservazione) |
| il **grado di conoscenza** | quanto e da dove conosco il soggetto | meta: è la misura delle altre tre |

## Precedenza dinamica: progettare contro eseguire (§11.2)

| Forma | Progettare (cosa fare) | Eseguire (come farlo qui) |
|-------|------------------------|---------------------------|
| `consolidato` | tecnica → storico → scoperto | scoperto → storico → d'uso |
| `libresco` | tecnica → d'uso; lo scoperto va prodotto prima di eseguire | scoperto (da produrre) → d'uso |
| `empirico` | scoperto → storico; la tecnica va cercata o chiesta prima di generalizzare | scoperto → storico |
| `ignoto` | nessuna precedenza: esplora (R0) o chiedi | non si esegue |
| `contraddittorio` | risolvi con DT-011 | non si esegue |

In breve: **progettare** privilegia ciò che il sistema *è* (tecnica > storico > scoperto); **eseguire** privilegia
ciò che il sistema *mostra adesso* (scoperto > storico > d'uso). Chi progetta leggendo il manuale utente sbaglia le
dipendenze; chi esegue fidandosi della specifica clicca nel posto sbagliato.

## Specifiche contro manuali: confrontale, non sommarle (§11.3)

- La fonte **tecnica** dice com'è fatto (oggetti, parametri, dipendenze, mapping); non dice come appare.
- La fonte **d'uso** dice come si usa (schermate, sequenze, messaggi); non dice perché né cosa succede a valle.
- Una divergenza fra le due è un indizio di personalizzazione o di documento vecchio: registrala (CTR) e mettila
  fra le prime osservazioni da fare. Di norma sulla UI vince il manuale, sul modello la specifica.

## Triangolazione obbligatoria (§11.4)

Un'azione R ≥ R2 richiede **due fonti di genere diverso concordi** sul soggetto (confidenza ≥ 0.70, nessuna CTR
aperta fra loro), altrimenti diventa una domanda. Una sola fonte tecnica → `libresco` → osserva prima; una sola
osservazione → `empirico` → chiedi se è voluto prima di generalizzare (eseguire qui a R1 è ammesso).

## Utente e osservazione in disaccordo (§11.5)

1. Non scegliere: registra una CTR fra la dichiarazione (testimoniale) e l'osservazione (empirica).
2. Mostra l'evidenza, non contraddire: la domanda la porta all'utente il manager, con il codice dell'osservazione.
3. Le tre risposte: "è cambiato" → vince l'osservazione; "guardi il soggetto sbagliato" → correggi il riferimento
   e riosserva; "non lo so" → quarantena, azioni R ≥ R2 bloccate.
4. Mai agire sul soggetto finché la CTR è aperta.

## Usare ciò che vale per un altro cliente: il controllo di analogia (§11.6)

Un'esperienza di un altro cliente entra nel prior (con confidenza × 0.8) solo se le faccette condizionanti del
cluster (CL-PRT) hanno lo stesso valore sui due clienti, non c'è CTR aperta fra loro e il soggetto altrove è almeno
validato con esito confermato. Altrimenti **orienta** la strategia (DT-018) ma non entra nel punteggio. Non leggi
tu l'altro cliente: te lo porta `kb precedents` già pesato per portabilità (skill `customer-isolation`).

## Errori tipici

- Trattare `libresco` come `consolidato` perché il documento è autorevole (bias di autorità della fonte, §17.3).
- Generalizzare un comportamento `empirico` a tutti i clienti: la portabilità resta `ignota` finché non è misurata.
- Formulare domande dall'incertezza invece che dai `gaps`.
