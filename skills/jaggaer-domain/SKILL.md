---
name: jaggaer-domain
description: Metodo per orientarsi nel dominio JAGGAER del plugin — le tre partizioni (dominio operativo o analitico × scope × cliente con i livelli S, C, L), il vocabolario degli scope (CAT, SRC, VEN, CON, P2P, INV, QLT, ANL, ADM, XSC) e i termini del glossario (cella, forma epistemica, gap, sorpresa, novità, precedente, strategia, catena logica). Usala quando devi collocare una richiesta o un documento nello scope giusto, capire se un compito attraversa più scope (handoff), distinguere conoscenza di prodotto, del cliente e appresa, o interpretare un termine del sistema; non contiene fatti di prodotto né di clienti, che stanno in kb/ e product/.
---

# jaggaer-domain — orientarsi: partizioni, scope, glossario (§1, §4, §39)

Questa skill è una **mappa per orientarsi**, non una fonte di fatti. Cosa fa un modulo, come è configurato un
cliente, quali campi ha un documento: tutto questo è nella conoscenza (`product/`, `customers/<C>/kb/`) e si
recupera per codice. Qui c'è il metodo per sapere **dove** cercare e **in che cella** stai lavorando.

## Le tre partizioni (§1)

Ogni agente lavora in **una cella**: un dominio × uno scope × un cliente (più il livello prodotto in sola lettura).

**Asse verticale — il dominio (§1.1)**

| | Operativo (`kb/`) | Analitico (`analysis/`) |
|---|---|---|
| scopo | sapere cosa verificare, come configurare, come operare | quando qualcosa va male, capire cosa fare |
| fonti | documentazione standard e del cliente, specifiche di integrazione, release notes, osservazione, esecuzioni, utente | ticket di esercizio, guasti osservati |
| produce | FLW KEY LCY INT CFG CFP SEL HND PMP PRF TBL QRY CHK STR e i test | PAT PBK BRF RUL |
| regola | non cita mai `analysis/` | non cita mai un test |

I due domini non si mescolano (skill `domain-boundary`).

**Asse orizzontale — lo scope (§1.2)**

| Codice | Scope | Perimetro tipico |
|--------|-------|------------------|
| `CAT` | Catalogo | articoli, listini, import, punchout |
| `SRC` | Sourcing | gare, richieste di offerta, aste, valutazione, aggiudicazione |
| `VEN` | Vendor Management | anagrafica, onboarding, qualifica, documenti, scorecard |
| `CON` | Contratti | contratti, clausole, scadenze, prezzi contrattuali |
| `P2P` | Procurement | richieste, approvazioni, ordini, ricezioni |
| `INV` | Fatturazione | fatture, abbinamento, contestazioni |
| `QLT` | Qualità | non conformità, audit, azioni correttive |
| `ANL` | Analytics | modello dati, report, query |
| `ADM` | Amministrazione | organizzazione, utenti, ruoli, workflow, notifiche, numerazioni, SSO, profili di integrazione |
| `XSC` | Trasversale | interfacce, handoff, mappa dei processi, strategie, tabelle di decisione |

Il registro degli scope (con le estensioni del cliente) si legge con `kb scopes`; l'elenco sopra è quello di base.

**Asse di profondità — il cliente e i tre livelli (§1.3)**

- **S** — prodotto standard (`product/`): condiviso, sola lettura per gli agenti di cliente; nasce dalla
  documentazione ufficiale e dalle promozioni della digestione settimanale.
- **C** — cliente (`customers/<C>/`): dalla documentazione del cliente (progetto, configurazione, manuali locali).
- **L** — appreso: da osservazione su Chrome, esecuzioni, dichiarazioni dell'utente.

Risoluzione dei conflitti: **L confermato ≥ 3 volte > C > S**; ogni contraddizione è un item CTR, perché dice dove
la documentazione è superata o dove il cliente ha personalizzato senza scriverlo. La conoscenza fra clienti fluisce
solo attraverso il livello prodotto, dopo la digestione (skill `customer-isolation`).

## Collocare una richiesta: il metodo

1. **Che oggetto tocca?** Un articolo, una gara, un fornitore, un contratto, una richiesta o un ordine, una fattura,
   una non conformità, un report, un'impostazione di amministrazione: lo scope segue l'oggetto, non la schermata da
   cui lo si raggiunge.
2. **Attraversa un confine?** Una richiesta che nasce da un catalogo e diventa un ordine tocca CAT e P2P; un ordine
   trasmesso a un sistema esterno tocca P2P e XSC. Ogni confine ha un contratto di handoff (HND: contratto,
   proprietario del test, cosa asserisce, cosa non deve passare, dove si ferma, test reciproco). Uno scope non crea
   entità di un altro: le consuma come fixture `lookup_or_fail`.
3. **È SaaS o integrato?** Dove si vede (interfaccia contro coda o log), in che tempi (secondi contro minuti),
   chi configura (amministratore della piattaforma contro team del sistema esterno), come fallisce (validazione
   contro silenzio). Un comportamento a cavallo si modella due volte, collegato (§19.4).
4. **Che livello?** Prodotto, cliente o appreso: decide quanto fidarsi e quanto è portabile.
5. **Operativo o analitico?** Se nasce da un ticket o da un guasto, è analitico e resta in `analysis/`.

Nel dubbio sullo scope, `kb resolve` con la domanda in un file trova i codici più vicini: lo scope è nel codice.

## La vista d'insieme (§4)

La sessione principale (manager) parla con l'utente e instrada; le celle per scope hanno i tre ruoli parametrici
(esperto operativo, estrattore, digestore); i trasversali lavorano su più scope o sul cliente intero (profilo,
mappa dei processi, validazione di cluster e lezioni, digestione settimanale, Analytics, triage, root cause,
riparazione dei test, progettazione e audit della configurazione, Defect). Ogni agente esegue il ciclo cognitivo
(skill `reasoning-cycle`); l'esecuzione su Chrome è dell'agente sotto la guardia di script e hook; tutto finisce
nella conoscenza con le sue tre memorie (semantica, episodica, copertura epistemica).

## Glossario essenziale (§39)

| Termine | Significato |
|---------|-------------|
| cella | un dominio × uno scope × un cliente |
| codice | `LIVELLO.CLIENTE.SCOPE.TIPO.SEQ`: nome del file, chiave del DB, riferimento (skill `coding-system`) |
| faccetta | una delle quindici dimensioni a vocabolario chiuso; F15 = genere di fonte |
| genere di fonte | tecnica (com'è fatto) · d'uso (come si usa) · empirica (come si comporta) · testimoniale (cosa dicono) |
| peso W | confidenza × portabilità × stato |
| forma epistemica | consolidato · libresco · empirico · ignoto · contraddittorio |
| gap | attributo atteso non coperto da nessuna fonte: sorgente di domande e osservazioni |
| tre memorie | semantica (ciò che so) · episodica (ciò che è successo) · di lavoro (ciò che scopro) |
| precedente | una DEC passata con esito, a distanza di contesto misurata |
| prior | tasso di esito che entra in una tabella e ne sposta la soglia |
| sorpresa · novità | osservazione che contraddice un item W ≥ 0.70 (ferma il passo) · osservazione di qualcosa che nessuna fonte menzionava (non ferma) |
| strategia | piano di ragionamento codificato, selezionato da DT-017 |
| traccia cognitiva | la prova nel rapporto che il ciclo è stato eseguito |
| catena logica | il percorso di un dato attraverso i documenti; spiega perché un campo è obbligatorio |
| `reason: ui` | obbligatorietà senza ragione a valle: sospetto di personalizzazione, da chiedere |

## Errori tipici

- Usare conoscenza di prodotto "a memoria" invece di recuperarla per codice: può essere superata sul tenant.
- Assegnare lo scope dalla schermata invece che dall'oggetto.
- Trattare un comportamento integrato (asincrono, silenzioso) con gli strumenti di uno SaaS (validazione a video).
