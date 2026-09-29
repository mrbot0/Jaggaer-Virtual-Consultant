// xray authenticate (§48.1, §58): verifica di connettività e credenziali verso l'ALM del cliente con l'AlmAdapter della
// factory (Xray Cloud: POST /api/v2/authenticate; Server/DC: GET /rest/api/2/myself con il PAT). Il token NON si stampa
// mai: l'uscita dice solo deployment, host dichiarati e l'esito. Credenziali solo dall'ambiente.
//
// CLI: node scripts/xray/authenticate.mjs [--customer C] [--workspace <dir>] [--json]
// Exit: 0 autenticato · 1 configurazione (xray.yaml, host) · 2 errore di sistema · 3 credenziali rifiutate o rete giù.
import { parseArgs } from "../lib/args.mjs";
import { isMain } from "../lib/is-main.mjs";
import { declaredHosts } from "../../mcp/alm-server/http.mjs";
import { xrayContext, failWith } from "./common.mjs";

const HELP = `uso: node scripts/xray/authenticate.mjs [--customer C] [--workspace <dir>] [--json] [--help]

Verifica credenziali e raggiungibilità dell'ALM (config/xray.yaml deployment). Nessun token nell'output.
Variabili: XRAY_CLIENT_ID/XRAY_CLIENT_SECRET (cloud), XRAY_TOKEN (server/DC), JIRA_BASE_URL/JIRA_USER/JIRA_API_TOKEN (Jira cloud).

Exit code: 0 autenticato · 1 configurazione · 2 errore di sistema · 3 credenziali rifiutate o rete giù.`;

export async function run(argv, env = process.env) {
  const { opts } = parseArgs(argv);
  const asJson = !!opts.json;
  if (opts.help) { console.log(HELP); return 0; }
  try {
    const c = await xrayContext(opts, env);
    await c.adapter.authenticate();
    const hosts = [...declaredHosts(c.config)];
    console.log(asJson ? JSON.stringify({ ok: true, customer: c.customer, deployment: c.config.deployment, hosts }) : `ALM ${c.customer}: autenticato (${c.config.deployment}${hosts.length ? `, ${hosts.join(", ")}` : ""})`);
    return 0;
  } catch (err) { return failWith(asJson, err); }
}

// exitCode, non process.exit: su Windows (Node 24) process.exit dopo più fetch termina il processo con 0xC0000409
if (isMain(import.meta.url)) run(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (e) => { console.error(e); process.exitCode = 2; });
