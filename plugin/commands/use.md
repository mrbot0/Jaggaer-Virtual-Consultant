---
name: use
description: Imposta il contesto di sessione JAGGAER — cliente, ambiente, scope, modalità, budget (scrive session.json; i guard lo leggono)
argument-hint: customer <ID> [--new] | env <id> | scope <ID> | mode <nrt|config|ops|diag|esplorazione> | budget <n> | close-stale | show
allowed-tools: Bash(node *)
---

Contesto di sessione (§56.2). Esegui con lo strumento Bash, senza modificare gli argomenti:

    node "${CLAUDE_PLUGIN_ROOT}/scripts/admin/session.mjs" use $ARGUMENTS --session "${CLAUDE_SESSION_ID}" --json

Poi riporta all'utente, in al massimo sei righe, lo stato risultante: cliente, ambiente (con il banner
di templates/workflow.md), scope, modalità, **livello di autonomia** (campo `autonomy` di `show`: effettivo, scelto, fonte,
tetto dell'ambiente), budget usato/totale, pendenze. Regole:

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
  produzione (es. `type: prod` con tre approvazioni mancanti o con il livello rosso in `config_levels`; `write_data` in
  produzione è un interruttore dell'utente, vero o falso, e non dà exit 3): si corregge il file fuori sessione.
- Sul browser (giro di correzione 1): prima di ogni click o input serve una navigate verso un host
  dichiarato (l'origine viene registrata; cambiare scheda o pagina la azzera); gli script nella pagina
  sono negati ovunque: si legge con snapshot, read_page, get_page_text. Senza piano attivo le azioni
  con effetto sono negate; `mode esplorazione` (in audit, sandbox e pre-produzione) è un'**unica
  esplorazione**: clicca tutto, compila con valori di prova, salva, invia, approva, conferma i dialoghi; mai
  cancellazioni, upload di file, script nella pagina, strumenti non classificati, produzione; nessun tetto di
  azioni per agente. Ogni click vuole un elemento con nome dell'ultima lettura (i click a coordinate sono negati). In
  pre-produzione si esplora con Chrome DevTools (il browser di Claude fuori dalla sandbox legge soltanto). Le pagine
  pesanti ("pagina troppo grande") si leggono **a pezzi**: con DevTools `take_snapshot` con `filePath` assoluto
  nella cartella `snapshots/` della sessione (il plugin legge il file appena scritto dallo strumento come lettura
  completa; l'agente lo legge a pezzi con Read); col browser di
  Claude read_page con ref_id o depth, e i pezzi della stessa pagina si sommano. Rischio da dire all'utente: in
  pre-produzione un invio può mandare davvero e-mail ai fornitori o dati all'ERP. La sceglie solo l'utente:
  serve che abbia appena scritto `ESPLORA SANDBOX` (sandbox) o `ESPLORA PREPROD` (pre-produzione) — le varianti
  `ESPLORA SANDBOX COMPLETA` / `ESPLORA PREPROD COMPLETA` sono sinonime — (frase registrata da
  approval-capture, vale per un solo cambio di modalità entro 10 minuti); altrimenti exit 3 — riportalo
  e attendi, non scrivere tu la frase.
- exit 1: mostra l'errore e la sintassi corretta (`customer <ID> [--new]`, `env <id>`, `scope <ID>`,
  `mode <nrt|config|ops|diag|esplorazione>`, `budget <n>`, `close-stale`, `show`). Se lo stato è illeggibile, `customer <ID>`
  lo ripara (ne resta una copia `.corrupt-<data>`).
- Il budget si alza solo con questo comando, su richiesta esplicita dell'utente: mai di tua iniziativa.
- Il file di stato non si modifica a mano: solo tramite questo comando e gli hook del plugin.
- Le approvazioni (3A, §52.2) non si danno con questo comando né con altri: le scrive l'utente con le
  frasi esatte (`APPROVO PIANO <PLAN>` …) e le registra l'hook approval-capture.
- Il **livello di autonomia** (alto, medio, basso) non si imposta con questo comando: lo sceglie l'utente con
  `AUTONOMIA ALTA` · `AUTONOMIA MEDIA` · `AUTONOMIA BASSA` (per la sessione) o con `default:` in
  `customers/<C>/config/autonomy.yaml`; predefinito alto, in produzione al massimo medio; file illeggibile o valore non
  valido ⇒ basso. `use show` lo mostra.
