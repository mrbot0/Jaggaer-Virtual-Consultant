---
name: integration-testing
description: Metodo per collaudare le integrazioni e i confini fra scope — le tre corsie di integrazione (L1 diff del contratto su golden con tolleranze, L2 checkpoint asincrono con DT-013, L3 stub inbound solo in sandbox), la disciplina dei contratti INT (protocollo, mapping con key_ref, errori, semantica del silenzio, stadio di checkpoint, tolleranze, scope proprietario) e HND (chi possiede il test, cosa asserisce, cosa non deve passare, dove si ferma, test reciproco). Usala quando esegui /nrt integration, quando generi o esegui un test INT o HND, quando mappi gli handoff di un processo, quando un messaggio verso un sistema esterno è in ritardo o silente, quando un compito tocca un altro scope.
---

# integration-testing — contratti, corsie, confini (§27.4, §1.2)

Un'integrazione fallisce in silenzio più spesso che a video: il messaggio parte, la coda lo accetta, e l'errore
arriva minuti dopo — o non arriva. Per questo si collauda con contratti espliciti e con corsie diverse da quella
guidata dell'interfaccia.

## Il contratto INT (`schemas/int.schema.json`)

Un item INT non è valido senza: `protocol`, `mappings` (campo FLD → destinazione, obbligatorietà, `key_ref`,
trasformazione, lunghezza massima, gruppi uno-fra), **`silence_semantics`** (cosa significa non ricevere risposta),
`e2e_checkpoint` (lo stadio fino a cui si verifica), `owner_scope`, `touches_scopes`, `tolerances`. In più: trigger,
latenze attese, errori con il loro significato. Le latenze e gli stadi sono conoscenza con freschezza: una latenza
reale diversa da quella dichiarata è un'osservazione da registrare (prior di DT-013), non un difetto.

## Le tre corsie di integrazione

| Corsia | Cosa verifica | Chi | Regola |
|--------|---------------|-----|--------|
| **L1 — contratto su golden** | il payload prodotto contro un golden atteso, campo per campo, con le tolleranze dell'INT | script, nessun modello | una differenza fuori tolleranza è un fallimento del contratto |
| **L2 — checkpoint asincrono** | fino a quale stadio il messaggio è arrivato, entro quanto | lettura della coda via MCP (modello) + script | stadio di default `queued_accepted`; DT-013 sceglie lo stadio con il prior dei timeout |
| **L3 — stub inbound** | cosa fa il sistema quando riceve un messaggio in ingresso | script (descrittore dello stub) | **solo in sandbox** |

    node "${CLAUDE_PLUGIN_ROOT}/scripts/run/integration.mjs" diff --golden <file> --actual <file> --int <INT> --json

Il checkpoint (`checkpoint --int … --reached <stadio> --elapsed-s <n>`) e lo stub (`stub --int …`) sono sotto
comandi dello stesso script: la sintassi completa è nel suo `--help`.

**Timeout classificati (§47.2)**: un timeout di rete è un problema d'ambiente; un timeout su un checkpoint entro la
latenza p95 dichiarata è d'ambiente; oltre, è un'osservazione (la latenza dichiarata era sbagliata). Nessuno dei due
è un Defect finché non è capito (skill `failure-forensics`).

## Il contratto HND e la proprietà dei test

Ogni confine fra scope ha un handoff (`schemas/hnd.schema.json`): `contract` (cosa si produce e si consuma, entità,
stato, via), **`owner_of_test`**, `asserts`, **`does_not_pass`** (ciò che non deve attraversare il confine),
`does_not_assert`, **`stop_at_step`** (il passo a cui il test si ferma: il confine), fixture condivise, test
reciproco. Critici: `stop_at_step` e `does_not_pass`.

Chi testa cosa (§27.2):

- il **proprietario della chiave** testa gli invarianti intrinseci (unicità, formato, immutabilità);
- chi **possiede l'interfaccia** testa la trasformazione (mapping, troncamenti, tolleranze);
- il **consumatore** testa solo che il dato arrivi, e si ferma al confine;
- una catena di campi appartiene allo scope del **documento di origine** della catena.

Un test HND si ferma a `stop_at_step`: asserire oltre il confine è asserire su uno scope che non è il tuo. Le entità
di un altro scope si consumano come fixture `lookup_or_fail`, mai create.

## Quando il compito tocca un altro scope

Non lo fai tu: restituisci `status: blocked` (o `needs-input`) con la **richiesta di handoff** — lo scope
destinatario, il contratto HND che la giustifica, la richiesta, la giustificazione, il rischio dichiarato. La media
il manager: verifica contratto, proprietà e rischio, chiede l'approvazione se serve e fa un dispatch con
`kind: handoff`, `via: agent-manager`, `contract: <HND>` (senza un HND esistente che dichiari lo scope il dispatch è
negato dal codice). Tu ricevi solo l'esito e il codice dell'evidenza: **non vedi come l'altro scope ha fatto**.

## Mappare gli handoff (mappa dei processi)

Per ogni passaggio fra stadi di scope diversi nella mappa dei processi deve esistere un HND. `kb handoffs --scope
<S> --validate` e `kb graph --scope <S>` segnalano handoff mancanti o riferimenti pendenti fra scope: un handoff
mancante è un gap della mappa, da proporre, non da inventare.

## Errori tipici

- Dichiarare verde un'integrazione perché la coda ha accettato il messaggio, quando lo stadio richiesto era oltre.
- Scrivere un INT senza semantica del silenzio: è proprio il caso che fallisce in produzione.
- Un test del consumatore che verifica la trasformazione: è il test del proprietario dell'interfaccia.
- Eseguire lo stub inbound fuori sandbox.
