---
name: clustering-rules
description: Metodo per creare e validare cluster con le dieci regole RC-01…RC-10 e DT-005 — ammissione solo con tutti i criteri di inclusione e nessuno di esclusione, rigetto motivato, fusione, scissione, quarantena, campionamento, deprecazione — per i cluster di faccette e quelli semantici (compresi CL-EPI, CL-STR, CL-FLD). Usala quando validi gli item digeriti di uno scope, quando proponi un cluster nuovo o una catena di campi, quando un item è ambiguo fra due cluster, quando la digestione settimanale propone cluster multi-cliente o un cluster condizionato (CL-PRT).
---

# clustering-rules — la validazione severa dei cluster (§7)

Un cluster porta conoscenza ("campi che alimentano chiavi ERP", "check da eseguire prima di toccare un workflow") e
gli agenti se ne fidano. Per questo **un cluster impreciso è peggio di nessun cluster**: nel dubbio un item non
entra, e il dubbio si registra.

## Due tipi (§7.1) e le famiglie (§7.2)

- **Cluster di faccette**: automatici, per costruzione (una combinazione di valori di faccetta).
- **Cluster semantici**: curati — nome, definizione, criteri di inclusione ed esclusione, firma di faccette.

Le famiglie (`CL-SYS`, `CL-KNW`, `CL-PRO`, `CL-CUS`, `CL-ERP`, `CL-CFG`, `CL-UIB`, `CL-INT`, `CL-CHK`, `CL-ERR`,
`CL-PRT`, `CL-RSK`, `CL-LRN`, `CL-ANL`, `CL-DEC`, `CL-EPI`, `CL-STR`, `CL-FLD`, `CL-FLD-CHAIN`, `CL-FLD-MAND`) e i
cluster di partenza sono in `clusters/` del plugin e nel catalogo del prodotto: leggili lì con

    node "${CLAUDE_PLUGIN_ROOT}/scripts/kb/kb.mjs" clusters --family <famiglia> --db customers/<C>/knowledge.db --json

## Le dieci regole per un cluster (§7.3)

| Regola | Criterio verificabile |
|--------|-----------------------|
| RC-01 famiglia | esistente, o nuova con ≥ 3 cluster candidati |
| RC-02 nome e definizione | nome ≤ 6 parole; definizione ≤ 40 parole, "insieme degli item che…" |
| RC-03 criteri | ≥ 2 di inclusione, ≥ 1 di esclusione, verificabili su faccette o contenuto strutturato |
| RC-04 membri | ≥ 3 item già validati |
| RC-05 distinzione | Jaccard < 50% con ogni cluster della famiglia |
| RC-06 firma | una combinazione di faccette caratterizza ≥ 80% dei membri |
| RC-07 profondità | ≤ 3 livelli |
| RC-08 proprietà | un agente responsabile |
| RC-09 portabilità | ipotesi dichiarata, con la faccetta condizionante |
| RC-10 domini | un solo dominio per cluster (mai operativo e analitico insieme) |

## Le operazioni del validatore e quando si usano

| Operazione | Quando | Come |
|------------|--------|------|
| **ammissione** | l'item soddisfa **tutti** i criteri di inclusione e **nessuno** di esclusione | DT-005 con i priori (tasso di quarantena della famiglia) tramite lo script, che scrive la DEC |
| **rigetto motivato** | un criterio non è soddisfatto | con la regola violata come motivo: torna al digester |
| **fusione** | sovrapposizione > 70% fra due cluster | proposta, con i due codici |
| **scissione** | > 40 membri con varianza alta | proposta sulla faccetta che separa |
| **quarantena** | ambiguo: i criteri non bastano a decidere | l'item va all'umano **e il criterio è segnalato come insufficiente** |
| **campionamento** | settimanale, 10% | ricontrolla membri già ammessi con seme deterministico |
| **deprecazione** | cluster vuoto per 2 digestioni | lo marca lo script |

Righe di esempio (sintassi completa nel `--help` dello script):

    node "${CLAUDE_PLUGIN_ROOT}/scripts/kb/cluster.mjs" admit <CL> <codice> --customer <C> --db customers/<C>/knowledge.db --json
    node "${CLAUDE_PLUGIN_ROOT}/scripts/kb/cluster.mjs" quarantine <codice> --reason "<criterio insufficiente>" --customer <C> --db customers/<C>/knowledge.db --json

## Come valutare un criterio

1. Leggi il criterio **sull'item come è scritto e sulle sue fonti**, non su ciò che l'item "probabilmente" è.
2. Un criterio su faccette si verifica sui valori (vocabolario chiuso, skill `faceting-and-weights`); uno sul
   contenuto si verifica su campi strutturati (per i FLD: regola parsata, non testo libero).
3. Un'osservazione singola non basta a soddisfare un criterio che parla di comportamento confermato.
4. Se due cluster della stessa famiglia accetterebbero entrambi l'item, i criteri di esclusione sono insufficienti:
   quarantena e segnalazione, non una scelta a sensazione.

## Casi speciali

- **CL-EPI** (forma epistemica) e **CL-STR** (strategie): si validano come gli altri; la forma di un soggetto la
  calcola il reindex, il cluster ne verifica la coerenza con il vettore.
- **Campi**: un FLD entra in CL-FLD-MAND solo con regola parsata; una catena CL-FLD-CHAIN solo con ≥ 3 FLD di ≥ 2
  documenti (skill `field-modeling`).
- **Portabilità condizionata** (CL-PRT): quando clienti diversi divergono sullo stesso soggetto, la digestione
  settimanale cerca la faccetta che spiega la partizione e propone un cluster condizionato su di essa.

## Ordine di clusterizzazione (§7.4)

Prima `CL-CHK` (diventano script), poi sistema × interfaccia (SaaS contro integrato), poi `CL-CFG` (copertura
della configurazione), poi `CL-UIB` (robustezza su Chrome), poi `CL-EPI` e `CL-PRT`, poi il resto.

## Errori tipici

- Ammettere "perché assomiglia": senza tutti i criteri di inclusione l'item non entra.
- Rigettare senza citare la regola violata.
- Risolvere un'ambiguità d'ufficio invece di mettere in quarantena e segnalare il criterio.
- Un cluster che mescola item operativi e analitici (RC-10).
