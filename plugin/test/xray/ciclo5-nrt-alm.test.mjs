// 18/11/2026 (ciclo di bug fixing 5, collaudo NRT e ALM): regressioni trovate percorrendo push-xray, defect e desk
// come li usano il comando nrt e il defect-reporter.
//   1. publish non si ferma al primo scope in errore: gli altri scope si pubblicano, l'errore resta tracciato (exit 3);
//   2. publish e verify rifiutano un --run che non è un codice RUN (niente letture/scritture fuori da runs/);
//   3. defect --publish è idempotente: lo stesso finding non apre (né mette in coda) un secondo Defect;
//   4. build-payload --scope aggiorna solo la voce dello scope: le altre (e le voci in coda che le citano) restano;
//   5. contact-sheet copia nel desk solo evidenze sotto customers/<C>/runs/ e segnala quelle mancanti.
// Contro il mock HTTP locale (node:http): mai Jira/Xray reali.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import YAML from "yaml";
import { mkWs, seedSession, cleanEnv, pinXray } from "../helpers/hook-env.mjs";
import { startAlmMock, closedUrl, almPlugin, CREDS } from "../helpers/alm-http-mock.mjs";
import { buildPayload } from "../../scripts/xray/build-payload.mjs";
import { buildDesk } from "../../scripts/evidence/contact-sheet.mjs";

const RUN = "RUN.ACME.20261118.1000.P2P";
const POS = "NRT.ACME.P2P.POS.0012"; const CAT = "NRT.ACME.CAT.POS.0001";
const KEYS = { [POS]: "PROJ-12", [CAT]: "PROJ-41" };
const png = (tag) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(tag)]);
let http;
let PLUGIN;
before(async () => { PLUGIN = almPlugin(); http = await startAlmMock({ tests: Object.values(KEYS).map((key) => ({ key, summary: key, labels: [] })) }); });
after(async () => { await http.close(); });

function xrayYaml(ws, base) {
  writeFileSync(join(ws, "customers/ACME/config/xray.yaml"), `deployment: server\nbase_url: ${base}\nproject: PROJ\ntest_plan_by_scope: { P2P: PROJ-50, CAT: PROJ-60 }\n` +
    "defects: { issue_type: Defect, assignee_by_scope: { P2P: mrossi } }\nnetwork: { retries: 1, backoff_ms: 0, timeout_ms: 3000 }\nattachments_cap: 5\n");
  pinXray(ws);
}
function addCase(ws, id, { evidence = [], result = "green" } = {}) {
  const scope = id.split(".")[2];
  const dir = join(ws, "customers/ACME/runs", RUN, "cases", id);
  mkdirSync(join(dir, "evidence"), { recursive: true });
  writeFileSync(join(dir, "plan.json"), JSON.stringify({ plan_id: `PLAN.${id}`, customer: "ACME", env: "sandbox", goal: "g",
    steps: [1, 2, 3].map((n) => ({ n, verb: ["NAVIGATE", "FILL", "SAVE"][n - 1], action_class: "ACT-OBS", note: `passo ${n}` })) }));
  evidence.forEach((e, i) => {
    const nn = String(i + 1).padStart(2, "0");
    const buf = png(`${id}-${nn}`);
    writeFileSync(join(dir, "evidence", `${nn}.png`), buf);
    writeFileSync(join(dir, "evidence", `${nn}.yaml`), YAML.stringify({ id: `EV-${nn}`, type: "EVD", plan: `PLAN.${id}`, step: e.step, scope, kind: e.kind, caption: `passo ${e.step}`,
      file: e.file ?? `customers/ACME/runs/${RUN}/cases/${id}/evidence/${nn}.png`, sha256: createHash("sha256").update(buf).digest("hex"), profile: "strict", publishable: true, ts: "2026-11-18T10:00:00Z" }));
  });
  if (result) { mkdirSync(join(ws, "customers/ACME/runs", RUN, "results"), { recursive: true }); writeFileSync(join(ws, "customers/ACME/runs", RUN, "results", `PLAN.${id}.yaml`), YAML.stringify({ plan_id: `PLAN.${id}`, status: result })); }
  const cd = join(ws, "customers/ACME/tests/cases", scope);
  mkdirSync(cd, { recursive: true });
  writeFileSync(join(cd, `${id}.yaml`), YAML.stringify({ id, title: `Caso ${id}`, alm: { test_key: KEYS[id] } }));
}
function setup(base = http.url) {
  const ws = mkWs();
  seedSession(ws, { scope: "P2P" });
  mkdirSync(join(ws, "customers/ACME/config"), { recursive: true });
  xrayYaml(ws, base);
  addCase(ws, POS, { evidence: [{ step: 3, kind: "failure" }], result: null });
  addCase(ws, CAT, { evidence: [{ step: 2, kind: "failure" }] });
  return ws;
}
const cli = (name, args, ws, env = {}) => new Promise((resolve) => {
  const ch = spawn(process.execPath, [join(PLUGIN, "scripts/xray", `${name}.mjs`), ...args, "--workspace", ws, "--json"], { env: cleanEnv({ JVC_WORKSPACE: ws, ...CREDS, ...env }) });
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
const defectsCreated = () => http.state.requests.filter((q) => q.method === "POST" && q.path === "/rest/api/2/issue" && q.json?.fields?.issuetype?.name === "Defect").length;

test("publish: uno scope in errore (evidenza sparita dal dossier) non ferma gli altri; l'errore è tracciato, exit 3", async () => {
  const ws = setup();
  await buildPayload(ws, { customer: "ACME", run: RUN, outcomes: { [POS]: { outcome: "ERROR-BLOCKING", step: 3 } } });
  // la retention ha tolto l'evidenza del caso CAT dopo la costruzione del payload: lo scope CAT (il primo) non si importa
  rmSync(join(ws, "customers/ACME/runs", RUN, "cases", CAT, "evidence", "01.png"));
  const r = await cli("publish", ["--run", RUN], ws);
  assert.equal(r.status, 3, r.stdout + r.stderr);
  const ex = Object.fromEntries(r.json.executions.map((x) => [x.scope, x]));
  assert.equal(ex.CAT.status, "errore");
  assert.match(ex.CAT.error, /evidenza inesistente/);
  assert.equal(ex.P2P.status, "pubblicato", "lo scope P2P si pubblica comunque");
  assert.ok(http.state.imports.some((i) => i.key === ex.P2P.execution_key));
  const pub = JSON.parse(readFileSync(join(ws, "customers/ACME/runs", RUN, "xray-published.json"), "utf8"));
  assert.ok(pub.scopes.P2P.imported_at);
  assert.match(pub.scopes.CAT.last_error, /evidenza inesistente/, "l'errore resta nel registro delle pubblicazioni");
  const audit = readdirSync(join(ws, "customers/ACME/audit")).map((f) => readFileSync(join(ws, "customers/ACME/audit", f), "utf8")).join("\n");
  assert.match(audit, /xray-publish/, "audit scritto anche con uno scope in errore");
  // ripresa: l'evidenza torna (ripristino), publish --scope CAT completa senza una seconda esecuzione
  writeFileSync(join(ws, "customers/ACME/runs", RUN, "cases", CAT, "evidence", "01.png"), png(`${CAT}-01`));
  const again = await cli("publish", ["--run", RUN, "--scope", "CAT"], ws);
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.equal(again.json.executions[0].status, "pubblicato");
});

test("publish e verify: --run che non è un codice RUN ⇒ exit 1, nessuna lettura fuori da runs/", async () => {
  const ws = setup();
  // payload e registro artefatti fuori da runs/ (customers/ACME/evil/): un --run con risalita non li deve raggiungere
  const evil = join(ws, "customers/ACME/evil");
  mkdirSync(evil, { recursive: true });
  writeFileSync(join(evil, "xray-payload.json"), JSON.stringify({ run: "x", executions: { P2P: { execution: { summary: "x" }, results: { tests: [{ testKey: "PROJ-12", status: "PASSED" }] } } } }));
  writeFileSync(join(evil, "xray-published.json"), JSON.stringify({ scopes: { P2P: { execution_key: "PROJ-999", imported_at: "x" } } }));
  for (const name of ["publish", "verify"]) {
    const r = await cli(name, ["--run", "../evil", ...(name === "publish" ? ["--dry-run"] : [])], ws);
    assert.equal(r.status, 1, `${name}: ${r.stdout}${r.stderr}`);
    assert.match(r.json.error, /nome di run non valido/, name);
  }
});

test("defect --publish idempotente: lo stesso finding non apre un secondo Defect; in coda non si accoda due volte", async () => {
  const ws = setup();
  writeFileSync(join(ws, "finding.yaml"), YAML.stringify({ id: "F-001", case: POS, run: RUN, step: 3, summary: "Ordine SENT con messaggio di errore", classification: "product-defect", outcome: "ERROR-BLOCKING", doc: "DOC.0001" }));
  const before0 = defectsCreated();
  const a = await cli("defect", ["--finding", "finding.yaml", "--publish"], ws);
  assert.equal(a.status, 0, a.stdout + a.stderr);
  assert.ok(a.json.published.key);
  const b = await cli("defect", ["--finding", "finding.yaml", "--publish"], ws);
  assert.equal(b.status, 0, b.stdout + b.stderr);
  assert.equal(b.json.published.key, a.json.published.key, "stessa chiave");
  assert.equal(b.json.published.existing, true);
  assert.equal(defectsCreated() - before0, 1, "un solo Defect nell'ALM");
  const saved = JSON.parse(readFileSync(join(ws, "customers/ACME/runs", RUN, "defects", "F-001.json"), "utf8"));
  assert.equal(saved.published.key, a.json.published.key, "il file del Defect conserva la chiave");
  // rete giù: la prima volta in coda, la seconda nessuna nuova voce
  const down = await closedUrl();
  const w2 = setup(down);
  writeFileSync(join(w2, "finding.yaml"), YAML.stringify({ id: "F-002", case: POS, run: RUN, step: 3, summary: "Ordine SENT con messaggio di errore", classification: "product-defect", outcome: "ERROR-BLOCKING", doc: "DOC.0001" }));
  const q1 = await cli("defect", ["--finding", "finding.yaml", "--publish"], w2);
  assert.equal(q1.status, 0, q1.stdout + q1.stderr);
  assert.equal(q1.json.published.queued, true);
  const q2 = await cli("defect", ["--finding", "finding.yaml", "--publish"], w2);
  assert.equal(q2.status, 0, q2.stdout + q2.stderr);
  assert.equal(q2.json.published.id, q1.json.published.id, "la stessa voce di coda");
  assert.equal(readdirSync(join(w2, "customers/ACME/queue")).length, 1, "una sola voce in coda");
});

test("build-payload --scope: aggiorna solo la voce dello scope, le altre restano (e la coda che le cita resta inviabile)", async () => {
  const ws = setup();
  await buildPayload(ws, { customer: "ACME", run: RUN, outcomes: { [POS]: { outcome: "ERROR-BLOCKING", step: 3 } } });
  const r = await cli("build-payload", ["--run", RUN, "--scope", "P2P"], ws);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const doc = JSON.parse(readFileSync(join(ws, "customers/ACME/runs", RUN, "xray-payload.json"), "utf8"));
  assert.deepEqual(Object.keys(doc.executions).sort(), ["CAT", "P2P"], "la voce CAT non si perde");
});

test("contact-sheet: un'evidenza che cita un file fuori da runs/ non entra nel desk; un'evidenza mancante è segnalata", () => {
  const ws = setup();
  writeFileSync(join(ws, "customers/ACME/config/segreto.png"), png("fuori"));
  addCase(ws, "NRT.ACME.P2P.POS.0020", { evidence: [{ step: 1, kind: "failure", file: "customers/ACME/config/segreto.png" }] });
  rmSync(join(ws, "customers/ACME/runs", RUN, "cases", CAT, "evidence", "01.png"));
  const r = buildDesk(ws, { customer: "ACME", release: "R1", runs: [RUN] });
  const copied = (dir) => (existsSync(dir) ? readdirSync(dir) : []);
  assert.deepEqual(copied(join(ws, "customers/ACME/evidence/desk/R1/P2P/NRT.ACME.P2P.POS.0020")), [], "il file fuori da runs/ non si copia");
  assert.ok(r.warnings.some((w) => /NRT\.ACME\.P2P\.POS\.0020/.test(w) && /fuori/.test(w)), JSON.stringify(r.warnings));
  assert.ok(r.warnings.some((w) => /NRT\.ACME\.CAT\.POS\.0001/.test(w) && /inesistente|mancante/.test(w)), JSON.stringify(r.warnings));
  assert.equal(copied(join(ws, "customers/ACME/evidence/desk/R1/P2P/NRT.ACME.P2P.POS.0012")).length, 1, "l'evidenza valida c'è");
});
