---
name: faceting-and-weights
description: Metodo per assegnare le quindici faccette di un item (F1 origine … F15 genere di fonte, ciascuna con vocabolario chiuso e un responsabile) e per leggere i numeri che ne derivano — peso della fonte, confidenza, portabilità P, peso effettivo W, qualità Q e classe d'uso, decadimento per tipo. Usala quando estrai o digerisci un item e devi faccettarlo, quando validi un cluster o la portabilità, quando nel recupero devi capire perché un item pesa poco o non è utilizzabile per un'azione R2, quando profili un cliente (F6, F7 ereditate).
---

# faceting-and-weights — faccette, confidenza, pesi, qualità (§6)

Le faccette rendono la conoscenza interrogabile e confrontabile; i pesi dicono **quanto fidarsi** (confidenza),
**quanto vale qui** (W) e **quanto si può usare** (Q). I numeri li calcolano gli script (`scripts/kb/weights.mjs`,
`scripts/kb/quality.mjs`): tu assegni le faccette di tua competenza e leggi i numeri, non li stimi.

## Le quindici faccette e chi le assegna (§6.1)

| # | Faccetta | Vocabolario (chiuso) | Chi |
|---|----------|----------------------|-----|
| F1 | origine | doc-standard · doc-cliente-tecnica · doc-cliente-utente · spec-integrazione-formale · spec-integrazione-prosa · release-notes · ticket · osservazione-chrome · esecuzione-test · esecuzione-config · dichiarazione-utente · promozione-digest | extractor |
| F2 | livello | S · C · L | dal codice |
| F3 | scope | CAT … XSC | dal codice |
| F4 | natura | procedura · vincolo · struttura-dati · regola-business · comportamento-ui · contratto-interfaccia · oggetto-config · anomalia · decisione · query · check · mappa-processo · profilo · strategia | digester |
| F5 | classe di sistema | saas-core · modulo-addon · app-integrata-erp · middleware · identity-provider · portale-fornitori · reporting-analytics · notifica-email · trasferimento-file · plugin-cliente | digester |
| F6 | modello di procurement | direct · indirect · misto · pubblico-normato · … (quindici valori) | profiler, ereditata |
| F7 | ERP | sap-ecc · sap-s4 · oracle · dynamics · altro · nessuno | profiler, ereditata |
| F8 | portabilità | universale · condizionata(faccetta) · specifica · ignota | validator, digestione |
| F9 | ripetitività | una-tantum · periodica · ripetitiva · continua | digester |
| F10 | rischio di azione | R0 · R1 · R2 · R3 | digester, verificato |
| F11 | determinismo | deterministico · probabilistico · richiede-input | digester |
| F12 | stato | grezzo · digerito · validato · clusterizzato · promosso · deprecato · quarantena | pipeline |
| F13 | freschezza | data dell'ultima verifica + release | esecuzione |
| F14 | confidenza | 0.00–1.00 | calcolata |
| F15 | genere di fonte | tecnica (com'è fatto) · d'uso (come si usa) · empirica (come si comporta) · testimoniale (cosa dice chi lo usa) | derivata da F1 |

Regole di metodo:

- Assegni **solo** le faccette del tuo ruolo; le altre le eredita o le calcola la pipeline.
- Un valore fuori vocabolario non esiste: la validazione (`validate-schema`) lo rifiuta. Nel dubbio fra due valori,
  scegli quello che la fonte dice esplicitamente, e dichiara l'altro in `gaps` o come domanda.
- F15 non si sceglie: discende da F1. È la faccetta che separa specifiche e manuali (skill `epistemic-awareness`).
- F5 applica il criterio SaaS contro integrato (dove si vede, in che tempi, chi configura, come fallisce): un item a
  cavallo si sdoppia in comportamento UI e contratto d'interfaccia, collegati (§19.4).

## Peso della fonte e confidenza (§6.2, §6.3)

Il peso di base dipende dall'origine: un esito di esecuzione o un'osservazione confermata tre volte valgono 1.00, la
specifica formale 0.95, la dichiarazione dell'utente 0.85, il documento tecnico del cliente 0.80, i manuali 0.70, il
ticket 0.50 (solo dominio analitico). Se il documento ha un profilo `DOC`, il suo `reliability.score` sostituisce il
peso generico (§19.7).

```
confidenza = peso_fonte × freschezza × (1 + 0.05 × min(conferme, 3)) × (1 − 0.3 × contraddizioni_aperte)
  freschezza: release corrente 1.00 · una fa 0.90 · due 0.75 · tre o più 0.50

  < 0.40 grezza (non utilizzabile) · 0.40–0.69 plausibile (esplorazione e proposte; mai R2/R3)
  0.70–0.89 affidabile (test, azioni R0/R1) · ≥ 0.90 verificata (R2 con approvazione; R3 mai in autonomia)
```

## Portabilità e peso effettivo (§6.3)

```
P = (clienti_confermanti − 2 × clienti_contraddicenti) / clienti_osservati
  universale: P ≥ 0.80, ≥ 2 clienti, 0 contraddizioni · condizionata: una faccetta spiega la partizione
  specifica: nessuna faccetta spiega · ignota: meno di 2 clienti

W = confidenza × moltiplicatore_portabilità × moltiplicatore_stato
```

Il recupero ordina per W e **tronca**: un item con W basso non è sbagliato, è poco pertinente qui (altro cliente con
portabilità non soddisfatta, stato solo digerito). Un item in quarantena o grezzo pesa zero.

## Il genere pesa diversamente per tipo di decisione (§6.4)

Progettare una configurazione pesa la fonte tecnica al 50%; eseguirla pesa l'empirica al 50%; scegliere un selettore
pesa l'empirica al 75%; classificare un fallimento è l'unica decisione in cui il dominio analitico pesa (30%). La
colonna "analitico" a zero ovunque tranne la diagnosi è la regola dei domini in forma numerica.

## Qualità Q e classi d'uso (§6.5)

La qualità risponde a "quanto posso **usare** questa informazione, per cosa e per quanto ancora": sedici parametri
(età, distanza di release, autorità, genere, stato del documento, corroborazione, contraddizioni, specificità,
completezza, verificabilità, metodo di verifica, recenza, applicabilità, stabilità, qualità dell'unità sorgente,
ambiente di provenienza), pesati per tipo di decisione da `decision-tables/quality-weights.yaml`.

| Q | Classe | Cosa ci si può fare |
|---|--------|---------------------|
| ≥ 0.85 | operativa | ogni azione entro il perimetro di rischio; base per `STR-REPLAY` |
| 0.70–0.84 | affidabile | R0/R1, generazione di test, progettazione con verifica prima di R2 |
| 0.50–0.69 | indicativa | solo esplorazione, proposte, domande; mai unica fonte di un'azione |
| < 0.50 | da-riverificare | non utilizzabile finché un'osservazione o un'esecuzione non la riporta sopra soglia |

Un'azione R2 su un soggetto la cui informazione migliore è `indicativa` diventa una domanda, qualunque sia la
confidenza dichiarata. `kb find` mostra Q accanto a W: Q dice quanto puoi usarlo, W quanto è pertinente adesso.

**Decadimento** (§6.5.2): ogni tipo invecchia con la sua emivita (`schemas/decay.yaml`): i selettori in poche
settimane, lo stato di configurazione in pochi mesi, le regole di obbligatorietà e le interfacce in circa sei mesi,
flussi e procedure in circa un anno, mappe e profili in circa due; decisioni e lezioni non decadono (sono storia).
Oltre la soglia un item non è deprecato: passa a `da-riverificare` ed entra fra le osservazioni R0 da fare.

## Errori tipici

- Assegnare F6/F7 su un item di scope invece di ereditarle dal profilo del cliente.
- Promuovere la confidenza con la promozione: `promozione-digest` vale il minimo dei contributori.
- Usare un item `indicativo` come unica base di un'azione con effetti.
- Leggere un W basso come "falso" e ignorare il gap che rivela.
