// MockAlmAdapter (§46.5): ALM in memoria, con file JSON facoltativo (config mock.file o JVC_ALM_MOCK_FILE, per il
// tenant demo e per ispezionare il server MCP da un test), che registra OGNI chiamata in calls[]. Stesse regole delle
// implementazioni reali (validazione di chiavi, stati, evidenze; mai Incident né Test da createDefect; etichetta
// scope:<id>); nessuna cancellazione. Rete simulata giù (simulateNetworkDown, mock.offline o JVC_ALM_MOCK_OFFLINE=1):
// le scritture falliscono con un errore di rete, come Jira irraggiungibile (per la coda offline).
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { writeFileAtomic } from "../../hooks/lib/fsx.mjs";
import { AlmError, checkKey, checkLabels, checkResults, countEvidence, executionLabels, defectLabels, refusedIssueType, strictText, LINK_KINDS, PROJECT } from "./adapter.mjs";

const empty = () => ({ seq: 0, tests: {}, executions: {}, defects: {}, links: [], calls: [] });

export class MockAlmAdapter {
  constructor(config = {}, { env = process.env, file = null } = {}) {
    this.config = config;
    this.env = env;
    this.file = file ?? env.JVC_ALM_MOCK_FILE ?? config.mock?.file ?? null;
    this.offline = config.mock?.offline === true || env.JVC_ALM_MOCK_OFFLINE === "1";
    this.state = empty();
    if (this.file && existsSync(this.file)) { try { this.state = { ...empty(), ...JSON.parse(readFileSync(this.file, "utf8")) }; } catch { this.state = empty(); } }
    for (const t of config.mock?.tests ?? []) if (t?.key && !this.state.tests[t.key]) this.state.tests[t.key] = { key: t.key, summary: t.summary ?? "", labels: t.labels ?? [], type: "Manual", status: "Open", plans: t.plans ?? [] };
  }
  get calls() { return this.state.calls; }
  simulateNetworkDown(flag = true) { this.offline = !!flag; }
  seedTest(t) { this.state.tests[checkKey(t.key)] = { key: t.key, summary: t.summary ?? "", labels: t.labels ?? [], type: "Manual", status: "Open", plans: t.plans ?? [] }; this.save(); }

  save() {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileAtomic(this.file, `${JSON.stringify(this.state, null, 2)}\n`);
  }
  record(op, args) { this.state.calls.push({ op, args, ts: new Date().toISOString() }); this.state.calls = this.state.calls.slice(-1000); }
  down(op) { if (this.offline) throw new AlmError("network", `rete: ${op} non raggiungibile (ALM simulato giù)`, { network: true }); }
  project(p) {
    const k = p ?? this.config.project ?? "DEMO";
    if (!PROJECT.test(k)) throw new AlmError("config", `progetto non valido: ${JSON.stringify(k)}`);
    return k;
  }
  nextKey(project) { this.state.seq += 1; return `${this.project(project)}-${1000 + this.state.seq}`; }

  async authenticate() { this.record("authenticate", {}); this.down("authenticate"); this.save(); }
  async getTest(key) {
    checkKey(key);
    this.record("getTest", { key });
    this.save();
    const t = this.state.tests[key];
    return t ? { key: t.key, summary: t.summary, labels: [...t.labels], type: t.type, status: t.status } : null;
  }
  async findTests(q = {}) {
    const labels = checkLabels(q.labels);
    if (q.plan) checkKey(q.plan, "piano");
    this.record("findTests", q);
    this.save();
    return Object.values(this.state.tests)
      .filter((t) => (!q.plan || (t.plans ?? []).includes(q.plan)) && labels.every((l) => t.labels.includes(l)) && (!q.text || `${t.key} ${t.summary}`.toLowerCase().includes(String(q.text).toLowerCase())))
      .map((t) => ({ key: t.key, summary: t.summary, labels: [...t.labels], type: t.type, status: t.status }));
  }
  async createExecution(e) {
    if (!e || typeof e.summary !== "string" || !e.summary.trim()) throw new AlmError("input", "createExecution: summary mancante");
    const labels = executionLabels(e);
    this.record("createExecution", { ...e, labels });
    this.down("createExecution");
    const key = this.nextKey(e.project);
    this.state.executions[key] = { key, summary: strictText(e.summary, this.env), labels, testPlanKey: e.testPlanKey ?? null, scope: e.scope, run: e.run ?? null, results: [] };
    this.save();
    return { key };
  }
  async importResults(executionKey, results) {
    checkKey(executionKey, "executionKey");
    checkResults(results);
    this.record("importResults", { executionKey, tests: results.tests.length, evidence: countEvidence(results) });
    this.down("importResults");
    const ex = this.state.executions[executionKey];
    if (!ex) { this.save(); throw new AlmError("not-found", `esecuzione ${executionKey} inesistente`); }
    ex.results.push({ info: results.info ?? null, tests: results.tests.map((t) => ({ testKey: t.testKey, status: t.status, comment: t.comment ?? null,
      steps: (t.steps ?? []).map((s) => ({ status: s.status, evidence: (s.evidence ?? []).map((x) => ({ filename: x.filename, contentType: x.contentType, bytes: Buffer.from(x.data, "base64").length })) })) })) });
    this.save();
    return { key: executionKey, tests: results.tests.length, evidence: countEvidence(results) };
  }
  async createDefect(d) {
    if (!d || typeof d.summary !== "string" || !d.summary.trim()) throw new AlmError("input", "createDefect: summary mancante");
    const type = d.issue_type ?? this.config.defects?.issue_type ?? "Bug";
    const bad = refusedIssueType(type);
    if (bad) throw new AlmError("refused", bad);
    const labels = defectLabels(d);
    if (d.precedent?.key) checkKey(d.precedent.key, "precedente");
    this.record("createDefect", { summary: d.summary, scope: d.scope, issue_type: type, labels, attachments: (d.attachments ?? []).length, precedent: d.precedent ?? null });
    this.down("createDefect");
    const key = this.nextKey(d.project ?? this.config.defects?.project);
    this.state.defects[key] = { key, issue_type: type, summary: strictText(d.summary, this.env), description: strictText(d.description ?? "", this.env), labels,
      assignee: d.assignee ?? this.config.defects?.assignee_by_scope?.[d.scope] ?? null, precedent: d.precedent ?? null, attachments: (d.attachments ?? []).map((a) => a.filename) };
    if (d.precedent?.key) this.state.links.push({ from: key, to: d.precedent.key, kind: "regression" });
    this.save();
    return { key };
  }
  async link(from, to, kind) {
    checkKey(from, "from"); checkKey(to, "to");
    if (!LINK_KINDS.includes(kind)) throw new AlmError("input", `tipo di collegamento non ammesso: ${kind} (tests | defect)`);
    this.record("link", { from, to, kind });
    this.down("link");
    this.state.links.push({ from, to, kind });
    this.save();
  }
  async getExecution(key) {
    checkKey(key);
    this.record("getExecution", { key });
    this.save();
    const ex = this.state.executions[key];
    if (!ex) return null;
    const last = new Map();
    for (const r of ex.results) for (const t of r.tests) last.set(t.testKey, t);
    return { key, tests: [...last.values()].map((t) => ({ testKey: t.testKey, status: t.status, steps: t.steps.map((s) => ({ status: s.status, evidence: s.evidence.length })) })) };
  }
}
