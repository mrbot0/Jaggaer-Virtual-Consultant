# Campi di classificazione degli item (`classification`)

I criteri dei cluster (`clusters/**`, §7.3) si verificano su faccette o su contenuto strutturato. Il contenuto
strutturato è di due tipi:

1. **campi della spec**, già definiti dal tipo di item: PRF `sector`, `legal.*`, `erp.*`, `procurement_model.*` (§19.2);
   FLD `mandatory.kind|in_states|by_role|reason.kind`, `key_ref`, `lineage.propagates_to` (§19.6.2); ERR `category`,
   `message`, `page_signature` (§20.6.2); EPI `shape` (§9.4); STR `code` (§14.4); `type` per tutti;
2. **campi di classificazione**, assegnati dal digester nell'oggetto opzionale `classification` dell'item, a
   **vocabolario chiuso** fissato in `schemas/item.base.schema.json` (un valore fuori vocabolario o un campo non
   dichiarato rende l'item invalido per `validate-schema`).

Semantica nei criteri: un campo non dichiarato non soddisfa `eq`/`in`; un campo dichiarato con valore `null`
("non so") rende il criterio indeterminato → l'item va in quarantena (nel dubbio non entra, DT-005).
Il test `test/kb/cluster-rules.test.mjs` verifica che ogni criterio su un campo usi un campo della spec o
`classification.<campo>` con valori del vocabolario, e che ogni campo del vocabolario sia usato da un cluster.

```yaml
# esempio: C.ACME.ADM.CFG.0019.yaml
classification:
  cfg_area: "010"                 # cataloghi e punchout → CL-CFG-010
  portability_condition: CL-CFG-020
```

| Campo | Vocabolario | Famiglia | Fonte |
|-------|-------------|----------|-------|
| `cfg_area` | `001` struttura organizzativa · `002` utenti e ruoli · `003` permessi · `004` workflow · `005` form e campi · `006` template · `007` numerazioni · `008` notifiche · `009` profili di integrazione · `010` cataloghi e punchout · `011` tassonomie · `012` valute/UdM · `013` codici fiscali · `014` allegati · `015` SSO · `016` lingue · `017` regole di validazione · `018` scadenze · `019` scorecard · `020` parametri di modulo | CL-CFG-001…020 (e l'area di DT-007) | §7.2, §28.5 |
| `ui_pattern` | `validazione-asincrona-griglia` · `lookup-ricerca` · `combobox-opzioni-chiuse` · `testo-libero` · `obbligatorio-marcato` · `toast` · `banner` · `validazione-in-rosso` · `modale-conferma` · `caricamento-file` · `salva-pubblica` · `schede-sezione` · `griglia-righe` · `visibile-per-ruolo` | CL-UIB-001…014 (in quest'ordine) | §7.1, §20.1, §20.2, §20.6.2, §11.3 |
| `interface_pattern` | `uscita-asincrona-erp` · `ingresso-erp` · `chiamata-sincrona` · `file-pianificato` · `punchout` · `autenticazione-federata` · `notifica-uscita` · `conferma-controparte` · `errore-silente` · `sincronizzazione-anagrafiche` | CL-INT-001…010 | §27.1, §27.4, §19.20 |
| `check_area` | `pre-azione-operativa` · `pre-modifica-config` · `post-modifica-config` · `salute-integrazioni` · `qualita-anagrafiche` · `permessi` · `notifiche` · `coerenza-workflow` · `coerenza-query-analytics` · `fixture-test` · `ambiente-pronto` | CL-CHK-001…011 | §62 (001, 009 derivati) |
| `learning_kind` | `elemento-nuovo` · `divergenza-dal-documentato` · `configurazione-osservata` · `vincolo-dal-messaggio` · `passo-non-documentato` · `conferma-ripetuta` | CL-LRN-001…006 | §20.2 |
| `analytics_pattern` | `tabella-enumerata` · `colonna-chiave` · `join-da-report` · `metrica-ricorrente` · `validazione-conteggi-campioni` · `valori-enumerati` · `colonna-testo-libero` · `query-con-limit` · `query-validata` · `query-tabelle-ignote` | CL-ANL-001…010 | §20.3 |
| `decision_kind` | `generare-test` · `scegliere-selettore` · `progettare-configurazione` · `eseguire` · `classificare-fallimento` · `scrivere-query-analytics` | CL-DEC-001…006 | §6.4, §11.2 |
| `functional_section` | `intestazione` · `righe` · `contabilita` · `fiscalita` · `logistica` · `riferimento-fornitore` · `prezzi-valute` · `allegati` · `workflow-approvazione` · `riferimenti-monte` · `custom-cliente` · `sistema-audit` · `testi-note` | CL-FLD-001…013 (un FLD in esattamente uno) | §19.6.3 |
| `mandatory_condition` | `importo` · `categoria-societa` | CL-FLD-MAND-003, 004 (esclusione in 002) | §19.6.3 |
| `portability_condition` | `F6` · `F7` · `CL-CFG-001` … `CL-CFG-020` | CL-PRT-003 (`F6`), 002 (`F7`), 004 (qualunque `CL-CFG-nnn`, match `in`) | §6.3, §11.6, §22.1 |
| `configured_by` | `admin-jaggaer` · `team-erp` | CL-SYS-011 (`team-erp`) | §19.4 (criterio SaaS vs integrato) |

Aggiungere un valore a un vocabolario è una modifica dello schema (con test), non una scelta del digester in sessione.
