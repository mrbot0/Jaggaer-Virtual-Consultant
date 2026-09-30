# F8 · F10 · C2 · G2 · G3 — Report di fase, parte strumenti (WP09d: kb, digestione, analytics, dominio analitico, config audit, admin)

Stato: **strumenti pronti** per la conoscenza (comandi `kb` rimanenti), la digestione settimanale e il competence report
(G2), Analytics con `DIN`/`USR`/`PSP` e query consegnabili (C2), il dominio analitico dai ticket (F8), il config auditor
(F10) e le operazioni di amministrazione (G3: status, lock, retention, **customer purge**). Restano fuori per costruzione:
i comandi `/learn`, `/kb`, `/admin` come file di comando (WP10a; `/vc status` è già cablato), gli agenti
`weekly-digest`, `analytics-learner`, `config-auditor` (WP10b), le prove sui dati reali dei criteri di uscita (M17, M18,
M20, M24: un DIN reale, un briefing giudicato da un configuratore senior, ≥ 3 condizioni reali, ≥ 5 promozioni approvate).

Suite completa alla consegna: vedi `.superpowers/sdd/wp09d-report.md` (conteggio e tempi).

## Cosa c'è

| Deliverable | File | Prova |
|-------------|------|-------|
| A `kb` related · facet-count · graph · scopes · handoffs --validate · clusters · contradictions · outcomes | `scripts/kb/registries.mjs`, cablati in `scripts/kb/kb.mjs` | `test/kb/wp09d-kb-commands.test.mjs` |
| A `kb promote` (L → C; C/L → S con approvazione `APPROVO PROMOZIONE <codice>`, pseudonimizzazione, codice dal DB, transazione) · `kb deprecate` (mai cancellato) | `scripts/kb/lifecycle.mjs`, `indexItemFile` in `scripts/kb/reindex.mjs` | stesso file: senza approvazione impossibile, token forgiato, monouso, nessun valore del cliente in S |
| A `kb migrate` (§49.4) | `scripts/kb/migrate.mjs`, `scripts/kb/migrations/0008-ops.sql` (`schema_migrations`, `query_runs`) | stesso file: registro, `knowledge_version`, DB più nuovo ⇒ exit 3 |
| B Digestione settimanale | `scripts/digest/{collect,pseudonymize,align,portability,promote-candidates,decay,report,weekly}.mjs`, `learn digest-weekly · competence-report · promote` | `test/digest/wp09d-weekly.test.mjs` |
| C Schemi Analytics | `schemas/{tbl,qry,din,usr,psp,err}.schema.json` in `validate-schema` (+ `privacyErrors` per DIN/USR) | `test/analytics/wp09d-analytics.test.mjs` |
| C Query consegnabili (DT-015) | `scripts/analytics/query-guard.mjs` (LIMIT, `record`, `check`) | stesso file |
| C DIN dagli aggregati | `scripts/analytics/din-build.mjs` (gruppo < 20 rifiutato, `de_facto_mandatory` ⇒ proposta di CTR) | stesso file |
| D Dominio analitico | `scripts/analysis/{common,ticket-import,cluster,chain,brief}.mjs`, `schemas/{pat,pbk,brf,rul}.schema.json`, `migrations/0009-analysis.sql`, `learn tickets · patterns · brief` | `test/analysis/wp09d-analysis.test.mjs`, golden `test/golden/wp09d/` |
| E Config audit | `scripts/config/{baseline,diff,lint}.mjs` | `test/config/wp09d-config-audit.test.mjs` |
| F Admin | `scripts/admin/{status,lock,retention,purge}.mjs`; `doctor` con `process.exitCode` | `test/admin/wp09d-admin.test.mjs` |
| Sicurezza | frasi `APPROVO PURGE <ID> DA <Nome>` · `APPROVO PROMOZIONE <codice>` · `APPROVO RETENTION <ID>` in approval-capture; guard-phrase e guard-config-scope le negano in ogni input di strumento; `DR-OK-002` + `DR-SHELL-007` (retention nella sola forma esatta) | `test/hooks/wp09d-approvals.test.mjs`, `test/admin/wp09d-admin.test.mjs` |

Tutte le CLI hanno `--help`, `--json`, exit code 0 · 1 · 2 · 3 e prendono i dati da file (SQL, aggregati, ticket,
baseline) o da opzioni semplici: mai JSON in linea. Il sale della pseudonimizzazione viene solo da `JVC_PSEUDO_SALT`.

## Test di fase del piano

| Piano | Test | Dove |
|-------|------|------|
| C2: query non eseguita non consegnata | `check` exit 3 finché non c'è un'esecuzione con LIMIT coerente | `wp09d-analytics.test.mjs` |
| C2: DIN con gruppo < 20 rifiutato | `buildDin` e `din-build` exit 3 | `wp09d-analytics.test.mjs` |
| C2 (M17): `de_facto_mandatory` rilevato | fill_rate 0.998 su un FLD `never` ⇒ DIN + proposta di CTR, FLD intatto | `wp09d-analytics.test.mjs` |
| F8: validate-boundary rifiuta un PAT che cita NRT | `checkBoundary` + CLI exit 3; lo scrittore analitico rifiuta prima di scrivere | `wp09d-analysis.test.mjs` |
| F8: pseudonimizzazione golden | `tickets.csv` → `tickets.golden.json` (sale fisso) | `wp09d-analysis.test.mjs` |
| F10: regola violata su baseline sintetica | `lint` exit 3 con la violazione | `wp09d-config-audit.test.mjs` |
| F10: deriva rilevata | `diff --env-a sandbox --env-b preprod` exit 3 + proposta `alignment.drift_known` | `wp09d-config-audit.test.mjs` |
| G2: promozione senza approvazione impossibile | `kb promote --to product` exit 3 (senza token, token forgiato, di un altro item, riusato); il digest non scrive S | `wp09d-kb-commands.test.mjs`, `wp09d-weekly.test.mjs` |
| G2: item contraddetto non promosso | CTR aperto ⇒ escluso dai candidati; gruppo divergente ⇒ CTR di prodotto | `wp09d-weekly.test.mjs` |
| G2: calibrazione solo con ≥ 10 DEC | 9 DEC ⇒ nessuna proposta; 12 DEC ⇒ proposta nella cartella del cliente, tabella intatta | `wp09d-weekly.test.mjs` |
| G3: purge su cliente di test | senza approvazioni exit 3; con due nomi ⇒ certificato (percorsi, sha256), `customers/<ID>/` rimosso, `promoted_from` → token | `wp09d-admin.test.mjs` |

## Decisioni che contano

- **Retention vs "la purge è l'unica cancellazione"**: la retention è la scadenza che §54.4 dichiara per osservazioni,
  evidenze, sessioni (90 giorni) e run/report (12 mesi) — "rimosso dai file" —, non un verbo di cancellazione a
  richiesta. È trattata come la purge: forma esatta (`DR-OK-002`), una approvazione con frase (§56.8), certificato,
  rimozione dei soli percorsi scaduti del cliente. L'audit non si rimuove mai (oltre 24 mesi è solo "archiviabile fuori
  repo"); la conoscenza mai.
- **Promozione a S**: un item che cita item del cliente non sale (va prima promosso il riferimento); il contenuto passa
  dal pseudonimizzatore; `promoted_from` resta il codice reale finché la purge del cliente non lo sostituisce con un token.
- **Digestione**: in `product/digest/` solo token (clienti, persone, documenti, item); la corrispondenza reale candidato →
  codici resta in `customers/<C>/digest/`; le proposte di calibrazione restano nella cartella del cliente.

## Dati reali (sola lettura)

Copia di `jvc-knowledge/product/knowledge.db` in una cartella temporanea (l'originale non è mai stato aperto in scrittura):
0 item, 20 842 unità, 184 profili DOC, 0 cluster caricati. `kb scopes` 10 scope del registro; `facet-count`, `graph`,
`handoffs --validate`, `clusters`, `contradictions` girano e restituiscono insiemi vuoti (la digestione in item non è
ancora avvenuta sui dati reali).

## Giro di correzione 1

- **Approvazioni confermate nel transcript (I1)**: guard-destructive, nell'eccezione a forma esatta, risolve i token di
  purge (`--execute`), retention (`--apply`) e promozione a S (`kb|lifecycle promote --to product`, `learn promote`) nel
  registro della sessione e li conferma nel transcript come le 3A (riga umana, sha del prompt e orario, una riga per
  record); un registro forgiato con la catena di hash corretta è negato. La policy dichiara `first_arg` e `approvals`
  (`DR-OK-001..005`); `DR-SHELL-008` nega ogni forma non esatta di `promote`. La prova a secco della purge non agisce e
  non richiede la conferma.
- **Promozione a S (I2)**: solo un candidato della digestione (DT-010, `customers/<C>/digest/<settimana>/candidates.yaml`,
  ultime 4 settimane) senza contraddizioni aperte (registro e item CTR); sotto il lock di `product/`; l'approvazione si
  consuma prima di scrivere.
- **Retention (I3, m1, m12)**: nessun collegamento (cartelle di categoria o voci link/giunzione, o che risolvono fuori da
  `customers/<C>/`): rifiutato, e verificato di nuovo prima di ogni rimozione; fase "deprecato" persistente
  (`.jvc/retention/<C>.json`, scritto dalla prova a secco) e rimozione solo di ciò che era già deprecato; knowledge.lock
  del cliente.
- **Purge (m9)**: si approva e si esegue solo nella sessione del cliente da cancellare (approval-capture e script).
- **Analytics (m2-m4, m10)**: LIMIT registrato solo se presente nel testo eseguito; la conoscenza delle tabelle registrata
  non si alza; `--max` limitato a 10 000; quote di istogramma su gruppi < 20 e chiavi identificative nelle mappe rifiutate.
- **Config (m5, m6)**: baseline più recente per orario di cattura; impronta obbligatoria.
- **Metriche (m11)**: costo compito ripetuto / prima volta e osservazioni R0 suggerite eseguite nella settimana
  (approssimazioni per sessione e per settimana).
- **Rischio residuo documentato**: i token salati `CUST-`/`RIF-` di un cliente cancellato restano nei report di
  `product/digest/` e sono ricalcolabili da chi possiede `JVC_PSEUDO_SALT` (codici di 4 caratteri).
