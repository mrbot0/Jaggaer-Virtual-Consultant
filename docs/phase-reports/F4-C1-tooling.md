# F4–F7 · C1 — Report di fase, parte strumenti (WP09b: test e configurazione)

Stato: **strumenti pronti** per la corsia guidata NRT (F4), le evidenze (F5, parte script), la corsia integration (F6),
la generazione e la promozione (F7) e la configurazione (C1). Tutto ciò che la spec descrive per la parte deterministica
esiste, è provato e gira; restano fuori per costruzione l'esecuzione su Chrome (la fa l'agente via MCP, WP10b), i comandi
`/nrt` e `/cfg` (WP10a), l'adattatore ALM/Xray (WP09c) e le prove sul tenant (M12–M16).

Suite completa alla consegna: **794 test, 794 pass, 0 fail, 0 skipped** (`npm test`, Windows 11, Node 24.15, 132 s, con il
corpus presente); prima di WP09b erano 721 e restano tutti verdi (i test che usavano nomi di run corti sono migrati alla
forma completa), i 73 nuovi sono nei file della tabella sotto. Test di tempo dei guard (toccati guard-config-scope e
observe-append): ogni chiamata < 300 ms (observe-append p95 144 ms).

## Cosa c'è

| Deliverable | Script / file | Prova |
|-------------|---------------|-------|
| A Schemi | `schemas/{nrt-case,sel,hnd,chk,cfp,flw,key,lcy,int,cfg,defs}.schema.json`, aggancio per `type` in `scripts/kb/validate-schema.mjs` (i casi `NRT.*` con la loro grammatica) | `test/kb/wp09b-schemas.test.mjs` (valido + invalido per schema), `test/hooks/wp09b-sel-guard.test.mjs` |
| B Catalogo dei check §62 | 21 item `S.STD.{ADM,XSC,VEN}.CHK.nnnn` in `product/kb/scopes/*/checks/` (generatore `test/tools/gen-check-catalog.mjs`) | `test/kb/wp09b-check-catalog.test.mjs`, `test/run/checks-teardown.test.mjs` |
| C Compilatori | `scripts/compile/{compile-case,compile-cfp,generate-atlas-po,lint-spec,lint-scope}.mjs`; `compile-plan --atlas` | `test/compile/{compile-case,compile-cfp,generate-atlas-po,lint}.test.mjs` |
| D Corsie di run | `scripts/run/{select-suite,fixtures,checks-run,teardown,baseline,auth-setup,integration}.mjs`, `scripts/kb/{compensation,snapshot}.mjs` (`kb compensation`, `kb snapshot`) | `test/run/*.test.mjs`, `test/kb/wp09b-compensation-snapshot.test.mjs`, `test/hooks/wp09b-snapshot-binding.test.mjs`, `test/decide/wp09b-run-code.test.mjs` |
| E Evidenze | `scripts/evidence/{select,contact-sheet}.mjs` | `test/evidence/evidence.test.mjs` |
| F Generazione | `scripts/compile/negative-generator.mjs`, `scripts/run/promotion.mjs`, `scripts/kb/coverage.mjs` (`kb coverage`) | `test/compile/negative-generator.test.mjs`, `test/run/promotion-coverage.test.mjs` |
| Librerie | `scripts/lib/{kb-items,run-code,run-results,compensations-store}.mjs` | nei test sopra |

Tutte le CLI hanno `--help`, `--json`, exit code 0 · 1 · 2 · 3 (3 = rifiuto di policy o violazione) e accettano i dati da
file o `chiave=valore` (mai JSON in linea: i guard lo negano).

## Test di fase del piano

| Piano | Test | Dove |
|-------|------|------|
| F4.1 | caso senza compensazione → rifiuto | `compile-case.test.mjs` (anche CLI, exit 3) |
| F4.2 | fallback in ordine; css solo `fragile` | `generate-atlas-po.test.mjs` |
| F4.3 | esecuzione ripetuta con esito identico | `promotion-coverage.test.mjs` (end-to-end: 3 run via step-check, esiti per piano, compile-plan conta 3 verdi) — sul tenant: M12 |
| F4.4 | 0 orfani | `select-fixtures.test.mjs`, `checks-teardown.test.mjs` |
| F6 | diff con tolleranze; timeout classificato ambientale | `baseline-auth-integration.test.mjs` (L1, L2: entro la p95 ⇒ E2, oltre ⇒ osservazione) |
| F7 | caso senza `derivation` non emesso; shadow → promosso dopo 3 run coerenti | `negative-generator.test.mjs`, `promotion-coverage.test.mjs` |
| C1.1 | verbo fuori vocabolario → invalido | `compile-cfp.test.mjs`, `wp09b-schemas.test.mjs` |
| C1.3 | pre-check che fallisce blocca | `checks-teardown.test.mjs` (CL-CHK-002, exit 3) |
| C1.4 | obbligatorietà verificata campo per campo | `compile-cfp.test.mjs` (`--verify`) |
| F2 (anticipato) | INT senza `silence_semantics` invalido | `wp09b-schemas.test.mjs` |

## Riporti chiusi

1. **INT e catene K4.** `mappings[].field` è il codice FLD; `field_ref` (id grezzo dell'estrazione) si converte con
   `normalizeIntMappings` (chains.mjs); l'obbligatorietà uno-fra delle `xs:choice` sta sul lato del mapping (`one_of
   { group, required }`, anche in `lineage.required_by` del FLD); extract.mjs la produce, chains.mjs la porta nella catena
   (un gruppo obbligatorio attraversa, nessuna reason `integration` dedotta per il singolo campo).
2. **Compensazioni e snapshot riusano K6.** Un solo formato (`scripts/lib/compensations-store.mjs`, usato da step-check,
   `kb compensation`, teardown). `session.snapshots[]` è legato agli oggetti governati: guard-config-scope vuole UNO
   snapshot degli ultimi 60 s che copra `config.object` + `config.governs` (con la sola area: `areas`); observe-append
   registra lo snapshot solo se la pagina mostra l'elemento del SEL del passo; `kb snapshot` lega ogni CFG alla sua pagina
   (location) e alle OBS recenti.
3. **Codici RUN.** `RUN.<C>.<AAAAMMDD>.<HHMM>.<S>` (data e ora valide, scope del registro, cliente della sessione) in
   step-check con i controlli di realpath invariati; run di default completo; test migrati.
4. **Back-check.** Il segno dei negativi resta nel token; i codici uniti da trattini (REQ-CC-1) si confrontano interi.
5. **SEL e guard.** `role` (enum con `search_box`) ed `effect` (`read|write`) sono quelli che leggono guard-production e
   l'Atlas di observe-append: test con i guard reali su item validati dallo schema.

## Sanità sui dati reali (livello S, solo conteggi)

Sui 183 file di candidati di `jvc-knowledge/_inbox/XSC/raw`: 747 FLD con obbligatorietà parsata (563 always, 126
conditional, 58 never) e 20 INT con 2 613 mapping (542 obbligatori; tutti risolti da `normalizeIntMappings`). Il
negative-generator produce 848 scheletri (689 NEG, 126 POS, 33 INT), tutti `shadow` (conoscenza dai documenti ⇒
libresco, con osservazione preliminare), 0 scartati; nessun contenuto copiato nel repository.

## Decisioni e deviazioni

Vedi `.superpowers/sdd/wp09b-report.md` (sezione Deviazioni): forma vs lacune negli schemi FLW/KEY/LCY/CFG; NEG con ERR
richiesto per promuovere (non per lo shadow); esiti per piano in `runs/<RUN>/results/`; coerenza della promozione per
`plan_id`; ruoli dei verbi nelle CFP (CHOOSE/TOGGLE/SAVE/SUBMIT/UPLOAD ⇒ ACT-CFG-CHANGE); ricette del teardown.

## Rischi residui

- Checkpoint di step-check a livello di run (`runs/<RUN>/checkpoints/<n>.json`, K6): in un run con più casi il caso
  successivo li sovrascrive; la ripresa di un caso già chiuso non serve, ma una ripresa a metà dopo un altro caso nello
  stesso run è negata (checkpoint non corrispondente) — si riprende in un run nuovo.
- Le prove sul tenant (3 esecuzioni identiche M12, ≥ 5 negativi che falliscono quando devono M14, R2 su libresco M16)
  richiedono Chrome e il tenant demo: gli script le preparano e ne registrano l'esito.

## Giro di correzione 1

Esito della review: "Needs fixes" (1 critico, 2 importanti) più i minori che rompono funzioni. Suite alla chiusura:
**802 test, 802 pass, 0 fail, 0 skipped** (`npm test` con il corpus); test di tempo dei guard verde (guard-config-scope
p95 97 ms, observe-append p95 158 ms). Test nuovi: `test/kb/wp09b-fixround1.test.mjs` (8).

| Rilievo | Correzione | Prova |
|---------|------------|-------|
| C1 `kb snapshot --area` sbloccava un passo di sola area senza osservazioni | guard-config-scope accetta una voce solo con un'osservazione per oggetto governato (observe-append: `obs`; kb snapshot: `obs[]` per ogni oggetto); sola area solo da observe-append (che ora la registra sulla pagina con il SEL del passo); kb snapshot richiede ≥ 1 CFG | sonda del revisore: negato prima e dopo `--area` |
| I2 prove forgiabili o vecchie | `customers/*/observations/**` protetto in scrittura (file e shell, sessione e sub-agenti); kb snapshot legge solo le righe del DB di observe-append; età ≤ 900 s anche con `--max-age-s`; pagina esatta | Write/Bash negati; OBS solo-file rifiutata; OBS di 10 giorni rifiutata; `setup/forms-archive` ≠ `setup/forms` |
| I3 promozione per plan_id | impronta del caso (senza stato, ALM, priorità, tag) nel piano prima delle sostituzioni del run e in ogni esito; contano solo gli esiti della versione attuale; precedente verde dai risultati di un altro caso promosso | i verdi della v1 non promuovono la v2; `green_precedent` dichiarato ignorato |
| M4 checks-run e gli esiti per piano | `runResults()` | rollback verde in `results/` riconosciuto |
| M5 rollback provato a vuoto | `.DRY` non conta | rollback-proven fallisce con il solo `.DRY` |
| M6 script sconosciuto | check fallito (exit 3), niente passo browser | `does-not-exist` ⇒ fail |
| M7 compensazione della FLW | stessa regola in lint-spec (`--workspace`) e compile-case | L-COMP assente con il workspace |
| M8 scheletri libresco | shadow solo se lint-spec e lint-scope puliti (altrimenti candidate, elencati in `gated`) | HND con passi segnaposto resta candidate |
| M9 dry-run e UPLOAD | UPLOAD ⇒ CAPTURE | piano .DRY senza UPLOAD |
| M17 corsia compilata per i casi che creano | compile-plan conta i verdi per impronta | tre run con prefissi diversi ⇒ 3 verdi |

Rinviati per decisione del controllore: deviazioni della CFP cliente nel verificatore, altri vuoti dell'anti-indebolimento,
lint-scope senza workspace, validazione di --xray-cap/--run/--release, file sorgente di auth-setup, ambiente di L3
dichiarato dal chiamante.
