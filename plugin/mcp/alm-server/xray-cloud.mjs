// XrayCloudAdapter (§46.5, ADR-19/20/21/27): Xray Cloud REST v2 + Jira Cloud REST.
//  - authenticate: POST <xray_url>/api/v2/authenticate { client_id, client_secret } da XRAY_CLIENT_ID/XRAY_CLIENT_SECRET
//    (solo ambiente, mai file né argomenti; il token resta in memoria e non si stampa mai);
//  - getTest/findTests/getExecution: GraphQL POST <xray_url>/api/v2/graphql (getTests, getTestExecutions) con JQL
//    costruita solo da chiavi ed etichette validate;
//  - createExecution: Jira POST <jira>/rest/api/2/issue, tipo "Test Execution" (config execution_issue_type),
//    etichette scope:<id> e run:<RUN> (ADR-20/34: una Test Execution per run e per scope);
//  - importResults: POST <xray_url>/api/v2/import/execution, formato NATIVO (ADR-19) con testExecutionKey: le evidenze
//    stanno sul passo (tests[].steps[].evidence[]). info.labels non fa parte del formato di import: le etichette si
//    mettono alla creazione dell'esecuzione;
//  - createDefect: Jira POST /rest/api/2/issue, tipo da config (defects.issue_type), mai Incident né Test; testo
//    redatto con profilo strict; etichetta scope:<id>; assegnatario dal registro; allegati (evidenze strict);
//    precedente di regressione collegato (links.regression);
//  - link: Jira POST /rest/api/2/issueLink (tipi da config links.tests / links.defect).
// Jira: JIRA_BASE_URL (o base_url) + JIRA_USER + JIRA_API_TOKEN, Basic. Host dichiarati in xray.yaml (http.mjs).
import { AlmError, checkKey, checkLabels, checkResults, countEvidence, executionLabels, defectLabels, refusedIssueType, strictText, jqlString, LINK_KINDS, PROJECT } from "./adapter.mjs";
import { request, declaredUrl, basicAuth, attachmentForm, XRAY_CLOUD_DEFAULT } from "./http.mjs";

export class JiraBase {
  constructor(config = {}, { env = process.env, fetchImpl = globalThis.fetch, networkHosts = null } = {}) {
    this.config = config;
    this.env = env;
    this.fetchImpl = fetchImpl;
    this.networkHosts = networkHosts;
  }
  project(p) {
    const k = p ?? this.config.project;
    if (typeof k !== "string" || !PROJECT.test(k)) throw new AlmError("config", `progetto Jira non valido o assente: ${JSON.stringify(k)} (config/xray.yaml project)`);
    return k;
  }
  jiraBase() {
    const u = this.env.JIRA_BASE_URL || this.config.jira_url || this.config.base_url;
    if (!u) throw new AlmError("config", "URL di Jira assente: base_url in config/xray.yaml (o JIRA_BASE_URL)");
    return declaredUrl(u, this.config, "URL di Jira", this.networkHosts);
  }
  jiraHeaders() { throw new AlmError("config", "autenticazione Jira non definita"); }
  async jira(method, path, body, extraHeaders = {}) {
    const isForm = body instanceof FormData;
    const headers = { Accept: "application/json", ...this.jiraHeaders(), ...(body !== undefined && !isForm ? { "Content-Type": "application/json" } : {}), ...extraHeaders };
    return request(this.config, { method, url: `${this.jiraBase()}${path}`, headers, body: body === undefined ? undefined : isForm ? body : JSON.stringify(body), env: this.env, fetchImpl: this.fetchImpl, networkHosts: this.networkHosts });
  }
  userField(name) { return { name }; }

  async createIssue(fields) {
    const r = await this.jira("POST", "/rest/api/2/issue", { fields });
    const key = r.json?.key;
    if (typeof key !== "string") throw new AlmError("http", "risposta di Jira senza key dell'issue creata");
    return key;
  }

  async createExecution(e) {
    if (!e || typeof e.summary !== "string" || !e.summary.trim()) throw new AlmError("input", "createExecution: summary mancante");
    const fields = {
      project: { key: this.project(e.project) },
      issuetype: { name: this.config.execution_issue_type ?? "Test Execution" },
      summary: strictText(e.summary, this.env).slice(0, 250),
      labels: executionLabels(e),
    };
    if (e.description) fields.description = strictText(e.description, this.env);
    return { key: await this.createIssue(fields) };
  }

  async createDefect(d) {
    if (!d || typeof d.summary !== "string" || !d.summary.trim()) throw new AlmError("input", "createDefect: summary mancante");
    const type = d.issue_type ?? this.config.defects?.issue_type ?? "Bug";
    const bad = refusedIssueType(type);
    if (bad) throw new AlmError("refused", bad);
    const fields = {
      project: { key: this.project(d.project ?? this.config.defects?.project) },
      issuetype: { name: type },
      summary: strictText(d.summary, this.env).slice(0, 250),
      description: strictText(d.description ?? "", this.env),
      labels: defectLabels(d),
    };
    const assignee = d.assignee ?? this.config.defects?.assignee_by_scope?.[d.scope] ?? null;
    if (assignee) fields.assignee = this.userField(String(assignee));
    const key = await this.createIssue(fields);
    if (Array.isArray(d.attachments) && d.attachments.length) await this.jira("POST", `/rest/api/2/issue/${key}/attachments`, attachmentForm(d.attachments), { "X-Atlassian-Token": "no-check" });
    if (d.precedent?.key) await this.issueLink(this.config.links?.regression ?? "Relates", key, checkKey(d.precedent.key, "precedente"));
    return { key };
  }

  async issueLink(type, from, to) {
    await this.jira("POST", "/rest/api/2/issueLink", { type: { name: type }, inwardIssue: { key: from }, outwardIssue: { key: to } });
  }

  async link(from, to, kind) {
    checkKey(from, "from"); checkKey(to, "to");
    if (!LINK_KINDS.includes(kind)) throw new AlmError("input", `tipo di collegamento non ammesso: ${kind} (tests | defect)`);
    const type = kind === "tests" ? this.config.links?.tests ?? "Tests" : this.config.links?.defect ?? "Defect";
    await this.issueLink(type, from, to);
  }
}

export class XrayCloudAdapter extends JiraBase {
  constructor(config = {}, opts = {}) {
    super(config, opts);
    this.token = null;
  }
  xrayBase() { return declaredUrl(this.config.xray_url ?? XRAY_CLOUD_DEFAULT, this.config, "URL di Xray Cloud", this.networkHosts); }
  jiraHeaders() {
    const user = this.env.JIRA_USER; const tok = this.env.JIRA_API_TOKEN;
    if (!user || !tok) throw new AlmError("auth", "credenziali Jira assenti: JIRA_USER e JIRA_API_TOKEN nell'ambiente (§48.1)");
    return { Authorization: basicAuth(user, tok) };
  }
  userField(accountId) { return { accountId }; }

  async authenticate() {
    const id = this.env.XRAY_CLIENT_ID; const secret = this.env.XRAY_CLIENT_SECRET;
    if (!id || !secret) throw new AlmError("auth", "credenziali Xray Cloud assenti: XRAY_CLIENT_ID e XRAY_CLIENT_SECRET nell'ambiente (§48.1)");
    const r = await request(this.config, { method: "POST", url: `${this.xrayBase()}/api/v2/authenticate`, headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ client_id: id, client_secret: secret }), env: this.env, fetchImpl: this.fetchImpl, networkHosts: this.networkHosts });
    const tok = typeof r.json === "string" ? r.json : r.text.replace(/^"|"$/g, "");
    if (!tok) throw new AlmError("auth", "Xray Cloud: autenticazione senza token");
    this.token = tok;
  }
  // WP09c giro 1: token scaduto (401) ⇒ una sola nuova autenticazione e un solo nuovo tentativo
  async xray(method, path, body, retried = false) {
    if (!this.token) await this.authenticate();
    try {
      return await request(this.config, { method, url: `${this.xrayBase()}${path}`, headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json", Accept: "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body), env: this.env, fetchImpl: this.fetchImpl, networkHosts: this.networkHosts });
    } catch (err) {
      if (retried || !(err instanceof AlmError) || err.status !== 401) throw err;
      this.token = null;
      return this.xray(method, path, body, true);
    }
  }
  async graphql(query, variables) {
    const r = await this.xray("POST", "/api/v2/graphql", { query, variables });
    if (r.json?.errors?.length) throw new AlmError("http", `Xray GraphQL: ${String(r.json.errors[0]?.message ?? "errore").slice(0, 200)}`);
    return r.json?.data ?? {};
  }

  static toTest(r) {
    const j = r?.jira ?? {};
    return { key: j.key, summary: j.summary ?? "", labels: j.labels ?? [], type: r?.testType?.name ?? null, status: j.status?.name ?? null };
  }
  async searchTests(jql, limit = 100) {
    const q = `query($jql: String, $limit: Int!) { getTests(jql: $jql, limit: $limit) { total results { issueId testType { name } jira(fields: ["key", "summary", "labels", "status"]) } } }`;
    const d = await this.graphql(q, { jql, limit });
    return (d.getTests?.results ?? []).map(XrayCloudAdapter.toTest).filter((t) => typeof t.key === "string");
  }
  async getTest(key) {
    checkKey(key);
    const list = await this.searchTests(`key = ${jqlString(key)}`, 1);
    return list.find((t) => t.key === key) ?? null;
  }
  async findTests(q = {}) {
    const parts = [`project = ${jqlString(this.project())}`, "issuetype = Test"];
    if (q.plan) parts.push(`issue in testPlanTests(${jqlString(checkKey(q.plan, "piano"))})`);
    for (const l of checkLabels(q.labels)) parts.push(`labels = ${jqlString(l)}`);
    if (q.text) parts.push(`text ~ ${jqlString(String(q.text).slice(0, 200))}`);
    return this.searchTests(parts.join(" AND "));
  }

  async importResults(executionKey, results) {
    checkKey(executionKey, "executionKey");
    checkResults(results, { allowTestCreation: this.config.allow_test_issue_creation === true });
    const { labels, ...info } = results.info ?? {};   // le etichette si mettono alla creazione (createExecution)
    const payload = { testExecutionKey: executionKey, ...(Object.keys(info).length ? { info } : {}), tests: results.tests };
    const r = await this.xray("POST", "/api/v2/import/execution", payload);
    return { key: r.json?.key ?? executionKey, tests: results.tests.length, evidence: countEvidence(results) };
  }

  async getExecution(key) {
    checkKey(key);
    const q = `query($jql: String, $limit: Int!) { getTestExecutions(jql: $jql, limit: $limit) { results { jira(fields: ["key"]) testRuns(limit: 100) { results { status { name } test { jira(fields: ["key"]) } steps { status { name } evidence { filename } } } } } } }`;
    const d = await this.graphql(q, { jql: `key = ${jqlString(key)}`, limit: 1 });
    const ex = (d.getTestExecutions?.results ?? [])[0];
    if (!ex) return null;
    return { key, tests: (ex.testRuns?.results ?? []).map((r) => ({ testKey: r.test?.jira?.key, status: r.status?.name ?? null, steps: (r.steps ?? []).map((s) => ({ status: s.status?.name ?? null, evidence: (s.evidence ?? []).length })) })) };
  }
}
