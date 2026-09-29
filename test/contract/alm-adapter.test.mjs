// WP09c — contratto AlmAdapter (§46.5) condiviso da tutte le implementazioni: MockAlmAdapter, XrayCloudAdapter e
// XrayServerAdapter (questi due contro un mock HTTP locale node:http che registra le richieste; mai Jira/Xray reali).
// Poi le verifiche specifiche delle implementazioni reali: autenticazione, forma del payload nativo con le evidenze
// sul passo giusto, Defect con etichetta scope e profilo strict, host non dichiarato rifiutato, segreti mai
// nei messaggi, rete giù ⇒ coda offline (queued) e retry.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import YAML from "yaml";
import { assertAdapter, methodNames, FORBIDDEN_METHOD, AlmError, ADAPTER_METHODS } from "../../mcp/alm-server/adapter.mjs";
import { MockAlmAdapter } from "../../mcp/alm-server/mock.mjs";
import { XrayCloudAdapter } from "../../mcp/alm-server/xray-cloud.mjs";
import { XrayServerAdapter } from "../../mcp/alm-server/xray-server.mjs";
import { createAdapter, loadXrayConfig } from "../../mcp/alm-server/factory.mjs";
import { OfflineQueue, withQueue } from "../../mcp/alm-server/queue.mjs";
import { materializeResults } from "../../mcp/alm-server/payload.mjs";
import { startAlmMock, closedUrl, CREDS } from "../helpers/alm-http-mock.mjs";

const RUN = "RUN.ACME.20260929.1000.P2P";
const TESTS = [{ key: "PROJ-1", summary: "RdA con CdC non attivo", labels: ["scope:P2P", "nrt"], plans: ["PROJ-50"] }, { key: "PROJ-2", summary: "Catalogo pubblicato", labels: ["scope:CAT"], plans: [] }];
const NET = { retries: 1, backoff_ms: 0, timeout_ms: 3000 };
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const results = () => ({
  info: { project: "PROJ", summary: `${RUN} — scope P2P`, testPlanKey: "PROJ-50", labels: ["scope:P2P"] },
  tests: [
    { testKey: "PROJ-1", status: "PASSED", comment: "EXPECTED-ERROR-AS-SUCCESS", steps: [{ status: "PASSED" }, { status: "PASSED", evidence: [{ data: PNG.toString("base64"), filename: "EV-02.png", contentType: "image/png" }] }] },
    { testKey: "PROJ-2", status: "ABORTED", comment: "ERROR-ENVIRONMENT", steps: [{ status: "ABORTED" }] },
  ],
});

let http;
before(async () => { http = await startAlmMock({ tests: TESTS }); });
after(async () => { await http.close(); });

const cloudCfg = (extra = {}) => ({ deployment: "cloud", base_url: http.url, xray_url: http.url, project: "PROJ", network: NET, defects: { issue_type: "Bug", assignee_by_scope: { P2P: "acc-557058:p2p-owner" } }, ...extra });
const serverCfg = (extra = {}) => ({ deployment: "server", base_url: http.url, project: "PROJ", network: NET, defects: { issue_type: "Defect", assignee_by_scope: { P2P: "mrossi" } }, ...extra });
const IMPLS = {
  mock: () => new MockAlmAdapter({ deployment: "mock", project: "PROJ", mock: { tests: TESTS }, defects: { issue_type: "Bug" } }, { env: {} }),
  cloud: () => new XrayCloudAdapter(cloudCfg(), { env: { ...CREDS } }),
  server: () => new XrayServerAdapter(serverCfg(), { env: { ...CREDS } }),
};

for (const [name, make] of Object.entries(IMPLS)) {
  test(`contratto AlmAdapter — ${name}: metodi, nessuna cancellazione, letture, esecuzione, import con evidenze sul passo, Defect, link`, async () => {
    const a = make();
    assert.equal(assertAdapter(a), a);
    for (const m of ADAPTER_METHODS) assert.equal(typeof a[m], "function", m);
    const names = methodNames(a);
    assert.deepEqual(names.filter((n) => FORBIDDEN_METHOD.test(n)), [], "nessun delete*, update*, createIncident");
    for (const n of names) assert.ok(!/^delete|incident/i.test(n), n);
    await a.authenticate();
    assert.deepEqual(await a.getTest("PROJ-1").then((t) => [t.key, t.summary]), ["PROJ-1", "RdA con CdC non attivo"]);
    assert.equal(await a.getTest("PROJ-999"), null);
    await assert.rejects(a.getTest("proj 1"), (e) => e instanceof AlmError && e.code === "input");
    assert.deepEqual((await a.findTests({ labels: ["scope:P2P"] })).map((t) => t.key), ["PROJ-1"]);
    assert.deepEqual((await a.findTests({ plan: "PROJ-50" })).map((t) => t.key), ["PROJ-1"]);
    const ex = await a.createExecution({ summary: `${RUN} — scope P2P`, scope: "P2P", run: RUN, testPlanKey: "PROJ-50" });
    assert.match(ex.key, /^PROJ-\d+$/);
    const rep = await a.importResults(ex.key, results());
    assert.deepEqual(rep, { key: ex.key, tests: 2, evidence: 1 });
    const back = await a.getExecution(ex.key);
    const t1 = back.tests.find((t) => t.testKey === "PROJ-1");
    assert.equal(t1.status, "PASSED");
    assert.deepEqual(t1.steps.map((s) => s.evidence), [0, 1], "evidenza sul secondo passo");
    assert.equal(back.tests.find((t) => t.testKey === "PROJ-2").status, "ABORTED");
    await assert.rejects(a.importResults(ex.key, { tests: [{ testKey: "PROJ-1", status: "BROKEN" }] }), (e) => e.code === "input");
    await assert.rejects(a.createDefect({ summary: "x", scope: "P2P", issue_type: "Incident" }), (e) => e instanceof AlmError && e.code === "refused" && /ADR-27/.test(e.message));
    await assert.rejects(a.createDefect({ summary: "x", scope: "P2P", issue_type: "IT Incident" }), (e) => e.code === "refused");
    await assert.rejects(a.createDefect({ summary: "x", scope: "P2P", issue_type: "Test" }), (e) => e.code === "refused" && /ADR-21/.test(e.message));
    await assert.rejects(a.createDefect({ summary: "x", scope: "p2p" }), (e) => e.code === "input");
    const d = await a.createDefect({ summary: "Ordine SENT con messaggio in errore", scope: "P2P", description: "atteso non SENT", precedent: { key: "PROJ-7", fixed_in: "R25.2" } });
    assert.match(d.key, /^PROJ-\d+$/);
    await a.link(d.key, "PROJ-1", "defect");
    await a.link(ex.key, "PROJ-1", "tests");
    await assert.rejects(a.link(d.key, "PROJ-1", "blocks"), (e) => e.code === "input");
  });
}

test("factory: deployment cloud|server|mock da xray.yaml validato; JVC_ALM_ADAPTER=mock forza il mock; deployment ignoto ⇒ errore", async () => {
  assert.ok(createAdapter({ deployment: "cloud", base_url: "https://acme.atlassian.net", project: "PROJ" }, { env: {} }) instanceof XrayCloudAdapter);
  assert.ok(createAdapter({ deployment: "server", base_url: "https://jira.acme.it", project: "PROJ" }, { env: {} }) instanceof XrayServerAdapter);
  assert.ok(createAdapter({ deployment: "cloud" }, { env: { JVC_ALM_ADAPTER: "mock" } }) instanceof MockAlmAdapter);
  assert.throws(() => createAdapter({ deployment: "jira" }, { env: {} }), /deployment non valido/);
  const ws = realpathSync.native(mkdtempSync(join(tmpdir(), "jvc-xcfg-")));
  mkdirSync(join(ws, "customers/ACME/config"), { recursive: true });
  writeFileSync(join(ws, "customers/ACME/config/xray.yaml"), "deployment: cloud\nbase_url: https://acme.atlassian.net\nproject: PROJ\ntest_plan_by_scope: { P2P: PROJ-50 }\n");
  const c = await loadXrayConfig(ws, "ACME");
  assert.equal(c.offline_queue, true, "coda offline di default");
  assert.equal(c.allow_test_issue_creation, false, "nessuna Test issue di default (ADR-21)");
  assert.equal(c.statuses.error_environment, "ABORTED");
  for (const bad of ["deployment: cloud\nproject: PROJ\n", "deployment: server\nbase_url: https://jira.acme.it\nproject: PROJ\ndefects: { issue_type: Incident }\n",
    "deployment: cloud\nbase_url: https://acme.atlassian.net\nproject: PROJ\nstatuses: { error_environment: FAILED }\n", "deployment: cloud\nbase_url: https://acme.atlassian.net\nproject: PROJ\napi_token: abc\n"]) {
    writeFileSync(join(ws, "customers/ACME/config/xray.yaml"), bad);
    await assert.rejects(loadXrayConfig(ws, "ACME"), (e) => e.code === "config", bad);
  }
});

test("Xray Cloud: autenticazione con client_id/secret dall'ambiente, Bearer sugli import; payload nativo con evidenze sul passo; etichette alla creazione", async () => {
  const start = http.state.requests.length;
  const a = new XrayCloudAdapter(cloudCfg(), { env: { ...CREDS } });
  await a.authenticate();
  const auth = http.state.requests.slice(start).find((r) => r.path === "/api/v2/authenticate");
  assert.deepEqual(auth.json, { client_id: CREDS.XRAY_CLIENT_ID, client_secret: CREDS.XRAY_CLIENT_SECRET });
  const ex = await a.createExecution({ summary: `${RUN} — scope P2P`, scope: "P2P", run: RUN });
  const create = http.state.requests.slice(start).find((r) => r.path === "/rest/api/2/issue");
  assert.equal(create.json.fields.issuetype.name, "Test Execution");
  assert.deepEqual(create.json.fields.labels, ["scope:P2P", `run:${RUN}`]);
  assert.match(create.headers.authorization, /^Basic /);
  await a.importResults(ex.key, results());
  const imp = http.state.requests.slice(start).find((r) => r.path === "/api/v2/import/execution");
  assert.equal(imp.headers.authorization, "Bearer xray-bearer-test-51c0");
  assert.equal(imp.json.testExecutionKey, ex.key);
  assert.equal(imp.json.info.testPlanKey, "PROJ-50");
  assert.equal(imp.json.info.labels, undefined, "le etichette non fanno parte del formato di import");
  assert.equal(imp.json.tests[0].steps[0].evidence, undefined);
  assert.deepEqual(Object.keys(imp.json.tests[0].steps[1].evidence[0]).sort(), ["contentType", "data", "filename"]);
  assert.equal(Buffer.from(imp.json.tests[0].steps[1].evidence[0].data, "base64").equals(PNG), true);
  assert.equal(imp.json.tests[1].status, "ABORTED", "ERROR-ENVIRONMENT mai FAILED");
  await assert.rejects(new XrayCloudAdapter(cloudCfg(), { env: {} }).authenticate(), (e) => e.code === "auth" && /XRAY_CLIENT_ID/.test(e.message));
});

test("Defect (cloud e server): tipo da config, etichetta scope, assegnatario dal registro, testo strict, allegati, precedente di regressione collegato", async () => {
  for (const [a, assignee] of [[new XrayCloudAdapter(cloudCfg(), { env: { ...CREDS } }), { accountId: "acc-557058:p2p-owner" }], [new XrayServerAdapter(serverCfg(), { env: { ...CREDS } }), { name: "mrossi" }]]) {
    const start = http.state.requests.length;
    const d = await a.createDefect({ summary: "Ordine SENT per mario.rossi@acme.it", scope: "P2P", description: "Importo € 1.250,00 atteso rifiutato", labels: ["nrt"],
      precedent: { key: "PROJ-7", fixed_in: "R25.2" }, attachments: [{ data: PNG.toString("base64"), filename: "EV-06.png", contentType: "image/png" }] });
    const reqs = http.state.requests.slice(start);
    const c = reqs.find((r) => r.path === "/rest/api/2/issue");
    assert.equal(c.json.fields.issuetype.name, a instanceof XrayCloudAdapter ? "Bug" : "Defect");
    assert.deepEqual(c.json.fields.labels, ["scope:P2P", "nrt"]);
    assert.deepEqual(c.json.fields.assignee, assignee);
    assert.ok(!/mario\.rossi@acme\.it/.test(c.body) && !/1\.250,00/.test(c.body), "profilo strict verso Jira");
    const att = reqs.find((r) => r.path === `/rest/api/2/issue/${d.key}/attachments`);
    assert.equal(att.headers["x-atlassian-token"], "no-check");
    assert.deepEqual(http.state.attachments.at(-1).names, ["EV-06.png"]);
    const link = reqs.find((r) => r.path === "/rest/api/2/issueLink");
    assert.deepEqual([link.json.type.name, link.json.inwardIssue.key, link.json.outwardIssue.key], ["Relates", d.key, "PROJ-7"]);
    if (a instanceof XrayServerAdapter) assert.equal(c.headers.authorization, `Bearer ${CREDS.XRAY_TOKEN}`);
  }
});

test("host non dichiarato in xray.yaml (JIRA_BASE_URL altrove) o http non loopback ⇒ rifiuto senza alcuna richiesta; redirect non seguiti", async () => {
  const start = http.state.requests.length;
  const a = new XrayCloudAdapter(cloudCfg(), { env: { ...CREDS, JIRA_BASE_URL: "https://jira.evil-example.com" } });
  await assert.rejects(a.createDefect({ summary: "x", scope: "P2P" }), (e) => e.code === "refused" && /non dichiarato/.test(e.message));
  const s = new XrayServerAdapter({ deployment: "server", base_url: "http://jira.acme.it", project: "PROJ", network: NET }, { env: { ...CREDS } });
  await assert.rejects(s.authenticate(), (e) => e.code === "refused" && /https/.test(e.message));
  assert.equal(http.state.requests.length, start, "nessuna richiesta partita");
  http.setFail({ path: /^\/rest\/api\/2\/myself$/, status: 302, body: {} });
  try { await assert.rejects(new XrayServerAdapter(serverCfg(), { env: { ...CREDS } }).authenticate(), (e) => e.code === "http" && /redirect/.test(e.message)); } finally { http.setFail(null); }
});

test("segreti mai nei messaggi d'errore: una risposta che li riecheggia è redatta", async () => {
  http.setFail({ path: /^\/rest\/api\/2\/issue$/, status: 400, body: { errorMessages: [`bad token ${CREDS.XRAY_TOKEN} and ${CREDS.JIRA_API_TOKEN} Bearer abcdefghijkl`] } });
  try {
    for (const a of [new XrayServerAdapter(serverCfg(), { env: { ...CREDS } }), new XrayCloudAdapter(cloudCfg(), { env: { ...CREDS } })]) {
      const err = await a.createDefect({ summary: "x", scope: "P2P" }).catch((e) => e);
      assert.ok(err instanceof AlmError);
      for (const v of Object.values(CREDS)) assert.ok(!err.message.includes(v), `${v} in ${err.message}`);
      assert.ok(!/abcdefghijkl/.test(err.message));
    }
  } finally { http.setFail(null); }
});

function dossier() {
  const ws = realpathSync.native(mkdtempSync(join(tmpdir(), "jvc-queue-")));
  const dir = join(ws, "customers/ACME/runs", RUN, "cases/NRT.ACME.P2P.NEG.0031/evidence");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "02.png"), PNG);
  const evd = (profile, publishable) => YAML.stringify({ id: "EV-02", type: "EVD", step: 2, kind: "failure", profile, publishable, sha256: createHash("sha256").update(PNG).digest("hex"), file: `customers/ACME/runs/${RUN}/cases/NRT.ACME.P2P.NEG.0031/evidence/02.png` });
  writeFileSync(join(dir, "02.yaml"), evd("strict", true));
  return { ws, evd: (p, pub) => writeFileSync(join(dir, "02.yaml"), evd(p, pub)), file: `customers/ACME/runs/${RUN}/cases/NRT.ACME.P2P.NEG.0031/evidence/02.png` };
}
const fileResults = (file) => ({ info: { project: "PROJ", summary: RUN }, tests: [{ testKey: "PROJ-1", status: "FAILED", steps: [{ status: "PASSED" }, { status: "FAILED", evidence: [{ file }] }] }] });

test("evidenze dal dossier: solo EVD strict e pubblicabili, sotto runs/ del cliente, non alterate", async () => {
  const d = dossier();
  const m = await materializeResults(d.ws, "ACME", fileResults(d.file));
  assert.equal(Buffer.from(m.tests[0].steps[1].evidence[0].data, "base64").equals(PNG), true);
  assert.equal(m.tests[0].steps[1].evidence[0].contentType, "image/png");
  d.evd("standard", true);
  await assert.rejects(materializeResults(d.ws, "ACME", fileResults(d.file)), /strict/);
  d.evd("strict", false);
  await assert.rejects(materializeResults(d.ws, "ACME", fileResults(d.file)), /non pubblicabile/);
  d.evd("strict", true);
  await assert.rejects(materializeResults(d.ws, "ACME", fileResults("customers/ACME/config/xray.yaml")), (e) => e.code === "refused" || e.code === "input");
  await assert.rejects(materializeResults(d.ws, "ACME", fileResults("../../etc/passwd")), (e) => e.code === "refused" || e.code === "input");
  await assert.rejects(materializeResults(d.ws, "ACME", { tests: [{ testKey: "PROJ-1", status: "PASSED", steps: [{ status: "PASSED", evidence: [{ data: "AAAA", filename: "x.png", contentType: "image/png" }] }] }] }), /inline/);
  writeFileSync(join(d.ws, d.file), Buffer.concat([PNG, Buffer.from("x")]));
  await assert.rejects(materializeResults(d.ws, "ACME", fileResults(d.file)), /alterata/);
});

test("rete giù (Jira/Xray irraggiungibili) ⇒ importResults e createDefect in coda offline { queued: true }: payload nel dossier + indice; retry con la rete tornata ⇒ inviati", async () => {
  const d = dossier();
  const down = await closedUrl();
  const offline = new XrayServerAdapter({ deployment: "server", base_url: down, project: "PROJ", network: NET }, { env: { ...CREDS } });
  const q = new OfflineQueue(d.ws, "ACME", { env: CREDS });
  const payload = { execution: { summary: `${RUN} — scope P2P`, scope: "P2P", run: RUN, testPlanKey: "PROJ-50" }, results: fileResults(d.file) };
  const err = await offline.importResults("PROJ-77", await materializeResults(d.ws, "ACME", payload.results)).catch((e) => e);
  assert.ok(err instanceof AlmError && err.network, `errore di rete atteso: ${err?.message}`);
  const r1 = await withQueue({ offline_queue: true }, q, async () => { throw err; }, { op: "import", run: RUN, scope: "P2P", payload });
  assert.equal(r1.queued, true);
  assert.equal(r1.payload, `runs/${RUN}/xray-payload.json`);
  const p = JSON.parse(readFileSync(join(d.ws, "customers/ACME/runs", RUN, "xray-payload.json"), "utf8"));
  assert.equal(p.executions.P2P.results.tests[0].steps[1].evidence[0].file, d.file, "il dossier cita il file, leggibile");
  const r2 = await withQueue({ offline_queue: true }, q, () => offline.createDefect({ summary: "x", scope: "P2P" }), { op: "defect", run: RUN, payload: { defect: { summary: "Totale errato", scope: "P2P", attachments: [{ file: d.file }] } } });
  assert.equal(r2.queued, true);
  assert.equal(readdirSync(join(d.ws, "customers/ACME/queue")).length, 2);
  assert.deepEqual([q.status().pending, q.status().items.map((i) => i.op).sort()], [2, ["defect", "import"]]);
  for (const v of Object.values(CREDS)) assert.ok(!JSON.stringify(q.list()).includes(v), "nessun segreto nella coda");
  // coda disabilitata ⇒ l'errore propaga
  await assert.rejects(withQueue({ offline_queue: false }, q, async () => { throw err; }, { op: "import", payload }), (e) => e.network);
  // ancora giù ⇒ restano in coda
  const still = await q.retryQueued(offline);
  assert.equal(still.still_queued.length, 2);
  // rete tornata
  const online = new XrayServerAdapter(serverCfg(), { env: { ...CREDS } });
  const sent = await q.retryQueued(online);
  assert.equal(sent.sent.length, 2, JSON.stringify(sent));
  assert.equal(q.status().pending, 0);
  assert.equal(q.list().length, 2, "le voci non si cancellano: passano a sent");
  const pub = JSON.parse(readFileSync(join(d.ws, "customers/ACME/runs", RUN, "xray-published.json"), "utf8"));
  assert.match(pub.scopes.P2P.execution_key, /^PROJ-\d+$/);
  const imp = http.state.imports.at(-1);
  assert.equal(imp.key, pub.scopes.P2P.execution_key);
  assert.equal(Buffer.from(imp.body.tests[0].steps[1].evidence[0].data, "base64").equals(PNG), true, "evidenza sul passo 2 dopo il retry");
  assert.ok(existsSync(join(d.ws, "customers/ACME/runs", RUN, "xray-payload.json")));
});
