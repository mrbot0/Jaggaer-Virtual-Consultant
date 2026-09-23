# Blocco workflow — intestazione con il banner di ambiente (§51.3, §52.4, §57.3)

Il manager riscrive il blocco a ogni evento e lo tiene in fondo alla conversazione. La prima riga
porta SEMPRE l'ambiente dichiarato in sessione (`session.json.env`, scritto da `/use env` e
verificato da `env-check`), con il banner del suo tipo. Il banner non si omette e non si abbrevia:
in produzione compare su ogni aggiornamento.

```
┌ WORKFLOW · {customer} · {banner} · scope {scope} · modalità {mode} · budget {used}/{tokens} ┐
{righe dei passi: agente · classe ACT · descrizione · stato ▶ ✓ ⏸ ✗ · · evidenza}
└ sorprese {n} · errori {n} · evidenze {n} ┘
```

## Banner per stato dell'ambiente

| Stato di `session.env` | `{banner}` | Colore |
|---|---|---|
| assente | `⚠ AMBIENTE NON DICHIARATO — nessuna azione sul browser: /use env <id>` | rosso |
| dichiarato, `verified: false` | `{label} ({id}) — NON VERIFICATO: solo navigazione e lettura finché env-check non riconosce ≥ 2 segnali` | grigio |
| `type: sandbox` o `dev`, verificato | `SANDBOX` | giallo |
| `type: preprod`, verificato | `PRE-PROD` (per ACT-APPROVE/TRANSMIT/PUBLISH: `con referente`) | arancione |
| `type: prod`, verificato | `⚠ PRODUZIONE — sola lettura sui dati` | rosso |

## Produzione con configurazione in corso (§52.4)

Alla riga di intestazione si aggiunge lo stato 3A letto da
`node "${CLAUDE_PLUGIN_ROOT}/scripts/admin/approvals.mjs" status --json` (sola lettura):

```
┌ WORKFLOW · ACME · ⚠ PRODUZIONE — sola lettura sui dati · configurazione 3A: A1 ✓ 10:02 · A2 ✓ 10:19 (M. Rossi) · A3 passo 4/7 ⏸ ┐
```

Prima di ogni A3 il manager ripete in una riga cosa sta per cambiare e come si torna indietro, poi
chiede la frase esatta `APPROVO PASSO <n> <PLAN.id>`. Le frasi valide (§57.2):

| Situazione | Frase dell'utente |
|---|---|
| Azione R2 in sandbox/preprod | `sì` alla domanda del workflow (una sola richiesta aperta) |
| Configurazione verde | `APPROVO PIANO <PLAN>` |
| Configurazione giallo | `APPROVO PIANO <PLAN>` poi `APPROVO PASSO <n> <PLAN>` |
| Configurazione rosso | `APPROVO PIANO` · `APPROVO PROVA` · `APPROVO PASSO <n>` |
| Produzione, qualunque configurazione | le tre frasi entro la finestra (default 60 min da A1), A2 `DA <Nome Cognome>` di una persona diversa da A1 se `second_approver_required` |

Un "ok", un "va bene" o una frase con piano o passo sbagliati non valgono: l'hook `approval-capture`
non registra nulla e il manager lo dice e attende. Il token di un passo vale una volta sola.

## Rifiuti da riportare così come sono (§58)

| Motivo del guard | Cosa dire |
|---|---|
| `nessun ambiente dichiarato` | Serve `/use env <id>` (o l'ambiente nell'intento) |
| `ambiente … non verificato` | Esegui env-check sulla pagina di base_url; non forzare |
| `host non dichiarato` | Redirect SSO o CDN non dichiarati: l'host va aggiunto in environments.yaml fuori sessione |
| `In produzione non si scrivono dati` | È corretto: si può fare in sandbox o pre-produzione |
| `Approvazione non valida` / `finestra 3A scaduta` | Scrivere la frase esatta; se scaduta, ripartire da A1 |
