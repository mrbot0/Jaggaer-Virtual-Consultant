# NETWORK — perimetro di rete del plugin (§53.2)

Il plugin parla **solo** con le categorie di host elencate qui. **Nessuna telemetria, nessun endpoint proprio.**
Un host che non rientra in una categoria è negato: nel browser da `guard-environment` (default deny, §53.5),
verso Jira/Xray dall'`AlmAdapter` (`mcp/alm-server/http.mjs`: host non dichiarato in `config/xray.yaml` ⇒ rifiuto,
nessuna richiesta parte, redirect mai seguiti, https obbligatorio salvo loopback).

`doctor --network` legge questa tabella: verifica che le cinque categorie siano dichiarate (`telemetry` con host
`none`) e che ogni host configurato dal cliente (environments.yaml, xray.yaml) rientri nella sua categoria e
nell'allow-list. La tabella è sotto integrità del pacchetto (`integrity.json`): si cambia solo con una release.

<!-- network-categories: tabella letta da scripts/admin/doctor.mjs (colonne: categoria | host | quando | dichiarato in) -->
| categoria | host | quando | dichiarato in |
|-----------|------|--------|---------------|
| jaggaer | dichiarati dal cliente | esecuzione e osservazione nel browser (Chrome DevTools MCP, browser integrato di Claude, Playwright facoltativo) | customers/C/config/environments.yaml (base_url, allowed_hosts) |
| alm | `*.atlassian.net`, `*.getxray.app` | Test Execution, import dei risultati, Defect (server MCP alm, scripts/xray) | customers/C/config/xray.yaml (base_url, jira_url, xray_url): solo quell'host; Server/DC on-premise: l'host dichiarato dal cliente |
| npm | `registry.npmjs.org` | installazione del plugin (npm ci) e primo avvio dei server MCP facoltativi pinnati (npx chrome-devtools-mcp@1.9.0, npx @playwright/mcp@0.0.41) | package-lock.json, .mcp.json |
| claude | `api.anthropic.com` | il modello, tramite Claude Code (non dal plugin) | Claude Code |
| telemetry | none | mai | — |

## Note

- **jaggaer**: nessun host JAGGAER è ammesso finché il cliente non lo dichiara (default deny); un redirect SSO verso
  un host non dichiarato è negato.
- **alm**: le credenziali solo da variabili d'ambiente (`XRAY_CLIENT_ID`/`XRAY_CLIENT_SECRET`, `XRAY_TOKEN`,
  `JIRA_BASE_URL`/`JIRA_USER`/`JIRA_API_TOKEN`), mai nei file né negli argomenti; con Jira irraggiungibile la
  pubblicazione va in coda offline (`customers/C/queue/`), mai un errore del collaudo.
- **npm**: i server MCP del browser (`chrome-devtools`, `playwright`) sono facoltativi (`JVC_MCP_OPTIONAL=1` in
  `.mcp.json`): il browser integrato di Claude è un'alternativa per le letture; senza rete verso il registro npm
  quei server non partono e il plugin funziona comunque con il server `alm` (Node locale).
