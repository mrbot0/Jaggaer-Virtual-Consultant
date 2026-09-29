// WP10a giro di correzione 1: file d'ingresso confinati al workspace (minore 2), build-report da file (I3), kb epistemic
// per soggetto (I4), find --cluster e ingest --kind (minore 1), doctor plugin-root (minore 3), avviso sui template
// ignorati (minore 5), /vc senza argomenti con le azioni suggerite (minore 7).
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { envWs, ROOT } from "../helpers/env-fixture.mjs";
import { cleanEnv } from "../helpers/hook-env.mjs";
import { confinedPath } from "../../scripts/lib/text-file.mjs";

const run = (ws, rel, args, env = {}) => {
  const r = spawnSync(process.execPath, [join(ROOT, rel), ...args], { encoding: "utf8", cwd: ws, env: cleanEnv({ JVC_WORKSPACE: ws, JVC_SESSION_ID: "sess-1", ...env }), timeout: 60000 });
  let json = null;
  try { json = JSON.parse(r.stdout.trim().split("\n").filter(Boolean).at(-1)); } catch { json = null; }
  return { ...r, json };
};

// ---------------- minore 2: file d'ingresso confinati al workspace ----------------
test("minore 2: confinedPath — dentro il workspace sì; assoluto fuori, .. che esce, vuoto ⇒ errore", () => {
  const ws = envWs({ env: "sandbox", scope: "P2P" });
  assert.ok(confinedPath(ws, "customers/ACME/x.txt").abs);
  assert.ok(confinedPath(ws, join(ws, "customers", "ACME", "x.txt")).abs);
  for (const bad of [join(tmpdir(), "altrove.txt"), "../fuori.txt", "customers/../../fuori.txt", "", "C:/Windows/win.ini"]) assert.ok(confinedPath(ws, bad).error, `accettato: ${bad}`);
});

test("minore 2: ogni file d'ingresso fuori dal workspace è rifiutato (text-file, payload-file, sql-file)", () => {
  const ws = envWs({ env: "sandbox", scope: "P2P" });
  const out = mkdtempSync(join(tmpdir(), "jvc-fuori-"));
  writeFileSync(join(out, "t.txt"), "Su ACME sandbox apri l'ultima RdA");
  writeFileSync(join(out, "p.yaml"), "n: 1\nstatus: ok\n");
  writeFileSync(join(out, "q.sql"), "select 1 from t");
  const abs = (f) => join(out, f);
  const rel = (f) => join("..", out.split(/[\\/]/).pop(), f);
  for (const f of [abs("t.txt"), rel("t.txt")]) {
    assert.equal(run(ws, "scripts/decide/intent.mjs", ["--text-file", f, "--json"]).status, 1, `intent ${f}`);
    assert.equal(run(ws, "scripts/kb/kb.mjs", ["resolve", "--text-file", f, "--db", "customers/ACME/knowledge.db", "--json"]).status, 1, `kb resolve ${f}`);
  }
  assert.equal(run(ws, "scripts/admin/workflow.mjs", ["event", "--kind", "step_end", "--payload-file", abs("p.yaml"), "--json"]).status, 1);
  assert.equal(run(ws, "scripts/analytics/query-guard.mjs", ["limit", "--sql-file", abs("q.sql"), "--json"]).status, 1);
  assert.equal(run(ws, "scripts/kb/review.mjs", ["reject", "C.ACME.P2P.FLW.0001", "--payload-file", abs("p.yaml"), "--root", ws, "--customer", "ACME"]).status, 1);
  assert.equal(run(ws, "scripts/kb/compensation.mjs", ["add", "--step", "1", "--payload-file", abs("p.yaml"), "--json"]).status, 1);
  assert.equal(run(ws, "scripts/run/fixtures.mjs", ["register", "--run", "RUN.ACME.20260923.1000.P2P", "--payload-file", abs("p.yaml"), "--customer", "ACME", "--json"]).status, 1);
  // dentro il workspace: stessi comandi accettati
  const d = join(ws, "customers/ACME/.sessions/sess-1");
  writeFileSync(join(d, "q.sql"), "select 1 from t");
  const ok = run(ws, "scripts/analytics/query-guard.mjs", ["limit", "--sql-file", "customers/ACME/.sessions/sess-1/q.sql", "--json"]);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
});

// ---------------- I3: build-report con i dati da file ----------------
test("I3 build-report: --payload-file (expected/observed/errors/intent/assumption/next) e --intent-file/--assumption-file/--next-file; riga semplice", async () => {
  const { writePlan, patchSession } = await import("../helpers/env-fixture.mjs");
  const { demoPlan } = await import("../helpers/k6-fixture.mjs");
  const { simpleArgv } = await import("../../hooks/lib/exact-argv.mjs");
  const YAML = (await import("yaml")).default;
  const { readFileSync } = await import("node:fs");
  const ws = envWs({ env: "sandbox", scope: "P2P" });
  const plan = writePlan(ws, demoPlan(), "RUN.ACME.20260922.1100.ADM");
  patchSession(ws, (s) => { s.session_code = "SES.ACME.20260923.001"; s.mode = "ops"; });
  const d = "customers/ACME/.sessions/sess-1";
  const intent = "Su ACME sandbox crea una RdA di prova per 5 sedie, CdC IT-0442: perché no?";
  writeFileSync(join(ws, d, "rpt.yaml"), YAML.stringify({ intent, assumption: "referente = utente corrente, è ok", next: ["verificare l'approvazione", "chiudere la bozza"],
    expected: { error: { code: "REQ-VAL-014" } }, errors: [{ code: "REQ-VAL-014", category: "validation", message: "Il centro di costo non è attivo" }] }));
  const line = ["--kind", "test", "--plan", plan, "--title", "NEG CdC", "--payload-file", `${d}/rpt.yaml`, "--json"];
  assert.ok(simpleArgv(`node "C:/p/scripts/report/build-report.mjs" --kind test --title NEG --payload-file ${d}/rpt.yaml --json`));
  const r = run(ws, "scripts/report/build-report.mjs", line);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.json.outcome, "EXPECTED-ERROR-AS-SUCCESS");
  const md = readFileSync(join(ws, r.json.files[0]), "utf8");
  assert.ok(md.startsWith(`${r.json.code} (test) — NEG CdC`));
  // report di azione: intento e prossimi passi da file di testo
  writeFileSync(join(ws, d, "intento.txt"), intent);
  writeFileSync(join(ws, d, "prossimi.txt"), "verificare l'approvazione, poi chiudere");
  const a = run(ws, "scripts/report/build-report.mjs", ["--kind", "action", "--plan", plan, "--title", "RdA", "--intent-file", `${d}/intento.txt`, "--next-file", `${d}/prossimi.txt`, "--json"]);
  assert.equal(a.status, 0, a.stdout + a.stderr);
  const amd = readFileSync(join(ws, a.json.files[0]), "utf8");
  assert.ok(amd.includes(`"${intent}"`), amd);
  assert.match(amd, /Prossimi {3}verificare l'approvazione, poi chiudere/);
  // la stessa voce in linea e da file ⇒ ambiguo; file fuori dal workspace ⇒ rifiutato; payload non oggetto ⇒ rifiutato
  assert.equal(run(ws, "scripts/report/build-report.mjs", ["--kind", "action", "--plan", plan, "--intent", "x", "--intent-file", `${d}/intento.txt`, "--json"]).status, 1);
  assert.equal(run(ws, "scripts/report/build-report.mjs", ["--kind", "test", "--plan", plan, "--expected", "{}", "--payload-file", `${d}/rpt.yaml`, "--json"]).status, 1);
  assert.equal(run(ws, "scripts/report/build-report.mjs", ["--kind", "action", "--plan", plan, "--intent-file", join(tmpdir(), "x.txt"), "--json"]).status, 1);
  writeFileSync(join(ws, d, "lista.yaml"), "- a\n- b\n");
  assert.equal(run(ws, "scripts/report/build-report.mjs", ["--kind", "action", "--plan", plan, "--payload-file", `${d}/lista.yaml`, "--json"]).status, 1);
  assert.match(run(ws, "scripts/report/build-report.mjs", ["--help"]).stdout, /--payload-file <file>/);
});

test("I3 /nrt report: la riga documentata porta i dati del report da file (--payload-file), senza testo in linea", async () => {
  const { commandFiles, commandLines } = await import("../helpers/commands.mjs");
  const lines = commandLines(commandFiles().nrt).filter((l) => l.includes("build-report.mjs"));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /--payload-file customers\/<C>\/\.sessions\/<sessione>\/report\.yaml/);
  assert.doesNotMatch(lines[0], /--(intent|next|assumption|expected|observed|errors|title) /);
});

// ---------------- I4: kb epistemic <soggetto> ----------------
test("I4 kb epistemic <soggetto>: K, forma, gap e prossimo passo per un soggetto (EPI dal DB, dalla digestione, ignoto); CLI via kb.mjs", async () => {
  const { openDb } = await import("../../scripts/kb/db.mjs");
  const { subjectProfile } = await import("../../scripts/kb/coverage-report.mjs");
  const ws = mkdtempSync(join(tmpdir(), "jvc-epi-"));
  const file = join(ws, "knowledge.db");
  const db = openDb(file);
  const item = (code, type) => db.prepare("insert into items(code, level, customer, scope, type, title, summary, facets, status, path, hash, updated_at) values (?, ?, ?, ?, ?, 't', 's', '{}', 'digerito', 'p', 'h', 'now')").run(code, code[0], code.split(".")[1], code.split(".")[2], type);
  item("C.ACME.ADM.CFG.0001", "CFG");
  db.prepare("insert into epistemic(subject_code, k_tech, k_use, k_obs, k_exec, shape, open_contradictions) values (?,?,?,?,?,?,?)").run("C.ACME.ADM.CFG.0001", 0.8, 0.6, 0.1, 0, "libresco", 0);
  item("C.ACME.ADM.CFG.0002", "CFG");
  db.prepare("insert into attribute_coverage(subject_code, attribute, units, genre, answered, recorded_at) values ('C.ACME.ADM.CFG.0002', 'location', '[]', 'tecnica', 1, 'now')").run();
  item("C.ACME.ADM.CFG.0003", "CFG");
  const a = subjectProfile(db, "C.ACME.ADM.CFG.0001");
  assert.deepEqual([a.shape, a.source, a.k_tech, a.k_obs], ["libresco", "epistemic", 0.8, 0.1]);
  assert.match(a.next, /osservazion/i);
  const b = subjectProfile(db, "C.ACME.ADM.CFG.0002");
  assert.equal(b.source, "digestione");
  assert.ok(b.gaps.includes("options") && !b.gaps.includes("location"));
  const c = subjectProfile(db, "C.ACME.ADM.CFG.0003");
  assert.equal(c.shape, "ignoto");
  assert.equal(c.gaps.length, 7);
  assert.throws(() => subjectProfile(db, "C.ACME.ADM.CFG.0099"), /non trovato/);
  db.close();
  const cli = (args) => spawnSync(process.execPath, [join(ROOT, "scripts/kb/kb.mjs"), "epistemic", ...args, "--db", file, "--json"], { encoding: "utf8", env: cleanEnv() });
  const r = cli(["C.ACME.ADM.CFG.0001"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(JSON.parse(r.stdout).subject.shape, "libresco");
  assert.equal(cli(["C.ACME.ADM.CFG.0099"]).status, 1);
  assert.equal(cli(["--scope", "ADM"]).status, 0, "la forma per scope resta");
  assert.equal(cli([]).status, 1, "né soggetto né scope");
});

// ---------------- minore 1: opzioni di §56.3 che mancavano ----------------
test("minore 1 kb find --cluster <CL>: solo i membri del cluster; ingest --kind forza il tipo di documento (validato)", async () => {
  const { openDb } = await import("../../scripts/kb/db.mjs");
  const { find } = await import("../../scripts/kb/find.mjs");
  const ws = mkdtempSync(join(tmpdir(), "jvc-find-"));
  const file = join(ws, "knowledge.db");
  const db = openDb(file);
  const item = (code, w) => db.prepare("insert into items(code, level, customer, scope, type, title, summary, facets, status, path, hash, updated_at, weight) values (?, 'C', 'ACME', 'CAT', 'FLW', 't', 's', '{}', 'validato', 'p', 'h', 'now', ?)").run(code, w);
  item("C.ACME.CAT.FLW.0001", 0.9); item("C.ACME.CAT.FLW.0002", 0.5); item("C.ACME.CAT.FLW.0003", 0.7);
  db.prepare("insert into cluster_members(cluster_code, item_code, admitted_at) values ('CL-FLW-001', 'C.ACME.CAT.FLW.0002', 'now'), ('CL-FLW-001', 'C.ACME.CAT.FLW.0003', 'now')").run();
  assert.deepEqual(find(db, { scope: "CAT", cluster: "CL-FLW-001" }).map((r) => r.code), ["C.ACME.CAT.FLW.0003", "C.ACME.CAT.FLW.0002"]);
  assert.equal(find(db, { scope: "CAT" }).length, 3);
  db.close();
  const r = spawnSync(process.execPath, [join(ROOT, "scripts/kb/kb.mjs"), "find", "--scope", "CAT", "--cluster", "CL-FLW-001", "--db", file, "--json"], { encoding: "utf8", env: cleanEnv() });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(JSON.parse(r.stdout).items.length, 2);
  // ingest --kind
  const { ingestFolder } = await import("../../scripts/ingest/ingest.mjs");
  const src = mkdtempSync(join(tmpdir(), "jvc-kind-"));
  writeFileSync(join(src, "note.txt"), "Il fornitore deve essere qualificato prima di un ordine. La richiesta passa in approvazione sopra 10.000 euro.\n");
  const root = mkdtempSync(join(tmpdir(), "jvc-kind-ws-"));
  const x = ingestFolder(src, { root, scope: "P2P", kind: "guida-admin", today: "2026-09-28" });
  assert.equal(x.docs[0].kind, "guida-admin");
  assert.throws(() => ingestFolder(src, { root, scope: "P2P", kind: "boh" }), /tipo di documento non valido/);
  const cli = spawnSync(process.execPath, [join(ROOT, "scripts/ingest/ingest.mjs"), "--input", src, "--root", root, "--scope", "P2P", "--kind", "boh", "--json"], { encoding: "utf8", env: cleanEnv() });
  assert.equal(cli.status, 1);
});
