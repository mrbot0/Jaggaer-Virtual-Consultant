// WP09d — F. Admin (§54.4, §56.8, §48.2, §35): customer purge (l'unica cancellazione: due approvazioni con frase da due
// nomi, certificato, promoted_from sostituito da un token), retention (scadenza dichiarata con una approvazione, audit e
// conoscenza mai rimossi), guard-destructive che ammette solo le forme esatte, status (+ --metrics), lock, doctor
// (process.exitCode dopo fetch). Ogni cancellazione vera avviene SOLO in cartelle temporanee create dal test, tramite
// gli script del plugin.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, existsSync, utimesSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import YAML from "yaml";
import { openDb } from "../../scripts/kb/db.mjs";
import { runHook, decisionOf, ROOT } from "../helpers/hook-env.mjs";
import { flw, writeItem, FACETS } from "../helpers/wp09b-items.mjs";
import { ws09d, withSession, say, cli, script } from "../helpers/wp09d.mjs";

const PURGE = "scripts/admin/purge.mjs";
const RET = "scripts/admin/retention.mjs";
const sha = (f) => createHash("sha256").update(readFileSync(f)).digest("hex");
const guard = (ws, command) => runHook("guard-destructive", { session_id: "sess-1", cwd: ws, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } }, { JVC_WORKSPACE: ws, CLAUDE_PLUGIN_ROOT: ROOT });
const denied = (r) => decisionOf(r) === "deny";
const silent = (r) => r.status === 0 && r.stdout.trim() === "";

function purgeWs() {
  const ws = ws09d();
  withSession(ws);
  writeItem(ws, flw("C.ACME.CAT.FLW.0001"));
  mkdirSync(join(ws, "customers", "BETA", "kb"), { recursive: true });
  writeItem(ws, flw("C.BETA.CAT.FLW.0001"));
  writeItem(ws, flw("S.STD.CAT.FLW.0001", { promoted_from: "L.ACME.CAT.FLW.0009" }));
  writeItem(ws, flw("S.STD.CAT.FLW.0002", { promoted_from: "L.BETA.CAT.FLW.0003" }));
  openDb(join(ws, "customers", "ACME", "knowledge.db")).close();
  return ws;
}

test("purge: senza approvazioni ⇒ exit 3 e nulla rimosso; un'approvazione sola o un token forgiato ⇒ exit 3", () => {
  const ws = purgeWs();
  let r = cli(PURGE, ["ACME", "--execute", "--json"], { ws });
  assert.equal(r.status, 3, r.stdout); assert.match(r.json.error, /due approvazioni/);
  const a = say(ws, "APPROVO PURGE ACME DA Mario Rossi");
  r = cli(PURGE, ["ACME", "--execute", "--approval-1", a.last.hash.slice(0, 16), "--approval-2", "0123456789abcdef", "--json"], { ws });
  assert.equal(r.status, 3); assert.match(r.json.error, /approvazione 2/);
  r = cli(PURGE, ["ACME", "--execute", "--approval-1", a.last.hash.slice(0, 16), "--approval-2", a.last.hash.slice(0, 20), "--json"], { ws });
  assert.equal(r.status, 3, "lo stesso record due volte"); assert.match(r.json.error, /stesso record/);
  const b = say(ws, "APPROVO RETENTION ACME");
  r = cli(PURGE, ["ACME", "--execute", "--approval-1", a.last.hash, "--approval-2", b.last.hash, "--json"], { ws });
  assert.equal(r.status, 3, "un'approvazione di retention non vale per la purge");
  assert.ok(existsSync(join(ws, "customers", "ACME", "kb")), "nulla rimosso");
});

test("purge: due approvazioni con frase da due nomi ⇒ prova a secco, poi esecuzione con certificato; promoted_from sostituito; puntatore azzerato; approvazioni monouso", () => {
  const ws = purgeWs();
  const kbFile = join(ws, "customers/ACME/kb/scopes/CAT/flows/C.ACME.CAT.FLW.0001.yaml");
  const kbSha = sha(kbFile);
  const a1 = say(ws, "APPROVO PURGE ACME DA Mario Rossi").last.hash.slice(0, 16);
  const a2 = say(ws, "APPROVO PURGE ACME DA Anna Bianchi").last.hash.slice(0, 16);
  const dry = cli(PURGE, ["ACME", "--approval-1", a1, "--approval-2", a2, "--json"], { ws });
  assert.equal(dry.status, 0, dry.stdout + dry.stderr);
  assert.equal(dry.json.dry_run, true); assert.equal(dry.json.approvals.ok, true); assert.deepEqual(dry.json.product_items, ["S.STD.CAT.FLW.0001"]);
  assert.ok(existsSync(kbFile), "la prova a secco non tocca nulla");
  const r = cli(PURGE, ["ACME", "--execute", "--approval-1", a1, "--approval-2", a2, "--json"], { ws });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(existsSync(join(ws, "customers", "ACME")), false, "customers/ACME rimosso");
  assert.ok(existsSync(join(ws, "customers/BETA/kb/scopes/CAT/flows/C.BETA.CAT.FLW.0001.yaml")), "gli altri clienti restano");
  const cert = JSON.parse(readFileSync(r.json.certificate, "utf8"));
  assert.equal(cert.kind, "customer-purge"); assert.equal(cert.customer, "ACME"); assert.equal(cert.status, "completata");
  assert.ok(cert.executed_at && cert.started_at);
  assert.deepEqual(cert.approvals.map((x) => x.approver_declared).sort(), ["Anna Bianchi", "Mario Rossi"]);
  const entry = cert.removed.find((x) => x.path === "customers/ACME/kb/scopes/CAT/flows/C.ACME.CAT.FLW.0001.yaml");
  assert.equal(entry.sha256, kbSha, "hash del file rimosso nel certificato");
  assert.ok(cert.removed.some((x) => x.path.endsWith("knowledge.db")), "anche il DB del cliente");
  assert.ok(cert.removed.some((x) => x.path.endsWith("approvals.jsonl")));
  assert.equal(cert.removed_count, cert.removed.length); assert.match(cert.certificate_sha256, /^[0-9a-f]{64}$/);
  assert.ok(r.json.certificate.replace(/\\/g, "/").includes("/.jvc/purge-certificates/"));
  const s1 = YAML.parse(readFileSync(join(ws, "product/kb/scopes/CAT/flows/S.STD.CAT.FLW.0001.yaml"), "utf8"));
  assert.match(s1.promoted_from, /^PURGED-[0-9a-f]{12}$/);
  assert.equal(cert.product_rewritten[0].promoted_from, s1.promoted_from);
  assert.equal(YAML.parse(readFileSync(join(ws, "product/kb/scopes/CAT/flows/S.STD.CAT.FLW.0002.yaml"), "utf8")).promoted_from, "L.BETA.CAT.FLW.0003", "altri clienti intatti");
  assert.equal(JSON.parse(readFileSync(join(ws, ".jvc/sessions/sess-1.json"), "utf8")).customer, null, "puntatore di sessione azzerato");
  assert.deepEqual(cert.pointers_reset, ["sess-1"]);
  const again = cli(PURGE, ["BETA", "--execute", "--approval-1", a1, "--approval-2", a2, "--json"], { ws });
  assert.equal(again.status, 3, "le approvazioni non si riusano (né per un altro cliente)");
});

test("guard-destructive: purge e retention passano SOLO nella forma esatta del plugin", () => {
  const ws = purgeWs();
  const P = script(PURGE);
  const R = script(RET);
  const hex = "0123456789abcdef";
  assert.ok(silent(guard(ws, `node "${P}" ACME --approval-1 ${hex} --approval-2 fedcba9876543210`)), "purge esatta (prova a secco; con --execute le approvazioni sono confermate nel transcript: wp09d-fixround1)");
  assert.ok(denied(guard(ws, `node "${P}" ACME --execute --approval-1 ${hex} --approval-2 fedcba9876543210`)), "--execute con token che non sono approvazioni");
  assert.ok(denied(guard(ws, `node "${P}" ACME --execute`)), "purge senza approvazioni");
  assert.ok(denied(guard(ws, `node "${P}" ACME --execute --approval-1 ${hex} --approval-2 x; rm -rf customers/ACME`)), "catena");
  assert.ok(denied(guard(ws, `node "${P}" ACME --execute --approval-1 ${hex} --approval-2 ${hex} --workspace C:\\`)), "opzione non ammessa");
  assert.ok(silent(guard(ws, `node "${R}" ACME --json`)), "retention: prova a secco");
  assert.ok(denied(guard(ws, `node "${R}" ACME --apply --approval ${hex} --json`)), "retention: --apply con un token che non è un'approvazione confermata");
  assert.ok(denied(guard(ws, `node "${R}" ACME --apply --json`)), "retention: --apply senza approvazione");
  assert.ok(denied(guard(ws, `node "${R}" ACME --apply --approval tok-a`)), "token di forma non ammessa");
  assert.ok(denied(guard(ws, `node "${R}" ACME ../BETA --apply --approval ${hex}`)), "un solo cliente");
  assert.ok(denied(guard(ws, `node ./retention.mjs ACME --apply --approval ${hex}`)), "retention.mjs fuori dal plugin");
  assert.ok(denied(guard(ws, `node "${R}" ACME --apply --approval ${hex} && del /s customers`)), "catena");
});

const DAY = 86400000;
function age(p, days) { const t = new Date(Date.now() - days * DAY); utimesSync(p, t, t); }
function put(ws, rel, days, text = "x\n") { const f = join(ws, rel); mkdirSync(join(f, ".."), { recursive: true }); writeFileSync(f, text); age(f, days); return f; }

function retentionWs() {
  const ws = ws09d();
  withSession(ws);
  const C = "customers/ACME";
  put(ws, `${C}/observations/L.ACME.CAT.OBS.0001.yaml`, 100);
  put(ws, `${C}/observations/L.ACME.CAT.OBS.0002.yaml`, 10);
  put(ws, `${C}/evidence/EVD-old.png`, 95);
  put(ws, `${C}/.sessions/old-sess/session.json`, 120);
  age(join(ws, `${C}/.sessions/sess-1/session.json`), 200);   // sessione corrente: mai
  put(ws, `${C}/runs/RUN-OLD/manifest.yaml`, 400);
  put(ws, `${C}/runs/RUN-NEW/manifest.yaml`, 20);
  put(ws, `${C}/runs/RUN-NEW/evidence/step-3.png`, 100);
  put(ws, `${C}/reports/RPT.ACME.20250101.0001.yaml`, 400);
  put(ws, `${C}/audit/2024-01.jsonl`, 800);
  put(ws, `${C}/kb/scopes/CAT/flows/C.ACME.CAT.FLW.0009.yaml`, 900, "id: C.ACME.CAT.FLW.0009\n");
  put(ws, `${C}/lessons/L.ACME.CAT.LSN.0001.md`, 900);
  const db = openDb(join(ws, C, "knowledge.db"));
  db.prepare("insert into observations(code, scope, payload) values ('L.ACME.CAT.OBS.0001','CAT','{}'),('L.ACME.CAT.OBS.0002','CAT','{}')").run();
  db.close();
  return ws;
}

test("retention: prova a secco elenca gli scaduti (90 giorni, 12 mesi); audit solo archiviabile; conoscenza e sessione corrente mai", () => {
  const ws = retentionWs();
  const r = cli(RET, ["ACME", "--json"], { ws });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(r.json.items.map((x) => [x.category, x.path]).sort(), [
    ["evidence", "customers/ACME/evidence/EVD-old.png"], ["evidence", "customers/ACME/runs/RUN-NEW/evidence/step-3.png"],
    ["observations", "customers/ACME/observations/L.ACME.CAT.OBS.0001.yaml"], ["reports", "customers/ACME/reports/RPT.ACME.20250101.0001.yaml"],
    ["runs", "customers/ACME/runs/RUN-OLD"], ["sessions", "customers/ACME/.sessions/old-sess"],
  ]);
  assert.deepEqual(r.json.archivable.map((x) => x.path), ["customers/ACME/audit/2024-01.jsonl"]);
  assert.ok(existsSync(join(ws, "customers/ACME/observations/L.ACME.CAT.OBS.0001.yaml")), "la prova a secco non rimuove");
});

test("retention --apply: senza approvazione exit 3; con `APPROVO RETENTION ACME` rimuove solo gli scaduti, certificato, indice aggiornato; approvazione monouso", () => {
  const ws = retentionWs();
  assert.equal(cli(RET, ["ACME", "--apply", "--json"], { ws }).status, 3);
  assert.equal(cli(RET, ["ACME", "--json"], { ws }).status, 0, "giro 1 (m1): la prova a secco registra gli scaduti come deprecati");
  const tok = say(ws, "APPROVO RETENTION ACME").last.hash.slice(0, 16);
  const r = cli(RET, ["ACME", "--apply", "--approval", tok, "--json"], { ws });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.json.removed, 6);
  const C = join(ws, "customers/ACME");
  for (const gone of ["observations/L.ACME.CAT.OBS.0001.yaml", "evidence/EVD-old.png", ".sessions/old-sess", "runs/RUN-OLD", "runs/RUN-NEW/evidence/step-3.png", "reports/RPT.ACME.20250101.0001.yaml"]) assert.equal(existsSync(join(C, gone)), false, gone);
  for (const kept of ["observations/L.ACME.CAT.OBS.0002.yaml", "runs/RUN-NEW/manifest.yaml", "audit/2024-01.jsonl", "kb/scopes/CAT/flows/C.ACME.CAT.FLW.0009.yaml", "lessons/L.ACME.CAT.LSN.0001.md", ".sessions/sess-1/session.json"]) assert.ok(existsSync(join(C, kept)), kept);
  const cert = JSON.parse(readFileSync(r.json.certificate, "utf8"));
  assert.equal(cert.kind, "retention"); assert.equal(cert.approval.hash.slice(0, 16), tok);
  assert.ok(cert.removed.find((x) => x.category === "runs").files.some((f) => f.path.endsWith("manifest.yaml") && /^[0-9a-f]{64}$/.test(f.sha256)));
  const db = openDb(join(C, "knowledge.db"));
  assert.deepEqual(db.prepare("select code from observations order by code").all().map((x) => x.code), ["L.ACME.CAT.OBS.0002"], "il DB perde l'OBS scaduta");
  db.close();
  assert.equal(cli(RET, ["ACME", "--apply", "--approval", tok, "--json"], { ws }).status, 3, "monouso");
});

test("status: sessione, budget, pendenze, ultime 5 DEC, ultime 3 sorprese, debito di quarantena, coda Xray; --metrics §35", () => {
  const ws = ws09d();
  const at = "2026-09-28T10:00:00Z";
  withSession(ws, { extra: { surprises: [{ at, plan: "PLAN.1", kind: "a" }, { at, plan: "PLAN.1", kind: "b" }, { at, plan: "PLAN.1", kind: "c" }, { at, plan: "PLAN.2", kind: "d" }] } });
  writeItem(ws, flw("C.ACME.CAT.FLW.0001"));
  writeItem(ws, flw("L.ACME.CAT.FLW.0002", { facets: { ...FACETS, F12: "quarantena" } }));
  const db = openDb(join(ws, "customers/ACME/knowledge.db"));
  db.close();
  return import("../../scripts/kb/reindex.mjs").then(({ reindex: ri }) => {
    ri(join(ws, "customers/ACME"), join(ws, "customers/ACME/knowledge.db"));
    const d = openDb(join(ws, "customers/ACME/knowledge.db"));
    d.prepare("update items set updated_at = '2026-01-01T00:00:00Z' where status = 'quarantena'").run();
    const dec = d.prepare("insert into decisions(code,table_code,outcome,strategy,at) values (?,?,?,?,?)");
    for (let i = 1; i <= 7; i++) dec.run(`L.ACME.CAT.DEC.000${i}`, "DT-002", "decidi", i % 2 ? "STR-REPLAY" : "STR-ASK-EARLY", `2026-09-2${i}T10:00:00Z`);
    d.prepare("insert into outcomes(decision_code,result) values ('L.ACME.CAT.DEC.0007','smentita'),('L.ACME.CAT.DEC.0006','confermata')").run();
    d.close();
    mkdirSync(join(ws, "customers/ACME/queue"), { recursive: true });
    writeFileSync(join(ws, "customers/ACME/queue/Q.1.json"), JSON.stringify({ status: "pending" }));
    writeFileSync(join(ws, "customers/ACME/queue/Q.2.json"), JSON.stringify({ status: "failed" }));
    const r = cli("scripts/admin/status.mjs", ["--metrics", "--json"], { ws });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const s = r.json.session;
    assert.equal(s.customer, "ACME"); assert.equal(s.budget.remaining, 200000);
    assert.deepEqual(s.last_decisions.map((x) => x.code), ["L.ACME.CAT.DEC.0007", "L.ACME.CAT.DEC.0006", "L.ACME.CAT.DEC.0005", "L.ACME.CAT.DEC.0004", "L.ACME.CAT.DEC.0003"]);
    assert.deepEqual(s.last_surprises.map((x) => x.kind), ["b", "c", "d"]);
    assert.equal(s.kb.quarantine_debt.count, 1); assert.deepEqual(s.kb.quarantine_debt.codes, ["L.ACME.CAT.FLW.0002"]);
    assert.deepEqual(s.xray_queue, { pending: 1, sent: 0, failed: 1 });
    const m = r.json.metrics;
    assert.equal(m.cognition.dec_total, 7); assert.equal(m.cognition.dec_verified_pct, 28.6); assert.equal(m.cognition.dec_disproved_pct, 50);
    assert.equal(m.cognition.surprises_per_task, 2); assert.equal(m.cognition.stopped_tasks_pct, 50, "PLAN.1 fermato alla 3ª sorpresa");
    assert.equal(m.cognition.str_replay_pct, 57.1);
    const text = cli("scripts/admin/status.mjs", [], { ws });
    assert.match(text.stdout, /Cliente ACME/); assert.match(text.stdout, /Coda Xray: in attesa 1/);
  });
});

test("lock: mostra i knowledge.lock; --clear-expired toglie solo i lock scaduti di processi non vivi", () => {
  const ws = ws09d();
  writeFileSync(join(ws, "product", "knowledge.lock"), JSON.stringify({ pid: 2147483000, expires: Date.now() - 1000 }));
  writeFileSync(join(ws, "customers", "ACME", "knowledge.lock"), JSON.stringify({ pid: process.pid, expires: Date.now() + 600000 }));
  const s = cli("scripts/admin/lock.mjs", ["--json"], { ws });
  assert.equal(s.status, 0);
  assert.deepEqual(s.json.locks.map((l) => [l.file, l.expired, l.pid_alive]).sort(), [["customers/ACME/knowledge.lock", false, true], ["product/knowledge.lock", true, false]]);
  const c = cli("scripts/admin/lock.mjs", ["--clear-expired", "--json"], { ws });
  assert.deepEqual(c.json.cleared.map((l) => l.file), ["product/knowledge.lock"]);
  assert.equal(existsSync(join(ws, "product", "knowledge.lock")), false);
  assert.ok(existsSync(join(ws, "customers", "ACME", "knowledge.lock")), "il lock attivo resta");
});

test("doctor: esce con process.exitCode (mai process.exit dopo i fetch di --network, 0xC0000409 su Windows/Node 24) e l'exit code arriva al chiamante", () => {
  const src = readFileSync(script("scripts/admin/doctor.mjs"), "utf8");
  const tail = src.slice(src.lastIndexOf("if (isMain("));
  assert.ok(!/process\.exit\(/.test(tail), "nessun process.exit nell'avvio della CLI");
  assert.match(tail, /process\.exitCode = c/);
  const ws = ws09d();
  const r = cli("scripts/admin/doctor.mjs", ["--network", "--json"], { ws });
  assert.equal(r.status, r.json.ok ? 0 : 3, "exit code coerente con l'esito");
  for (const f of ["purge", "retention", "status"]) assert.ok(!/process\.exit\(/.test(readFileSync(script(`scripts/admin/${f}.mjs`), "utf8")), f);
});
