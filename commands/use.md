---
description: Imposta il contesto di sessione JAGGAER — cliente, ambiente, scope, modalità, budget (scrive session.json; i guard lo leggono)
argument-hint: customer <ID> [--new] | env <id> | scope <ID> | mode <nrt|config|ops|diag> | budget <n> | close-stale | show
allowed-tools: Bash(node *)
---

Contesto di sessione (§56.2). Esegui con lo strumento Bash, senza modificare gli argomenti:

    node "${CLAUDE_PLUGIN_ROOT}/scripts/admin/session.mjs" use $ARGUMENTS --session "${CLAUDE_SESSION_ID}" --json

Poi riporta all'utente, in al massimo sei righe, lo stato risultante: cliente, ambiente (con il banner
di templates/workflow.md), scope, modalità, budget usato/totale, pendenze. Regole:

- exit 3 con `pending_compensations` (compensazioni pendenti del cliente precedente): elenca i
  codici restituiti e chiedi come chiuderle; non cambiare cliente per altra via.
- exit 3 con `open_tasks` (sotto-compiti ancora aperti): cliente e scope non cambiano finché i
  sub-agenti elencati non hanno chiuso con il loro rapporto; attendili, poi riesegui. Un dispatch
  che non chiuderà mai (permesso negato, interruzione, errore dello strumento) scade da solo dopo
  2 ore; prima, solo su richiesta esplicita dell'utente, `close-stale` li chiude a mano (in audit).
- `env <id>` (§51.2) dichiara l'ambiente da `customers/<C>/config/environments.yaml`; resta
  **non verificato** (solo navigazione e lettura sul browser) finché non verifichi l'impronta:
  1. apri `base_url` dell'ambiente con lo strumento MCP del browser (navigate) e salva lo snapshot
     della pagina (take_snapshot / read_page) in un file della sessione, per esempio
     `customers/<C>/.sessions/<sid>/env-page.txt`;
  2. esegui `node "${CLAUDE_PLUGIN_ROOT}/scripts/chrome/env-check.mjs" --env <id> --snapshot <file> --write-session --session "${CLAUDE_SESSION_ID}" --json`;
  3. exit 0 = verificato (≥ 2 segnali); exit 3 = `unknown` o rifiutato: riporta segnali e motivo
     (§58 "Ambiente non riconosciuto"), **non forzare** e non ripetere con un altro snapshot.
  Cambiare ambiente azzera la verifica. exit 3 su `use env` = environments.yaml viola le regole di
  produzione (es. `type: prod` con `write_data: true`): si corregge il file fuori sessione.
- exit 1: mostra l'errore e la sintassi corretta (`customer <ID> [--new]`, `env <id>`, `scope <ID>`,
  `mode <nrt|config|ops|diag>`, `budget <n>`, `close-stale`, `show`). Se lo stato è illeggibile, `customer <ID>`
  lo ripara (ne resta una copia `.corrupt-<data>`).
- Il budget si alza solo con questo comando, su richiesta esplicita dell'utente: mai di tua iniziativa.
- Il file di stato non si modifica a mano: solo tramite questo comando e gli hook del plugin.
- Le approvazioni (3A, §52.2) non si danno con questo comando né con altri: le scrive l'utente con le
  frasi esatte (`APPROVO PIANO <PLAN>` …) e le registra l'hook approval-capture.
