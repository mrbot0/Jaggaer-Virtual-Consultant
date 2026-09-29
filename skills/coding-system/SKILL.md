---
name: coding-system
description: Metodo per leggere, citare e produrre codici del sistema — item di conoscenza <LIVELLO>.<CLIENTE>.<SCOPE>.<TIPO>.<SEQ>[.v<VER>], registro dei tipi, test NRT, run e sessioni, procedure CFP a verbi e check CHK — con le regole di codifica (il codice non cambia, SEQ dal DB, codice = nome del file, versione per un cambio incompatibile). Usala quando crei o proponi un item (PMP, PRF, FLD, CFG, SEL, CHK, lezione), quando scrivi una procedura o un check codificati, quando citi un riferimento nel rapporto o nella lezione, quando un codice non valida o collide.
---

# coding-system — codici, tipi, procedure e check (§5)

Tutto si recupera e si compone per codice: un test è una lista di codici, una procedura è una lista di passi
codificati, un rapporto cita codici e non prosa. Il codice dice anche **quanto fidarsi** (livello) e **quanto è
portabile** (cliente).

## Il formato (§5.2)

```
<LIVELLO>.<CLIENTE>.<SCOPE>.<TIPO>.<SEQ>[.v<VER>]

LIVELLO  S (prodotto standard) · C (documentazione del cliente) · L (appreso: osservazione, esecuzione, utente)
CLIENTE  STD per il livello S; altrimenti il codice di 4 caratteri del cliente attivo
SCOPE    CAT · SRC · VEN · CON · P2P · INV · QLT · ANL · ADM · XSC
TIPO     tre lettere dal registro (schemas/registry.json)
SEQ      4 cifre, assegnate dal DB — mai inventate
VER      facoltativa: un cambio incompatibile è una nuova versione, non un nuovo codice
```

Altri formati: test `NRT.<CLIENTE>.<SCOPE>.<GENERE>.<SEQ>` con genere `POS NEG INT HND BSL CFG SMK OPS`; run
`RUN.<CLIENTE>.<AAAAMMGG>.<HHMM>.<SCOPE>`; sessione `SES.<CLIENTE>.<AAAAMMGG>.<SEQ>`.

## Il registro dei tipi (§5.3)

Ogni tipo è ammesso solo a certi livelli (`schemas/registry.json`): per esempio `PRF` solo C, `STR`/`DT`/`ACT` solo
S, `OBS`/`LSN`/`DEC`/`RPT` solo L. Un codice con un tipo a un livello non ammesso non è valido. I tipi si dividono per
dominio:

- **dominio operativo** (`kb/`): CAP FLW KEY LCY FLD DOC UNT DIN USR PSP ERR ACT RPT ENV INT CFG CFP SEL HND INV GLS
  PMP PRF TBL QRY CHK STR OBS CTR EVD LSN CLS DT DEC EPI;
- **dominio analitico** (`analysis/`): PAT PBK BRF RUL — mai citati da `kb/` (skill `domain-boundary`).

Prima di proporre un tipo chiediti cosa il soggetto *è* (DT-020 lo decide per gli item digeriti, skill
`doc-ingestion`): una procedura a passi è FLW (uso) o CFP (configurazione), un vincolo d'identità è KEY, stati e
transizioni sono LCY, un campo è FLD, un'interfaccia è INT.

## Le regole di codifica (§5.4)

| Regola | Cosa significa per te |
|--------|----------------------|
| il codice non cambia mai; cambia la versione | non "rinomini" un item: ne fai una versione `.v<n>` |
| un item deprecato conserva il codice con `superseded_by` | non si cancella nulla |
| `SEQ` assegnato dal DB | per un item nuovo proponi il file in `_inbox` senza inventare il SEQ, o usa il codice che ti dà lo script o l'header (es. `inputs.lesson_code`) |
| il codice è il nome del file | `<codice>.yaml` (o `.md` per la lezione): nessuna mappa da mantenere |
| un L promosso a S riceve un nuovo codice S con `promoted_from` | la promozione è umana e la fa lo script |
| nel testo un riferimento è il codice fra backtick | il validatore ne verifica l'esistenza (self-check controllo 1) |
| `kb/` non cita PAT PBK BRF RUL; `analysis/` non cita NRT | il confine dei domini |

Per validare un item prima di consegnarlo:

    node "${CLAUDE_PLUGIN_ROOT}/scripts/kb/validate-schema.mjs" customers/<C>/_inbox/<S>/digested/<codice>.yaml --json

## Codificare una procedura (CFP) (§5.5)

Una procedura di configurazione è una lista di passi con **verbi del vocabolario chiuso**:
`NAVIGATE · CLICK · FILL · CHOOSE · TOGGLE · UPLOAD · SAVE · SUBMIT · WAIT · VERIFY · READ · CAPTURE · ASK`.
Il verbo `DELETE` non esiste: si compensa con `close`/`cancel`/disattivazione. Ogni passo ha un `target` (codice
SEL dell'Atlas) e, nel piano eseguibile, un `expect`. La procedura dichiara: `governs` (i CFG che tocca), `risk`,
`preconditions` (CHK), `verification_test` (il verificatore NRT...CFG), `rollback` (una procedura di
disattivazione, mai un'eliminazione), `snapshot_before`, `evidence`, `sources` (con il genere della fonte).

**La versione cliente dichiara il delta, non una copia**: `derives_from` la CFP standard e `deviations[]` (passo
cambiato, inserito dopo il passo n, con la fonte di ciascuna deviazione), più `confirmed_by_observation`.

## Codificare un check (CHK) (§5.6)

Un check è un controllo ripetibile eseguito da script: `kind` (precondition · postcondition · health ·
data-quality · permission), `how` (un verbo READ o VERIFY su un target con l'atteso), `cost`, `deterministic`,
`frequency`, `cluster` (di norma una famiglia CL-CHK). Un buon CHK nasce da una lezione ("quale controllo, eseguito
prima, avrebbe reso il compito banale?") e cita l'**invariante** violata, non il fallimento che l'ha rivelata.

## Citare nel rapporto

- Solo codici esistenti, fra backtick nel testo, come liste nel YAML (`output`, `recalled`, `decisions`).
- Un item proposto e non ancora validato si cita con il percorso del file in `_inbox`, non con un codice inventato.
- Summary ≤ 60 parole per item, ≤ 20 per un FLD (§8.3).

## Errori tipici

- Inventare un SEQ, o riusarne uno di un'altra entità: la collisione la rifiuta il DB.
- Cambiare il significato di un codice esistente invece di versionarlo.
- Un verbo fuori vocabolario nel piano: la validazione lo rifiuta prima dell'esecuzione.
- Una deviazione C che copia l'intera procedura S invece di dichiarare il delta.
