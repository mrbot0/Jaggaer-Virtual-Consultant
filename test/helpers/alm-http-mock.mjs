// Mock HTTP locale (node:http, 127.0.0.1) di Jira + Xray Cloud + Xray Server/DC per i test di contratto degli
// adattatori ALM: registra ogni richiesta (metodo, percorso, intestazioni, corpo) e simula il minimo di stato che il
// contratto osserva. MAI Jira/Xray reali. Credenziali di prova fisse (CREDS), non segreti veri.
import { createServer } from "node:http";
import { readFileSync, writeFileSync, cpSync } from "node:fs";
import { join } from "node:path";
import { copyPlugin } from "./plugin-copy.mjs";
import { ROOT } from "./hook-env.mjs";

export const CREDS = Object.freeze({
  XRAY_CLIENT_ID: "cid-test-0001", XRAY_CLIENT_SECRET: "csecret-test-7f3a9", JIRA_USER: "bot-user", JIRA_API_TOKEN: "jira-token-test-4b2c", XRAY_TOKEN: "pat-test-9d1e",
});
const XRAY_TOKEN_ISSUED = "xray-bearer-test-51c0";

// WP09c giro 1 (I3): forma del JSON nativo per piattaforma — Cloud: PASSED/FAILED/…, "evidence"; Server/DC: PASS/FAIL/…,
// "evidences". Il mock rifiuta (400) la forma dell'altra piattaforma.
const CLOUD_ST = new Set(["PASSED", "FAILED", "TODO", "EXECUTING", "ABORTED"]);
const DC_ST = new Set(["PASS", "FAIL", "TODO", "EXECUTING", "ABORTED"]);
export function shapeError(body, dc) {
  const ok = dc ? DC_ST : CLOUD_ST; const good = dc ? "evidences" : "evidence"; const bad = dc ? "evidence" : "evidences";
  for (const t of body?.tests ?? []) {
    if (!ok.has(t.status)) return `stato ${t.status} non valido per ${dc ? "Xray Server/DC" : "Xray Cloud"}`;
    if (bad in t) return `campo ${bad} non valido (atteso ${good})`;
    for (const s of t.steps ?? []) { if (!ok.has(s.status)) return `stato di passo ${s.status} non valido`; if (bad in s) return `campo ${bad} nel passo (atteso ${good})`; }
  }
  return null;
}

// Copia del plugin il cui NETWORK.md ammette anche il loopback nella categoria alm (solo per i mock locali dei test):
// il NETWORK.md del pacchetto non lo ammette e l'adattatore rifiuta ogni host fuori da quella categoria.
export function almPlugin() {
  const p = copyPlugin("jvc-plugin-alm-");
  cpSync(join(ROOT, "product"), join(p, "product"), { recursive: true });   // catalogo delle azioni (evidence select)
  const f = join(p, "NETWORK.md");
  const text = readFileSync(f, "utf8");
  const next = text.replace("| alm | `*.atlassian.net`, `*.getxray.app` |", "| alm | `*.atlassian.net`, `*.getxray.app`, `127.0.0.1` |");
  if (next === text) throw new Error("riga alm di NETWORK.md non trovata");
  writeFileSync(f, next);
  return p;
}

export async function startAlmMock({ tests = [], project = "PROJ", fail = null } = {}) {
  const state = { tokenVersion: 0, seq: 100, tests: new Map(tests.map((t) => [t.key, { labels: [], plans: [], summary: "", ...t }])), issues: new Map(), imports: [], links: [], attachments: [], requests: [] };
  const basic = `Basic ${Buffer.from(`${CREDS.JIRA_USER}:${CREDS.JIRA_API_TOKEN}`).toString("base64")}`;
  const jiraOk = (h) => h.authorization === basic || h.authorization === `Bearer ${CREDS.XRAY_TOKEN}`;
  const token = () => `${XRAY_TOKEN_ISSUED}${state.tokenVersion ? `-v${state.tokenVersion}` : ""}`;
  const xrayOk = (h) => h.authorization === `Bearer ${token()}`;
  const filter = (jql = "") => {
    let list = [...state.tests.values()];
    const key = /key = "([^"]+)"/.exec(jql)?.[1];
    if (key) list = list.filter((t) => t.key === key);
    for (const m of jql.matchAll(/labels = "([^"]+)"/g)) list = list.filter((t) => t.labels.includes(m[1]));
    const plan = /testPlanTests\("([^"]+)"\)/.exec(jql)?.[1];
    if (plan) list = list.filter((t) => t.plans.includes(plan));
    return list;
  };
  const runsOf = (key) => {
    const last = new Map();
    for (const imp of state.imports.filter((i) => i.key === key)) for (const t of imp.body.tests ?? []) last.set(t.testKey, t);
    return [...last.values()];
  };
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      const body = raw.toString("utf8");
      let json = null;
      try { json = body ? JSON.parse(body) : null; } catch { json = null; }
      const url = new URL(req.url, "http://x");
      const path = url.pathname;
      state.requests.push({ method: req.method, path, query: url.search, headers: { ...req.headers }, body, json });
      const send = (status, obj) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(obj === undefined ? "" : JSON.stringify(obj)); };
      if (fail && (fail.path == null || fail.path.test(path))) return send(fail.status, fail.body ?? { error: "failure" });
      if (req.method === "POST" && path === "/api/v2/authenticate") {
        return json?.client_id === CREDS.XRAY_CLIENT_ID && json?.client_secret === CREDS.XRAY_CLIENT_SECRET ? send(200, token()) : send(401, { error: "Authentication failed. Invalid client credentials!" });
      }
      if (path.startsWith("/api/v2/")) {
        if (!xrayOk(req.headers)) return send(401, { error: "Unauthorized" });
        if (req.method === "POST" && path === "/api/v2/graphql") {
          const q = json?.query ?? "";
          if (q.includes("getTests")) {
            const list = filter(json?.variables?.jql).slice(0, json?.variables?.limit ?? 100);
            return send(200, { data: { getTests: { total: list.length, results: list.map((t, i) => ({ issueId: String(10000 + i), testType: { name: "Manual" }, jira: { key: t.key, summary: t.summary, labels: t.labels, status: { name: "Open" } } })) } } });
          }
          if (q.includes("getTestExecutions")) {
            const key = /key = "([^"]+)"/.exec(json?.variables?.jql ?? "")?.[1];
            if (!state.issues.has(key)) return send(200, { data: { getTestExecutions: { total: 0, results: [] } } });
            return send(200, { data: { getTestExecutions: { total: 1, results: [{ jira: { key }, testRuns: { results: runsOf(key).map((t) => ({ status: { name: t.status }, test: { jira: { key: t.testKey } }, steps: (t.steps ?? []).map((s) => ({ status: { name: s.status }, evidence: (s.evidence ?? []).map((e) => ({ filename: e.filename })) })) })) } }] } } });
          }
          return send(400, { errors: [{ message: "query non supportata dal mock" }] });
        }
        if (req.method === "POST" && path === "/api/v2/import/execution") {
          const bad = shapeError(json, false);
          if (bad) return send(400, { error: bad });
          const key = json?.testExecutionKey ?? `${project}-${++state.seq}`;
          state.imports.push({ key, body: json, via: "cloud" });
          return send(200, { id: "20001", key, self: `http://x/rest/api/2/issue/${key}` });
        }
        return send(404, { error: "not found" });
      }
      if (!jiraOk(req.headers)) return send(401, { errorMessages: ["Unauthorized"] });
      if (req.method === "POST" && path === "/rest/raven/1.0/import/execution") {
        const bad = shapeError(json, true);
        if (bad) return send(400, { error: bad });
        const key = json?.testExecutionKey ?? `${project}-${++state.seq}`;
        state.imports.push({ key, body: json, via: "server" });
        return send(200, { testExecIssue: { id: "20001", key, self: `http://x/rest/api/2/issue/${key}` } });
      }
      let m;
      if (req.method === "GET" && (m = /^\/rest\/raven\/1\.0\/api\/testexec\/([^/]+)\/test$/.exec(path))) {
        if (!state.issues.has(m[1])) return send(404, { error: "Test Execution not found" });
        const ex = [...state.issues.keys()].indexOf(m[1]);
        return send(200, runsOf(m[1]).map((t, i) => ({ id: ex * 1000 + i, key: t.testKey, status: t.status })));
      }
      if (req.method === "GET" && (m = /^\/rest\/raven\/1\.0\/api\/testrun\/(\d+)$/.exec(path))) {
        const id = Number(m[1]);
        const all = [...state.issues.keys()].flatMap((k, ex) => runsOf(k).map((t, i) => ({ id: ex * 1000 + i, t })));
        const hit = all.find((x) => x.id === id);
        return hit ? send(200, { status: hit.t.status, steps: (hit.t.steps ?? []).map((s) => ({ status: { name: s.status }, evidences: (s.evidences ?? s.evidence ?? []).map((e) => ({ fileName: e.filename })) })) }) : send(404, { error: "run" });
      }
      if (req.method === "GET" && path === "/rest/api/2/myself") return send(200, { name: "svc" });
      if (req.method === "POST" && path === "/rest/api/2/issue") {
        const f = json?.fields ?? {};
        const key = `${f.project?.key ?? project}-${++state.seq}`;
        state.issues.set(key, { key, fields: f });
        return send(201, { id: String(state.seq), key, self: `http://x/rest/api/2/issue/${key}` });
      }
      if (req.method === "GET" && (m = /^\/rest\/api\/2\/issue\/([^/]+)$/.exec(path))) {
        const t = state.tests.get(m[1]);
        if (t) return send(200, { key: t.key, fields: { summary: t.summary, labels: t.labels, issuetype: { name: "Test" }, status: { name: "Open" } } });
        const i = state.issues.get(m[1]);
        return i ? send(200, { key: i.key, fields: i.fields }) : send(404, { errorMessages: ["Issue does not exist or you do not have permission to see it."] });
      }
      if (req.method === "GET" && path === "/rest/api/2/search") {
        const list = filter(url.searchParams.get("jql") ?? "");
        return send(200, { total: list.length, issues: list.map((t) => ({ key: t.key, fields: { summary: t.summary, labels: t.labels, issuetype: { name: "Test" }, status: { name: "Open" } } })) });
      }
      if (req.method === "POST" && path === "/rest/api/2/issueLink") { state.links.push(json); return send(201); }
      if (req.method === "POST" && (m = /^\/rest\/api\/2\/issue\/([^/]+)\/attachments$/.exec(path))) {
        if (req.headers["x-atlassian-token"] !== "no-check") return send(403, { errorMessages: ["XSRF check failed"] });
        const names = [...body.matchAll(/filename="([^"]+)"/g)].map((x) => x[1]);
        state.attachments.push({ key: m[1], names, bytes: raw.length });
        return send(200, names.map((filename) => ({ filename })));
      }
      return send(404, { errorMessages: ["route not in mock"] });
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, state, close: () => new Promise((r) => server.close(r)), setFail: (f) => { fail = f; }, expireToken: () => { state.tokenVersion += 1; } };
}

// Porta chiusa: un URL loopback a cui non risponde nessuno (rete giù).
export async function closedUrl() {
  const s = createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const port = s.address().port;
  await new Promise((r) => s.close(r));
  return `http://127.0.0.1:${port}`;
}
