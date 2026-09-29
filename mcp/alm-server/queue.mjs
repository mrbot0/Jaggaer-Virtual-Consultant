// Coda offline (§46.5, §47 E2, ADR-22): Jira/Xray giù non invalida un collaudo. Un errore di RETE in
// importResults / createDefect (o nella pubblicazione di un run) scrive il payload nel dossier
// (customers/<C>/runs/<RUN>/xray-payload.json, voce dello scope) e un indice customers/<C>/queue/<id>.json, e
// restituisce { queued: true, id }. retryQueued() ripete le voci pendenti; le voci non si cancellano mai: passano a
// status sent (con la chiave ottenuta) o failed (errore non di rete: da guardare, non si ripete da sola).
// Nessun segreto nella coda: i messaggi d'errore sono già redatti dagli adattatori.
import { readFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { writeFileAtomic } from "../../hooks/lib/fsx.mjs";
import { AlmError, safeMessage, strictText } from "./adapter.mjs";
import { ownedExecution } from "./factory.mjs";
import { materializeResults, materializeAttachments } from "./payload.mjs";

const RUN = /^RUN\.([A-Z0-9]{4})\.\d{8}\.\d{4}\.[A-Z0-9]{3}$/;
const ID = /^Q\.\d{14}\.[0-9a-f]{6}$/;
const stamp = (d) => d.toISOString().replace(/[-:T]/g, "").slice(0, 14);
const readJson = (f) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return null; } };

export const payloadFile = (ws, customer, run) => join(ws, "customers", customer, "runs", run, "xray-payload.json");
export const publishedFile = (ws, customer, run) => join(ws, "customers", customer, "runs", run, "xray-published.json");

export function readPayload(ws, customer, run) { return readJson(payloadFile(ws, customer, run)); }
// Voce dello scope nel payload del run (le altre voci restano come sono).
export function writePayloadEntry(ws, customer, run, scope, entry) {
  const f = payloadFile(ws, customer, run);
  const cur = readJson(f) ?? { run, customer, executions: {} };
  cur.executions = { ...(cur.executions ?? {}), [scope]: entry };
  mkdirSync(join(f, ".."), { recursive: true });
  writeFileAtomic(f, `${JSON.stringify(cur, null, 2)}\n`);
  return `runs/${run}/xray-payload.json`;
}
// WP09c giro 1 (I2): UNA Test Execution per run e scope — mappa condivisa da alm_create_execution e xray publish
// (runs/<RUN>/xray-executions.json, protetta: la scrivono solo gli script e il server del plugin).
export const executionsFile = (ws, customer, run) => join(ws, "customers", customer, "runs", run, "xray-executions.json");
export function readExecutions(ws, customer, run) { return readJson(executionsFile(ws, customer, run)) ?? { run, scopes: {} }; }
export const executionFor = (ws, customer, run, scope) => readExecutions(ws, customer, run).scopes?.[scope]?.key ?? null;
export function recordExecution(ws, customer, run, scope, key, via) {
  const cur = readExecutions(ws, customer, run);
  cur.scopes = { ...(cur.scopes ?? {}), [scope]: { key, via, created_at: new Date().toISOString() } };
  mkdirSync(join(executionsFile(ws, customer, run), ".."), { recursive: true });
  writeFileAtomic(executionsFile(ws, customer, run), `${JSON.stringify(cur, null, 2)}
`);
}
// I1: un'esecuzione esistente si usa solo se creata dal plugin in questa sessione (session.alm.created); senza sessione
// (CI) vale la mappa protetta.
export function assertOwned(ws, customer, key, env = process.env) {
  if (!ownedExecution(ws, customer, key, env)) throw new AlmError("refused", `esecuzione ${key} non creata dal plugin in questa sessione (session.alm.created): nessun import nei risultati altrui (§46.5)`);
  return key;
}

export function readPublished(ws, customer, run) { return readJson(publishedFile(ws, customer, run)) ?? { run, scopes: {} }; }
export function recordPublished(ws, customer, run, scope, rec) {
  const cur = readPublished(ws, customer, run);
  cur.scopes = { ...(cur.scopes ?? {}), [scope]: { ...(cur.scopes?.[scope] ?? {}), ...rec } };
  writeFileAtomic(publishedFile(ws, customer, run), `${JSON.stringify(cur, null, 2)}\n`);
}

export class OfflineQueue {
  constructor(ws, customer, { env = process.env } = {}) {
    if (!/^[A-Z0-9]{4}$/.test(String(customer ?? ""))) throw new AlmError("config", "coda offline senza cliente");
    this.ws = ws; this.customer = customer; this.env = env;
    this.dir = join(ws, "customers", customer, "queue");
  }
  checkRun(run) {
    const m = RUN.exec(String(run ?? ""));
    if (!m || m[1] !== this.customer) throw new AlmError("input", `run non valido per ${this.customer}: ${JSON.stringify(run)}`);
    return run;
  }
  file(id) { return join(this.dir, `${id}.json`); }
  save(entry) { mkdirSync(this.dir, { recursive: true }); writeFileAtomic(this.file(entry.id), `${JSON.stringify(entry, null, 2)}\n`); }

  // op: import { executionKey?, execution?, results } · defect { defect }. Con run+scope (import) il payload va nel dossier.
  enqueue({ op, run = null, scope = null, payload, error = null, now = new Date() }) {
    if (!["import", "defect"].includes(op)) throw new AlmError("input", `operazione di coda non ammessa: ${op}`);
    const id = `Q.${stamp(now)}.${randomBytes(3).toString("hex")}`;
    const entry = { id, op, customer: this.customer, run, scope, status: "pending", attempts: 0, created_at: now.toISOString(), last_error: error ? safeMessage(error, this.env) : null };
    // Defect: testo redatto (strict, valori delle variabili note) PRIMA di scriverlo su disco
    if (op === "defect" && payload?.defect) payload = { ...payload, defect: { ...payload.defect, summary: strictText(payload.defect.summary, this.env), description: strictText(payload.defect.description ?? "", this.env) } };
    if (op === "import" && run && scope) entry.payload_ref = { file: writePayloadEntry(this.ws, this.customer, this.checkRun(run), scope, payload), scope };
    else { if (run) this.checkRun(run); entry.payload = payload; }
    this.save(entry);
    return { queued: true, id, ...(entry.payload_ref ? { payload: entry.payload_ref.file } : {}) };
  }

  list() {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir).filter((f) => f.endsWith(".json") && ID.test(f.slice(0, -5))).sort().map((f) => readJson(join(this.dir, f))).filter((e) => e && ID.test(e.id));
  }
  status() {
    const all = this.list();
    const by = (s) => all.filter((e) => e.status === s);
    return { customer: this.customer, pending: by("pending").length, sent: by("sent").length, failed: by("failed").length,
      items: all.filter((e) => e.status !== "sent").map((e) => ({ id: e.id, op: e.op, run: e.run, scope: e.scope, status: e.status, attempts: e.attempts, created_at: e.created_at, last_error: e.last_error })) };
  }
  payloadOf(entry) {
    if (!entry.payload_ref) return entry.payload;
    const doc = readPayload(this.ws, this.customer, this.checkRun(entry.run));
    const p = doc?.executions?.[entry.payload_ref.scope];
    if (!p) throw new AlmError("input", `payload assente nel dossier: ${entry.payload_ref.file} (${entry.payload_ref.scope})`);
    return p;
  }

  // Esegue una voce; → { key, report, created }. Gli errori propagano (il chiamante decide pending/failed).
  // WP09c giro 1 (I1): chiave esistente solo se creata dal plugin in questa sessione; evidenze solo per file del dossier
  // (profilo strict verificato: niente base64 in linea); created = la chiave è nata ORA (solo allora si registra).
  async send(adapter, entry) {
    const p = this.payloadOf(entry);
    if (entry.op === "import") {
      const results = await materializeResults(this.ws, this.customer, p.results, { allowInline: false });
      let key = p.execution_key ?? p.executionKey ?? (entry.run && entry.scope ? executionFor(this.ws, this.customer, this.checkRun(entry.run), entry.scope) : null);
      let created = false;
      if (key) assertOwned(this.ws, this.customer, key, this.env);
      else {
        key = (await adapter.createExecution(p.execution)).key;
        created = true;
        if (entry.run && entry.scope) recordExecution(this.ws, this.customer, entry.run, entry.scope, key, entry.id);
      }
      const report = await adapter.importResults(key, results);
      if (entry.run && entry.scope) recordPublished(this.ws, this.customer, entry.run, entry.scope, { execution_key: key, imported_at: new Date().toISOString(), tests: report.tests, evidence: report.evidence, via: entry.id });
      return { key, report, created };
    }
    const d = { ...p.defect, attachments: await materializeAttachments(this.ws, this.customer, p.defect?.attachments ?? [], { allowInline: false }) };
    const r = await adapter.createDefect(d);
    return { key: r.key, report: null, created: true };
  }

  async retryQueued(adapter, { now = () => new Date() } = {}) {
    const out = { sent: [], still_queued: [], failed: [] };
    let authed = false;
    for (const e of this.list().filter((x) => x.status === "pending")) {
      e.attempts += 1;
      e.last_attempt_at = now().toISOString();
      try {
        if (!authed) { await adapter.authenticate(); authed = true; }
        const r = await this.send(adapter, e);
        Object.assign(e, { status: "sent", key: r.key, sent_at: now().toISOString(), last_error: null });
        out.sent.push({ id: e.id, op: e.op, key: r.key, created: r.created });
      } catch (err) {
        const msg = safeMessage(err?.message ?? err, this.env);
        e.last_error = msg;
        if (err instanceof AlmError && err.network) out.still_queued.push({ id: e.id, op: e.op, error: msg });
        else { e.status = "failed"; out.failed.push({ id: e.id, op: e.op, error: msg }); }
      }
      this.save(e);
    }
    return out;
  }
}

// Chiamata con coda: errore di rete e coda abilitata ⇒ { queued: true, id }; altrimenti il risultato o l'errore.
export async function withQueue(config, queue, fn, spec) {
  try { return await fn(); } catch (err) {
    if (err instanceof AlmError && err.network && config?.offline_queue !== false && queue) return queue.enqueue({ ...spec, error: err.message });
    throw err;
  }
}
