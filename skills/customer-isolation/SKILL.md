---
name: customer-isolation
description: Metodo per non attraversare mai la cartella di un cliente diverso da quello attivo (percorsi, DB, sessioni, budget, credenziali sono per cliente) e per usare correttamente le sole eccezioni — la lettura trasversale di process-mapper (tutti gli scope del cliente attivo) e di weekly-digest (i kb di tutti i clienti, pseudonimizzati), concesse e tolte dal manager, non chieste né prese dall'agente. Usala quando un compito coinvolge un altro cliente o un confronto fra clienti, quando usi precedenti di altri clienti, quando lavori come process-mapper o weekly-digest, quando guard-customer nega una lettura, quando promuovi conoscenza verso il prodotto.
---

# customer-isolation — un cliente alla volta (§1.3, §54.3)

Tutto è per cliente: percorsi, hook, DB, sessioni, budget, credenziali. Il know-how di un cliente è riservato, e
anche un confronto innocuo ("come l'ha configurato l'altro?") è una fuga. La conoscenza fra clienti fluisce **solo**
attraverso il livello prodotto, dopo la digestione settimanale, pseudonimizzata e approvata da un umano.

## La regola

Non leggi, non scrivi, non citi nulla sotto `customers/<X>/` per un `X` diverso dal cliente attivo della sessione.
Non apri il DB di un altro cliente. Non nomini un altro cliente in un item, un test, una lezione o un rapporto del
cliente attivo. `guard-customer` nega; il deny non si aggira (skill `scope-discipline`).

Un consulente che lavora per due clienti apre due sessioni; una sessione non cambia cliente se non con il comando
dell'utente, che prima chiude compensazioni e sotto-compiti aperti.

## Come arriva, legittimamente, l'esperienza di altri clienti

- **Precedenti pesati**: `kb precedents` restituisce anche decisioni di altri clienti **già pesate per portabilità**
  e senza i loro dati; entrano nel prior solo se il controllo di analogia regge (skill `epistemic-awareness`,
  `precedents`), altrimenti orientano soltanto.
- **Il livello prodotto**: item S promossi dalla digestione settimanale, già pseudonimizzati.

Non serve altro: se ti sembra di aver bisogno di leggere un altro cliente, restituisci la domanda al manager.

## Le due eccezioni sono del manager, non tue

| Ruolo | Cosa può leggere | Chi concede | Limiti |
|-------|------------------|-------------|--------|
| `process-mapper` | tutti gli scope del **cliente attivo** e del prodotto | il manager, nella sessione principale, prima del dispatch; lo toglie al ritorno | sola lettura (Read, Glob, Grep), mai `analysis/`, **mai altri clienti**; scade comunque dopo alcune ore |
| `weekly-digest` | i kb e i registri di **tutti** i clienti e del prodotto | come sopra | sola lettura con gli strumenti di lettura; via shell gli altri clienti restano negati: i dati fra clienti li raccoglie lo script della pipeline, pseudonimizzati; in `product/` scrivono solo gli script (candidati) |

Il permesso è registrato nel file di sessione (`cross_read`), vale solo per quel tipo di agente e solo per gli
strumenti di lettura; è in audit. **Tu non lo chiedi e non lo attivi**: lo script di sessione è negato ai
sub-agenti. Se una lettura trasversale ti viene negata, il permesso non c'è: restituisci `status: blocked` e lo dici —
non cercare un'altra strada.

## La digestione settimanale fra clienti (§22)

Raccolta, pseudonimizzazione (il sale sta nell'ambiente, mai in chiaro), allineamento, portabilità, contraddizioni di
prodotto, candidati S, esiti, calibrazione, copertura, decadimento, reindex: tutto con gli script, sotto il lock della
conoscenza. Cosa non fa mai: spostare dati di business fra clienti, promuovere senza approvazione umana, promuovere
item contraddetti, cancellare, cambiare una tabella di decisione senza versione e umano.

La promozione di un candidato è **umana**: la chiedi con `approval_request: { kind: promote, target: <codice> }`; la
frase esatta la mostra all'utente la sessione principale, non tu.

## Riconoscere una fuga prima che accada

Prima di scrivere, rileggi: c'è il nome o il codice di un altro cliente? un valore che viene da un'altra cartella di
cliente? un confronto "cliente A contro cliente B" in un item del cliente attivo? Se sì, togli il riferimento:
nel livello del cliente si scrive solo ciò che vale per lui, con la portabilità dichiarata come ipotesi (sezione 7
della lezione).

## Se succede

Un dato di un altro cliente visibile nella tua cella è una fuga (§54.6): non usarlo, non citarlo, riportalo al
manager con il percorso. La risposta (purge dei dati contaminati, audit, revisione dei permessi) la decidono l'utente
e il processo di sicurezza.
