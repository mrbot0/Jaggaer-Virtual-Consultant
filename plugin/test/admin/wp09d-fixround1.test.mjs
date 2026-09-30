// WP09d giro di correzione 1: I1 approvazioni amministrative confermate nel transcript da guard-destructive (purge,
// retention, kb promote --to product); I2 promozione a S solo di candidati del digest senza CTR aperti; I3 retention non
// segue cartelle collegate; minori (deprecazione persistente della retention, LIMIT osservato, conoscenza delle tabelle
// non alzabile, --max limitato, baseline più recente per orario, impronta obbligatoria, purge legata al cliente della
// sessione, istogrammi dei DIN, metriche §35, lock della retention). Cancellazioni vere solo nelle cartelle temporanee
// del test, tramite gli script del plugin.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, existsSync, utimesSync, symlinkSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import YAML from "yaml";
import { openDb } from "../../scripts/kb/db.mjs";
import { reindex } from "../../scripts/kb/reindex.mjs";
import { runHook, decisionOf, reasonOf, ROOT } from "../helpers/hook-env.mjs";
import { flw, writeItem, FACETS } from "../helpers/wp09b-items.mjs";
import { ws09d, withSession, say, cli, script, SALT } from "../helpers/wp09d.mjs";
import { appendApproval, approvalsFile, sha256 } from "../../scripts/admin/approvals.mjs";
import { isoWeek } from "../../scripts/digest/collect.mjs";
import { recordRun, deliverable, ensureLimit, MAX_LIMIT } from "../../scripts/analytics/query-guard.mjs";
import { latestBaseline, loadBaseline, hashObjects } from "../../scripts/config/baseline.mjs";
import { validateItem } from "../../scripts/kb/validate-schema.mjs";

const PURGE = script("scripts/admin/purge.mjs");
const RET = script("scripts/admin/retention.mjs");
const KB = script("scripts/kb/kb.mjs");
const LEARN = script("scripts/digest/learn.mjs");
const guard = (ws, command, transcript_path) => runHook("guard-destructive", { session_id: "sess-1", cwd: ws, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, ...(transcript_path ? { transcript_path } : {}) }, { JVC_WORKSPACE: ws, CLAUDE_PLUGIN_ROOT: ROOT });
const denied = (r) => decisionOf(r) === "deny";
const silent = (r) => r.status === 0 && r.stdout.trim() === "";
const emptyTranscript = () => { const f = join(mkdtempSync(join(tmpdir(), "tr-")), "sess-1.jsonl"); writeFileSync(f, ""); return f; };
// Registro forgiato ma con la catena di hash corretta: nessuna riga del transcript lo sostiene.
const forge = (ws, rec) => appendApproval(approvalsFile(ws, "ACME", "sess-1"), { ...rec, prompt_sha256: sha256(`frase mai scritta ${Math.random()}`), session: "sess-1" });

// ---------------- I1 ----------------
test("I1 purge: guard-destructive conferma le due approvazioni nel transcript; registro forgiato (catena valida) ⇒ deny", () => {
  const ws = ws09d(); withSession(ws);
  const a = say(ws, "APPROVO PURGE ACME DA Mario Rossi");
  const b = say(ws, "APPROVO PURGE ACME DA Anna Bianchi", { transcript: a.transcript });
  const cmd = `node "${PURGE}" ACME --execute --approval-1 ${a.last.hash.slice(0, 16)} --approval-2 ${b.last.hash.slice(0, 16)}`;
  assert.ok(silent(guard(ws, cmd, a.transcript)), "approvazioni vere, frasi nel transcript");
  assert.ok(denied(guard(ws, cmd, emptyTranscript())), "transcript senza le frasi");
  assert.ok(denied(guard(ws, cmd)), "transcript assente");
  const f1 = forge(ws, { kind: "purge", target: "ACME", approver_declared: "Tizio Uno" });
  const f2 = forge(ws, { kind: "purge", target: "ACME", approver_declared: "Caio Due" });
  const r = guard(ws, `node "${PURGE}" ACME --execute --approval-1 ${f1.hash.slice(0, 16)} --approval-2 ${f2.hash.slice(0, 16)}`, a.transcript);
  assert.ok(denied(r), "registro forgiato con catena valida"); assert.match(reasonOf(r), /transcript/);
  assert.ok(denied(guard(ws, `node "${PURGE}" ACME --execute --approval-1 0123456789abcdef --approval-2 fedcba9876543210`, a.transcript)), "token inesistenti");
  assert.ok(silent(guard(ws, `node "${PURGE}" ACME --approval-1 0123456789abcdef --approval-2 fedcba9876543210`)), "prova a secco: non agisce, nessuna conferma richiesta");
});

test("I1 retention --apply e kb promote --to product: approvazione confermata nel transcript dal guard; forma non esatta di promote ⇒ deny", () => {
  const ws = ws09d(); withSession(ws);
  const r = say(ws, "APPROVO RETENTION ACME");
  const tok = r.last.hash.slice(0, 16);
  assert.ok(silent(guard(ws, `node "${RET}" ACME --apply --approval ${tok}`, r.transcript)));
  assert.ok(denied(guard(ws, `node "${RET}" ACME --apply --approval ${tok}`, emptyTranscript())));
  const fr = forge(ws, { kind: "retention", target: "ACME", approver_declared: null });
  assert.ok(denied(guard(ws, `node "${RET}" ACME --apply --approval ${fr.hash.slice(0, 16)}`, r.transcript)));
  const p = say(ws, "APPROVO PROMOZIONE L.ACME.CAT.FLW.0001", { transcript: r.transcript });
  const pt = p.last.hash.slice(0, 16);
  for (const s of [KB, LEARN]) assert.ok(silent(guard(ws, `node "${s}" promote L.ACME.CAT.FLW.0001 --customer ACME --to product --approval ${pt} --json`, r.transcript)), s);
  assert.ok(denied(guard(ws, `node "${KB}" promote L.ACME.CAT.FLW.0001 --customer ACME --to product --approval ${pt}`, emptyTranscript())));
  const fp = forge(ws, { kind: "promote", target: "L.ACME.CAT.FLW.0001", approver_declared: null });
  assert.ok(denied(guard(ws, `node "${KB}" promote L.ACME.CAT.FLW.0001 --customer ACME --to product --approval ${fp.hash.slice(0, 16)}`, r.transcript)));
  assert.ok(silent(guard(ws, `node "${KB}" promote L.ACME.CAT.FLW.0001 --customer ACME --json`)), "L → C: nessuna approvazione");
  assert.ok(silent(guard(ws, `node "${KB}" find --scope CAT --json`)), "gli altri comandi kb non cambiano");
  assert.ok(denied(guard(ws, `cd x && node "${KB}" promote L.ACME.CAT.FLW.0001 --customer ACME --to product --approval ${pt}`, r.transcript)), "forma non esatta");
  assert.ok(denied(guard(ws, `node "${KB}" promote L.ACME.CAT.FLW.0001 --to product --approval ${pt} --workspace C:\\`, r.transcript)), "opzione non ammessa");
});

// ---------------- I2 ----------------
function promoteWs() {
  const ws = ws09d(); withSession(ws);
  const steps = [{ n: 1, verb: "NAVIGATE", target: { url_pattern: "/r" }, expect: { page_sig: "r" } }, { n: 2, verb: "SAVE", target: "S.STD.P2P.SEL.0002", creates: { entity: "requisition", kind: "create" }, expect: { toast: "ok" } }];
  for (const n of [1, 2, 3]) writeItem(ws, flw(`L.ACME.CAT.FLW.000${n}`, { steps, evidence: [{ at: 2, kind: "assertion" }], facets: { ...FACETS, F12: "clusterizzato" } }));
  reindex(join(ws, "customers", "ACME"), join(ws, "customers", "ACME", "knowledge.db"));
  const week = isoWeek(new Date()).id;
  mkdirSync(join(ws, "customers/ACME/digest", week), { recursive: true });
  writeFileSync(join(ws, "customers/ACME/digest", week, "candidates.yaml"), YAML.stringify({ week, customer: "ACME", candidates: [{ id: `CAND-${week}-001`, class: "universale", p: 1, items: ["L.ACME.CAT.FLW.0001", "L.ACME.CAT.FLW.0003"] }] }));
  return ws;
}
const promote = (ws, code) => { const s = say(ws, `APPROVO PROMOZIONE ${code}`); return cli("scripts/kb/kb.mjs", ["promote", code, "--customer", "ACME", "--to", "product", "--approval", s.last.hash.slice(0, 16), "--json"], { ws, env: { JVC_PSEUDO_SALT: SALT } }); };

test("I2 promote --to product: solo candidati del digest (DT-010); item con CTR aperto rifiutato; il candidato passa", () => {
  const ws = promoteWs();
  let r = promote(ws, "L.ACME.CAT.FLW.0002");
  assert.equal(r.status, 3, r.stdout); assert.match(r.json.error, /candidat/);
  const db = openDb(join(ws, "customers/ACME/knowledge.db"));
  db.prepare("insert into contradictions(code,a_code,b_code,facet,resolution,status) values ('L.ACME.CAT.CTR.0001','L.ACME.CAT.FLW.0003','S.STD.CAT.FLW.0009','F12',null,'aperto')").run();
  db.close();
  r = promote(ws, "L.ACME.CAT.FLW.0003");
  assert.equal(r.status, 3, r.stdout); assert.match(r.json.error, /contraddizione aperta|CTR/);
  r = promote(ws, "L.ACME.CAT.FLW.0001");
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.equal(r.json.code, "S.STD.CAT.FLW.0001");
});

test("I2/m7 promote --to product: rispetta il lock di product/ della digestione (exit 3, approvazione non consumata)", () => {
  const ws = promoteWs();
  writeFileSync(join(ws, "product", "knowledge.lock"), JSON.stringify({ pid: process.pid, expires: Date.now() + 600000 }));
  const s = say(ws, "APPROVO PROMOZIONE L.ACME.CAT.FLW.0001");
  const r = cli("scripts/kb/kb.mjs", ["promote", "L.ACME.CAT.FLW.0001", "--customer", "ACME", "--to", "product", "--approval", s.last.hash.slice(0, 16), "--json"], { ws, env: { JVC_PSEUDO_SALT: SALT } });
  assert.equal(r.status, 3, r.stdout); assert.match(r.json.error, /lock/);
  const recs = readFileSync(approvalsFile(ws, "ACME", "sess-1"), "utf8");
  assert.ok(!recs.includes('"consume"'), "l'approvazione resta utilizzabile");
});

// ---------------- I3 ----------------
const DAY = 86400000;
const old = (f, days) => { const t = new Date(Date.now() - days * DAY); utimesSync(f, t, t); };
test("I3 retention: una cartella di categoria collegata (giunzione/link) è rifiutata; nulla fuori dal cliente viene toccato", () => {
  const ws = ws09d(); withSession(ws);
  mkdirSync(join(ws, "product/kb/scopes/CAT"), { recursive: true });
  const kbFile = join(ws, "product/kb/scopes/CAT/S.STD.CAT.FLW.0001.yaml"); writeFileSync(kbFile, "id: x\n"); old(kbFile, 400);
  mkdirSync(join(ws, "customers/ACME/audit"), { recursive: true });
  const audit = join(ws, "customers/ACME/audit/2024-01.jsonl"); writeFileSync(audit, "{}\n"); old(audit, 400);
  symlinkSync(join(ws, "product/kb/scopes/CAT"), join(ws, "customers/ACME/observations"), "junction");
  symlinkSync(join(ws, "customers/ACME/audit"), join(ws, "customers/ACME/evidence"), "junction");
  const dry = cli("scripts/admin/retention.mjs", ["ACME", "--json"], { ws });
  assert.equal(dry.status, 3, dry.stdout); assert.match(dry.json.error, /collegat|link/);
  const tok = say(ws, "APPROVO RETENTION ACME").last.hash.slice(0, 16);
  assert.equal(cli("scripts/admin/retention.mjs", ["ACME", "--apply", "--approval", tok, "--json"], { ws }).status, 3);
  assert.ok(existsSync(kbFile), "la conoscenza di product/ resta"); assert.ok(existsSync(audit), "l'audit resta");
});

test("I3 retention: una voce collegata dentro una categoria che punta fuori dal cliente è rifiutata", () => {
  const ws = ws09d(); withSession(ws);
  mkdirSync(join(ws, "product/analysis/x"), { recursive: true });
  const tgt = join(ws, "product/analysis/x/f.yaml"); writeFileSync(tgt, "x\n"); old(tgt, 400);
  mkdirSync(join(ws, "customers/ACME/runs/RUN-1"), { recursive: true });
  symlinkSync(join(ws, "product/analysis/x"), join(ws, "customers/ACME/runs/RUN-1/evidence"), "junction");
  const r = cli("scripts/admin/retention.mjs", ["ACME", "--json"], { ws });
  assert.equal(r.status, 3, r.stdout);
  assert.ok(existsSync(tgt));
});

// ---------------- minori ----------------
test("m1/m12 retention: fase di deprecazione persistente (prova a secco) prima della rimozione; --apply rimuove solo ciò che era deprecato; lock del cliente", () => {
  const ws = ws09d(); withSession(ws);
  mkdirSync(join(ws, "customers/ACME/observations"), { recursive: true });
  const o1 = join(ws, "customers/ACME/observations/L.ACME.CAT.OBS.0001.yaml"); writeFileSync(o1, "x\n"); old(o1, 100);
  const tok1 = say(ws, "APPROVO RETENTION ACME").last.hash.slice(0, 16);
  let r = cli("scripts/admin/retention.mjs", ["ACME", "--apply", "--approval", tok1, "--json"], { ws });
  assert.equal(r.status, 3, "senza la deprecazione precedente"); assert.match(r.json.error, /deprecat/);
  assert.ok(existsSync(o1));
  const dry = cli("scripts/admin/retention.mjs", ["ACME", "--json"], { ws });
  assert.equal(dry.status, 0); assert.ok(dry.json.deprecation?.file);
  const o2 = join(ws, "customers/ACME/observations/L.ACME.CAT.OBS.0002.yaml"); writeFileSync(o2, "x\n"); old(o2, 100);
  writeFileSync(join(ws, "customers/ACME/knowledge.lock"), JSON.stringify({ pid: process.pid, expires: Date.now() + 600000 }));
  const tok2 = say(ws, "APPROVO RETENTION ACME").last.hash.slice(0, 16);
  r = cli("scripts/admin/retention.mjs", ["ACME", "--apply", "--approval", tok2, "--json"], { ws });
  assert.equal(r.status, 3, "lock del cliente attivo"); assert.ok(existsSync(o1));
  writeFileSync(join(ws, "customers/ACME/knowledge.lock"), JSON.stringify({ pid: 2147483000, expires: Date.now() - 1000 }));
  const tok3 = say(ws, "APPROVO RETENTION ACME").last.hash.slice(0, 16);
  r = cli("scripts/admin/retention.mjs", ["ACME", "--apply", "--approval", tok3, "--json"], { ws });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(existsSync(o1), false, "deprecato e poi rimosso");
  assert.ok(existsSync(o2), "scaduto ma non ancora deprecato: resta fino alla prossima prova a secco");
  assert.deepEqual(r.json.pending_deprecation, ["customers/ACME/observations/L.ACME.CAT.OBS.0002.yaml"]);
});

test("m2/m3/m4 query-guard: LIMIT registrato solo se nel testo eseguito; la conoscenza registrata non si alza; --max limitato", () => {
  const db = openDb(join(mkdtempSync(join(tmpdir(), "qg-")), "k.db"));
  recordRun(db, { sql: "select a from t", rowCount: 3, coherence: "coerente", tablesKnowledge: "validate" });
  const d = deliverable(db, { sql: "select a from t", patternKnown: true });
  assert.equal(d.deliverable, false, "eseguita senza LIMIT ⇒ DT-015 no"); assert.match(d.reason, /executed_with_limit|override/);
  recordRun(db, { sql: "select b from u limit 10", rowCount: 3, coherence: "coerente", tablesKnowledge: "ignote" });
  const e = deliverable(db, { sql: "select b from u", tablesKnowledge: "validate", patternKnown: true });
  assert.equal(e.qry_eligible, false, "il chiamante non trasforma tabelle ignote in validate"); assert.ok(e.warning);
  db.close();
  assert.equal(ensureLimit("select a from t limit 999999", { max: 10 ** 9 }).limit, MAX_LIMIT);
  const ws = ws09d(); const f = join(ws, "q.sql"); writeFileSync(f, "select a from t limit 999999");
  assert.equal(cli("scripts/analytics/query-guard.mjs", ["limit", "--sql-file", f, "--max", "5000000", "--json"], { ws }).json.limit, MAX_LIMIT);
});

test("m5/m6 baseline: la più recente per orario di cattura; impronta obbligatoria", () => {
  const ws = ws09d();
  const dir = join(ws, "customers/ACME/config-baselines/sandbox"); mkdirSync(dir, { recursive: true });
  const doc = (at, v) => { const objects = { k: { values: { v } } }; return YAML.stringify({ env: "sandbox", captured_at: at, objects, hash: hashObjects(objects) }); };
  writeFileSync(join(dir, "2026-09-29.yaml"), doc("2026-09-29T08:00:00.000Z", 1));
  writeFileSync(join(dir, "2026-09-29-101010.yaml"), doc("2026-09-29T10:10:10.000Z", 2));
  assert.ok(latestBaseline(ws, "ACME", "sandbox").endsWith("2026-09-29-101010.yaml"));
  const nohash = join(dir, "x.yaml"); writeFileSync(nohash, YAML.stringify({ env: "sandbox", objects: { k: { values: { v: 1 } } } }));
  assert.throws(() => loadBaseline(nohash), /impronta/);
});

test("m9 purge: il cliente della sessione deve essere quello da cancellare (approvazione e script)", () => {
  const ws = ws09d(); withSession(ws);
  mkdirSync(join(ws, "customers/BETA/kb"), { recursive: true });
  const s = say(ws, "APPROVO PURGE BETA DA Mario Rossi");
  assert.equal(s.records.length, 0); assert.match(s.context, /sessione/);
  const f1 = appendApproval(approvalsFile(ws, "ACME", "sess-1"), { kind: "purge", target: "BETA", approver_declared: "A B", prompt_sha256: sha256("x"), session: "sess-1" });
  const f2 = appendApproval(approvalsFile(ws, "ACME", "sess-1"), { kind: "purge", target: "BETA", approver_declared: "C D", prompt_sha256: sha256("y"), session: "sess-1" });
  const r = cli("scripts/admin/purge.mjs", ["BETA", "--execute", "--approval-1", f1.hash, "--approval-2", f2.hash, "--json"], { ws });
  assert.equal(r.status, 3, r.stdout); assert.match(r.json.error, /cliente della sessione/);
  assert.ok(existsSync(join(ws, "customers/BETA/kb")));
});

test("m10 DIN: quote di istogramma su gruppi < 20 e chiavi identificative nelle mappe ⇒ rifiutati", () => {
  const din = (extra) => ({ id: "L.ACME.P2P.DIN.0001", type: "DIN", title: "Profilo", summary: "x.", facets: FACETS, sources: [{ q: 1 }], document: "document.requisition",
    sample: { size: 1000 }, fields: [{ field: "S.STD.P2P.FLD.0117", fill_rate: 1 }], privacy: { values_retained: "none", aggregation_min_group: 20 }, ...extra });
  assert.equal(validateItem(din({ fields: [{ field: "S.STD.P2P.FLD.0088", values_histogram: { catalogo: 0.7, "testo-libero": 0.3 } }] })).ok, true);
  assert.match(validateItem(din({ fields: [{ field: "S.STD.P2P.FLD.0088", values_histogram: { catalogo: 0.99, raro: 0.01 } }] })).errors.join(" "), /gruppo/);
  assert.match(validateItem(din({ by_role: { approvers: { "mario.rossi@acme.it": 0.5, altri: 0.5 } } })).errors.join(" "), /identificativ|email/);
  assert.match(validateItem(din({ amounts: { supplier_names: { "Fornitore Uno": 0.6, "Fornitore Due": 0.4 } } })).errors.join(" "), /identificativ/);
  assert.match(validateItem(din({ lifecycle: { by_document: { "4500012345": 0.5, "4500012346": 0.5 } } })).errors.join(" "), /identificativ/);
});

test("m11 status --metrics: costo compito ripetuto / prima volta e osservazioni R0 suggerite eseguite nella settimana", () => {
  const ws = ws09d();
  withSession(ws, { budget: { tokens: 200000, used: 30000, by_model: { haiku: 0, sonnet: 0, opus: 0 } } });
  withSession(ws, { sid: "sess-2", budget: { tokens: 200000, used: 100000, by_model: { haiku: 0, sonnet: 0, opus: 0 } } });
  const db = openDb(join(ws, "customers/ACME/knowledge.db"));
  db.prepare("insert into decisions(code,table_code,outcome,strategy,session,at) values ('L.ACME.CAT.DEC.0001','DT-017','STR-REPLAY','STR-REPLAY','sess-1',?),('L.ACME.CAT.DEC.0002','DT-017','STR-EXPLORE','STR-EXPLORE','sess-2',?)").run(new Date().toISOString(), new Date().toISOString());
  db.prepare("insert into epistemic(subject_code, shape) values ('C.ACME.CAT.CFG.0001','ignoto'),('C.ACME.CAT.CFG.0002','ignoto'),('C.ACME.CAT.CFG.0003','ignoto'),('C.ACME.CAT.CFG.0004','ignoto')").run();
  db.prepare("insert into observations(code, scope, payload) values ('L.ACME.CAT.OBS.0001','CAT',?),('L.ACME.CAT.OBS.0002','CAT',?)").run(JSON.stringify({ ts: new Date().toISOString() }), JSON.stringify({ ts: "2025-01-01T00:00:00Z" }));
  db.close();
  const r = cli("scripts/admin/status.mjs", ["--metrics", "--json"], { ws });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.json.metrics.cognition.repeated_vs_first_cost, 0.3);
  assert.equal(r.json.metrics.cognition.r0_suggested_executed_pct, 25);
});
