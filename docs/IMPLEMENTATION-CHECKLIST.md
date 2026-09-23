# JAGGAER Virtual Consultant — Checklist delle implementazioni

Fonte: `jaggaer-virtual-consultant-piano-di-sviluppo.md` (fasi) e `jaggaer-virtual-consultant-architettura.md` v8.0 (catalogo dei componenti §31.2, §43.3, §44).
Legenda: ✅ completato e revisionato · 🔄 in corso · ⬜ da fare · Brief = requisiti pronti per l'implementazione.

Ultimo aggiornamento: 23/09/2026 15:50 — **punto corrente: WP04 (K3) avviato; WP03 (K2) chiuso**.

## Avanzamento complessivo

**≈ 21 % del progetto** (stima pesata sullo sforzo) · 3 pacchetti su 16 chiusi.

| Misura | Valore | Come è calcolata |
|---|---|---|
| Avanzamento pesato | **≈ 21 %** (22 / 106 unità) | peso stimato per pacchetto nella tabella sotto × % di completamento |
| Pacchetti chiusi | 3 / 16 = **19 %** | WP01, WP02, WP03 con review pulita e tag |
| Hook del catalogo §44.4 | 9 / 16 = **56 %** | 15 hook + approval-capture |
| Test automatici | 230 / 230 verdi | `npm test` al tag `k2-done` (`0bfb2a2`); tempi dei guard max 127 ms |

### Chiusura di WP03 (K2)
- 4 giri di correzione dopo la review, tutti committati (`c491d1e..0bfb2a2`). Tag `k2-done` → `0bfb2a2`.
- Anomalie risolte: le 16 della review iniziale (#11 ricostruita: scritture via shell sui file di stato), più 4 emerse nelle re-review (riparazione eseguibile da un sub-agente, abbinamento dei sub-agenti paralleli, dispatch mai chiusi, scrittura tramite il comando `w` di sed).
- Novità per l'utente: `use close-stale` chiude a mano i sotto-compiti rimasti aperti; quelli più vecchi di 2 ore scadono da soli. La sessione principale non può più cancellare la propria cartella di sessione dalla shell.
- Problemi minori rinviati alla review finale: alcuni comandi di sola lettura negati per eccesso di prudenza (per esempio `grep sed …`), script sed letti da stdin non analizzati, nomi di comando offuscati.
- Da segnalare per WP08/WP10a: i guard richiedono `npm install` nel plugin, altrimenti negano ogni chiamata. La prenotazione del budget per dispatch paralleli passa a WP07.

## Stato per pacchetto di lavoro

Peso = sforzo relativo stimato (unità arbitrarie, totale 106). È una stima: va ricalibrata quando un pacchetto si chiude.

| # | Pacchetto | Fase piano | Peso | % | Stato | Evidenza |
|---|-----------|-----------|-----|---|-------|----------|
| WP01 | Codifica, faccette, pesi, qualità, DB, reindex, `kb` find/resolve/get, epistemica, confini | K0 | 6 | 100 | ✅ | tag `k0-done`, 29 test, `docs/phase-reports/K0.md` |
| WP02 | Formato DT e `dt-eval`, DT-001…DT-026, 195 cluster di bootstrap, regole RC-01…10, operazioni del validator, priori | K1 | 8 | 100 | ✅ | tag `k1-done`, 98 test, golden 10/10, DT-002 100/100 |
| WP03 | Stato di sessione, contratti prompt/rapporto, hook base, guard di partizione, budget, traccia cognitiva | K2 | 8 | 100 | ✅ | tag `k2-done` → `0bfb2a2`, 230 test, 4 giri di correzione, `docs/phase-reports/K2.md` |
| WP04 | Precedenti, esiti, 12 strategie, `strategy-select`, revisione delle credenze, profondità, piano, self-check, why, calibrazione, lezioni | K3 | 8 | 0 | 🔄 | `.superpowers/sdd/briefs/wp04-k3.md` |
| WP05 | Modello dei campi FLD, carta d'identità, pipeline a lotti ≤ 50, parser deontico, catene, `kb fields/impact/identity` | K4 | 7 | 0 | ⬜ Brief | `wp05-k4.md` |
| WP06 | Ambienti, `env-check`, guard-environment/production/config-scope, catalogo azioni ACT, tripla approvazione 3A | K5 | 6 | 0 | ⬜ Brief | `wp06-k5.md` |
| WP07 | `step-check`, `observe-append`, errori della piattaforma, evidenze, intento DT-026, workflow, report ed esiti, budget, `compile-plan` opzionale | K6 | 8 | 0 | ⬜ Brief | `wp07-k6.md` |
| WP08 | guard-destructive, guard-alm-write, integrità, `doctor`, template settings | F0 | 3 | 0 | ⬜ Brief | `wp08-f0.md` |
| WP09a | Pipeline di ingestion: parser DOCX/XLSX/PDF/XSD/export/screenshot/trascrizioni/e-mail, unità, profilo DOC, banche di domande, back-check, alias, versioni, residuo, revisione, survey del tenant, PRF/PMP | F1' (strumenti) | 10 | 0 | ⬜ Brief | `wp09a-ingest.md` |
| WP09b | Schemi NRT/SEL/HND/CHK/CFP/FLW/KEY/LCY/INT/CFG, compile-case/cfp, lint, Atlas, corsie di esecuzione, compensazioni, snapshot, evidenze, negativi, promozione, copertura | F3–F7, C1 (strumenti) | 12 | 0 | ⬜ Brief | `wp09b-run.md` |
| WP09c | AlmAdapter (Xray Cloud/Server/Mock), server MCP ALM, script xray, coda offline, Defect, `.mcp.json`, NETWORK.md | F5 | 6 | 0 | ⬜ Brief | `wp09c-alm.md` |
| WP09d | Comandi `kb` restanti, digestione settimanale, Analytics (TBL/QRY/DIN/USR/PSP/ERR), dominio analitico, audit config, admin (status, lock, retention, purge) | F8–F12, G2–G3 (strumenti) | 8 | 0 | ⬜ Brief | `wp09d-ops.md` |
| WP10a | Comandi `vc use kb nrt cfg ops learn admin`, template restanti, README, manuale integrato | §44.1, §55–58 | 4 | 0 | ⬜ Brief | `wp10a-commands.md` |
| WP10b | 15 agenti foglia + suite `evals/` | §44.2, §49.1 | 5 | 0 | ⬜ Brief | `wp10b-agents.md` |
| WP10c | Skill `agent-manager` + 26 skill | §44.3 | 5 | 0 | ⬜ Brief | `wp10c-skills.md` |
| FINAL | Review dell'intero branch | — | 2 | 0 | ⬜ | — |
| **Totale** | | | **106** | **≈ 21** | | 22 unità completate |

## Catalogo dei componenti (spec §44)

### Hook (15 + approval-capture)
- [x] session-context · precompact-save · stop-integrity · audit-append (WP03 ✅)
- [x] guard-domain-boundary · guard-scope · guard-customer (WP03 ✅)
- [x] guard-budget · subagent-trace (WP03 ✅)
- [ ] guard-environment · guard-production · guard-config-scope · approval-capture (WP06)
- [ ] observe-append (WP07)
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
- Il KB JAGGAER verrà caricato con la pipeline di WP09a: fino ad allora il livello S contiene solo il bootstrap (DT, cluster, strategie, azioni, check).
- 18 tabelle di decisione hanno pesi `bootstrap` progettati: vanno calibrate sui DEC reali (≥ 10 per tabella).
- La latenza dei guard (~110–150 ms per processo, di cui ~74 ms di avvio di Node) supera l'obiettivo di 100 ms della spec: limite accettato.
