# F5 — Report di fase, parte strumenti (WP09c: ALM / Xray)

Stato: **strumenti pronti** per il sink `xray` delle evidenze (§27.5) e per il Defect (§30.4): `AlmAdapter` con le tre
implementazioni, server MCP ALM del plugin, script `scripts/xray/*`, coda offline, `.mcp.json` e `NETWORK.md`. Tutto
gira contro un mock HTTP locale (`node:http`) e contro il mock in memoria; **mai** contro Jira/Xray reali. Restano fuori
per costruzione: i comandi `/nrt push-xray` e `/nrt report` (WP10a), l'agente `defect-reporter` (WP10b) e la prova sul
tenant e sul Jira del cliente (criterio M13, "Test Execution con evidenze sul passo corretto, leggibile dal QA lead").

Suite completa alla consegna: vedi `.superpowers/sdd/wp09c-report.md` (conteggio e tempi). Prima di WP09c erano 809 test,
tutti verdi e rimasti verdi.

## Cosa c'è

| Deliverable | File | Prova |
|-------------|------|-------|
| A `AlmAdapter` (§46.5) | `mcp/alm-server/adapter.mjs` (interfaccia JSDoc, `assertAdapter`: nessun `delete*`, `update*`, `createIncident`) | `test/contract/alm-adapter.test.mjs` (lo stesso contratto per le tre implementazioni) |
| A Xray Cloud | `mcp/alm-server/xray-cloud.mjs` (`/api/v2/authenticate`, GraphQL, `/api/v2/import/execution` nativo, Jira REST per esecuzioni, Defect, link, allegati) | contratto + richieste registrate dal mock HTTP |
| A Xray Server/DC | `mcp/alm-server/xray-server.mjs` (PAT `XRAY_TOKEN`, `/rest/raven/1.0/import/execution`, `testexec`/`testrun` per la rilettura) | contratto + richieste registrate |
| A Mock | `mcp/alm-server/mock.mjs` (memoria + file JSON, ogni chiamata registrata, rete simulata giù) | contratto, server MCP, e2e dei guard |
| A Factory | `mcp/alm-server/factory.mjs` (`config/xray.yaml.deployment`, `JVC_ALM_ADAPTER=mock`) | `factory` nel contratto |
| A Rete | `mcp/alm-server/http.mjs` (solo host dichiarati in `xray.yaml`, https salvo loopback, redirect mai seguiti, retry E2, errori redatti) | host non dichiarato, redirect, segreti mai nei messaggi |
| A Evidenze verso Jira | `mcp/alm-server/payload.mjs` (dal dossier: EVD `strict` + `publishable`, sotto `runs/`, sha256) | `evidenze dal dossier` nel contratto |
| A Coda offline (ADR-22) | `mcp/alm-server/queue.mjs` (`runs/<RUN>/xray-payload.json` + `customers/<C>/queue/<id>.json`, `{ queued: true }`, `retryQueued`) | contratto (rete giù ⇒ in coda ⇒ retry ⇒ inviato), server MCP, `publish` |
| A Server MCP (§44.6) | `mcp/alm-server/server.mjs` (JSON-RPC 2.0 stdio in proprio, 7 strumenti esatti) | `test/mcp/alm-server.test.mjs`, `test/hooks/wp09c-alm-e2e.test.mjs` |
| B Script | `scripts/xray/{authenticate,build-payload,publish,verify,retry-queued,defect,common}.mjs` | `test/xray/xray-scripts.test.mjs` |
| B Schema | `schemas/xray-config.schema.json` | `factory` nel contratto (Incident, stato FAILED per l'ambiente, segreti nel file ⇒ rifiuto) |
| C `.mcp.json` | `alm` (node, `${CLAUDE_PLUGIN_ROOT}`), `chrome-devtools-mcp@1.9.0` e `@playwright/mcp@0.0.41` facoltativi | `.mcp.json` in `test/mcp/alm-server.test.mjs` |
| C `NETWORK.md` | cinque categorie (jaggaer, alm, npm, claude, telemetry = none); `doctor --network` le legge (`network-categories`); sotto integrità | `test/admin/wp09c-network.test.mjs`, `test/admin/integrity.test.mjs` |

Tutte le CLI hanno `--help`, `--json`, exit code 0 · 1 · 2 · 3 e accettano i dati da file o `chiave=valore` (mai JSON in
linea). Le credenziali solo dall'ambiente (`XRAY_CLIENT_ID`/`XRAY_CLIENT_SECRET`, `XRAY_TOKEN`,
`JIRA_BASE_URL`/`JIRA_USER`/`JIRA_API_TOKEN`), mai stampate.

## Test di fase del piano (F5)

| Piano | Test | Dove |
|-------|------|------|
| Contratto contro il mock | lo stesso contratto per mock, cloud e server | `test/contract/alm-adapter.test.mjs` |
| Evidenze sul passo | build-payload (passo 3 e 4), import registrato dal mock HTTP (file giusto sul passo giusto), rilettura (`verify`) | `xray-scripts.test.mjs`, contratto |
| Jira giù → `queued` | adattatore, server MCP e `publish`; `retry-queued` con la rete tornata | contratto, `alm-server.test.mjs`, `xray-scripts.test.mjs` |
| Una Test Execution per run e scope | due scope nello stesso run ⇒ due esecuzioni con `scope:<id>` e `run:<RUN>`; ripubblicare non ne crea una seconda | `xray-scripts.test.mjs` |
| Defect con label `scope:`, mai Incident | adattatori, server MCP, `defect.mjs`, schema della configurazione, guard | contratto, `alm-server.test.mjs`, `wp09c-alm-e2e.test.mjs`, `xray-scripts.test.mjs` |
| Errori attesi = successi; ambiente mai FAIL | `EXPECTED-ERROR-AS-SUCCESS ⇒ PASSED`; `ERROR-ENVIRONMENT ⇒ ABORTED/TODO`, nessun Defect proposto, `defect.mjs` rifiuta | `xray-scripts.test.mjs` |

## Riporti chiusi

- `hooks/lib/alm-record.mjs`: `/^d{1,20}$/` → `/^\d{1,20}$/` (le pagine create dal plugin ora si registrano).
- `alm-read-tools.json`: le tre letture del server del plugin ci sono; e2e server reale + `guard-alm-write` + `alm-record`.
- Nomi dei server coerenti con `mcp-allowlist.json` (`alm`, `plugin_jaggaer-virtual-consultant_alm`) e col matcher di
  `guard-alm-write`; prefissi `chrome-devtools` e `playwright` (diretti e del plugin) già riconosciuti da `browser-tools`.
- `integrity.mjs` include `mcp/` (ora provato) e `NETWORK.md`.
- `guard-config-scope`: `write_text`/`write_bytes` in `CODE_WRITE`; `/results/` con interprete e primitiva di scrittura.
