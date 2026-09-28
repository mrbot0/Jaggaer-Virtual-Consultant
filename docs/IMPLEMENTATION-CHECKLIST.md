# JAGGAER Virtual Consultant — Checklist delle implementazioni

Fonte: `jaggaer-virtual-consultant-piano-di-sviluppo.md` (fasi) e `jaggaer-virtual-consultant-architettura.md` v8.0 (catalogo dei componenti §31.2, §43.3, §44).
Legenda: ✅ completato e revisionato · 🔄 in corso · ⬜ da fare · Brief = requisiti pronti per l'implementazione.

Ultimo aggiornamento: 28/09/2026 19:20 — **punto corrente: WP08 (F0) avviato; WP07 (K6) chiuso**.

## Avanzamento complessivo

**≈ 46 % del progetto** (stima pesata sullo sforzo) · 7 pacchetti su 17 chiusi.

| Misura | Valore | Come è calcolata |
|---|---|---|
| Avanzamento pesato | **≈ 46 %** (51 / 111 unità) | peso stimato per pacchetto nella tabella sotto × % di completamento |
| Pacchetti chiusi | 7 / 17 = **41 %** | WP01–WP07 con review e tag |
| Hook del catalogo §44.4 | 14 / 16 = **88 %** | 15 hook + approval-capture; in più browser-origin e guard-phrase nati dalla review |
| Test automatici | 578 / 578 verdi | `npm test` al tag `k6-done` (`ea67488`); intento 33/33; observe-append p50 125 ms |

### Chiusura di WP03 (K2)
- 4 giri di correzione dopo la review, tutti committati (`c491d1e..0bfb2a2`). Tag `k2-done` → `0bfb2a2`.
- Anomalie risolte: le 16 della review iniziale (#11 ricostruita: scritture via shell sui file di stato), più 4 emerse nelle re-review (riparazione eseguibile da un sub-agente, abbinamento dei sub-agenti paralleli, dispatch mai chiusi, scrittura tramite il comando `w` di sed).
- Novità per l'utente: `use close-stale` chiude a mano i sotto-compiti rimasti aperti; quelli più vecchi di 2 ore scadono da soli. La sessione principale non può più cancellare la propria cartella di sessione dalla shell.
- Problemi minori rinviati alla review finale: alcuni comandi di sola lettura negati per eccesso di prudenza (per esempio `grep sed …`), script sed letti da stdin non analizzati, nomi di comando offuscati.
- Da segnalare per WP08/WP10a: i guard richiedono `npm install` nel plugin, altrimenti negano ogni chiamata. La prenotazione del budget per dispatch paralleli passa a WP07.

### Chiusura di WP04 (K3)
- Implementato in 8 commit, più 2 giri di correzione (`205496d..43f935f`). Tag `k3-done` → `43f935f`.
- Consegnato: precedenti ed esiti, le 12 strategie con `strategy-select` (golden 20/20), revisione delle credenze, profondità, schema del piano di esecuzione, self-check a 13 controlli, `why`, calibrazione (solo proposte), lezioni e loro validazione.
- Corretto dopo la review: gli effetti non dichiarati di una decisione ora sono "sconosciuti", non "assenti". Una credenza non si sostituisce senza un successore. I detector di spreco bloccano. Il self-check richiede il database. Ogni sessione riceve il codice `SES.<CLIENTE>.<AAAAMMDD>.<SEQ>`.
- Decisione da confermare: il pre-mortem si applica solo ai compiti a profondità "profonda" con rischio ≥ R2. La spec è ambigua tra §10.4, §14.2 e §17.3.
- Rinviati come minori: il numero progressivo del codice di sessione usa la data UTC, più alcune duplicazioni e rifiniture elencate nel ledger.

### Chiusura di WP05 (K4)
- Implementato in 6 commit, più 2 giri di correzione (`783f561..d985f8d`). Tag `k4-done` → `d985f8d`.
- Consegnato: lo schema dei campi FLD con l'obbligatorietà come regola e la carta d'identità a 12 blocchi. Poi la pipeline dei campi a lotti di al massimo 50, il parser deontico italiano e inglese (golden 228/228), le catene tra documenti e i comandi `kb fields`, `kb impact` e `kb identity`.
- Corretto dopo la review: nessuna formula di raccomandazione produce più un obbligo, e anche la validazione a valle lo impedisce. Il budget per documento non si può alzare, e il consumo resta legato alla sessione reale.
- Da misurare con documenti reali: la precisione delle catene, obiettivo ≥ 80 %.
- Da rispettare in WP09b: le forme INT/LCY lette dalle catene sono provvisorie.

### Chiusura di WP07 (K6, esecuzione su Chrome)
- Implementato in 10 commit, più 5 giri di correzione (`4380433..ea67488`). Tag `k6-done` → `ea67488`.
- Consegnato:
  - `step-check` con i parser dei tre formati di browser e `observe-append`, che registra le osservazioni e riconosce gli errori della piattaforma;
  - redazione dei dati personali al momento della cattura, ed evidenze mascherate senza script di pagina;
  - riconoscimento dell'intento (33/33) e workflow a schermo;
  - report con esito classificato, budget rigidi con riserva per gli agenti paralleli e compile-plan opzionale;
  - la prova M7 simulata, in cui la 3A lavora sullo stato scritto da K6.
- Corretto nelle review, che hanno avuto un peso forte sulla sicurezza:
  - l'origine della pagina non si ricava più dal testo della pagina;
  - un piano fuori dalla sandbox richiede `APPROVO PIANO`, ed è legato al suo hash;
  - ogni click o input deve colpire l'elemento previsto dal passo;
  - checkpoint protetti, e l'ultimo passo verificato vive nello stato di sessione;
  - dati personali rimossi dalla firma di pagina e dalle evidenze;
  - nessun falso "superato" sugli errori attesi.
- **Deciso al limite dei 5 giri.** Il browser integrato di Claude assegna riferimenti a elementi che non mostra, quindi un legame affidabile tra elemento e passo non è garantito. Fuori dalla sandbox le azioni con effetto tramite il browser di Claude saranno negate: per quelle si usa Chrome DevTools MCP. Letture e navigazione restano libere. La correzione è inclusa in WP08.
- Da verificare dal vivo su Chrome reale: il ritorno indietro con la cache della pagina (bfcache).

### Agent manager come layer di orchestrazione (valutazione del 28/09/2026)
- **Cosa dice la spec:** il manager è l'orchestratore (§23.2). Gestisce stato, routing, handoff, escalation, blackboard, budget e vigilanza cognitiva, ed è l'unico che parla con l'utente. È una skill che gira nella sessione principale, perché in Claude Code solo lei può lanciare sub-agenti.
- **Cosa esiste già nel codice:** ogni dispatch è registrato con budget e stato. Ogni chiamata di strumento di ogni agente finisce in audit con il suo identificativo. Ogni rapporto viene validato e archiviato.
- **Cosa mancava:** una vista unica di cosa fanno gli agenti e di come lo fanno. Mancavano anche l'applicazione nel codice della vigilanza (stop al terzo compito fermato per sorprese sullo stesso scope) e del limite di un'escalation di tier per compito, e la verifica degli handoff. Infine non c'era alcun modo per l'utente di mettere in pausa o fermare un agente.
- **Decisione: tre livelli separati.**
  1. Il manager, un modello nella sessione principale, dialoga e instrada.
  2. Le regole di orchestrazione sono codice deterministico che il manager non può scavalcare.
  3. Il monitor è indipendente da agenti e manager. Ricava tutto dalle registrazioni degli hook, sorveglia anche il manager e si può seguire da un terminale separato.
- **Controllo dell'utente:** pausa, ripresa e stop per agente o per tutti, modalità passo-passo con conferma di ogni azione con effetto, e limiti di chiamate e durata per ogni dispatch. Tutto è applicato dai guard, non dal modello. Pianificato in WP10d.

### Chiusura di WP06 (K5, cancello di sicurezza)
- Implementato in 7 commit, più 3 giri di correzione (`8f2103d..69cc6e7`). Tag `k5-done` → `69cc6e7`.
- Consegnato: lo schema degli ambienti (prod con scrittura dati rifiutato), `env-check` e `use env`, e il guard dell'ambiente con allow-list degli host (il redirect SSO non dichiarato è negato). Poi il catalogo delle 15 classi di azione, `validate-plan`, il guard di produzione (100/100 scritture negate), la tripla approvazione 3A con registro concatenato e il guard di configurazione.
- Irrobustito dopo la review:
  - gli script di pagina sono vietati in ogni ambiente;
  - l'URL corrente è registrato solo dopo una navigazione riuscita, e viene azzerato al cambio scheda;
  - senza piano attivo niente azioni con effetto, salvo l'esplorazione in sandbox richiesta scrivendo `ESPLORA SANDBOX`;
  - i server MCP fuori da una allow-list sono negati;
  - impostazioni di Claude e codice del plugin sono protetti in scrittura.
- **Rischi residui dichiarati** (in `docs/phase-reports/K5.md`):
  - La protezione di impostazioni, codice del plugin e registro delle approvazioni si basa sul testo dei comandi. Un modello deliberatamente ostile può aggirarla, per esempio con nomi di file costruiti durante l'esecuzione. Le varianti d'attacco oltre quelle note non sono state provate fino in fondo.
  - Raccomandazione: rendere la cartella del plugin e `~/.claude` di sola lettura a livello di sistema operativo, oppure usare impostazioni gestite.
- **Prerequisito bloccante:** prima che un agente usi il browser serve WP07, in particolare `observe-append`, che registra la pagina realmente osservata.

## Stato per pacchetto di lavoro

Peso = sforzo relativo stimato (unità arbitrarie, totale 111). È una stima: va ricalibrata quando un pacchetto si chiude.

| # | Pacchetto | Fase piano | Peso | % | Stato | Evidenza |
|---|-----------|-----------|-----|---|-------|----------|
| WP01 | Codifica, faccette, pesi, qualità, DB, reindex, `kb` find/resolve/get, epistemica, confini | K0 | 6 | 100 | ✅ | tag `k0-done`, 29 test, `docs/phase-reports/K0.md` |
| WP02 | Formato DT e `dt-eval`, DT-001…DT-026, 195 cluster di bootstrap, regole RC-01…10, operazioni del validator, priori | K1 | 8 | 100 | ✅ | tag `k1-done`, 98 test, golden 10/10, DT-002 100/100 |
| WP03 | Stato di sessione, contratti prompt/rapporto, hook base, guard di partizione, budget, traccia cognitiva | K2 | 8 | 100 | ✅ | tag `k2-done` → `0bfb2a2`, 230 test, 4 giri di correzione, `docs/phase-reports/K2.md` |
| WP04 | Precedenti, esiti, 12 strategie, `strategy-select`, revisione delle credenze, profondità, piano, self-check, why, calibrazione, lezioni | K3 | 8 | 100 | ✅ | tag `k3-done` → `43f935f`, 305 test, golden 20/20, `docs/phase-reports/K3.md` |
| WP05 | Modello dei campi FLD, carta d'identità, pipeline a lotti ≤ 50, parser deontico, catene, `kb fields/impact/identity` | K4 | 7 | 100 | ✅ | tag `k4-done` → `d985f8d`, 370 test, deontico 228/228, `docs/phase-reports/K4.md` |
| WP06 | Ambienti, `env-check`, guard-environment/production/config-scope, catalogo azioni ACT, tripla approvazione 3A | K5 | 6 | 100 | ✅ | tag `k5-done` → `69cc6e7`, 466 test, 3 giri di correzione, `docs/phase-reports/K5.md` |
| WP07 | `step-check`, `observe-append`, errori della piattaforma, evidenze, intento DT-026, workflow, report ed esiti, budget, `compile-plan` opzionale | K6 | 8 | 100 | ✅ | tag `k6-done` → `ea67488`, 578 test, 5 giri di correzione, `docs/phase-reports/K6.md` |
| WP08 | guard-destructive, guard-alm-write, integrità, `doctor`, template settings | F0 | 3 | 0 | 🔄 | `wp08-f0.md` + decisione portata da WP07 |
| WP09a | Pipeline di ingestion: parser DOCX/XLSX/PDF/XSD/export/screenshot/trascrizioni/e-mail, unità, profilo DOC, banche di domande, back-check, alias, versioni, residuo, revisione, survey del tenant, PRF/PMP | F1' (strumenti) | 10 | 0 | ⬜ Brief | `wp09a-ingest.md` |
| WP09b | Schemi NRT/SEL/HND/CHK/CFP/FLW/KEY/LCY/INT/CFG, compile-case/cfp, lint, Atlas, corsie di esecuzione, compensazioni, snapshot, evidenze, negativi, promozione, copertura | F3–F7, C1 (strumenti) | 12 | 0 | ⬜ Brief | `wp09b-run.md` |
| WP09c | AlmAdapter (Xray Cloud/Server/Mock), server MCP ALM, script xray, coda offline, Defect, `.mcp.json`, NETWORK.md | F5 | 6 | 0 | ⬜ Brief | `wp09c-alm.md` |
| WP09d | Comandi `kb` restanti, digestione settimanale, Analytics (TBL/QRY/DIN/USR/PSP/ERR), dominio analitico, audit config, admin (status, lock, retention, purge) | F8–F12, G2–G3 (strumenti) | 8 | 0 | ⬜ Brief | `wp09d-ops.md` |
| WP10a | Comandi `vc use kb nrt cfg ops learn admin`, template restanti, README, manuale integrato | §44.1, §55–58 | 4 | 0 | ⬜ Brief | `wp10a-commands.md` |
| WP10b | 15 agenti foglia + suite `evals/` | §44.2, §49.1 | 5 | 0 | ⬜ Brief | `wp10b-agents.md` |
| WP10d | **Layer di orchestrazione e controllo degli agenti** (richiesta utente 28/09): console `agents status/show/watch`, vigilanza ed escalation applicate dai guard, handoff verificati, monitor indipendente che sorveglia anche il manager, pausa/stop/passo-passo per agente | §23.2, §24, §29.5, §45 | 5 | 0 | ⬜ Brief | `wp10d-orchestration.md` — da eseguire prima di WP10c |
| WP10c | Skill `agent-manager` + 26 skill | §44.3 | 5 | 0 | ⬜ Brief | `wp10c-skills.md` |
| FINAL | Review dell'intero branch | — | 2 | 0 | ⬜ | — |
| **Totale** | | | **111** | **≈ 46** | | 51 unità completate |

## Catalogo dei componenti (spec §44)

### Hook (15 + approval-capture)
- [x] session-context · precompact-save · stop-integrity · audit-append (WP03 ✅)
- [x] guard-domain-boundary · guard-scope · guard-customer (WP03 ✅)
- [x] guard-budget · subagent-trace (WP03 ✅)
- [x] guard-environment · guard-production · guard-config-scope · approval-capture (WP06 ✅) · in più browser-origin, guard-phrase
- [x] observe-append (WP07 ✅)
- [ ] guard-destructive · guard-alm-write (WP08)

### Script (gruppi §44.5)
- [x] `kb/`: codes, validate-codes/schema/boundary/scope, assign-seq, db + migrazioni, lock, reindex, weights, quality, epistemic, find, resolve, get, summary, cluster, cluster-rules
- [ ] `kb/`: precedents, outcomes, fields, impact, identity, units, related, facet-count, promote, deprecate, migrate, compensation, snapshot, coverage, review, lesson, belief-update, chains
- [x] `decide/`: dt-eval, ingestion-gain · [ ] strategy-select, self-check, depth, why, validate-plan, step-check, intent, budget
- [x] `digest/`: outcomes-rates · [ ] collect, align, portability, calibrate, promote-candidates, report, decay, weekly, pseudonymize
- [x] `admin/`: session, agent-report · [ ] approvals, workflow, integrity, doctor, status, lock, retention, purge
- [ ] `ingest/` · `chrome/` · `compile/` · `run/` · `evidence/` · `xray/` · `analysis/` · `analytics/` · `config/` · `report/`

### Dati di bootstrap del livello S
- [x] 26 tabelle di decisione (`decision-tables/`) · 195 cluster (`clusters/`) · pesi della qualità, decadimento, pesi della fonte
- [ ] 12 strategie (`strategies/`) · 15 classi di azione (`product/kb/actions/`) · check iniziali §62 · banche di domande §63–64

### Schemi
- [x] registry, facets, item.base (+ classification), dt, cluster, session, agent-prompt, agent-report, cognitive-trace, message, audit-event
- [ ] strategy, hypotheses, execution-plan, why, lesson, fld, parsed-doc, environments, act, approval, remediation-scope, rpt, nrt-case, sel, hnd, chk, cfp, flw, key, lcy, int, cfg, unit, doc, prf, pmp, tbl, qry, din, usr, psp, err, pat, pbk, brf, rul, xray-config

### Agenti, skill, comandi, MCP
- [ ] 15 agenti · [ ] 27 skill · [ ] 8 comandi (esiste solo `commands/use.md` minimale) · [ ] server MCP ALM + `.mcp.json` completo

## Punti aperti da decidere con il committente
- **Documentazione JAGGAER di partenza caricata** (28/09/2026) in `JAGGAER DOC/`: 385 file tra corsi (guide, workbook, XML di workflow e configurazione, form) e kit di sviluppo dei web service. È esclusa da git perché materiale proprietario. WP09a la userà come corpus reale: la pipeline di ingestion la elaborerà per intero e scriverà la conoscenza di livello S in un workspace separato, `jvc-knowledge`, non nel repo del plugin. Fino ad allora il livello S contiene solo il bootstrap (DT, cluster, strategie, azioni, check).
- 18 tabelle di decisione hanno pesi `bootstrap` progettati: vanno calibrate sui DEC reali (≥ 10 per tabella).
- La latenza dei guard (~110–150 ms per processo, di cui ~74 ms di avvio di Node) supera l'obiettivo di 100 ms della spec: limite accettato.
