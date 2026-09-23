# Catalogo dei cluster di bootstrap

Cluster semantici curati (§7.1), un file per cluster: `clusters/<FAMIGLIA>/<CODICE>.yaml`, validato da
`schemas/cluster.schema.json` e dalle regole RC-01..RC-10 di `scripts/kb/cluster-rules.mjs`. Tutti hanno
`status: bootstrap`: RC-04 (≥ 3 membri validati) e RC-06 (firma su ≥ 80% dei membri) sono saltate con motivo
finché la prima digestione non porta membri. `reindex --clusters` li carica nella tabella `clusters` del DB;
`scripts/kb/cluster.mjs` ammette (scrivendo la DEC di DT-005), rigetta, fonde, scinde, mette in quarantena, campiona e depreca (§7.3).

Criteri: `{ facet: Fn, op: eq|in|neq, value }` o `{ field: percorso, op: exists|eq|in, value }`. I campi sono quelli della
spec (PRF §19.2, FLD §19.6.2, ERR §20.6.2, EPI §9.4, STR §14.4) oppure `classification.<campo>`, a vocabolario chiuso in
`schemas/item.base.schema.json` e descritti in `docs/classification-fields.md`. Un campo non dichiarato non soddisfa
eq/in; un campo dichiarato `null` o una faccetta assente rendono il criterio indeterminato → quarantena (nel dubbio non
entra). Ogni cluster di dominio `kb` esclude i tipi analitici PAT PBK BRF RUL (§1.1).

Nomi dalla spec dove li dà (CL-SYS ← F5, CL-KNW ← F4, CL-PRO ← F6, CL-ERP ← F7, CL-CFG ← §7.2 con rischio §28.5,
CL-CHK ← §62, CL-ERR ← §20.6.4, CL-RSK R0..R3, CL-DEC ← §6.4, CL-EPI ← §9.3, CL-STR ← §14.2, CL-FLD* ← §19.6.3);
derivati dal testo della spec altrove (campo `note` nel file quando la derivazione non è ovvia).

Totale: **195 cluster** in 20 famiglie.

## CL-SYS (11)

| Codice | Nome | Responsabile | Portabilità |
|---|---|---|---|
| CL-SYS-001 | Nucleo SaaS JAGGAER | xsc-expert | universale |
| CL-SYS-002 | Moduli aggiuntivi | xsc-expert | universale |
| CL-SYS-003 | Applicazioni integrate con ERP | xsc-expert | universale |
| CL-SYS-004 | Middleware di integrazione | xsc-expert | universale |
| CL-SYS-005 | Identity provider | xsc-expert | universale |
| CL-SYS-006 | Portale fornitori | xsc-expert | universale |
| CL-SYS-007 | Reporting e Analytics | xsc-expert | universale |
| CL-SYS-008 | Notifiche email | xsc-expert | universale |
| CL-SYS-009 | Trasferimento file | xsc-expert | universale |
| CL-SYS-010 | Plugin del cliente | xsc-expert | universale |
| CL-SYS-011 | Lato ERP del cliente | xsc-expert | condizionata (F7) |

## CL-KNW (14)

| Codice | Nome | Responsabile | Portabilità |
|---|---|---|---|
| CL-KNW-001 | Procedure | cluster-validator | universale |
| CL-KNW-002 | Vincoli | cluster-validator | universale |
| CL-KNW-003 | Strutture dati | cluster-validator | universale |
| CL-KNW-004 | Regole di business | cluster-validator | universale |
| CL-KNW-005 | Comportamenti dell'interfaccia | cluster-validator | universale |
| CL-KNW-006 | Contratti di interfaccia | cluster-validator | universale |
| CL-KNW-007 | Oggetti di configurazione | cluster-validator | universale |
| CL-KNW-008 | Anomalie | cluster-validator | universale |
| CL-KNW-009 | Decisioni | cluster-validator | universale |
| CL-KNW-010 | Query | cluster-validator | universale |
| CL-KNW-011 | Check ripetitivi | cluster-validator | universale |
| CL-KNW-012 | Mappe di processo | cluster-validator | universale |
| CL-KNW-013 | Profili | cluster-validator | universale |
| CL-KNW-014 | Strategie | cluster-validator | universale |

## CL-PRO (15)

| Codice | Nome | Responsabile | Portabilità |
|---|---|---|---|
| CL-PRO-001 | Acquisti diretti | customer-profiler | condizionata (F6) |
| CL-PRO-002 | Acquisti indiretti | customer-profiler | condizionata (F6) |
| CL-PRO-003 | Diretti e indiretti | customer-profiler | condizionata (F6) |
| CL-PRO-004 | Pubblico normato | customer-profiler | condizionata (F6) |
| CL-PRO-005 | Procurement privato | customer-profiler | condizionata (F6) |
| CL-PRO-006 | Acquisti centralizzati | customer-profiler | condizionata (F6) |
| CL-PRO-007 | Acquisti decentralizzati | customer-profiler | condizionata (F6) |
| CL-PRO-008 | Catalogo-centrico | customer-profiler | condizionata (F6) |
| CL-PRO-009 | Acquisti a testo libero | customer-profiler | condizionata (F6) |
| CL-PRO-010 | Con gare strutturate | customer-profiler | condizionata (F6) |
| CL-PRO-011 | Senza gare | customer-profiler | condizionata (F6) |
| CL-PRO-012 | Con contratti quadro | customer-profiler | condizionata (F6) |
| CL-PRO-013 | Multi-società | customer-profiler | condizionata (F6) |
| CL-PRO-014 | Multi-valuta | customer-profiler | condizionata (F6) |
| CL-PRO-015 | Multi-lingua | customer-profiler | condizionata (F6) |

## CL-CUS (13)

| Codice | Nome | Responsabile | Portabilità |
|---|---|---|---|
| CL-CUS-001 | Settore manifatturiero | customer-profiler | specifica |
| CL-CUS-002 | Soggetti ad appalti pubblici | customer-profiler | specifica |
| CL-CUS-003 | Gruppi multi-società | customer-profiler | specifica |
| CL-CUS-004 | ERP SAP | customer-profiler | specifica |
| CL-CUS-005 | ERP non SAP | customer-profiler | specifica |
| CL-CUS-006 | Senza ERP integrato | customer-profiler | specifica |
| CL-CUS-007 | Con middleware | customer-profiler | specifica |
| CL-CUS-008 | Acquisti centralizzati | customer-profiler | specifica |
| CL-CUS-009 | Acquisti decentralizzati | customer-profiler | specifica |
| CL-CUS-010 | Catalogo-centrici | customer-profiler | specifica |
| CL-CUS-011 | Con gare strutturate | customer-profiler | specifica |
| CL-CUS-012 | Multi-valuta | customer-profiler | specifica |
| CL-CUS-013 | Multi-lingua | customer-profiler | specifica |

## CL-ERP (6)

| Codice | Nome | Responsabile | Portabilità |
|---|---|---|---|
| CL-ERP-001 | SAP ECC | xsc-expert | condizionata (F7) |
| CL-ERP-002 | SAP S/4HANA | xsc-expert | condizionata (F7) |
| CL-ERP-003 | Oracle | xsc-expert | condizionata (F7) |
| CL-ERP-004 | Microsoft Dynamics | xsc-expert | condizionata (F7) |
| CL-ERP-005 | Altro ERP | xsc-expert | condizionata (F7) |
| CL-ERP-006 | Nessun ERP | xsc-expert | condizionata (F7) |

## CL-CFG (20)

| Codice | Nome | Responsabile | Portabilità | Rischio base |
|---|---|---|---|---|
| CL-CFG-001 | Struttura organizzativa | config-designer | condizionata (F7 e parametri di modulo (CL-CFG-020)) | R3 |
| CL-CFG-002 | Utenti e ruoli | config-designer | condizionata (F7 e parametri di modulo (CL-CFG-020)) | R2/R3 |
| CL-CFG-003 | Permessi | config-designer | condizionata (F7 e parametri di modulo (CL-CFG-020)) | R3 |
| CL-CFG-004 | Workflow | config-designer | condizionata (F7 e parametri di modulo (CL-CFG-020)) | R3 |
| CL-CFG-005 | Form e campi | config-designer | condizionata (F7 e parametri di modulo (CL-CFG-020)) | R2 |
| CL-CFG-006 | Template | config-designer | condizionata (F7 e parametri di modulo (CL-CFG-020)) | R1 |
| CL-CFG-007 | Numerazioni | config-designer | condizionata (F7 e parametri di modulo (CL-CFG-020)) | R3 |
| CL-CFG-008 | Notifiche | config-designer | condizionata (F7 e parametri di modulo (CL-CFG-020)) | R1 |
| CL-CFG-009 | Profili di integrazione | config-designer | condizionata (F7 e parametri di modulo (CL-CFG-020)) | R3 |
| CL-CFG-010 | Cataloghi e punchout | config-designer | condizionata (F7 e parametri di modulo (CL-CFG-020)) | R2 |
| CL-CFG-011 | Tassonomie | config-designer | condizionata (F7 e parametri di modulo (CL-CFG-020)) | R2 |
| CL-CFG-012 | Valute e unità di misura | config-designer | condizionata (F7 e parametri di modulo (CL-CFG-020)) | R3 |
| CL-CFG-013 | Codici fiscali | config-designer | condizionata (F7 e parametri di modulo (CL-CFG-020)) | R3 |
| CL-CFG-014 | Allegati | config-designer | condizionata (F7 e parametri di modulo (CL-CFG-020)) | R1 |
| CL-CFG-015 | SSO | config-designer | condizionata (F7 e parametri di modulo (CL-CFG-020)) | R3 |
| CL-CFG-016 | Lingue | config-designer | condizionata (F7 e parametri di modulo (CL-CFG-020)) | R1 |
| CL-CFG-017 | Regole di validazione | config-designer | condizionata (F7 e parametri di modulo (CL-CFG-020)) | R2 |
| CL-CFG-018 | Scadenze | config-designer | condizionata (F7 e parametri di modulo (CL-CFG-020)) | R1 |
| CL-CFG-019 | Scorecard | config-designer | condizionata (F7 e parametri di modulo (CL-CFG-020)) | R1 |
| CL-CFG-020 | Parametri di modulo | config-designer | condizionata (F7 e parametri di modulo (CL-CFG-020)) | R2/R3 |

## CL-UIB (14)

| Codice | Nome | Responsabile | Portabilità |
|---|---|---|---|
| CL-UIB-001 | Validazione asincrona in griglia | test-mechanic | condizionata (F5 (CL-SYS-010 plugin del cliente)) |
| CL-UIB-002 | Campo lookup con ricerca | test-mechanic | condizionata (F5 (CL-SYS-010 plugin del cliente)) |
| CL-UIB-003 | Combobox a opzioni chiuse | test-mechanic | condizionata (F5 (CL-SYS-010 plugin del cliente)) |
| CL-UIB-004 | Campo a testo libero | test-mechanic | condizionata (F5 (CL-SYS-010 plugin del cliente)) |
| CL-UIB-005 | Campo obbligatorio marcato | test-mechanic | condizionata (F5 (CL-SYS-010 plugin del cliente)) |
| CL-UIB-006 | Messaggio toast | test-mechanic | condizionata (F5 (CL-SYS-010 plugin del cliente)) |
| CL-UIB-007 | Banner di errore o avviso | test-mechanic | condizionata (F5 (CL-SYS-010 plugin del cliente)) |
| CL-UIB-008 | Testo di validazione in rosso | test-mechanic | condizionata (F5 (CL-SYS-010 plugin del cliente)) |
| CL-UIB-009 | Dialogo modale di conferma | test-mechanic | condizionata (F5 (CL-SYS-010 plugin del cliente)) |
| CL-UIB-010 | Caricamento di file | test-mechanic | condizionata (F5 (CL-SYS-010 plugin del cliente)) |
| CL-UIB-011 | Salva e pubblica distinti | test-mechanic | condizionata (F5 (CL-SYS-010 plugin del cliente)) |
| CL-UIB-012 | Schede di sezione del documento | test-mechanic | condizionata (F5 (CL-SYS-010 plugin del cliente)) |
| CL-UIB-013 | Griglia di righe del documento | test-mechanic | condizionata (F5 (CL-SYS-010 plugin del cliente)) |
| CL-UIB-014 | Elemento visibile per ruolo | test-mechanic | condizionata (F5 (CL-SYS-010 plugin del cliente)) |

## CL-INT (10)

| Codice | Nome | Responsabile | Portabilità |
|---|---|---|---|
| CL-INT-001 | Uscita asincrona verso ERP | xsc-expert | condizionata (F7) |
| CL-INT-002 | Ingresso dall'ERP | xsc-expert | condizionata (F7) |
| CL-INT-003 | Chiamata sincrona | xsc-expert | condizionata (F7) |
| CL-INT-004 | Trasferimento file pianificato | xsc-expert | condizionata (F7) |
| CL-INT-005 | Punchout di catalogo | xsc-expert | condizionata (F7) |
| CL-INT-006 | Autenticazione federata | xsc-expert | condizionata (F7) |
| CL-INT-007 | Notifica in uscita | xsc-expert | condizionata (F7) |
| CL-INT-008 | Conferma del controparte | xsc-expert | condizionata (F7) |
| CL-INT-009 | Errore silente | xsc-expert | condizionata (F7) |
| CL-INT-010 | Sincronizzazione anagrafiche | xsc-expert | condizionata (F7) |

## CL-CHK (11)

| Codice | Nome | Responsabile | Portabilità |
|---|---|---|---|
| CL-CHK-001 | Pre-azione operativa | xsc-expert | universale |
| CL-CHK-002 | Pre-modifica di configurazione | config-designer | universale |
| CL-CHK-003 | Post-modifica di configurazione | config-designer | universale |
| CL-CHK-004 | Salute delle integrazioni | xsc-expert | universale |
| CL-CHK-005 | Qualità delle anagrafiche | xsc-expert | universale |
| CL-CHK-006 | Permessi | config-auditor | universale |
| CL-CHK-007 | Notifiche | config-auditor | universale |
| CL-CHK-008 | Coerenza dei workflow | config-auditor | universale |
| CL-CHK-009 | Coerenza delle query Analytics | analytics-learner | universale |
| CL-CHK-010 | Fixture di test | test-mechanic | universale |
| CL-CHK-011 | Ambiente pronto | xsc-expert | universale |

## CL-ERR (9)

| Codice | Nome | Responsabile | Portabilità |
|---|---|---|---|
| CL-ERR-001 | Validazione del dato | failure-triage | condizionata (F5) |
| CL-ERR-002 | Permessi insufficienti | failure-triage | condizionata (F5) |
| CL-ERR-003 | Rifiuto o silenzio del controparte | failure-triage | condizionata (F5) |
| CL-ERR-004 | Errore interno di sistema | failure-triage | condizionata (F5) |
| CL-ERR-005 | Timeout e latenza | failure-triage | condizionata (F5) |
| CL-ERR-006 | Concorrenza | failure-triage | condizionata (F5) |
| CL-ERR-007 | Regola di processo | failure-triage | condizionata (F5) |
| CL-ERR-008 | Sessione scaduta | failure-triage | condizionata (F5) |
| CL-ERR-009 | Errore non classificato | failure-triage | condizionata (F5) |

## CL-PRT (6)

| Codice | Nome | Responsabile | Portabilità |
|---|---|---|---|
| CL-PRT-001 | Universale | weekly-digest | universale |
| CL-PRT-002 | Condizionata dall'ERP | weekly-digest | condizionata (F7) |
| CL-PRT-003 | Condizionata dal modello di procurement | weekly-digest | condizionata (F6) |
| CL-PRT-004 | Condizionata da un parametro | weekly-digest | condizionata (CL-CFG-020 parametri di modulo) |
| CL-PRT-005 | Specifica del cliente | weekly-digest | specifica |
| CL-PRT-006 | Portabilità ignota | weekly-digest | ignota |

## CL-RSK (4)

| Codice | Nome | Responsabile | Portabilità |
|---|---|---|---|
| CL-RSK-001 | Rischio R0: osservare | config-designer | universale |
| CL-RSK-002 | Rischio R1: bozze reversibili | config-designer | universale |
| CL-RSK-003 | Rischio R2: effetti con approvazione | config-designer | universale |
| CL-RSK-004 | Rischio R3: massivo o strutturale | config-designer | universale |

## CL-LRN (6)

| Codice | Nome | Responsabile | Portabilità |
|---|---|---|---|
| CL-LRN-001 | Elemento nuovo | lesson-validator | universale |
| CL-LRN-002 | Divergenza dal documentato | lesson-validator | universale |
| CL-LRN-003 | Configurazione osservata | lesson-validator | universale |
| CL-LRN-004 | Vincolo dal messaggio | lesson-validator | universale |
| CL-LRN-005 | Passo non documentato | lesson-validator | universale |
| CL-LRN-006 | Conferma ripetuta | lesson-validator | universale |

## CL-ANL (10)

| Codice | Nome | Responsabile | Portabilità |
|---|---|---|---|
| CL-ANL-001 | Tabelle enumerate | analytics-learner | condizionata (CL-CFG-020 parametri Analytics) |
| CL-ANL-002 | Colonne chiave | analytics-learner | condizionata (CL-CFG-020 parametri Analytics) |
| CL-ANL-003 | Join noti da report | analytics-learner | condizionata (CL-CFG-020 parametri Analytics) |
| CL-ANL-004 | Metriche ricorrenti | analytics-learner | condizionata (CL-CFG-020 parametri Analytics) |
| CL-ANL-005 | Validazione per conteggi e campioni | analytics-learner | condizionata (CL-CFG-020 parametri Analytics) |
| CL-ANL-006 | Valori enumerati osservati | analytics-learner | condizionata (CL-CFG-020 parametri Analytics) |
| CL-ANL-007 | Colonne a testo libero | analytics-learner | condizionata (CL-CFG-020 parametri Analytics) |
| CL-ANL-008 | Pattern di query con LIMIT | analytics-learner | condizionata (CL-CFG-020 parametri Analytics) |
| CL-ANL-009 | Query validate | analytics-learner | condizionata (CL-CFG-020 parametri Analytics) |
| CL-ANL-010 | Query su tabelle ignote | analytics-learner | condizionata (CL-CFG-020 parametri Analytics) |

## CL-DEC (6)

| Codice | Nome | Responsabile | Portabilità |
|---|---|---|---|
| CL-DEC-001 | Generare un test | agent-manager | universale |
| CL-DEC-002 | Scegliere un selettore | agent-manager | universale |
| CL-DEC-003 | Progettare una configurazione | agent-manager | universale |
| CL-DEC-004 | Eseguire configurazione od operazione | agent-manager | universale |
| CL-DEC-005 | Classificare un fallimento | agent-manager | universale |
| CL-DEC-006 | Scrivere una query Analytics | agent-manager | universale |

## CL-EPI (5)

| Codice | Nome | Responsabile | Portabilità |
|---|---|---|---|
| CL-EPI-001 | Consolidato | cluster-validator | specifica |
| CL-EPI-002 | Libresco | cluster-validator | specifica |
| CL-EPI-003 | Empirico | cluster-validator | specifica |
| CL-EPI-004 | Ignoto | cluster-validator | specifica |
| CL-EPI-005 | Contraddittorio | cluster-validator | specifica |

## CL-STR (12)

| Codice | Nome | Responsabile | Portabilità |
|---|---|---|---|
| CL-STR-001 | Replica del precedente | cluster-validator | universale |
| CL-STR-002 | Verifica prima di agire | cluster-validator | universale |
| CL-STR-003 | Triangola | cluster-validator | universale |
| CL-STR-004 | Prova a vuoto | cluster-validator | universale |
| CL-STR-005 | Minimo cambiamento | cluster-validator | universale |
| CL-STR-006 | Bisezione | cluster-validator | universale |
| CL-STR-007 | Esplora a budget | cluster-validator | universale |
| CL-STR-008 | Chiedi presto | cluster-validator | universale |
| CL-STR-009 | Generalizza con cautela | cluster-validator | universale |
| CL-STR-010 | Fermati e registra | cluster-validator | universale |
| CL-STR-011 | Pre-mortem | cluster-validator | universale |
| CL-STR-012 | Cerca la smentita | cluster-validator | universale |

## CL-FLD (13)

| Codice | Nome | Responsabile | Portabilità |
|---|---|---|---|
| CL-FLD-001 | Intestazione | scope-digester | universale |
| CL-FLD-002 | Righe | scope-digester | universale |
| CL-FLD-003 | Contabilità | scope-digester | universale |
| CL-FLD-004 | Fiscalità | scope-digester | universale |
| CL-FLD-005 | Logistica | scope-digester | universale |
| CL-FLD-006 | Riferimento fornitore | scope-digester | universale |
| CL-FLD-007 | Prezzi e valute | scope-digester | universale |
| CL-FLD-008 | Allegati | scope-digester | universale |
| CL-FLD-009 | Workflow e approvazione | scope-digester | universale |
| CL-FLD-010 | Riferimenti a documenti a monte | scope-digester | universale |
| CL-FLD-011 | Campi custom del cliente | scope-digester | universale |
| CL-FLD-012 | Campi di sistema e audit | scope-digester | universale |
| CL-FLD-013 | Testi e note | scope-digester | universale |

## CL-FLD-MAND (7)

| Codice | Nome | Responsabile | Portabilità |
|---|---|---|---|
| CL-FLD-MAND-001 | Obbligatorietà sempre | scope-digester | condizionata (F6 e società del documento (mandatory.when)) |
| CL-FLD-MAND-002 | Obbligatorietà per stato | scope-digester | condizionata (F6 e società del documento (mandatory.when)) |
| CL-FLD-MAND-003 | Obbligatorietà per importo | scope-digester | condizionata (F6 e società del documento (mandatory.when)) |
| CL-FLD-MAND-004 | Obbligatorietà per categoria o società | scope-digester | condizionata (F6 e società del documento (mandatory.when)) |
| CL-FLD-MAND-005 | Obbligatorietà per ruolo | scope-digester | condizionata (F6 e società del documento (mandatory.when)) |
| CL-FLD-MAND-006 | Obbligatorietà per integrazione | scope-digester | condizionata (F6 e società del documento (mandatory.when)) |
| CL-FLD-MAND-007 | Obbligatorietà non documentata | scope-digester | condizionata (F6 e società del documento (mandatory.when)) |

## CL-FLD-CHAIN (3)

| Codice | Nome | Responsabile | Portabilità |
|---|---|---|---|
| CL-FLD-CHAIN-001 | Fornitore → qualifica → invito → contratto | process-mapper | condizionata (F7) |
| CL-FLD-CHAIN-002 | Articolo → listino → riga → ricezione | process-mapper | condizionata (F7) |
| CL-FLD-CHAIN-012 | CdC → ordine → ERP → fattura | process-mapper | condizionata (F7) |
