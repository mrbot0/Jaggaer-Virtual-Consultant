// WP09c B — scripts/xray: build-payload (una Test Execution per run e per scope, stati da §29.9, evidenze strict sul
// passo), publish (factory, idempotente, coda offline), verify (rilettura), retry-queued, authenticate (nessun token
// nell'output) e defect (mai Incident, regressione, passi minimi, evidenze strict, confine di dominio). Contro il mock
// HTTP locale (node:http): mai Jira/Xray reali.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import YAML from "yaml";
import { mkWs, seedSession, cleanEnv, pinXray } from "../helpers/hook-env.mjs";
import { startAlmMock, closedUrl, almPlugin, CREDS } from "../helpers/alm-http-mock.mjs";
import { buildPayload, parseOutcomes } from "../../scripts/xray/build-payload.mjs";

const RUN = "RUN.ACME.20260929.1000.P2P";
const NEG = "NRT.ACME.P2P.NEG.0031"; const POS = "NRT.ACME.P2P.POS.0012"; const ENV = "NRT.ACME.P2P.POS.0013"; const NOKEY = "NRT.ACME.P2P.POS.0014"; const CAT = "NRT.ACME.CAT.POS.0001";
const KEYS = { [NEG]: "PROJ-31", [POS]: "PROJ-12", [ENV]: "PROJ-13", [CAT]: "PROJ-41" };
const png = (tag) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(tag)]);
let http;
// WP09c giro 1: script eseguiti da una copia del plugin il cui NETWORK.md ammette il loopback dei mock locali
let PLUGIN;
before(async () => { PLUGIN = almPlugin(); http = await startAlmMock({ tests: Object.values(KEYS).map((key) => ({ key, summary: key, labels: [] })) }); });
after(async () => { await http.close(); });

function xrayYaml(ws, base, extra = "") {
  writeFileSync(join(ws, "customers/ACME/config/xray.yaml"), `deployment: server\nbase_url: ${base}\nproject: PROJ\ntest_plan_by_scope: { P2P: PROJ-50, CAT: PROJ-60 }\n` +
    `defects: { issue_type: Defect, assignee_by_scope: { P2P: mrossi } }\nnetwork: { retries: 1, backoff_ms: 0, timeout_ms: 3000 }\nattachments_cap: 5\n${extra}`);
  pinXray(ws);   // WP09c giro 1: vale come fissata da use customer (l'utente modifica il file a mano, poi use customer)
}
function addCase(ws, id, { steps = 4, evidence = [], result = null } = {}) {
  const scope = id.split(".")[2];
  const dir = join(ws, "customers/ACME/runs", RUN, "cases", id);
  mkdirSync(join(dir, "evidence"), { recursive: true });
  writeFileSync(join(dir, "plan.json"), JSON.stringify({ plan_id: `PLAN.${id}`, customer: "ACME", env: "sandbox", goal: "g",
    steps: Array.from({ length: steps }, (_, i) => ({ n: i + 1, verb: ["NAVIGATE", "FILL", "SAVE", "SUBMIT"][i % 4], action_class: "ACT-OBS", note: `passo ${i + 1}` })), evidence: evidence.filter((e) => e.kind === "assertion").map((e) => ({ at: e.step, kind: "assertion" })) }));
  evidence.forEach((e, i) => {
    const nn = String(i + 1).padStart(2, "0");
    const buf = png(`${id}-${nn}`);
    writeFileSync(join(dir, "evidence", `${nn}.png`), buf);
    writeFileSync(join(dir, "evidence", `${nn}.yaml`), YAML.stringify({ id: `EV-${nn}`, type: "EVD", plan: `PLAN.${id}`, step: e.step, scope, kind: e.kind, caption: `passo ${e.step}`,
      file: `customers/ACME/runs/${RUN}/cases/${id}/evidence/${nn}.png`, sha256: createHash("sha256").update(buf).digest("hex"), profile: e.profile ?? "strict", publishable: true, ts: "2026-09-29T10:00:00Z" }));
  });
  if (result) { mkdirSync(join(ws, "customers/ACME/runs", RUN, "results"), { recursive: true }); writeFileSync(join(ws, "customers/ACME/runs", RUN, "results", `PLAN.${id}.yaml`), YAML.stringify({ plan_id: `PLAN.${id}`, status: result })); }
  if (KEYS[id]) { const cd = join(ws, "customers/ACME/tests/cases", scope); mkdirSync(cd, { recursive: true }); writeFileSync(join(cd, `${id}.yaml`), YAML.stringify({ id, title: `Caso ${id}`, alm: { test_key: KEYS[id] } })); }
}
function setup(base = http.url) {
  const ws = mkWs();
  seedSession(ws, { scope: "P2P" });
  mkdirSync(join(ws, "customers/ACME/config"), { recursive: true });
  xrayYaml(ws, base);
  addCase(ws, NEG, { evidence: [{ step: 4, kind: "assertion" }] });
  addCase(ws, POS, { evidence: [{ step: 3, kind: "failure" }, { step: 2, kind: "assertion", profile: "standard" }] });
  addCase(ws, ENV, { evidence: [] });
  addCase(ws, NOKEY, { evidence: [] });
  addCase(ws, CAT, { steps: 2, result: "green" });
  writeFileSync(join(ws, "outcomes.yaml"), YAML.stringify({ [NEG]: "EXPECTED-ERROR-AS-SUCCESS", [POS]: { outcome: "ERROR-BLOCKING", step: 3, reason: "ordine SENT con messaggio in errore" }, [ENV]: "ERROR-ENVIRONMENT" }));
  return ws;
}
// processo asincrono: il mock HTTP gira nello stesso processo dei test (spawnSync lo bloccherebbe)
const cli = (name, args, ws, env = {}) => new Promise((resolve) => {
  const ch = spawn(process.execPath, [join(PLUGIN, "scripts/xray", `${name}.mjs`), ...args, "--workspace", ws, "--json"], { env: cleanEnv({ ...CREDS, ...env }) });
  let stdout = ""; let stderr = "";
  ch.stdout.on("data", (d) => { stdout += d; });
  ch.stderr.on("data", (d) => { stderr += d; });
  const t = setTimeout(() => ch.kill(), 60000);
  ch.on("close", (status) => {
    clearTimeout(t);
    let json = null;
    try { json = JSON.parse(stdout.trim().split("\n").pop()); } catch { json = null; }
    resolve({ status, stdout, stderr, json });
  });
});

test("build-payload: una Test Execution per scope; errore atteso ⇒ PASSED; ERROR-ENVIRONMENT ⇒ ABORTED (mai FAILED, nessun Defect); fallimento sul passo 3 con l'evidenza strict sul passo 3; nessuna Test issue creata", async () => {
  const ws = setup();
  const doc = await buildPayload(ws, { customer: "ACME", run: RUN, outcomes: parseOutcomes({ file: join(ws, "outcomes.yaml") }) });
  assert.deepEqual(Object.keys(doc.executions).sort(), ["CAT", "P2P"], "una Test Execution per run e per scope");
  const p = doc.executions.P2P;
  assert.deepEqual(p.execution, { summary: `${RUN} — scope P2P`, scope: "P2P", run: RUN, project: "PROJ", testPlanKey: "PROJ-50", description: p.execution.description });
  assert.deepEqual(p.results.info.labels, ["scope:P2P"]);
  const byKey = Object.fromEntries(p.results.tests.map((t) => [t.testKey, t]));
  assert.equal(byKey["PROJ-31"].status, "PASSED");
  assert.match(byKey["PROJ-31"].comment, /EXPECTED-ERROR-AS-SUCCESS/);
  assert.deepEqual(byKey["PROJ-31"].steps.map((s) => s.evidence?.length ?? 0), [0, 0, 0, 1], "evidenza sul passo 4");
  assert.deepEqual(byKey["PROJ-12"].steps.map((s) => s.status), ["PASSED", "PASSED", "FAILED", "TODO"]);
  assert.deepEqual(byKey["PROJ-12"].steps.map((s) => s.evidence?.length ?? 0), [0, 0, 1, 0], "failure sul passo 3; l'evidenza standard resta fuori da Xray");
  assert.equal(byKey["PROJ-12"].steps[2].evidence[0].file, `customers/ACME/runs/${RUN}/cases/${POS}/evidence/01.png`);
  assert.equal(byKey["PROJ-13"].status, "ABORTED");
  assert.ok(byKey["PROJ-13"].steps.every((s) => s.status !== "FAILED"));
  assert.deepEqual(p.defects_suggested.map((d) => d.case), [POS], "Defect proposto solo per ERROR-BLOCKING");
  assert.deepEqual(doc.skipped.map((s) => s.case), [NOKEY]);
  assert.match(doc.skipped[0].reason, /ADR-21/);
  assert.equal(doc.executions.CAT.results.tests[0].status, "PASSED", "results green ⇒ SUCCESS");
  assert.equal(doc.executions.CAT.execution.testPlanKey, "PROJ-60");
  assert.ok(existsSync(join(ws, "customers/ACME/runs", RUN, "xray-payload.json")));
  // stato di ERROR-ENVIRONMENT dalla configurazione: TODO
  xrayYaml(ws, http.url, "statuses: { error_environment: TODO }\n");
  const d2 = await buildPayload(ws, { customer: "ACME", run: RUN, outcomes: parseOutcomes({ file: join(ws, "outcomes.yaml") }) });
  assert.equal(d2.executions.P2P.results.tests.find((t) => t.testKey === "PROJ-13").status, "TODO");
  // deroga ADR-21: il caso senza chiave diventa testInfo
  xrayYaml(ws, http.url, "allow_test_issue_creation: true\n");
  const d3 = await buildPayload(ws, { customer: "ACME", run: RUN, outcomes: parseOutcomes({ file: join(ws, "outcomes.yaml") }) });
  assert.equal(d3.skipped.length, 0);
  assert.equal(d3.executions.P2P.results.tests.find((t) => t.testInfo)?.testInfo.labels[0], "scope:P2P");
  // esiti posizionali caso=ESITO@passo; esito fuori tassonomia ⇒ errore
  assert.deepEqual(parseOutcomes({ pairs: { [POS]: "ERROR-BLOCKING@2" } })[POS], { outcome: "ERROR-BLOCKING", step: 2 });
  assert.throws(() => parseOutcomes({ pairs: { [POS]: "FAILED" } }), /tassonomia/);
  const cl = await cli("build-payload", ["--run", RUN, `${NEG}=EXPECTED-ERROR-AS-SUCCESS`], ws);
  assert.equal(cl.status, 0, cl.stdout + cl.stderr);
  assert.equal(cl.json.executions.length, 2);
});

test("publish → verify: esecuzione per scope con etichette, import nativo con evidenze sul passo giusto, idempotente; verify coerente, poi differenza ⇒ exit 3", async () => {
  const ws = setup();
  const start = http.state.requests.length;
  const dry = await cli("publish", ["--run", RUN, "--outcomes", "outcomes.yaml", "--dry-run"], ws);
  assert.equal(dry.status, 0, dry.stdout + dry.stderr);
  assert.equal(dry.json.dry_run, true);
  assert.equal(http.state.requests.length, start, "dry-run: nessuna chiamata");
  const r = await cli("publish", ["--run", RUN, "--outcomes", "outcomes.yaml"], ws);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  for (const v of Object.values(CREDS)) assert.ok(!r.stdout.includes(v) && !r.stderr.includes(v), "nessun segreto nell'output");
  const ex = Object.fromEntries(r.json.executions.map((x) => [x.scope, x]));
  assert.equal(ex.P2P.status, "pubblicato");
  assert.equal(ex.P2P.tests, 3);
  assert.equal(ex.P2P.evidence, 2);
  const creates = http.state.requests.slice(start).filter((q) => q.path === "/rest/api/2/issue");
  assert.deepEqual(creates.map((c) => c.json.fields.labels).sort((a, b) => a[0].localeCompare(b[0])), [["scope:CAT", `run:${RUN}`], ["scope:P2P", `run:${RUN}`]]);
  assert.ok(creates.every((c) => c.json.fields.issuetype.name === "Test Execution"));
  const imp = http.state.imports.find((i) => i.key === ex.P2P.execution_key);
  assert.equal(imp.body.info.testPlanKey, "PROJ-50");
  const t12 = imp.body.tests.find((t) => t.testKey === "PROJ-12");
  // deployment server (Xray Server/DC, giro 1 I3): stati PASS/FAIL e campo "evidences"
  assert.equal(t12.status, "FAIL");
  assert.equal(t12.steps[2].evidences[0].filename, "EV-01.png");
  assert.equal(Buffer.from(t12.steps[2].evidences[0].data, "base64").toString("latin1").endsWith(`${POS}-01`), true, "il file giusto sul passo giusto");
  assert.equal(imp.body.tests.find((t) => t.testKey === "PROJ-13").status, "ABORTED");
  const pub = JSON.parse(readFileSync(join(ws, "customers/ACME/runs", RUN, "xray-published.json"), "utf8"));
  assert.equal(pub.scopes.P2P.execution_key, ex.P2P.execution_key);
  const created = JSON.parse(readFileSync(join(ws, "customers/ACME/.sessions/sess-1/session.json"), "utf8")).alm.created.map((c) => c.key).sort();
  assert.deepEqual(created, [ex.CAT.execution_key, ex.P2P.execution_key].sort(), "esecuzioni in session.alm.created");
  // idempotente: nessuna seconda Test Execution per lo stesso run e scope
  const again = await cli("publish", ["--run", RUN, "--scope", "P2P"], ws);
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.equal(again.json.executions[0].execution_key, ex.P2P.execution_key);
  assert.equal(http.state.requests.filter((q) => q.path === "/rest/api/2/issue").length - creates.length - (http.state.requests.slice(0, start).filter((q) => q.path === "/rest/api/2/issue").length), 0);
  const v = await cli("verify", ["--run", RUN], ws);
  assert.equal(v.status, 0, v.stdout + v.stderr);
  assert.equal(v.json.ok, true);
  // il QA lead cambia a mano un'evidenza: verify lo vede
  http.state.imports.push({ key: ex.P2P.execution_key, body: { tests: [{ ...t12, steps: t12.steps.map((s) => ({ status: s.status })) }] } });
  const v2 = await cli("verify", ["--run", RUN, "--scope", "P2P"], ws);
  assert.equal(v2.status, 3);
  assert.match(JSON.stringify(v2.json.executions[0].mismatches), /evidenze del passo 3/);
});

test("rete giù: publish in coda (exit 0, payload nel dossier, indice in queue/); retry-queued con la rete tornata ⇒ inviato e verificabile", async () => {
  const down = await closedUrl();
  const ws = setup(down);
  const r = await cli("publish", ["--run", RUN, "--outcomes", "outcomes.yaml", "--scope", "P2P"], ws);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.json.executions[0].status, "in coda");
  assert.ok(existsSync(join(ws, "customers/ACME/runs", RUN, "xray-payload.json")));
  assert.equal(readdirSync(join(ws, "customers/ACME/queue")).length, 1);
  const st = await cli("retry-queued", ["--status"], ws);
  assert.equal(st.json.pending, 1);
  assert.equal((await cli("retry-queued", [], ws)).json.still_queued.length, 1, "ancora giù");
  xrayYaml(ws, http.url);
  const ok = await cli("retry-queued", [], ws);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.equal(ok.json.sent.length, 1);
  assert.equal((await cli("retry-queued", ["--status"], ws)).json.pending, 0);
  const v = await cli("verify", ["--run", RUN, "--scope", "P2P"], ws);
  assert.equal(v.status, 0, v.stdout + v.stderr);
});

test("authenticate: ok senza token nell'output; credenziali errate o host non dichiarato ⇒ exit 3 senza segreti", async () => {
  const ws = setup();
  const ok = await cli("authenticate", [], ws);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.deepEqual(ok.json.hosts, ["127.0.0.1"]);
  for (const v of Object.values(CREDS)) assert.ok(!ok.stdout.includes(v));
  const bad = await cli("authenticate", [], ws, { XRAY_TOKEN: "pat-wrong-0000" });
  assert.equal(bad.status, 3);
  assert.ok(!bad.stdout.includes("pat-wrong-0000"));
  const cloud = mkWs();
  seedSession(cloud, { scope: "P2P" });
  mkdirSync(join(cloud, "customers/ACME/config"), { recursive: true });
  writeFileSync(join(cloud, "customers/ACME/config/xray.yaml"), `deployment: cloud\nbase_url: ${http.url}\nxray_url: ${http.url}\nproject: PROJ\nnetwork: { retries: 1, backoff_ms: 0 }\n`);
  pinXray(cloud);
  assert.equal((await cli("authenticate", [], cloud)).status, 0);
  const wrong = await cli("authenticate", [], cloud, { XRAY_CLIENT_SECRET: "csecret-wrong-1111" });
  assert.equal(wrong.status, 3);
  assert.ok(!wrong.stdout.includes("csecret-wrong-1111") && !wrong.stdout.includes(CREDS.XRAY_CLIENT_ID));
  const evil = await cli("authenticate", [], ws, { JIRA_BASE_URL: "https://jira.evil-example.com" });
  assert.equal(evil.status, 3);
  assert.match(evil.json.error, /non dichiarato/);
  for (const name of ["authenticate", "build-payload", "publish", "verify", "retry-queued", "defect"]) assert.equal((await cli(name, ["--help"], ws)).status, 0, name);
  const noCfg = mkWs();
  assert.equal((await cli("authenticate", ["--customer", "ACME"], noCfg)).status, 1, "xray.yaml assente");
});

test("defect: regressione con precedente fixed nel titolo, passi minimi, evidenze strict, etichetta scope, tipo e assegnatario da config; mai Incident, mai per ambiente o difetto del test; confine di dominio", async () => {
  const ws = setup();
  writeFileSync(join(ws, "finding.yaml"), YAML.stringify({ id: "F-003", case: POS, run: RUN, step: 3, classification: "regression", summary: "Ordine SENT con messaggio in errore",
    expected: "ordine non SENT", observed: "ordine SENT, mario.rossi@acme.it notificato", doc: { doc: "Manuale P2P.pdf", section: "4.2" }, precedent: { key: "PROJ-7", status: "fixed", fixed_in: "R25.2" }, evidence: ["EV-01", "EV-02"] }));
  const b = await cli("defect", ["--finding", "finding.yaml"], ws);
  assert.equal(b.status, 0, b.stdout + b.stderr);
  const f = JSON.parse(readFileSync(join(ws, "customers/ACME/runs", RUN, "defects/F-003.json"), "utf8"));
  assert.equal(f.defect.summary, "[P2P] Ordine SENT con messaggio in errore — regression of PROJ-7 (fixed in R25.2)");
  assert.equal(f.defect.issue_type, "Defect");
  assert.equal(f.defect.assignee, "mrossi");
  assert.deepEqual(f.defect.attachments.map((a) => a.filename), ["EV-01.png"], "solo l'evidenza strict");
  assert.match(f.warnings.join(" "), /EV-02 esclusa/);
  assert.match(f.defect.description, /1\. NAVIGATE passo 1\n2\. FILL passo 2\n3\. SAVE passo 3/);
  assert.ok(!/4\. SUBMIT/.test(f.defect.description), "passi minimi fino al fallimento");
  assert.match(f.defect.description, /Manuale P2P\.pdf §4\.2/);
  assert.ok(!f.defect.description.includes("mario.rossi@acme.it"), "profilo strict");
  const start = http.state.requests.length;
  const p = await cli("defect", ["--finding", "finding.yaml", "--publish"], ws);
  assert.equal(p.status, 0, p.stdout + p.stderr);
  assert.match(p.json.published.key, /^PROJ-\d+$/);
  const reqs = http.state.requests.slice(start);
  const c = reqs.find((q) => q.path === "/rest/api/2/issue");
  assert.deepEqual([c.json.fields.issuetype.name, c.json.fields.labels, c.json.fields.assignee], ["Defect", ["scope:P2P", "nrt"], { name: "mrossi" }]);
  assert.ok(reqs.some((q) => q.path === "/rest/api/2/issueLink" && q.json.outwardIssue.key === "PROJ-7"), "precedente collegato");
  assert.ok(reqs.some((q) => q.path.endsWith("/attachments")));
  // mai un Defect per ambiente, difetto del test, cambiamento atteso, errore atteso
  for (const extra of [["classification=environment"], ["classification=test-defect"], ["classification=expected-change"], ["outcome=ERROR-ENVIRONMENT"], ["outcome=EXPECTED-ERROR-AS-SUCCESS"]]) {
    const r = await cli("defect", [`case=${POS}`, `run=${RUN}`, "step=3", "summary=Totale errato", ...extra], ws);
    assert.equal(r.status, 3, `${extra} → ${r.stdout}`);
  }
  // confine di dominio
  const dom = await cli("defect", [`case=${POS}`, `run=${RUN}`, "step=3", "summary=vedi C.ACME.P2P.PAT.0003"], ws);
  assert.equal(dom.status, 3);
  assert.match(dom.json.error, /confine di dominio/);
  // Incident dalla configurazione: rifiutato dallo schema
  xrayYaml(ws, http.url, "");
  writeFileSync(join(ws, "customers/ACME/config/xray.yaml"), readFileSync(join(ws, "customers/ACME/config/xray.yaml"), "utf8").replace("issue_type: Defect", "issue_type: Incident"));
  pinXray(ws);
  assert.equal((await cli("defect", [`case=${POS}`, `run=${RUN}`, "summary=x"], ws)).status, 1);
});
