#!/usr/bin/env node
// Server MCP ALM del plugin (§44.6, §46.5, §53.3): stdio, JSON-RPC 2.0 delimitato da a capo, implementato qui (nessuna
// dipendenza: niente SDK). Metodi: initialize (protocolVersion 2025-06-18, capabilities { tools: {} }, serverInfo),
// notifications/initialized, ping, tools/list, tools/call. ESATTAMENTE sette strumenti a grana grossa, nessuno di
// cancellazione (la prima difesa è l'assenza di codice; guard-alm-write è la seconda):
//   alm_get_test · alm_find_tests · alm_queue_status                      (letture: hooks/lib/alm-read-tools.json)
//   alm_create_execution · alm_import_results · alm_create_defect · alm_link (scritture: guard-alm-write)
// Difesa in profondità: alm_create_defect rifiuta Incident e Test; alm_import_results solo su esecuzioni create dal
// plugin (da questo processo o in session.alm.created); evidenze solo dal dossier con profilo strict; errore di rete
// in import/defect ⇒ coda offline { queued: true }. Segreti solo dall'ambiente, mai nell'output (redazione).
// In Claude Code gli strumenti si chiamano mcp__plugin_jaggaer-virtual-consultant_alm__<tool> (o mcp__alm__<tool>).
import { createInterface } from "node:readline";
import { statSync } from "node:fs";
import { AlmError, safeMessage, refusedIssueType, ISSUE_KEY } from "./adapter.mjs";
import { almContext, currentSession, xrayConfigFile } from "./factory.mjs";
import { OfflineQueue, withQueue, readPayload, recordPublished } from "./queue.mjs";
import { materializeResults, materializeAttachments } from "./payload.mjs";
import { isMain } from "../../scripts/lib/is-main.mjs";

export const PROTOCOL_VERSION = "2025-06-18";
export const SERVER_INFO = Object.freeze({ name: "jvc-alm", title: "JAGGAER Virtual Consultant — ALM (Jira/Xray)", version: "0.1.0" });

const KEY = { type: "string", pattern: ISSUE_KEY.source, description: "Chiave Jira (PROGETTO-123)" };
const SCOPE = { type: "string", pattern: "^[A-Z0-9]{3}$", description: "Scope (tre caratteri, es. P2P): etichetta scope:<id>" };
const RUN = { type: "string", pattern: "^RUN\\.[A-Z0-9]{4}\\.\\d{8}\\.\\d{4}\\.[A-Z0-9]{3}$", description: "Codice del run (RUN.<C>.<AAAAMMGG>.<HHMM>.<SCOPE>)" };
const LABELS = { type: "array", items: { type: "string", pattern: "^[A-Za-z0-9_.:-]{1,255}$" } };
const EVIDENCE = { type: "array", items: { type: "object", required: ["file"], additionalProperties: false, properties: { file: { type: "string", description: "Evidenza del dossier: customers/<C>/runs/<RUN>/cases/<caso>/evidence/<nn>.png (metadati EVD strict accanto)" }, filename: { type: "string" }, contentType: { type: "string" } } } };
const STATUS = { enum: ["PASSED", "FAILED", "ABORTED", "TODO", "EXECUTING"] };

export const TOOLS = Object.freeze([
  { name: "alm_get_test", title: "Leggi un Test", description: "Legge un Test Xray per chiave. Sola lettura. → { test } (null se inesistente).", annotations: { readOnlyHint: true },
    inputSchema: { type: "object", required: ["key"], additionalProperties: false, properties: { key: KEY } } },
  { name: "alm_find_tests", title: "Cerca Test", description: "Cerca Test Xray del progetto del cliente per Test Plan, etichette o testo. Sola lettura. → { tests[] }.", annotations: { readOnlyHint: true },
    inputSchema: { type: "object", additionalProperties: false, properties: { plan: KEY, labels: LABELS, text: { type: "string", maxLength: 200 } } } },
  { name: "alm_create_execution", title: "Crea una Test Execution", description: "Crea UNA Test Execution per run e per scope (ADR-20/34) con etichette scope:<id> e run:<RUN>; Test Plan dello scope da config/xray.yaml. → { key }.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    inputSchema: { type: "object", required: ["summary", "scope"], additionalProperties: false, properties: { summary: { type: "string", minLength: 1, maxLength: 250 }, scope: SCOPE, run: RUN, description: { type: "string", maxLength: 5000 }, testPlanKey: KEY, labels: LABELS } } },
  { name: "alm_import_results", title: "Importa i risultati", description: "Importa i risultati in formato nativo Xray (ADR-19, evidenze SUL PASSO) in una Test Execution creata dal plugin in questa sessione. Risultati inline (evidenze solo come file del dossier) oppure run+scope per il payload del dossier (runs/<RUN>/xray-payload.json, scripts/xray/build-payload). Rete giù ⇒ { queued: true } (coda offline). → { key, tests, evidence }.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    inputSchema: { type: "object", required: ["executionKey"], additionalProperties: false, properties: {
      executionKey: KEY, run: RUN, scope: SCOPE,
      results: { type: "object", required: ["tests"], properties: { info: { type: "object" }, tests: { type: "array", items: { type: "object", required: ["testKey", "status"], properties: { testKey: KEY, status: STATUS, comment: { type: "string" },
        steps: { type: "array", items: { type: "object", required: ["status"], properties: { status: STATUS, comment: { type: "string" }, actualResult: { type: "string" }, evidence: EVIDENCE } } } } } } } } } } },
  { name: "alm_create_defect", title: "Apri un Defect", description: "Apre un Defect (mai un Incident, ADR-27; mai un Test, ADR-21) con etichetta scope:<id>, assegnatario dal registro, allegati solo evidenze strict del dossier, riferimento al precedente se regressione. Testo redatto con profilo strict. Rete giù ⇒ { queued: true }. → { key }.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    inputSchema: { type: "object", required: ["summary", "scope"], additionalProperties: false, properties: { summary: { type: "string", minLength: 1, maxLength: 250 }, scope: SCOPE, description: { type: "string", maxLength: 20000 },
      issue_type: { type: "string", description: "Tipo da config/xray.yaml defects.issue_type se assente (Bug/Defect). Incident e Test rifiutati." }, labels: LABELS, run: RUN,
      precedent: { type: "object", required: ["key"], additionalProperties: false, properties: { key: KEY, fixed_in: { type: "string" } } }, attachments: EVIDENCE } } },
  { name: "alm_link", title: "Collega due issue", description: "Aggiunge un collegamento (tests | defect) fra due issue: un'aggiunta, non sovrascrive nulla. → { linked: true }.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    inputSchema: { type: "object", required: ["from", "to", "kind"], additionalProperties: false, properties: { from: KEY, to: KEY, kind: { enum: ["tests", "defect"] } } } },
  { name: "alm_queue_status", title: "Stato della coda offline", description: "Voci della coda offline del cliente (pendenti, fallite, inviate). Sola lettura. → { pending, failed, sent, items[] }.", annotations: { readOnlyHint: true },
    inputSchema: { type: "object", additionalProperties: false, properties: {} } },
]);

const text = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj) }], structuredContent: obj });
const toolError = (msg) => ({ content: [{ type: "text", text: `errore: ${msg}` }], isError: true });

export function createServer({ env = process.env, cwd = process.cwd(), fetchImpl } = {}) {
  const cache = new Map();
  const created = new Set();
  async function ctx() {
    const base = await almContext({ env, cwd, fetchImpl });
    let mtime = 0;
    try { mtime = base.customer ? statSync(xrayConfigFile(base.ws, base.customer)).mtimeMs : 0; } catch { mtime = 0; }
    const k = `${base.ws}|${base.customer}|${mtime}`;
    if (!cache.has(k)) cache.set(k, base);
    const c = cache.get(k);
    return { ...c, queue: c.customer ? new OfflineQueue(c.ws, c.customer, { env }) : null };
  }
  const mine = (c, key) => {
    if (created.has(key)) return true;
    const s = currentSession(c.ws, env).session;
    return (Array.isArray(s?.alm?.created) ? s.alm.created : []).some((x) => String(typeof x === "string" ? x : x?.key).toUpperCase() === key);
  };

  const handlers = {
    async alm_get_test(a, c) { return { test: await c.adapter.getTest(a.key) }; },
    async alm_find_tests(a, c) { return { tests: await c.adapter.findTests({ plan: a.plan, labels: a.labels, text: a.text }) }; },
    async alm_queue_status(a, c) { return c.queue ? c.queue.status() : { customer: null, pending: 0, sent: 0, failed: 0, items: [] }; },
    async alm_create_execution(a, c) {
      const r = await c.adapter.createExecution({ summary: a.summary, scope: a.scope, run: a.run ?? null, description: a.description, labels: a.labels,
        testPlanKey: a.testPlanKey ?? c.config.test_plan_by_scope?.[a.scope] ?? null });
      created.add(r.key);
      return { key: r.key };
    },
    async alm_import_results(a, c) {
      if (!mine(c, a.executionKey)) throw new AlmError("refused", `${a.executionKey}: si importano risultati solo in esecuzioni create dal plugin in questa sessione (session.alm.created)`);
      let original;
      if (a.results) original = { execution_key: a.executionKey, results: a.results };
      else {
        if (!a.run || !a.scope || !c.customer) throw new AlmError("input", "servono results oppure run e scope (payload del dossier)");
        c.queue.checkRun(a.run);
        const entry = readPayload(c.ws, c.customer, a.run)?.executions?.[a.scope];
        if (!entry?.results) throw new AlmError("input", `payload assente: runs/${a.run}/xray-payload.json (${a.scope}) — scripts/xray/build-payload.mjs`);
        original = { ...entry, execution_key: a.executionKey };
      }
      const results = c.customer ? await materializeResults(c.ws, c.customer, original.results, { allowInline: false }) : original.results;
      if (!c.customer && JSON.stringify(results).includes("\"file\"")) throw new AlmError("config", "evidenze per file senza un cliente attivo");
      const r = await withQueue(c.config, c.queue, () => c.adapter.importResults(a.executionKey, results), { op: "import", run: a.run ?? null, scope: a.run ? a.scope ?? null : null, payload: original });
      if (!r.queued && a.run && a.scope && c.customer) recordPublished(c.ws, c.customer, a.run, a.scope, { execution_key: a.executionKey, imported_at: new Date().toISOString(), tests: r.tests, evidence: r.evidence, via: "alm_import_results" });
      return r;
    },
    async alm_create_defect(a, c) {
      const type = a.issue_type ?? c.config.defects?.issue_type ?? "Bug";
      const bad = refusedIssueType(type);
      if (bad) throw new AlmError("refused", bad);
      const defect = { summary: a.summary, scope: a.scope, description: a.description ?? "", issue_type: type, labels: a.labels, precedent: a.precedent ?? null, attachments: a.attachments ?? [] };
      const attachments = c.customer ? await materializeAttachments(c.ws, c.customer, defect.attachments) : [];
      if (!c.customer && defect.attachments.length) throw new AlmError("config", "allegati senza un cliente attivo");
      const r = await withQueue(c.config, c.queue, () => c.adapter.createDefect({ ...defect, attachments }), { op: "defect", run: a.run ?? null, payload: { defect } });
      if (r.key) created.add(r.key);
      return r.queued ? r : { key: r.key };
    },
    async alm_link(a, c) { await c.adapter.link(a.from, a.to, a.kind); return { linked: true, from: a.from, to: a.to, kind: a.kind }; },
  };

  async function callTool(name, args) {
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) return null;
    const a = args && typeof args === "object" && !Array.isArray(args) ? args : {};
    const extra = Object.keys(a).filter((k) => !(k in tool.inputSchema.properties));
    if (extra.length) return toolError(`argomenti non previsti per ${name}: ${extra.join(", ")}`);
    const missing = (tool.inputSchema.required ?? []).filter((k) => a[k] === undefined || a[k] === null || a[k] === "");
    if (missing.length) return toolError(`argomenti mancanti per ${name}: ${missing.join(", ")}`);
    try {
      const c = await ctx();
      return text(await handlers[name](a, c));
    } catch (err) {
      return toolError(safeMessage(err instanceof AlmError ? err.message : `errore interno: ${err?.message ?? err}`, env));
    }
  }

  async function handle(msg) {
    if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
      return msg && typeof msg === "object" && "id" in msg ? { jsonrpc: "2.0", id: msg.id ?? null, error: { code: -32600, message: "Invalid Request" } } : null;
    }
    const isRequest = "id" in msg && msg.id !== null && msg.id !== undefined;
    const reply = (result) => (isRequest ? { jsonrpc: "2.0", id: msg.id, result } : null);
    const fault = (code, message) => (isRequest ? { jsonrpc: "2.0", id: msg.id, error: { code, message } } : null);
    switch (msg.method) {
      case "initialize": return reply({ protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: SERVER_INFO,
        instructions: "Strumenti ALM del plugin: nessuna cancellazione; Defect mai Incident; una Test Execution per run e scope; evidenze sul passo." });
      case "notifications/initialized": case "notifications/cancelled": return null;
      case "ping": return reply({});
      case "tools/list": return reply({ tools: TOOLS });
      case "tools/call": {
        const r = await callTool(msg.params?.name, msg.params?.arguments);
        return r ? reply(r) : fault(-32602, `strumento sconosciuto: ${String(msg.params?.name).slice(0, 80)}`);
      }
      default: return msg.method.startsWith("notifications/") ? null : fault(-32601, `metodo non supportato: ${msg.method.slice(0, 80)}`);
    }
  }
  return { handle, callTool, tools: TOOLS };
}

// stdio: una riga = un messaggio; le risposte nell'ordine di arrivo; stdout SOLO JSON-RPC (diagnostica su stderr).
export function serveStdio({ input = process.stdin, output = process.stdout, env = process.env } = {}) {
  const server = createServer({ env });
  const rl = createInterface({ input, crlfDelay: Infinity });
  let chain = Promise.resolve();
  const write = (obj) => { if (obj) output.write(`${JSON.stringify(obj)}\n`); };
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); return; }
    chain = chain.then(async () => {
      if (Array.isArray(msg)) { const out = (await Promise.all(msg.map((m) => server.handle(m)))).filter(Boolean); if (out.length) write(out); return; }
      write(await server.handle(msg));
    }).catch((err) => process.stderr.write(`jvc-alm: ${safeMessage(err?.message ?? err, env)}\n`));
  });
  // fine di stdin: uscita naturale (process.exit dopo fetch su Windows/Node 24 termina con 0xC0000409); rete di sicurezza
  rl.on("close", () => { chain.finally(() => { process.exitCode = 0; setTimeout(() => process.exit(0), 3000).unref(); }); });
  return server;
}

if (isMain(import.meta.url)) serveStdio();
