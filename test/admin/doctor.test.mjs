// F0.4 — doctor (§48.1, §55.2, §54.7): ogni controllo { id, status: green|yellow|red, detail, fix } con un caso rosso e
// uno verde (dove la spec lo prevede giallo — browser, prod_allowed_red — il caso giallo). Testo + --json; exit 0 senza
// rossi, 3 con un rosso.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, appendFileSync, mkdirSync, rmSync, cpSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { runChecks } from "../../scripts/admin/doctor.mjs";
import { demoWorkspace, DEMO_ENV } from "../helpers/demo-workspace.mjs";
import { copyPlugin } from "../helpers/plugin-copy.mjs";
import { cleanEnv, seedSession, ROOT } from "../helpers/hook-env.mjs";

const run = (ws, opts = {}) => runChecks({ ws, plugin: ROOT, env: { ...DEMO_ENV, ...(opts.env ?? {}) }, ...opts });
const byId = (checks, id) => checks.find((c) => c.id === id) ?? assert.fail(`controllo ${id} assente: ${checks.map((c) => c.id).join(", ")}`);
const status = async (ws, id, opts) => byId(await run(ws, opts), id).status;

test("forma dei controlli: id, status green|yellow|red, detail, fix; nessun valore di credenziale nell'output", async () => {
  const ws = demoWorkspace();
  const checks = await run(ws);
  for (const c of checks) {
    assert.ok(typeof c.id === "string" && ["green", "yellow", "red"].includes(c.status) && typeof c.detail === "string" && "fix" in c, JSON.stringify(c));
  }
  const ids = checks.map((c) => c.id);
  for (const id of ["node", "deps", "version", "integrity", "db:ACME", "environments:ACME", "credentials", "browser", "alm:ACME", "compensations", "prod_allowed_red", "hardening", "audit"]) assert.ok(ids.includes(id), id);
  const text = JSON.stringify(checks);
  for (const v of ["demo", "\"x\"", "\"s\"", "\"t\""]) assert.ok(!text.includes(`NRT_SBX_USER=${v}`) && !text.includes(`:${v}`), v);
  assert.ok(!checks.some((c) => c.status === "red"), JSON.stringify(checks.filter((c) => c.status === "red")));
});

test("node: ≥ 22 verde, 20 rosso", async () => {
  const ws = demoWorkspace();
  assert.equal(await status(ws, "node", { nodeVersion: "22.3.0" }), "green");
  assert.equal(await status(ws, "node", { nodeVersion: "20.11.1" }), "red");
});

test("deps: dipendenze installate e importabili verde; plugin senza node_modules rosso con fix 'npm ci nel plugin' (il lockfile è sotto integrità)", async () => {
  const ws = demoWorkspace();
  assert.equal(await status(ws, "deps"), "green");
  const p = copyPlugin("jvc-plugin-", { modules: false });   // giro 1: nessuna cancellazione nei test
  const c = byId(await runChecks({ ws, plugin: p, env: DEMO_ENV }), "deps");
  assert.equal(c.status, "red");
  assert.match(c.fix, /npm ci nel plugin/); assert.match(c.fix, /package-lock.json/);
});

test("version: knowledge_version del DB nell'intervallo di plugin.json verde; fuori intervallo o metadati assenti rosso", async () => {
  const ws = demoWorkspace();
  assert.equal(await status(ws, "version"), "green");
  const { openDb } = await import("../../scripts/kb/db.mjs");
  const db = openDb(join(ws, "customers/ACME/knowledge.db"));
  db.prepare("update meta set value='99' where key='knowledge_version'").run();
  db.close();
  const c = byId(await run(ws), "version");
  assert.equal(c.status, "red");
  assert.match(c.fix, /kb migrate|aggiorna/);
  const p = copyPlugin();
  const m = JSON.parse(readFileSync(join(p, ".claude-plugin/plugin.json"), "utf8"));
  delete m.metadata;
  writeFileSync(join(p, ".claude-plugin/plugin.json"), JSON.stringify(m));
  assert.equal(byId(await runChecks({ ws: demoWorkspace(), plugin: p, env: DEMO_ENV }), "version").status, "red");
});

test("integrity: manifesto allineato verde; file alterato rosso", async () => {
  const ws = demoWorkspace();
  assert.equal(await status(ws, "integrity"), "green");
  const p = copyPlugin();
  spawnSync(process.execPath, [join(p, "scripts/admin/integrity.mjs"), "build"], { env: cleanEnv() });
  appendFileSync(join(p, "hooks/lib/io.mjs"), "\n// x\n");
  const c = byId(await runChecks({ ws, plugin: p, env: DEMO_ENV }), "integrity");
  assert.equal(c.status, "red");
  assert.match(c.detail, /hooks\/lib\/io\.mjs/);
});

test("db: apribile in WAL con migrazioni applicate verde; file non SQLite rosso; migrazioni mancanti giallo", async () => {
  const ws = demoWorkspace();
  assert.equal(await status(ws, "db:ACME"), "green");
  const Database = (await import("better-sqlite3")).default;
  const d = new Database(join(ws, "customers/ACME/knowledge.db"));
  d.exec("DROP TABLE reports");
  d.close();
  assert.equal(await status(ws, "db:ACME"), "yellow");
  rmSync(join(ws, "customers/ACME/knowledge.db-wal"), { force: true });
  rmSync(join(ws, "customers/ACME/knowledge.db-shm"), { force: true });
  writeFileSync(join(ws, "customers/ACME/knowledge.db"), "non è un database");
  assert.equal(await status(ws, "db:ACME"), "red");
});

test("environments: valido verde; prod con write_data: true (regola di produzione) rosso", async () => {
  const ws = demoWorkspace();
  assert.equal(await status(ws, "environments:ACME"), "green");
  const f = join(ws, "customers/ACME/config/environments.yaml");
  writeFileSync(f, readFileSync(f, "utf8").replace("write_data: false", "write_data: true"));
  const c = byId(await run(ws), "environments:ACME");
  assert.equal(c.status, "red");
});

test("credentials: variabili per prefisso dell'ambiente attivo presenti verde (solo nomi); assenti rosso", async () => {
  const ws = demoWorkspace();
  const g = byId(await run(ws), "credentials");
  assert.equal(g.status, "green");
  assert.match(g.detail, /NRT_SBX_USER/);
  assert.ok(!g.detail.includes("demo"));
  const r = byId(await runChecks({ ws, plugin: ROOT, env: {} }), "credentials");
  assert.equal(r.status, "red");
  assert.match(r.detail, /NRT_SBX_/);
});

test("browser: server del browser non sondabili dal plugin ⇒ giallo 'verificare in sessione'; .mcp.json illeggibile rosso", async () => {
  const ws = demoWorkspace();
  const c = byId(await run(ws), "browser");
  assert.equal(c.status, "yellow");
  assert.match(c.detail + c.fix, /verificare in sessione/);
  const p = copyPlugin();
  writeFileSync(join(p, ".mcp.json"), "{ rotto");
  assert.equal(byId(await runChecks({ ws, plugin: p, env: DEMO_ENV }), "browser").status, "red");
});

test("alm: coda offline abilitata verde; senza coda e Jira irraggiungibile (--network) rosso; senza --network giallo", async () => {
  const ws = demoWorkspace();
  assert.equal(await status(ws, "alm:ACME"), "green");
  writeFileSync(join(ws, "customers/ACME/config/xray.yaml"), "deployment: cloud\nbase_url: https://acme.atlassian.net\noffline_queue: false\n");
  assert.equal(await status(ws, "alm:ACME"), "yellow");
  const down = async () => { throw new Error("ECONNREFUSED"); };
  assert.equal(await status(ws, "alm:ACME", { network: true, fetcher: down, resolver: async () => ["127.0.0.1"] }), "red");
  assert.equal(await status(ws, "alm:ACME", { network: true, fetcher: async () => ({ status: 401 }), resolver: async () => ["127.0.0.1"] }), "green");
});

test("compensations: nessuna pendenza di sessioni precedenti verde; compensazioni pendenti rosso con l'elenco", async () => {
  const ws = demoWorkspace();
  assert.equal(await status(ws, "compensations"), "green");
  seedSession(ws, { sid: "sess-old", scope: "P2P", pending: { compensations: ["CMP.ACME.0001"], approvals: [], questions: [], expected_outcomes: [] } });
  writeFileSync(join(ws, ".jvc/current-session"), "sess-1");
  const c = byId(await run(ws), "compensations");
  assert.equal(c.status, "red");
  assert.match(c.detail, /sess-old.*CMP\.ACME\.0001/);
});

test("prod_allowed_red: vuoto verde; non vuoto giallo con l'elenco (§52.2)", async () => {
  const ws = demoWorkspace();
  assert.equal(await status(ws, "prod_allowed_red"), "green");
  const f = join(ws, "customers/ACME/config/environments.yaml");
  writeFileSync(f, readFileSync(f, "utf8").replace("prod_allowed_red: []", "prod_allowed_red: [C.ACME.ADM.CFG.0019]"));
  const c = byId(await run(ws), "prod_allowed_red");
  assert.equal(c.status, "yellow");
  assert.match(c.detail, /C\.ACME\.ADM\.CFG\.0019/);
});

test("hardening §54.7: 12 voci, automatiche calcolate e manuali marcate; settings allargati rispetto al template rosso", async () => {
  const ws = demoWorkspace();
  const c = byId(await run(ws), "hardening");
  assert.equal(c.status, "green");
  assert.equal(c.items.length, 12);
  assert.ok(c.items.filter((i) => i.status === "manual").length >= 4);
  assert.ok(["green"].includes(c.items.find((i) => i.n === 4).status));
  const s = JSON.parse(readFileSync(join(ws, ".claude/settings.json"), "utf8"));
  s.permissions.allow.push("Bash(*)");
  s.permissions.deny = s.permissions.deny.filter((d) => d !== "WebFetch");
  writeFileSync(join(ws, ".claude/settings.json"), JSON.stringify(s));
  const r = byId(await run(ws), "hardening");
  assert.equal(r.status, "red");
  assert.match(r.items.find((i) => i.n === 4).detail, /Bash\(\*\)|WebFetch/);
});

test("audit: catena del mese corrente valida verde; riga manomessa rossa", async () => {
  const ws = demoWorkspace();
  assert.equal(await status(ws, "audit"), "green");
  const f = join(ws, "customers/ACME/audit", `${new Date().toISOString().slice(0, 7)}.jsonl`);
  writeFileSync(f, readFileSync(f, "utf8").replace('"action":"demo"', '"action":"altro"'));
  assert.equal(await status(ws, "audit"), "red");
});

test("--network: host dichiarati risolti verde, offline giallo (saltato), host configurato fuori allow-list rosso", async () => {
  const ws = demoWorkspace();
  const ok = await run(ws, { network: true, resolver: async () => ["10.0.0.1"], fetcher: async () => ({ status: 200 }) });
  assert.equal(byId(ok, "network").status, "green");
  assert.equal(byId(ok, "network-allowlist").status, "green");
  const offline = await run(ws, { network: true, resolver: async () => { const e = new Error("getaddrinfo ENOTFOUND"); e.code = "ENOTFOUND"; throw e; }, fetcher: async () => ({ status: 200 }) });
  assert.equal(byId(offline, "network").status, "yellow");
  writeFileSync(join(ws, "customers/ACME/config/xray.yaml"), "deployment: cloud\nbase_url: https://jira.evil-example.com\noffline_queue: true\n");
  const bad = await run(ws, { network: true, resolver: async () => ["10.0.0.1"], fetcher: async () => ({ status: 200 }) });
  assert.equal(byId(bad, "network-allowlist").status, "red");
  assert.match(byId(bad, "network-allowlist").detail, /jira\.evil-example\.com/);
  // senza --network i controlli di rete non girano
  assert.ok(!(await run(ws)).some((c) => c.id.startsWith("network")));
});

test("CLI: tabella di testo e --json; exit 0 senza rossi, 3 con un rosso, 0 con --help, 1 con argomenti non validi", () => {
  const ws = demoWorkspace();
  const cli = (args, env = DEMO_ENV) => spawnSync(process.execPath, [join(ROOT, "scripts/admin/doctor.mjs"), ...args], { env: cleanEnv({ ...env, JVC_WORKSPACE: ws }), encoding: "utf8", timeout: 60000 });
  const j = cli(["--json"]);
  assert.equal(j.status, 0, j.stdout + j.stderr);
  const out = JSON.parse(j.stdout);
  assert.equal(out.ok, true);
  assert.ok(Array.isArray(out.checks));
  const t = cli([]);
  assert.equal(t.status, 0);
  assert.match(t.stdout, /STATO\s+CONTROLLO/);
  assert.equal(cli([], {}).status, 3, "credenziali mancanti ⇒ rosso");
  assert.equal(cli(["--help"]).status, 0);
  assert.equal(cli(["frobnicate"]).status, 1);
});
