# F1' — Report di fase, parte strumenti (WP09a: pipeline di ingestion)

Stato: **strumenti pronti** per l'ingestion della KB JAGGAER. Tutto ciò che la spec descrive per la parte
deterministica di F1' (§19.1 passi 3-6, §19.7-§19.19, §34.2) esiste, è provato e gira sul corpus reale. Restano fuori,
per costruzione, le parti che richiedono gli agenti (scope-extractor T1, digester T2, customer-profiler, process-mapper:
WP10b) e la revisione umana; i loro ingressi e le loro uscite sono qui (piani, banche di domande, code, schemi).

Suite completa alla consegna: **707 test, 707 pass, 0 fail, 0 skipped** (`npm test`, Windows 11, Node 24.15, 130 s, con il
corpus presente); prima di WP09a erano 652 e restano tutti verdi, i 55 nuovi sono nei file della tabella sotto. Il test di
accettazione sul corpus reale (`test/ingest/corpus-acceptance.test.mjs`) gira in ~62 s ed è **saltato** quando la
cartella `JAGGAER DOC` non c'è (CI senza documenti) o con `JVC_SKIP_CORPUS=1`.

## Cosa c'è

| Deliverable | Script / file | Prova |
|-------------|---------------|-------|
| A Parser → documento normalizzato | `scripts/ingest/parse-{docx,xlsx,pptx,pdf,xls,xsd,spec,config-export,screenshots,transcript,email,text}.mjs`, `lib/{zip,xml,parsed,office,cli,paths}.mjs`, `harvest.mjs` | `test/ingest/parsers.test.mjs` (golden per formato su campioni sintetici in `test/fixtures/docs/`, rigenerabili con `build-fixtures.mjs`), `test/ingest/zip-limits.test.mjs` |
| B Unità (§19.9) | `segmentUnits` in `scripts/ingest/segment.mjs`, `schemas/unit.schema.json` | `test/ingest/units.test.mjs` |
| C Profilo DOC (§19.7) | `scripts/ingest/profile-doc.mjs`, `schemas/doc.schema.json`, `schemas/doc-reliability.yaml`, aggancio in `reindex` | `test/ingest/profile-doc.test.mjs` |
| D Schemi di estrazione (§19.10) | `schemas/unit-extraction/*.schema.json` (7), `scripts/ingest/extract.mjs` | `test/ingest/extract.test.mjs` (golden procedura → attore/passi/atteso) |
| E Digestione guidata (§19.11-19.19) | `schemas/expected-attributes.yaml` (registro §64 completo), `product/question-banks/*.yaml` (21 tipi + `profile.yaml` §63), `scripts/kb/{units,digest-plan,backcheck,review,ingest-backlog}.mjs`, `scripts/ingest/{aliases,doc-diff,residue,ingestion-report}.mjs`, `templates/ingestion-report.md`, migrazione `0007-units.sql` | `test/kb/digestion.test.mjs` |
| F Tenant come documento (§19.17) | `scripts/chrome/survey.mjs` | `test/chrome/survey.test.mjs` (tenant demo) |
| G Profilo e mappa | `schemas/{prf,pmp}.schema.json`, `scripts/kb/coverage-report.mjs` | `test/kb/profile-map.test.mjs` (esempi della spec come fixture) |
| Pipeline | `scripts/ingest/ingest.mjs` | `test/ingest/pipeline.test.mjs`, `test/ingest/corpus-acceptance.test.mjs` |

Comandi `kb` nuovi: `kb units` (`--doc --near --query | --query-file | --question TIPO.attributo --type --top`),
`kb review` (queue · accept · correct · reject · stats), `kb epistemic --scope <S> [--plan]`.

## §34.2 → script

| Runbook §34.2 | Script (oggi) | Note |
|---------------|---------------|------|
| `/use-customer BETA --new` | — (WP10a) | il workspace nasce da `ingest.mjs` se assente (`lib/paths.mjs`) |
| `/kb ingest data/BETA/progetto/` | `node scripts/ingest/ingest.mjs --input <dir> --root <ws> --customer BETA` | harvest → DOC → unità → estrazione T0 → residuo → report; il `documentation_inventory` del PRF si compone dai profili DOC (`_inbox/<scope>/profiles/`) |
| `/kb ingest data/BETA/manuali/ --scope P2P` | idem con `--scope P2P` | |
| `/kb ingest data/BETA/spec/ --scope P2P --genre tecnica` | idem con `--genre tecnica` | il genere forzato vale per tutti i documenti della cartella |
| `/kb digest --scope P2P` | `scripts/kb/digest-plan.mjs plan` (domande × 5 unità) → agente digester (WP10b) → `digest-plan.mjs record-answers` → `backcheck.mjs` (gate, exit 3) | i piani per lo scope-extractor sono in `_inbox/<scope>/raw/<DOCID>.yaml` (`llm_plan`, sessioni ≤ 80k) |
| `/kb digest --scope P2P --fields document.requisition` | `scripts/kb/digest-fields.mjs plan` (K4), lanciato dalla pipeline per ogni documento con tabelle di campi | lotti ≤ 50 righe, cursore oltre 80k |
| `/kb review --scope P2P` | `node scripts/kb/kb.mjs review queue|accept|correct|reject|stats --root <ws> --customer <C>` | verbi in `customers/<C>/reviews/<AAAA-MM>.jsonl` |
| `/kb reindex --scope P2P` | `node scripts/kb/reindex.mjs --root <ws>/customers/<C> --db …` | indicizza anche `sources/units/**` e i DOC (peso di base = `reliability.score`) |
| `/kb epistemic --scope P2P --plan` | `node scripts/kb/kb.mjs epistemic --scope P2P --plan --db …` | report §9.6 con la riga "identità dei dati" e il piano R0 |
| (backlog §19.18) | `node scripts/kb/ingest-backlog.mjs --db …` | ordine DT-025, guadagno realizzato vs atteso per tipo |
| (versioni §19.16) | automatico in `ingest.mjs` (stessa chiave, contenuto nuovo ⇒ `.vN` + `_inbox/<scope>/doc-diff/`); a mano `doc-diff.mjs` | codici delle unità conservati a hash invariato |
| (tenant §19.17) | `node scripts/chrome/survey.mjs --snapshots <dir> --root <ws> --customer <C>` | dagli snapshot MCP salvati |

## Dove stanno le cose (workspace di conoscenza, mai il repository del plugin)

```
<ws>/product/                      livello S (vendor)       <ws>/customers/<C>/          livello C
  knowledge.db                     indice (items, units, units_fts, doc_profiles, attribute_coverage, subject_units)
  sources/units/<DOCID>/U.<DOCID>.<nnnn>.yaml    posizione canonica delle unità (verità del contenuto; reindex le indicizza)
  kb/                              solo promozione validata (§29.6): la pipeline non ci scrive
  kb/aliases.yaml                  registro degli alias (§19.12), scritto solo dopo validazione (aliases.mjs)
  reviews/<AAAA-MM>.jsonl          verbi della revisione (§19.19)
<ws>/_inbox/<scope>/               (per il cliente: customers/<C>/_inbox/<scope>/)
  parsed/<docId>.json + _manifest.json    documenti normalizzati, formato e residuo per file
  profiles/<DOC>.yaml              profili DOC da promuovere
  raw/<DOCID>.yaml                 item grezzi T0 + piano per lo scope-extractor
  fields/<docId>/…                 righe grezze e lotti ≤ 50 (K4)
  residue/<DOC>.yaml, residue/_harvest.yaml    residuo classificato (§19.15)
  reports/<DOCID>.md|.yaml         report di ingestion (§19.15)
  doc-diff/<DOCID>.yaml            diff fra versioni (§19.16)
  survey/<data>/                   ricognizione del tenant (§19.17)
  aliases.proposed.yaml, backlog.yaml, ingest-summary.yaml
```

## Statistiche reali del corpus (JAGGAER DOC, 28/09/2026 — solo conteggi, nessun contenuto)

Esecuzione: `node scripts/ingest/ingest.mjs --input "JAGGAER DOC" --root ../jvc-knowledge --scope XSC --origin vendor`
→ 71 s (harvest 6 s), workspace `C:\Users\PC-Marco\Desktop\plugin\jvc-knowledge` (unità + _inbox ≈ 43 MB, DB 26 MB).

**File per tipo** (385):

| Estensione | File | Profilati | Residuo |
|------------|-----:|----------:|--------:|
| png | 83 | 0 | 83 |
| jpg | 69 | 0 | 69 |
| xml | 62 | 57 | 5 (duplicati) |
| pdf | 60 | 60 | 0 |
| docx | 31 | 31 | 0 |
| snag | 21 | 0 | 21 |
| txt | 14 | 14 | 0 |
| xlsx | 13 | 12 | 1 (duplicato) |
| db (Thumbs.db) | 10 | 0 | 10 |
| csv | 6 | 4 | 2 (duplicati) |
| gif | 5 | 0 | 5 |
| pptx | 3 | 3 | 0 |
| zip | 3 | 0 | 3 |
| senza estensione | 2 | 1 | 1 (immagine) |
| htm | 1 | 1 | 0 |
| 7z | 1 | 0 | 1 |
| xls (BIFF8) | 1 | 1 | 0 |

**Documenti profilati: 184**, 0 errori — per kind: config-export 64 · training-deck 37 · manuale-utente 19 ·
spec-integrazione 20 · dati-import 20 · guida-admin 14 · doc-progetto 9 · help-online 1. Affidabilità (senza release
dichiarate: freschezza neutra 0.80, corroborazione neutra): config-export 0.76 · spec-integrazione 0.72 · guida-admin
0.60 · manuale-utente 0.56 · help-online 0.52 · training-deck / dati-import 0.48 · doc-progetto 0.48–0.60 (i documenti
"UNOFFICIAL" scendono per paternità). Una versione rilevata (`.v2`: lo stesso DOCX in due cartelle con contenuto diverso).

**Unità: 20.868** — testo 12.407 · riga-tabella-campi 3.501 · tabella 2.343 · regola 1.163 · procedura 580 ·
riferimento 250 · esempio 202 · nota 146 · passo 142 · definizione 116 · figura 17 · decisione 1. Per formato: PDF 11.403
(60 doc) · DOCX 6.974 (31) · XML 1.067 (64) · PPTX 673 · XLSX 282 · HTML 223 · TXT 127 · CSV 114 · XLS 5.

**Campi**: 3.501 righe di campi (DOCX dei dev kit WS 2.613, export XML document_config/form 888); 0 elementi di tracciato
formale (nessun XSD/WSDL/OpenAPI nel corpus: i dev kit sono prosa + tabelle). Lotti di digestione dei campi: 577, il più
grande 43 righe (limite 50); 3 dev kit superano gli 80k token di digestione e riprendono dal cursore nella sessione
successiva (§29.10).

**Item grezzi T0: 5.797** — FLD 4.391 · CFG 540 · FLW 489 · INV 130 · GLS 116 · CFP 112 · INT 20 (uno per dev kit /
spec) · KEY 19 · LCY 8 · 9 regole ambigue a residuo.

**Residuo** — per file (201): deferred 137 (133 immagini senza sidecar OCR, 4 archivi .zip/.7z da estrarre) ·
duplicate 35 (stesso sha256) · unsupported 19 (Snagit .snag) · irrelevant 10 (Thumbs.db). Per unità: irrelevant 84 ·
tacit 30 · ambiguous 9. Righe di tabelle-dataset fuori campione (commodity codes, 2 × 86k righe): 99.059, conservate nel
documento normalizzato, non unità. Avvisi dei parser: 20 fogli con intestazione su due righe, 11 tabelle annidate
appiattite, 4 PDF con pagine di sole immagini, 3 DOCX con caselle di testo; nessun PDF interamente scansionato.

**Token stimati** (≈ caratteri / 4): testo del corpus segmentato ≈ 1,11 M; lavoro LLM pianificato ≈ 2,59 M
(estrazione T1 e domande dei candidati di documento ≈ 1,80 M in 150 sessioni ≤ 80k; digestione dei campi ≈ 0,79 M).
Nessuna unità oltre i 3k token; sessione più grande 79.640 token.

## Catene di K4 (§19.6.4) e forma INT per WP09b

La misura "catene corrette ≥ 80 %" di K4 su un campione rivisto **non è ancora fattibile**: `chains.mjs` lavora su FLD e
INT **digeriti** (codici, `mandatory.kind`), che richiedono la digestione T2 (agenti WP10b) e una revisione umana del
campione; oggi esistono i loro grezzi. Cosa è pronto per chiuderla:

- ogni dev kit WS produce un candidato **INT** con `protocol`, `endpoints`, `operations`, `error_catalog` e
  `mappings: [{ field_ref, target, mandatory }]`, dove `field_ref` è il `raw_id` del FLD di integrazione;
- ogni FLD di integrazione porta `lineage.required_by: [{ ref: <raw_id INT>, mandatory_there }]` — la stessa forma che
  `chains.lineageRelations` legge per i FLD;
- **allineamento richiesto a WP09b** (`schemas/int.schema.json`): alla digestione `field_ref` diventa `field` (codice
  FLD) e `ref` diventa il codice INT; `chains.mjs` legge già `INT.mappings[{ field, target, mandatory }]` (test in
  `test/ingest/extract.test.mjs` sulla forma digerita). I campi in più che WP09b aggiunge (`key_ref`, tolleranze,
  `silence_semantics`, `e2e_checkpoint`) non toccano `chains.mjs`.

## Limiti dichiarati

- **PDF** (senza dipendenze): testo dei flussi in ordine di contenuto, una sezione per pagina, titoli solo dalla dimensione
  del font, tabelle non ricostruite (restano righe di testo: per questo 0 righe-campo dai PDF), font CID senza `/ToUnicode`
  non decodificabili (avviso), PDF cifrati → residuo deferred. Sul corpus: 60/60 letti.
- **Immagini**: nessun OCR incorporato (decisione del controllore): serve `<immagine>.ocr.txt` (+ `.layout.json`)
  prodotto dall'agente; senza, residuo deferred con motivo (133 sul corpus, quasi tutti loghi e foto di articoli).
- **Formati vecchi**: `.xls` BIFF8 letto (celle, SST con CONTINUE, celle unite); BIFF5/cifrati, `.doc`, `.ppt` →
  deferred con motivo; `.snag` unsupported; archivi deferred (estrarre e rilanciare).
- **Tabelle-dataset** oltre 400 righe: campione di 40 righe come unità, il resto nel documento normalizzato.
- **Versioni**: riconosciute dal nome senza marcatori di versione e dal formato; due copie diverse con lo stesso nome in
  cartelle diverse sono trattate come versioni (ordine = ordine del percorso).
- **Stime di token**: caratteri/4, per la pianificazione dei budget; non sono misure di consumo.
