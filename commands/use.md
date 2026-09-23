---
description: Imposta il contesto di sessione JAGGAER — cliente, scope, modalità, budget (scrive session.json; i guard lo leggono)
argument-hint: customer <ID> [--new] | scope <ID> | mode <nrt|config|ops|diag> | budget <n> | close-stale | show
allowed-tools: Bash(node *)
---

Contesto di sessione (§56.2). Esegui con lo strumento Bash, senza modificare gli argomenti:

    node "${CLAUDE_PLUGIN_ROOT}/scripts/admin/session.mjs" use $ARGUMENTS --session "${CLAUDE_SESSION_ID}" --json

Poi riporta all'utente, in al massimo sei righe, lo stato risultante: cliente, scope, modalità,
budget usato/totale, pendenze. Regole:

- exit 3 con `pending_compensations` (compensazioni pendenti del cliente precedente): elenca i
  codici restituiti e chiedi come chiuderle; non cambiare cliente per altra via.
- exit 3 con `open_tasks` (sotto-compiti ancora aperti): cliente e scope non cambiano finché i
  sub-agenti elencati non hanno chiuso con il loro rapporto; attendili, poi riesegui. Un dispatch
  che non chiuderà mai (permesso negato, interruzione, errore dello strumento) scade da solo dopo
  2 ore; prima, solo su richiesta esplicita dell'utente, `close-stale` li chiude a mano (in audit).
- exit 1: mostra l'errore e la sintassi corretta (`customer <ID> [--new]`, `scope <ID>`,
  `mode <nrt|config|ops|diag>`, `budget <n>`, `close-stale`, `show`). Se lo stato è illeggibile, `customer <ID>`
  lo ripara (ne resta una copia `.corrupt-<data>`).
- Il budget si alza solo con questo comando, su richiesta esplicita dell'utente: mai di tua iniziativa.
- Il file di stato non si modifica a mano: solo tramite questo comando e gli hook del plugin.
