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

## Giro di correzione 1

Revisione "Needs fixes" (1 critico, 3 importanti), decisioni vincolanti del controllore applicate:

| Rilievo | Correzione | Prova |
|---------|-----------|-------|
| C1 credenziali verso qualunque host | (a) `customers/*/config/**` protetto dalle scritture di sessione e sub-agenti (Write/Edit/NotebookEdit, shell, interpreti, script eseguiti: `guard-config-scope`); (b) `use customer` fissa sha256 di `config/xray.yaml` in `session.alm.config`: file cambiato ⇒ `guard-alm-write` nega le scritture ALM e ogni chiamata dell'`AlmAdapter` (server MCP, `scripts/xray/*`) è rifiutata; (c) host ammesso solo se SIA in `xray.yaml` SIA nella categoria `alm` di `NETWORK.md` (rifiuto prima di ogni credenziale); (d) `doctor --network` controlla anche `xray_url` | `test/hooks/wp09c-fixround1.test.mjs`, `test/xray/wp09c-fixround1.test.mjs` (base_url riscritto ⇒ nessuna richiesta all'altro host, nessuna credenziale; deroga ADR-21 attivata dopo `use customer` ⇒ negata) |
| I1 import in esecuzioni nominate da file non protetti | `runs/**/xray-*.json` e `customers/*/queue/**` protetti come gli esiti dei run; `publish` e `retry-queued` rifiutano chiavi non in `session.alm.created` e registrano solo ciò che creano; la coda rifiuta le evidenze base64 in linea (profilo strict sempre verificato) | `test/xray/wp09c-fixround1.test.mjs` (mappa e coda forgiate) |
| I2 `alm_create_execution` non idempotente | mappa condivisa `runs/<RUN>/xray-executions.json` (server MCP e `publish`): una Test Execution per run e scope | MCP due volte + `publish` ⇒ una sola esecuzione |
| I3 formato Cloud inviato a Server/DC | `XrayServerAdapter`: stati `PASS`/`FAIL`/`TODO`/`EXECUTING`/`ABORTED` (personalizzabili in `statuses.dc`) e campo `evidences`; rilettura riportata a `PASSED`/`FAILED`; il mock HTTP rifiuta la forma dell'altra piattaforma | test I3 e contratto |
| minori | testo dei Defect in coda redatto prima della scrittura; errore di sistema delle CLI redatto; Xray Cloud si riautentica una volta su 401 | test "minori" |

**Formato Server/DC da confermare sul tenant (M13):** la forma usata (stati predefiniti `PASS`/`FAIL`/… e `evidences`
sul passo e sul test) è quella del JSON nativo documentato per Xray Server/DC; stati personalizzati e versione dell'istanza
del cliente vanno verificati alla prima pubblicazione reale (`xray verify` dopo `xray publish`), eventualmente con
`statuses.dc` in `config/xray.yaml`.

Un Jira Server/DC on-premise richiede che il suo host sia aggiunto alla categoria `alm` di `NETWORK.md` con una release
del plugin (il file è sotto integrità).
