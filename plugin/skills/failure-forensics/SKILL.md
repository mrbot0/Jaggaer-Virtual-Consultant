---
name: failure-forensics
description: Metodo di diagnosi e rimedio dei fallimenti — classificazione con DT-001 e i precedenti (test-defect, config-drift, product-defect, baseline-change, environment, expected-change, regression), il metodo della prima divergenza con STR-BISECT, ipotesi falsificabili e test discriminanti, il finding con confidence, evidence_bundle, recommendation e precedent, dal finding al CHK che cita l'invariante, e l'instradamento verso Defect, healing o ambiente. Usala quando triagi i fallimenti di un run (/nrt triage), quando un triage torna escalate e serve la root cause, quando un passo diverge senza spiegazione, quando scegli fra Defect, riparazione del test e problema d'ambiente, quando proponi il controllo che avrebbe intercettato un guasto.
---

# failure-forensics — capire prima di rimediare (§30, DT-001, STR-BISECT)

Un fallimento non è un difetto finché non è capito. Il metodo: classificare con una tabella e con lo storico,
isolare la prima divergenza, formulare ipotesi che si possono smentire, e trasformare ciò che si è capito in un
controllo che la prossima volta intercetta il problema prima.

## 1. Classificare (§30.1, DT-001)

| Categoria | Significa | Destino |
|-----------|-----------|---------|
| `test-defect` | il test è sbagliato o fragile (selettore, dato, attesa) | riparazione del test (skill `selector-strategy`), mai un Defect |
| `config-drift` | la configurazione è cambiata rispetto alla baseline | audit della configurazione; nessun Defect di prodotto |
| `product-defect` | il prodotto non fa ciò che la fonte tecnica o d'uso dice | Defect (skill `evidence-and-xray`) |
| `regression` | un `product-defect` il cui precedente è un Defect chiuso come **fixed** | Defect con il riferimento al precedente |
| `baseline-change` | il comportamento è cambiato e la baseline del test va aggiornata | aggiornamento della baseline, dopo conferma |
| `environment` | ambiente, rete, sistema esterno, manutenzione | retry, poi `blocked` con diagnosi ambientale; **mai un Defect** |
| `expected-change` | cambio dichiarato (delta della release) | aggiornamento atteso del test |

Regole di metodo:

- **Sempre incrociato con il delta della release** (`delta.yaml`): un cambio dichiarato non è un difetto.
- **Prima i precedenti** (skill `precedents`): una regressione si riconosce solo dal precedente fixed. Con un
  precedente vicino e confermato la classificazione è un replay e costa poco.
- Il catalogo degli errori della piattaforma (ERR) distingue un errore noto (spesso atteso o d'ambiente) da uno nuovo.
- **Confidenza sotto 0.60** → non chiudere: `status: escalate` con le categorie candidate, i punteggi e le prove; il
  manager fa **un** dispatch della root cause con l'output parziale. Mai una categoria inventata per chiudere.

## 2. La prima divergenza (§30.2)

```
1 timeline dal trace del run            5 precedenti sul soggetto (§12)
2 primo passo divergente                 6 briefing e playbook come contesto (solo in diagnosi)
  (STR-BISECT se ignoto)                 7 ipotesi falsificabile
3 console e rete al passo                8 micro-esplorazione R0 per discriminare
4 kb: invariante, FLW, documento         9 finding
```

**STR-BISECT**: con una procedura lunga e la divergenza ignota, dimezza la sequenza, verifica lo stato a metà (R0),
ripeti sulla metà che diverge: in log2(n) verifiche trovi il primo passo divergente. Tutto ciò che viene dopo il
primo passo divergente è conseguenza, non causa.

## 3. Ipotesi che si possono smentire

Con il registro delle ipotesi (skill `belief-revision`): almeno due ipotesi aperte, ciascuna con un prior dichiarato
e un **test discriminante** con il suo costo; si esegue per primo il test che separa di più al costo minore; ogni
ipotesi si chiude con evidenza citata. Con un'ipotesi preferita a prior alto si combina `STR-DISCONFIRM`: un test
progettato per smentirla prima di concludere.

Una buona ipotesi è falsificabile: dice quale osservazione la smentirebbe ("se il riferimento è presente e corretto,
H2 cade"). "Qualcosa non va nella configurazione" non è un'ipotesi.

**Prima pulisci il modello**: se sul soggetto ci sono contraddizioni aperte (forma `contraddittorio`), risolverle
(DT-011, un'osservazione mirata) spesso elimina metà delle ipotesi. Due CTR aperte sullo stesso documento = prima
risolverle, poi diagnosticare.

## 4. Incertezza epistemica o aleatoria (DT-024)

Una divergenza coerente a ogni ripetizione è epistemica (manca conoscenza: osservare, non riprovare). Divergenze che
cambiano a ogni ripetizione, timeout intermittenti, errori di concorrenza sono aleatorie (riprova con backoff, marca
flaky, **non** aggiornare il modello). Il caso misto si isola con la bisezione prima di classificare.

## 5. Il finding

```yaml
finding:
  id: <F-…>
  case: <NRT…>            step: <n>            first_divergence: <n>
  classification: <categoria>                  confidence: <0–1>
  hypotheses: { supported: [<H>], refuted: [<H con evidenza>] }
  evidence_bundle: [<EV…>, <OBS…>]
  precedent: <DEC o chiave del Defect precedente> | null
  recommendation: "<Defect | healing | baseline | ambiente | domanda>"
  check_proposal: { invariant: <codice>, how: "<READ/VERIFY prima del passo>" }
```

La confidenza dichiarata entra nella calibrazione (§17.4): non gonfiarla.

## 6. Dal finding al check (§30.3)

Ogni finding risponde a "quale controllo, eseguito prima, avrebbe intercettato questo?". Il CHK proposto cita
l'**invariante** documentale violata, non il fallimento: la catena è invariante → check; il fallimento è stato solo
l'occasione. Così il confine dei domini è rispettato: un check del dominio operativo non cita un ticket né un
pattern (skill `domain-boundary`).

## 7. Il dominio analitico in diagnosi

Briefing (BRF) e playbook (PBK) dello scope si leggono **solo in diagnosi** e solo come contesto: orientano le
ipotesi, non entrano nel finding come prova e non finiscono mai in `kb/` o nei test. La prova è l'osservazione, il
trace, l'item del dominio operativo.

## 8. Tassonomia degli errori e comportamento (§47.1)

| Classe | Esempi | Comportamento |
|--------|--------|---------------|
| E1 policy | un guard nega, budget superato | fermarsi, spiegare, **non ritentare** (esito ABORTED-BY-POLICY, nessuna lezione) |
| E2 ambiente | browser, rete, manutenzione, ALM giù, DB bloccato | retry con backoff (3), coda offline dove esiste, poi `blocked` — mai un difetto |
| E3 dati | file non valido, codice inesistente, input fuori dominio | fallire subito, il problema è a monte; nessuna riparazione a runtime |
| E4 esecuzione | passo fallito, elemento assente, asserzione falsa | checkpoint, sorpresa, ripianifica o fermati secondo `repair_policy` |
| E5 cognitivo | traccia incompleta, escalation esaurita, terza sorpresa | `partial` / `escalate` / `needs-input`: decide il manager con l'utente |

## Errori tipici

- Aprire un Defect per un timeout o un errore d'ambiente.
- Diagnosticare dal messaggio d'errore dell'ultimo passo invece che dalla prima divergenza.
- Una sola ipotesi "confermata" senza test discriminante (chiusura prematura, §17.3).
- Classificare `regression` senza il precedente fixed citato, o `product-defect` senza la fonte del comportamento atteso.
