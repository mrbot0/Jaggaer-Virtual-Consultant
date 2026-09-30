---
name: doc-ingestion
description: Metodo della pipeline di ingestion dei documenti — ordine obbligato (profilo, mappa, estrazione, digestione, validazione, copertura, promozione), profilo DOC con affidabilità calcolata, parsing per formato, segmentazione in unità di significato, estrazione come elicitazione strutturata (regole deontiche), digestione guidata dagli attributi attesi con la banca di domande, risoluzione di alias e versioni, DT-020/021/022, back-check, residuo e report di ingestion, ingestion incrementale, il tenant come documento, priorità DT-025, revisione umana. Usala quando esegui /kb ingest, completi grezzi needs_llm, digerisci _inbox di uno scope, profili un documento o un cliente dall'inventario documentale, diffi due versioni di un documento o prepari la coda di revisione.
---

# doc-ingestion — dalla fonte all'item, senza perdere la provenienza (§19.1–19.5, §19.7–19.19)

La pipeline trasforma documenti (e schermate) in item codificati, con la citazione di ogni affermazione e con ciò
che il documento **non** dice (gaps) come sottoprodotto. Il modello dei campi (§19.6) e la carta d'identità (§19.20)
hanno skill proprie (`field-modeling`, `identity-and-keys`).

## L'ordine obbligato (§19.1)

```
1 PROFILAZIONE  profilo del cliente (PRF)          chi salta 1 e 2 estrae il prodotto, non il cliente
2 MAPPA         mappa dei processi (PMP)
3 ESTRAZIONE    extractor → grezzi in _inbox/<S>/
4 DIGESTIONE    digester → codice, faccette, summary, relazioni, cluster proposto, attributi coperti
5 VALIDAZIONE   cluster-validator → validati e clusterizzati
6 COPERTURA     reindex → profilo epistemico di ogni soggetto        chi salta 6 non sa quanto sa
7 PROMOZIONE    umano → in uso
```

Chi estrae **non interpreta né classifica** ("cosa dice questa fonte?"); chi digerisce **non legge le fonti
intere** ("cosa significa per questo cliente e come lo codifico?"). Nessuno dei due scrive in `kb/` (§29.6).

## 1. Profilare il documento prima di leggerlo (§19.7)

Nessun documento entra senza profilo DOC: kind, genere (F15), origine, versione, data, release coperta, lingue,
scope, struttura, unità per tipo e **affidabilità calcolata** (base per kind × freschezza × autorialità × coerenza
interna × corroborazione, `schemas/doc-reliability.yaml`). Il `reliability.score` diventa il peso di base delle sue
affermazioni; i `known_issues` abbassano localmente le sezioni segnalate. Un documento vecchio non si scarta: entra
con peso ridotto e chiederà conferma per osservazione. Il profilo lo fa lo script (`scripts/ingest/profile-doc.mjs`,
dentro `scripts/ingest/ingest.mjs`).

## 2. Parsing per formato (§19.8)

Ogni formato ha una strategia e modi di fallimento noti — dichiarali nel profilo invece di ignorarli: tabelle a
colonne spezzate nei PDF, cifre confuse dall'OCR, **revisioni e commenti** nei DOCX (spesso la vera storia di una
personalizzazione), fogli nascosti e liste di validazione negli XLSX (vocabolari chiusi), `minOccurs`/`required`
negli schemi formali (obbligatorietà **tecnica**, peso alto), export di configurazione (stato reale alla data
dell'export: invecchia in fretta), etichette e asterischi negli screenshot, conoscenza tacita nelle registrazioni,
decisioni con data e autore nelle e-mail, release notes per voce (new · changed · fixed · deprecated).

## 3. Segmentare in unità di significato (§19.9)

L'unità (UNT) è la citazione minima: ciò che un item indica come fonte e ciò che il back-check rilegge. Non è un
blocco di N token: è un pezzo che **ha senso da solo** (procedura, passo, riga di tabella di campi, tabella, nota,
regola, definizione, figura, esempio, riferimento, tracciato, decisione). Ogni unità porta un'intestazione di
contesto (documento, capitolo, sezione, pagina, tipo, lingua, unità precedente e successiva); ≤ 300 parole; codice
stabile fra versioni se l'hash non cambia.

## 4. Estrarre interrogando, non riassumendo (§19.10)

L'extractor interroga ogni unità con uno **schema fisso per tipo** (`schemas/unit-extraction/`): per una procedura
attore, trigger, precondizioni, passi (verbo, oggetto, valore), risultato atteso, eccezioni; per una riga di campi
label, nome tecnico, tipo, testo di obbligatorietà **così com'è**, valori ammessi; per una regola `subject`,
`modality`, `condition`, `scope_qualifiers`, `consequence`, `source_unit`.

La modalità di una regola (obbligo, obbligo condizionale, divieto, facoltà, raccomandazione, comportamento del
sistema, immutabilità, vincolo esterno, eccezione) si riconosce dai segnali lessicali — la tabella completa è in
[references/deontic-signals.md](references/deontic-signals.md). T0 per i casi chiari, T1 per le condizioni
annidate, e **una regola con modalità non determinata non produce mai un `mandatory.kind`**: va in residuo
`ambiguous`. Il testo non fidato non passa sulla riga di comando: si scrive in un file di lavoro.

    node "${CLAUDE_PLUGIN_ROOT}/scripts/ingest/deontic.mjs" --text-file customers/<C>/.sessions/<sid>/work/<task>/frase.txt --lang it --json

## 5. Digerire guidati dagli attributi attesi (§19.11)

Il digester non legge il documento: per ogni soggetto candidato pone **una domanda per attributo atteso** del tipo
(banca di domande in `product/question-banks/`), recupera al più 5 unità per domanda, risponde con citazione e
genere; unità in disaccordo → CTR; nessuna risposta → **gap**. Scala con i soggetti, non con le pagine; i gap sono
gratuiti; le contraddizioni emergono dove contano.

    node "${CLAUDE_PLUGIN_ROOT}/scripts/kb/digest-plan.mjs" plan --db customers/<C>/knowledge.db --type <TIPO> --subject <codice> --doc <DOC> --top 5 --out customers/<C>/.sessions/<sid>/work/<task>/plan-<codice>.yaml --json
    node "${CLAUDE_PLUGIN_ROOT}/scripts/kb/digest-plan.mjs" record-answers --db customers/<C>/knowledge.db --answers-file customers/<C>/.sessions/<sid>/work/<task>/answers-<codice>.yaml --json

Le sei passate del digester — procedurale (FLW CAP INV EVD), vincolare (KEY LCY), integrativa (INT),
configurativa (CFG CFP), comparativa (C con `deviates_from`, CTR), ripetitiva (CHK) — più la **passata
epistemica**: quali attributi sono coperti e da quale genere (l'input del vettore K).

## 6. Risolvere entità, alias, versioni, lingue (§19.12)

Il nome tecnico è la chiave forte; poi il registro degli alias del cliente; un candidato con label molto simile
nella stessa sezione diventa `merge-candidate`, **mai fuso d'ufficio**; coppie di lingue allineate per posizione e
nome tecnico; un item S e uno C sullo stesso soggetto si legano con `deviates_from` (se il C non differisce, è una
conferma dell'S). I casi incerti vanno al validatore.

## 7. Le tre decisioni del digester (§19.13)

| Tabella | Domanda | Regola di metodo |
|---------|---------|------------------|
| DT-020 | che tipo è? | segnali pesati (posizione, forma dell'unità, lessico, nome tecnico, riferimenti esterni); sotto la soglia l'item è `ambiguo` con i due tipi candidati |
| DT-021 | standard o del cliente? | origine del documento, lessico deittico ("nel nostro…", nomi), confronto con l'item S, export del cliente; in mezzo alla banda → ambiguo, si chiede ("regola vostra o del prodotto?") — un C classificato S contamina il prodotto |
| DT-022 | completo abbastanza? | attributi coperti pesati per criticità; sotto soglia `digerito` con gaps (non usabile per R ≥ R2); manca un attributo critico → `quarantena` con la lista, che è già la domanda o l'osservazione da fare |

## 8. Back-check e provenienza (§19.14)

Ogni item digerito passa il back-check prima del validatore: per ogni affermazione, **il testo citato la dice?**
(supportata · parziale · non supportata · derived). Una non supportata blocca l'item: se è un'inferenza corretta, va
marcata `derived` con la regola che l'ha prodotta — "il documento dice" e "il sistema deduce" hanno pesi diversi.

    node "${CLAUDE_PLUGIN_ROOT}/scripts/kb/backcheck.mjs" --item customers/<C>/_inbox/<S>/digested/<codice>.yaml --db customers/<C>/knowledge.db --json

## 9. Residuo, report, versioni, tenant, priorità, revisione

- **Residuo** classificato (irrelevant · duplicate · ambiguous · unsupported · deferred · tacit) e **report di
  ingestion** per documento: unità → item per tipo, back-check, esiti di DT-021, copertura prodotta, gap più
  frequenti ("il documento non parla di conseguenze" è una diagnosi sul documento), contraddizioni, costo, cosa resta
  da fare. Dettagli in [references/deontic-signals.md](references/deontic-signals.md).
- **Versione nuova** (§19.16): diff per hash; le unità invariate non costano nulla; le modificate riportano gli item a
  `digerito` e al back-check (valore cambiato → item versionato + CTR "cambio documentale"); le sparite marcano
  `source-removed` (da osservare, non deprecare); le release notes sono un indizio.
- **Il tenant è un documento** (§19.17): pagine, sezioni, campi con attributi, messaggi di validazione, schermate di
  setup, export: stessa pipeline, fonte a peso più alto.
- **Priorità** (§19.18, DT-025): il backlog si ordina per guadagno epistemico atteso (peso dei soggetti × gap sul
  genere del documento × affidabilità / costo): una specifica breve su un'interfaccia critica batte un manuale lungo
  su funzioni già consolidate.
- **Revisione umana** (§19.19): si spende dove cambia le cose — quarantene su attributi critici, ambigui di DT-021,
  soggetti R3, CTR dello stesso cliente, regole deontiche ambigue a lotti di 10, campione del 5% del resto. Tre verbi:
  accetta, correggi, rifiuta (con la regola); coda e verbi con `scripts/kb/review.mjs`.

## Budget

80k token per documento e 3k per unità (§29.10): la digestione si ferma al lotto corrente e riprende dal cursore.
Non si alzano.

## Errori tipici

- Riassumere un'unità invece di interrogarla con lo schema del suo tipo.
- Citare come "dice il documento" un'affermazione dedotta.
- Fondere due candidati simili senza nome tecnico comune.
- Estrarre prima di profilo e mappa: si ottiene il prodotto, non il cliente.
