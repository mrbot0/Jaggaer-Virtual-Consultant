// XrayServerAdapter (§46.5): Xray Server/Data Center + Jira Server/DC REST v2, Personal Access Token (Bearer) da
// XRAY_TOKEN (solo ambiente). Stesso contratto del cloud:
//  - authenticate: GET /rest/api/2/myself (verifica del PAT; nessun token stampato);
//  - getTest: GET /rest/api/2/issue/<key> (404 ⇒ null); findTests: GET /rest/api/2/search?jql=… (JQL da valori validati);
//  - createExecution / createDefect / link: Jira REST v2 (JiraBase in xray-cloud.mjs), utenti per nome;
//  - importResults: POST /rest/raven/1.0/import/execution, formato nativo con testExecutionKey (evidenze sul passo);
//  - getExecution (verify): GET /rest/raven/1.0/api/testexec/<key>/test e /rest/raven/1.0/api/testrun/<id>.
import { AlmError, checkKey, checkLabels, checkResults, countEvidence, jqlString } from "./adapter.mjs";
import { JiraBase } from "./xray-cloud.mjs";

// WP09c giro 1 (I3): il JSON nativo di Xray Server/DC usa gli stati predefiniti PASS/FAIL/TODO/EXECUTING/ABORTED e il
// campo "evidences" (Cloud: PASSED/FAILED/… ed "evidence"). Stati personalizzati dell'istanza: config statuses.dc
// (nome Cloud → nome DC). Il formato va confermato sulla versione DC del cliente (M13).
export const DC_STATUS = Object.freeze({ PASSED: "PASS", FAILED: "FAIL", TODO: "TODO", EXECUTING: "EXECUTING", ABORTED: "ABORTED" });
export function toDcResults(results, map = {}) {
  const st = (x) => map[x] ?? DC_STATUS[x] ?? x;
  const conv = (o) => { const { evidence, ...rest } = o; return { ...rest, status: st(o.status), ...(evidence ? { evidences: evidence } : {}) }; };
  return { ...results, tests: results.tests.map((t) => ({ ...conv(t), ...(t.steps ? { steps: t.steps.map(conv) } : {}) })) };
}
export function fromDcStatus(x, map = {}) {
  const back = Object.fromEntries([...Object.entries(DC_STATUS), ...Object.entries(map)].map(([k, v]) => [v, k]));
  return back[x] ?? x;
}

export class XrayServerAdapter extends JiraBase {
  jiraHeaders() {
    const tok = this.env.XRAY_TOKEN;
    if (!tok) throw new AlmError("auth", "Personal Access Token assente: XRAY_TOKEN nell'ambiente (§48.1)");
    return { Authorization: `Bearer ${tok}` };
  }

  async authenticate() { await this.jira("GET", "/rest/api/2/myself"); }

  static toTest(i) {
    const f = i?.fields ?? {};
    return { key: i?.key, summary: f.summary ?? "", labels: f.labels ?? [], type: f.issuetype?.name ?? null, status: f.status?.name ?? null };
  }
  async getTest(key) {
    checkKey(key);
    try {
      const r = await this.jira("GET", `/rest/api/2/issue/${key}?fields=summary,labels,issuetype,status`);
      return r.json?.key ? XrayServerAdapter.toTest(r.json) : null;
    } catch (err) { if (err instanceof AlmError && err.code === "not-found") return null; throw err; }
  }
  async findTests(q = {}) {
    const parts = [`project = ${jqlString(this.project())}`, "issuetype = Test"];
    if (q.plan) parts.push(`issue in testPlanTests(${jqlString(checkKey(q.plan, "piano"))})`);
    for (const l of checkLabels(q.labels)) parts.push(`labels = ${jqlString(l)}`);
    if (q.text) parts.push(`text ~ ${jqlString(String(q.text).slice(0, 200))}`);
    const r = await this.jira("GET", `/rest/api/2/search?maxResults=100&fields=summary,labels,issuetype,status&jql=${encodeURIComponent(parts.join(" AND "))}`);
    return (r.json?.issues ?? []).map(XrayServerAdapter.toTest).filter((t) => typeof t.key === "string");
  }

  async importResults(executionKey, results) {
    checkKey(executionKey, "executionKey");
    checkResults(results, { allowTestCreation: this.config.allow_test_issue_creation === true });
    const { labels, ...info } = results.info ?? {};
    const payload = { testExecutionKey: executionKey, ...(Object.keys(info).length ? { info } : {}), tests: toDcResults(results, this.config.statuses?.dc ?? {}).tests };
    const r = await this.jira("POST", "/rest/raven/1.0/import/execution", payload);
    return { key: r.json?.testExecIssue?.key ?? executionKey, tests: results.tests.length, evidence: countEvidence(results) };
  }

  async getExecution(key) {
    checkKey(key);
    let runs;
    try { runs = (await this.jira("GET", `/rest/raven/1.0/api/testexec/${key}/test`)).json ?? []; } catch (err) { if (err instanceof AlmError && err.code === "not-found") return null; throw err; }
    const tests = [];
    for (const run of Array.isArray(runs) ? runs : []) {
      const d = Number.isInteger(run?.id) ? (await this.jira("GET", `/rest/raven/1.0/api/testrun/${run.id}`)).json ?? {} : {};
      const map = this.config.statuses?.dc ?? {};
      tests.push({ testKey: run?.key, status: fromDcStatus(run?.status ?? d.status ?? null, map), steps: (d.steps ?? []).map((s) => ({ status: fromDcStatus(s.status?.name ?? s.status ?? null, map), evidence: (s.evidences ?? s.evidence ?? []).length })) });
    }
    return { key, tests };
  }
}
