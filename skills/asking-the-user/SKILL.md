---
name: asking-the-user
description: Metodo per decidere quando una lacuna impone una domanda all'utente e quando basta un'assunzione dichiarata, e per formulare la domanda dai gaps del profilo epistemico (contesto, cosa so, cosa non so, perché conta, domanda, opzioni, cosa farò). Usala quando DT-002 restituisce chiedi, quando una strategia è STR-ASK-EARLY, quando manca un dato obbligatorio per creare un documento o progettare una configurazione, per le domande di profilo del cliente, per le domande di apprendimento di fine sessione, e quando restituisci needs-input al manager.
---

# asking-the-user — chiedere bene, poco e una volta (§16)

Una domanda costa attenzione dell'utente, la risorsa più scarsa del sistema. Si chiede solo quando la tabella lo
dice, solo ciò che il sistema non sa, e in una forma che mostra che il lavoro è stato fatto.

**Chi parla con l'utente è solo la sessione principale.** Un sub-agente non chiede: restituisce
`status: needs-input` con la domanda **già formulata** nel campo `needs_input: { question, options, gap }`; il
manager la porta all'utente e ti ridispaccia con la risposta (`reply_to`). Le approvazioni non sono domande: si
chiedono con `approval_request` e la frase esatta la mostra il manager (mai tu).

## Quando chiedere (§16.1)

Decide DT-002 (skill `decision-tables`): `chiedi` o `fermati` → domanda; `procedi-con-assunzione` → **nessuna
domanda**, ma l'assunzione va dichiarata in `why.assumed` e nella lezione. Tre regole in più:

1. **Mai ciò che il DB sa**: un item con confidenza ≥ 0.70 e stato ≥ validato è una risposta, non una domanda.
   Prima di chiedere richiama (`kb find`, `kb resolve`).
2. **Mai due volte** allo stesso cliente: la risposta diventa un item L; cercala prima di chiedere di nuovo.
3. **Una per volta se dipendenti, a lotti se indipendenti**: se la risposta alla prima cambia la seconda, la
   seconda aspetta.

## Da dove vengono le domande: i gaps

Non "non sono sicuro", ma l'attributo atteso non coperto: "l'attributo `impacts` di `<codice>` non è coperto da
nessuna fonte tecnica e l'azione è R2". La domanda cita il gap, e la risposta lo chiude. I `gaps` li dà
`kb epistemic` (skill `epistemic-awareness`); per i documenti anche il report di ingestion.

## Come formularla (§16.2)

```
[CONTESTO]      cosa sto facendo, su quale soggetto (codice e nome leggibile)
[COSA SO]       le fonti che coprono il soggetto, con il loro genere e la loro età
[COSA NON SO]   i gap, per nome di attributo
[PERCHÉ CONTA]  il rischio dell'azione e cosa non posso garantire senza la risposta
[DOMANDA]       una sola domanda chiusa
[OPZIONI]       a) … b) … c) non lo so / chiedo al referente
[COSA FARÒ]     per ogni opzione, il comportamento conseguente (anche per "non lo so")
```

`[COSA SO]` e `[COSA NON SO]` vengono dal profilo epistemico: l'utente vede che il sistema ha fatto i compiti e
risponde più volentieri. L'opzione "non lo so" c'è sempre, e ha un comportamento prudente (di norma quarantena del
soggetto e nessuna azione R ≥ R2).

Nel rapporto:

```yaml
status: needs-input
needs_input:
  question: "<la [DOMANDA] con il contesto essenziale>"
  options: ["a) …", "b) …", "c) non lo so / chiedo al referente"]
  gap: <attributo> di <codice>
open_questions: []            # le altre, se indipendenti, in lotto; marcate bloccanti o no
```

## Cosa succede con la risposta (§16.3)

La risposta diventa un item L testimoniale (0.85), una lezione sul perché la documentazione non bastava, una CTR se
contraddice qualcosa, e aggiorna il profilo epistemico: il gap è chiuso dal genere `testimoniale`, che è meglio di
niente ma non è `tecnica` — DT-019 dirà se cercare comunque la fonte tecnica.

## Domande di apprendimento (§16.4)

A fine sessione, al più due, facoltative, dai gaps dei soggetti più pesanti e dalle novità viste (§13.5): "ho visto
un campo non documentato: è usato? da chi?". Non bloccano nulla: vanno in `open_questions` marcate non bloccanti.

## Domande di profilo e di configurazione

- **Profilo del cliente**: le domande di apertura vengono dai gaps dei soggetti critici e dall'inventario della
  documentazione (per quali scope manca una fonte tecnica).
- **Configurazione**: su una forma `libresco` prima si elencano le osservazioni R0 che chiuderebbero i gaps; si
  chiede solo ciò che nessuna osservazione può dire (intenzione, impatto voluto, finestra).
- **Operatività**: i campi obbligatori mancanti per creare un documento li dice `kb fields --mandatory-in`; si
  chiedono tutti insieme, a lotto, prima di toccare il tenant.

## Errori tipici

- Chiedere ciò che un'osservazione R0 potrebbe verificare in un minuto.
- Domande aperte ("come è configurato?") invece di chiuse con opzioni e conseguenze.
- Chiedere a metà di un'azione con effetti: le domande vengono prima di toccare (STR-ASK-EARLY).
- Scrivere nella domanda una frase di approvazione o di controllo dell'utente: non la scrivi mai tu.
- Troppe domande: più di una manciata per compito è il segnale che il soggetto è `ignoto` e serve un'esplorazione.
