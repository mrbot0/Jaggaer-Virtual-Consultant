// xray publish (§27.5, §45.5, ADR-20/22): pubblica il payload del run (runs/<RUN>/xray-payload.json, costruito da
// build-payload se assente o con --rebuild) con l'AlmAdapter della factory: per ogni scope UNA Test Execution
// (creata una sola volta: runs/<RUN>/xray-published.json la ricorda) e l'import nativo con le evidenze sul passo
// (file del dossier materializzati, profilo strict verificato). Rete giù ⇒ coda offline (customers/<C>/queue/), esito
// "in coda", exit 0: Jira giù non invalida un collaudo. --dry-run: nessuna chiamata, solo cosa si pubblicherebbe.
// Le esecuzioni create finiscono in session.alm.created (se c'è una sessione) e nell'audit.
//
// CLI: node scripts/xray/publish.mjs --run <RUN> [--scope S] [--dry-run] [--rebuild] [--outcomes <file.yaml>]
//      [caso=ESITO[@passo]…] [--customer C] [--workspace <dir>] [--json]
// Exit: 0 pubblicato o in coda · 1 argomenti o configurazione · 2 errore di sistema · 3 rifiuto o errore dell'ALM, anche di un solo
//       scope (gli altri scope si pubblicano lo stesso; l'errore è nell'esito dello scope e in xray-published.json).
import { resolve as resolvePath } from "node:path";
import { parseArgs } from "../lib/args.mjs";
import { isMain } from "../lib/is-main.mjs";
import { readPayload, recordPublished, executionFor, recordExecution, assertOwned, readExecutions, sessionCodeOf } from "../../mcp/alm-server/queue.mjs";
import { materializeResults } from "../../mcp/alm-server/payload.mjs";
import { AlmError } from "../../mcp/alm-server/adapter.mjs";
import { buildPayload, parseOutcomes, summary } from "./build-payload.mjs";
import { XrayError, xrayContext, recordCreated, audit, failWith, kv } from "./common.mjs";
import { confineInputs } from "../lib/text-file.mjs";
import { runRefusal } from "../lib/run-code.mjs";

export async function publish(c, { run, scope = null, dryRun = false, rebuild = false, outcomes = {}, env = process.env }) {
  // 18/11/2026 (ciclo di bug fixing): il run è un codice RUN la cui cartella sta sotto runs/ PRIMA di leggere il payload
  // (prima solo build-payload lo verificava: con un payload già presente un --run con risalita leggeva e scriveva fuori)
  const badRun = runRefusal(c.ws, c.customer, run);
  if (badRun) throw new XrayError(1, badRun);
  let doc = rebuild ? null : readPayload(c.ws, c.customer, run);
  if (!doc) doc = await buildPayload(c.ws, { customer: c.customer, run, outcomes, config: c.config });
  const scopes = Object.keys(doc.executions ?? {}).filter((S) => !scope || S === scope).sort();
  if (!scopes.length) throw new XrayError(1, `nessuna esecuzione da pubblicare nel payload di ${run}${scope ? ` per lo scope ${scope}` : ""}`);
  if (dryRun) return { dry_run: true, run, executions: summary({ executions: Object.fromEntries(scopes.map((S) => [S, doc.executions[S]])) }), skipped: doc.skipped ?? [], warnings: doc.warnings ?? [] };
  const out = [];
  let authed = false;
  // 18/11/2026 (ciclo di bug fixing): uno scope in errore (evidenza sparita dal dossier, rifiuto dell'ALM, esecuzione
  // altrui) non ferma gli altri: l'errore resta nell'esito dello scope e in xray-published.json (last_error), l'audit si
  // scrive comunque e la CLI esce con 3. Solo un'autenticazione rifiutata (non di rete) ferma tutto: varrebbe per ogni scope.
  const scopeError = (S, err, key = null) => {
    const msg = err?.message ?? String(err);
    const status = err instanceof XrayError && err.code === 3 ? "rifiutato" : "errore";
    try { recordPublished(c.ws, c.customer, run, S, { last_error: msg, last_error_at: new Date().toISOString(), ...(key ? { execution_key: key } : {}) }); } catch { /* il registro è informativo */ }
    out.push({ scope: S, status, error: msg, ...(key ? { execution_key: key } : {}), ...(err instanceof AlmError ? { alm_error: err.code } : {}) });
  };
  for (const S of scopes) {
    const entry = doc.executions[S];
    if (!entry.results?.tests?.length) { out.push({ scope: S, status: "vuoto" }); continue; }
    // WP09c giro 1 (I1/I2): la Test Execution del run e dello scope dalla mappa condivisa col server MCP; se esiste, solo se
    // creata dal plugin in questa sessione (mai import nei risultati altrui); altrimenti si crea (e si registra) ora
    let key = executionFor(c.ws, c.customer, run, S);
    if (key) {
      try { assertOwned(c.ws, c.customer, key, env, { run, scope: S }); } catch (err) { scopeError(S, new XrayError(3, `scope ${S}: ${err.message}`)); continue; }
    }
    try {
      if (!authed) {
        try { await c.adapter.authenticate(); } catch (err) { if (err instanceof AlmError && !err.network) throw Object.assign(err, { fatal: true }); throw err; }
        authed = true;
      }
      if (!key) {
        key = (await c.adapter.createExecution(entry.execution)).key;
        recordExecution(c.ws, c.customer, run, S, key, "xray-publish", { session_code: sessionCodeOf(c.ws, c.customer, env) });
        recordPublished(c.ws, c.customer, run, S, { execution_key: key, created_at: new Date().toISOString() });
        await recordCreated(c.ws, env, key, "execution", "xray-publish");
      }
      const results = await materializeResults(c.ws, c.customer, entry.results);
      const rep = await c.adapter.importResults(key, results);
      recordPublished(c.ws, c.customer, run, S, { execution_key: key, imported_at: new Date().toISOString(), tests: rep.tests, evidence: rep.evidence });
      out.push({ scope: S, status: "pubblicato", execution_key: key, tests: rep.tests, evidence: rep.evidence });
    } catch (err) {
      if (err?.fatal) throw err;
      if (!(err instanceof AlmError && err.network) || c.config.offline_queue === false) { scopeError(S, err, key); continue; }
      // giro 2 (Minor 1): la voce protetta porta la provenienza dell'esecuzione del plugin (completabile in una sessione successiva)
      const m = key ? readExecutions(c.ws, c.customer, run).scopes?.[S] : null;
      const provenance = key && m?.created_by_plugin === true && m.key === key ? { created_by_plugin: true, key, session_code: m.session_code ?? null } : null;
      const q = c.queue.enqueue({ op: "import", run, scope: S, payload: { ...entry, execution_key: key }, error: err.message, provenance });
      out.push({ scope: S, status: "in coda", queued: true, id: q.id, execution_key: key, error: err.message });
    }
  }
  await audit(c.ws, env, c.customer, { action: "xray-publish", run, scopes: out.map((o) => ({ scope: o.scope, status: o.status, execution: o.execution_key ?? null, ...(o.error ? { error: o.error } : {}) })) }, "xray-publish");
  const failed = out.filter((o) => o.status === "errore" || o.status === "rifiutato");
  return { run, deployment: c.config.deployment, executions: out, skipped: doc.skipped ?? [], warnings: doc.warnings ?? [],
    ...(failed.length ? { failed: failed.map((o) => o.scope), error: failed.map((o) => (o.error.startsWith(`scope ${o.scope}`) ? o.error : `scope ${o.scope}: ${o.error}`)).join("; ") } : {}) };
}

const HELP = `uso: node scripts/xray/publish.mjs --run <RUN> [--scope S] [--dry-run] [--rebuild] [--outcomes <file.yaml>]
       [caso=ESITO[@passo]…] [--customer C] [--workspace <dir>] [--json] [--help]

Pubblica il run su Xray: una Test Execution per scope (ADR-20/34), import nativo con evidenze sul passo (ADR-19).
Implementazione da config/xray.yaml deployment (cloud | server | mock). Rete giù ⇒ coda offline (ADR-22), exit 0.
Credenziali solo dall'ambiente (XRAY_CLIENT_ID/XRAY_CLIENT_SECRET, XRAY_TOKEN, JIRA_*), mai stampate.

Exit code: 0 pubblicato o in coda · 1 argomenti o configurazione · 2 errore di sistema · 3 rifiuto o errore dell'ALM, anche di
un solo scope (gli altri si pubblicano lo stesso; l'errore è nell'esito dello scope).`;

export async function run(argv, env = process.env) {
  const { opts, positional } = parseArgs(argv, { flags: ["dry-run", "rebuild"] });
  const asJson = !!opts.json;
  if (opts.help) { console.log(HELP); return 0; }
  { const bad = confineInputs(opts, ["outcomes"], { env }); if (bad) return failWith(asJson, new XrayError(1, bad)); }
  try {
    if (!opts.run) throw new XrayError(1, "richiesto --run <RUN>");
    const c = await xrayContext(opts, env);
    const outcomes = parseOutcomes({ file: opts.outcomes ? resolvePath(c.ws, opts.outcomes) : null, pairs: kv(positional) });
    const r = await publish(c, { run: opts.run, scope: opts.scope ?? null, dryRun: !!opts["dry-run"], rebuild: !!opts.rebuild || Object.keys(outcomes).length > 0, outcomes, env });
    if (asJson) console.log(JSON.stringify({ ok: !r.failed, ...r }));
    else if (r.dry_run) console.log([`dry-run ${r.run} (nessuna chiamata all'ALM):`, ...r.executions.map((x) => `  ${x.scope}: ${x.tests} test, ${x.evidence} evidenze, piano ${x.testPlanKey ?? "—"}`)].join("\n"));
    else console.log(r.executions.map((x) => `${x.scope}: ${x.status}${x.execution_key ? ` ${x.execution_key}` : ""}${x.queued ? ` (coda ${x.id})` : ""}${x.error ? ` — ${x.error}` : ""}`).join("\n"));
    return r.failed ? 3 : 0;
  } catch (err) { return failWith(asJson, err); }
}

// exitCode, non process.exit: su Windows (Node 24) process.exit dopo più fetch termina il processo con 0xC0000409
if (isMain(import.meta.url)) run(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (e) => { console.error(e); process.exitCode = 2; });
