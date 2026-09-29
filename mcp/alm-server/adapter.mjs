// AlmAdapter (§46.5, §44.6, §53.3, ADR-19/20/21/27): l'interfaccia che il server MCP ALM incapsula e che gli script
// scripts/xray/* usano. Implementazioni: XrayCloudAdapter (xray-cloud.mjs), XrayServerAdapter (xray-server.mjs),
// MockAlmAdapter (mock.mjs); scelta da customers/<C>/config/xray.yaml `deployment` (factory.mjs).
//
// ASSENTI PER COSTRUZIONE: delete*, update di risultati altrui, createIncident. La prima difesa è l'assenza di codice;
// guard-alm-write è la seconda. assertAdapter() lo verifica a runtime su ogni implementazione (test di contratto).
//
// @typedef {{ key: string, summary: string, labels: string[], type?: string|null, status?: string|null, plans?: string[] }} AlmTest
// @typedef {{ project?: string, summary: string, description?: string, scope: string, run?: string|null,
//             testPlanKey?: string|null, labels?: string[] }} NewExecution
// @typedef {{ status: string, comment?: string, actualResult?: string,
//             evidence?: { data: string, filename: string, contentType: string }[] }} StepResult
// @typedef {{ testKey: string, status: string, comment?: string, start?: string, finish?: string,
//             steps?: StepResult[], evidence?: object[] }} TestResult
// @typedef {{ info?: { project?: string, summary?: string, description?: string, testPlanKey?: string|null,
//             labels?: string[], startDate?: string, finishDate?: string }, tests: TestResult[] }} ExecutionResults
//             (formato nativo di Xray, ADR-19: le evidenze stanno SUL PASSO, steps[i].evidence)
// @typedef {{ key: string, tests: number, evidence: number }} ImportReport
// @typedef {{ project?: string, summary: string, description?: string, scope: string, issue_type?: string,
//             labels?: string[], assignee?: string|null, precedent?: { key: string, fixed_in?: string|null }|null,
//             attachments?: { data: string, filename: string, contentType: string }[] }} NewDefect
//
// interface AlmAdapter {
//   authenticate(): Promise<void>;
//   getTest(key): Promise<AlmTest|null>;
//   findTests({ plan?, labels?, text? }): Promise<AlmTest[]>;
//   createExecution(e: NewExecution): Promise<{ key }>;
//   importResults(executionKey, results: ExecutionResults): Promise<ImportReport>;
//   createDefect(d: NewDefect): Promise<{ key }>;
//   link(from, to, kind: 'tests'|'defect'): Promise<void>;
//   getExecution?(key): Promise<{ key, tests: [{ testKey, status, steps: [{ status, evidence }] }] }|null>   // lettura (verify)
// }
import { redactText } from "../../scripts/chrome/redact.mjs";

export const ADAPTER_METHODS = Object.freeze(["authenticate", "getTest", "findTests", "createExecution", "importResults", "createDefect", "link"]);
// nomi che non devono esistere su nessuna implementazione (né sul prototipo)
export const FORBIDDEN_METHOD = /^(delete|remove|destroy|purge|archive|trash|erase|drop|wipe|discard|unlink)|incident|^(update|overwrite|replace|edit|set|patch|put|transition|close)[A-Z_]/i;
export const LINK_KINDS = Object.freeze(["tests", "defect"]);
export const XRAY_STATUSES = Object.freeze(["PASSED", "FAILED", "ABORTED", "TODO", "EXECUTING"]);
export const ISSUE_KEY = /^[A-Z][A-Z0-9_]{0,30}-\d{1,9}$/;
export const LABEL = /^[A-Za-z0-9_.:-]{1,255}$/;
export const PROJECT = /^[A-Z][A-Z0-9_]{0,30}$/;

// code: config · auth · network · http · refused · not-found · input
export class AlmError extends Error {
  constructor(code, msg, { network = false, status = null } = {}) { super(msg); this.code = code; this.network = network; this.status = status; }
}

// Tutti i nomi di metodo raggiungibili (proprie e dei prototipi, fino a Object.prototype escluso).
export function methodNames(obj) {
  const out = new Set();
  for (let p = obj; p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
    for (const k of Object.getOwnPropertyNames(p)) if (k !== "constructor" && typeof obj[k] === "function") out.add(k);
  }
  return [...out];
}

export function assertAdapter(obj) {
  if (!obj || typeof obj !== "object") throw new AlmError("config", "adattatore ALM assente");
  const missing = ADAPTER_METHODS.filter((m) => typeof obj[m] !== "function");
  if (missing.length) throw new AlmError("config", `adattatore ALM incompleto: mancano ${missing.join(", ")}`);
  const bad = methodNames(obj).filter((m) => FORBIDDEN_METHOD.test(m));
  if (bad.length) throw new AlmError("config", `adattatore ALM con metodi vietati per costruzione (§46.5): ${bad.join(", ")}`);
  return obj;
}

// ADR-27 e ADR-21: mai un Incident; mai una issue di tipo Test da createDefect.
export function refusedIssueType(t) {
  const s = String(t ?? "").trim();
  if (/incident/i.test(s)) return `tipo di issue "${s}" vietato: un fallimento NRT produce un Defect, mai un Incident (ADR-27)`;
  if (/^(test|xray test|test case|caso di test)$/i.test(s)) return `tipo di issue "${s}" vietato da createDefect: nessuna creazione automatica di Test (ADR-21)`;
  return null;
}

// Testo verso Jira: profilo strict imposto (§27.5, ADR-18), valori delle variabili d'ambiente note mascherati.
export const strictText = (s, env = process.env) => (typeof s === "string" ? redactText(s, { profile: "strict", env }).text : s);
// Messaggi d'errore: mai un segreto (token, valori di XRAY_*/JIRA_*), mai oltre 300 caratteri.
export const safeMessage = (s, env = process.env) => redactText(String(s ?? ""), { profile: "standard", env }).text.slice(0, 300);

export function checkKey(key, what = "chiave") {
  if (typeof key !== "string" || !ISSUE_KEY.test(key)) throw new AlmError("input", `${what} non valida: ${JSON.stringify(key)} (atteso PROGETTO-123)`);
  return key;
}
export function checkLabels(labels) {
  const list = labels == null ? [] : labels;
  if (!Array.isArray(list) || list.some((l) => typeof l !== "string" || !LABEL.test(l))) throw new AlmError("input", "etichette non valide (lettere, cifre, _ . : -)");
  return list;
}
export const scopeLabel = (scope) => {
  if (typeof scope !== "string" || !/^[A-Z0-9]{3}$/.test(scope)) throw new AlmError("input", `scope non valido: ${JSON.stringify(scope)} (atteso un codice di tre caratteri, es. P2P)`);
  return `scope:${scope}`;
};
export const jqlString = (s) => `"${String(s).replace(/["\\]/g, "\\$&")}"`;

// Validazione dei risultati in formato nativo: stati noti, evidenze con data/filename/contentType.
export function checkResults(results, { allowTestCreation = false } = {}) {
  if (!results || typeof results !== "object" || !Array.isArray(results.tests)) throw new AlmError("input", "risultati senza tests[] (formato nativo di Xray, ADR-19)");
  for (const t of results.tests) {
    // testInfo senza testKey crea il Test in Xray: solo con la deroga ADR-21 (build-payload lo emette solo allora)
    if (t?.testKey === undefined && t?.testInfo) {
      if (!allowTestCreation) throw new AlmError("refused", "testInfo senza testKey creerebbe una Test issue: serve allow_test_issue_creation: true in config/xray.yaml (ADR-21)");
      if (typeof t.testInfo.summary !== "string") throw new AlmError("input", "testInfo senza summary");
    } else checkKey(t?.testKey, "testKey");
    if (!XRAY_STATUSES.includes(t.status)) throw new AlmError("input", `stato non valido per ${t.testKey}: ${t.status}`);
    for (const s of t.steps ?? []) {
      if (!XRAY_STATUSES.includes(s?.status)) throw new AlmError("input", `stato di passo non valido per ${t.testKey}: ${s?.status}`);
      for (const e of s.evidence ?? []) if (typeof e?.data !== "string" || typeof e?.filename !== "string" || typeof e?.contentType !== "string") throw new AlmError("input", `evidenza del passo di ${t.testKey} senza data/filename/contentType`);
    }
  }
  return results;
}
export const countEvidence = (results) => (results?.tests ?? []).reduce((n, t) => n + (t.evidence?.length ?? 0) + (t.steps ?? []).reduce((m, s) => m + (s.evidence?.length ?? 0), 0), 0);

// Etichette di una Test Execution: scope:<id> sempre (ADR-34), run:<RUN> se c'è.
export function executionLabels(e) {
  const labels = [scopeLabel(e.scope), ...checkLabels(e.labels)];
  if (e.run) labels.push(`run:${e.run}`);
  return [...new Set(labels)];
}
export function defectLabels(d) { return [...new Set([scopeLabel(d.scope), ...checkLabels(d.labels)])]; }
