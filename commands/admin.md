---
description: Operazioni amministrative JAGGAER fuori dal lavoro quotidiano — retention, cancellazione di un cliente (purge con due approvazioni), lock, sessioni, integrità del pacchetto (admin)
argument-hint: retention [--apply] | customer purge <ID> | lock [--clear-expired] | session [close-stale] | integrity
allowed-tools: Bash(node *)
---

Operazioni (§56.8, §54.4). Sempre script diretti, mai un sub-agente (§26.2 R5: fuori dal lavoro quotidiano, nessun
ragionamento di dominio). `<C>` è il cliente attivo (`/use show`). La prima parola di `$ARGUMENTS` è l'azione. Le
approvazioni le scrive **solo l'utente**, come unico testo del suo messaggio; l'hook approval-capture le registra e
risponde con il token (16 cifre esadecimali, monouso). Tu non scrivi mai le frasi (i guard le negano in ogni input),
non inventi token e usi le righe di comando **esattamente** come sono qui: sono le sole forme ammesse dai guard, che
confermano ogni approvazione nel transcript.

## `retention [--apply]` — scadenze dichiarate (1 approvazione)

Prova a secco (elenco degli scaduti: osservazioni, evidenze e sessioni oltre 90 giorni; run e report oltre 12 mesi;
l'audit e la conoscenza mai):

    node "${CLAUDE_PLUGIN_ROOT}/scripts/admin/retention.mjs" <C> --json

Mostra l'elenco. Per applicare, l'utente scrive `APPROVO RETENTION <C>` (vale 60 minuti); poi, con il token restituito:

    node "${CLAUDE_PLUGIN_ROOT}/scripts/admin/retention.mjs" <C> --apply --approval <token> --json

Riporta il certificato (`.jvc/retention-certificates/`) e i percorsi rimossi. Exit 3 = approvazione mancante, scaduta,
già usata o non confermata: si ripete la frase.

## `customer purge <ID>` — l'unica cancellazione del plugin (2 approvazioni con frase, certificato)

Solo in una sessione del cliente `<ID>` stesso. Due persone diverse scrivono, ciascuna come unico testo del proprio
messaggio:

    APPROVO PURGE <ID> DA <Nome Cognome>

(la seconda con un altro nome: lo stesso nome due volte è respinto; ciascuna vale 60 minuti). Con i due token,
prima l'inventario senza scritture (file, byte, item promossi in `product/`, verifica delle approvazioni):

    node "${CLAUDE_PLUGIN_ROOT}/scripts/admin/purge.mjs" <ID> --approval-1 <token1> --approval-2 <token2> --json

Mostra l'inventario e chiedi conferma esplicita all'utente; solo dopo il suo sì:

    node "${CLAUDE_PLUGIN_ROOT}/scripts/admin/purge.mjs" <ID> --execute --approval-1 <token1> --approval-2 <token2> --json

Riporta il certificato (`.jvc/purge-certificates/`), i `promoted_from` sostituiti in `product/` e i puntatori di sessione
azzerati. Non esistono altre cancellazioni: file, righe o record si compensano (`close`/`cancel`), non si cancellano.

## `lock [--clear-expired]` — lock della conoscenza

    node "${CLAUDE_PLUGIN_ROOT}/scripts/admin/lock.mjs" show --json

Proprietario, scadenza, processo vivo ("DB bloccato" in §58). Solo su richiesta esplicita dell'utente, per i soli lock
scaduti di processi non più vivi:

    node "${CLAUDE_PLUGIN_ROOT}/scripts/admin/lock.mjs" --clear-expired --json

## `session [close-stale]` — sessioni

    node "${CLAUDE_PLUGIN_ROOT}/scripts/admin/session.mjs" show --session "${CLAUDE_SESSION_ID}" --json

Stato della sessione (cliente, ambiente e verifica, scope, modalità, budget, pendenze, sotto-compiti aperti). Con
`close-stale`, solo su richiesta esplicita dell'utente, chiude a mano i sotto-compiti rimasti aperti (in audit):

    node "${CLAUDE_PLUGIN_ROOT}/scripts/admin/session.mjs" use close-stale --session "${CLAUDE_SESSION_ID}" --json

## `integrity` — verifica del pacchetto (sola lettura)

    node "${CLAUDE_PLUGIN_ROOT}/scripts/admin/integrity.mjs" verify --json

Esito `ok`, file alterati, mancanti o in più, firma. Integrità fallita = pacchetto manomesso: i guard negano tutto, si
reinstalla dalla release firmata e **non si opera**. `integrity build` non si esegue mai da una sessione: riscrive il
manifesto e si fa solo nel repository del plugin, per una release.

## Regole

- exit 1: sintassi (argument-hint) o cliente inesistente; exit 2: errore di sistema; exit 3: approvazione mancante o
  non valida, riportala e fermati.
- Qualunque altra richiesta di cancellare (file, cartelle, righe del DB, entità sul tenant) si rifiuta: il verbo DELETE
  non esiste; si propone la compensazione.
