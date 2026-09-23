import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveSessionId, loadSession, saveSession, updateSession, computeAllowedPaths, newSession, validateSession,
} from "../../scripts/admin/session.mjs";
import { verifyChain } from "../../hooks/lib/audit.mjs";
import { mkWs, seedSession, runSessionCli } from "../helpers/hook-env.mjs";

const REGISTRY = JSON.parse(readFileSync(new URL("../../schemas/registry.json", import.meta.url), "utf8"));
const SCHEMA = JSON.parse(readFileSync(new URL("../../schemas/session.schema.json", import.meta.url), "utf8"));

function freshWs() {
  const ws = realpathSync.native(mkdtempSync(join(tmpdir(), "jvc-s-")));
  mkdirSync(join(ws, ".jvc"), { recursive: true });
  writeFileSync(join(ws, ".jvc/current-session"), "sess-1");
  return ws;
}

test("schema session: tutti i campi di §45.1 obbligatori; scope = registry.scopes", () => {
  for (const k of ["session_id", "customer", "scope", "mode", "env", "budget", "allowed_paths", "pending", "surprises", "ledger",
    "hypotheses_file", "blackboard_dir", "last_compact_summary", "knowledge_version", "plugin_version", "updated_at"]) {
    assert.ok(SCHEMA.required.includes(k), `manca ${k} fra i required`);
  }
  assert.deepEqual(SCHEMA.properties.scope.enum.filter(Boolean).sort(), [...REGISTRY.scopes].sort());
  const s = newSession({ sid: "sess-1", customer: "ACME", pluginVersion: "0.1.0", knowledgeVersion: "1" });
  assert.equal(validateSession(s).ok, true, validateSession(s).errors?.join("; "));
  assert.equal(s.budget.tokens, 200000);
  assert.deepEqual(s.budget.by_model, { haiku: 0, sonnet: 0, opus: 0 });
  assert.equal(s.mode, "nrt");
  assert.equal(s.env, null);
  for (const k of ["session_id", "budget", "allowed_paths", "pending", "ledger", "updated_at"]) {
    const bad = structuredClone(s); delete bad[k];
    assert.equal(validateSession(bad).ok, false, `senza ${k} deve essere invalido`);
  }
  assert.equal(validateSession({ ...s, mode: "configurazione" }).ok, false);
  assert.equal(validateSession({ ...s, scope: "XXX" }).ok, false);
  assert.equal(validateSession({ ...s, budget: { ...s.budget, used: -1 } }).ok, false);
});

test("saveSession: scrittura atomica tmp+rename nella stessa cartella, nessun residuo", () => {
  const ws = freshWs();
  const dir = join(ws, "customers/ACME/.sessions/sess-1");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "session.json");
  const s = newSession({ sid: "sess-1", customer: "ACME", pluginVersion: "0.1.0", knowledgeVersion: "1" });
  saveSession(file, s);
  const back = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(back.customer, "ACME");
  assert.match(back.updated_at, /^\d{4}-\d\d-\d\dT/);
  assert.deepEqual(readdirSync(dir).filter((f) => f !== "session.json"), [], "nessun file temporaneo residuo");
});

test("saveSession: oggetto invalido → eccezione PRIMA del rename, file originale intatto", () => {
  const ws = freshWs();
  const dir = join(ws, "customers/ACME/.sessions/sess-1");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "session.json");
  saveSession(file, newSession({ sid: "sess-1", customer: "ACME", pluginVersion: "0.1.0", knowledgeVersion: "1" }));
  const before = readFileSync(file, "utf8");
  const bad = JSON.parse(before); delete bad.budget;
  assert.throws(() => saveSession(file, bad), /session\.json non valido/);
  assert.equal(readFileSync(file, "utf8"), before);
  assert.deepEqual(readdirSync(dir), ["session.json"]);
});

test("updateSession: read-modify-write sotto lock", () => {
  const ws = mkWs();
  const file = seedSession(ws);
  updateSession(file, (s) => { s.budget.used = 1234; });
  assert.equal(JSON.parse(readFileSync(file, "utf8")).budget.used, 1234);
  assert.equal(existsSync(`${file}.lock`), false);
});

test("resolveSessionId: --session > JVC_SESSION_ID > .jvc/current-session; placeholder non sostituito ignorato", () => {
  const ws = freshWs();
  assert.equal(resolveSessionId({ workspace: ws, arg: "abc", env: { JVC_SESSION_ID: "envid" } }), "abc");
  assert.equal(resolveSessionId({ workspace: ws, arg: undefined, env: { JVC_SESSION_ID: "envid" } }), "envid");
  assert.equal(resolveSessionId({ workspace: ws, env: {} }), "sess-1");
  assert.equal(resolveSessionId({ workspace: ws, arg: "${CLAUDE_SESSION_ID}", env: {} }), "sess-1");
  assert.equal(resolveSessionId({ workspace: ws, arg: "../../etc", env: {} }), null, "id con caratteri non sicuri rifiutato");
});

test("computeAllowedPaths: la cella di §31.4 per cliente × scope", () => {
  const p = computeAllowedPaths("ACME", "CAT", { sessionId: "sess-1" });
  for (const e of [
    "product/kb/scopes/CAT/**", "customers/ACME/kb/scopes/CAT/**", "customers/ACME/kb/handoffs/*CAT*",
    "customers/ACME/kb/scopes/XSC/integrations/**", "customers/ACME/tests/**/CAT/**", "customers/ACME/.sessions/sess-1/**",
    "customers/ACME/_inbox/CAT/**",
    ...["lessons", "decisions", "outcomes", "observations", "epistemic", "contradictions", "runs", "reports", "evidence"].map((d) => `customers/ACME/${d}/**`),
  ]) assert.ok(p.includes(e), `manca ${e}`);
  assert.ok(!p.some((x) => /ADM|BETA|analysis/.test(x)), "niente altri scope, clienti o analysis");
  assert.equal(new Set(p).size, p.length);
  assert.deepEqual(computeAllowedPaths(null, "CAT"), []);
  assert.ok(!computeAllowedPaths("ACME", null).some((x) => x.includes("/kb/")), "senza scope nessuna cella kb");
});

test("CLI use customer --new: scheletro §8.2, knowledge.db, .gitignore, session.json e puntatore", () => {
  const ws = freshWs();
  const r = runSessionCli(["use", "customer", "ACME", "--new", "--workspace", ws, "--json"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.json.ok, true);
  const c = join(ws, "customers/ACME");
  for (const d of ["profile", "kb/scopes/CAT", "kb/scopes/XSC", "kb/handoffs", "analysis/briefings", "observations", "lessons", "decisions",
    "outcomes", "epistemic", "contradictions", "clusters", "tests", "runs", "evidence", "reports", "audit", "config", "_inbox", ".sessions"]) {
    assert.ok(existsSync(join(c, d)), `manca ${d}`);
  }
  assert.ok(existsSync(join(c, "knowledge.db")));
  const gi = readFileSync(join(c, ".gitignore"), "utf8");
  assert.match(gi, /^\.sessions\/$/m); assert.match(gi, /^\.auth\/$/m);
  const ptr = JSON.parse(readFileSync(join(ws, ".jvc/sessions/sess-1.json"), "utf8"));
  assert.equal(ptr.customer, "ACME");
  assert.equal(ptr.path, "customers/ACME/.sessions/sess-1/session.json");
  const { session } = loadSession(ws, "sess-1");
  assert.equal(session.customer, "ACME");
  assert.equal(session.knowledge_version, "1");
  assert.ok(existsSync(join(c, ".sessions/sess-1/blackboard")));
  assert.ok(existsSync(join(c, ".sessions/sess-1/hypotheses.yaml")));
});

test("CLI use customer senza --new su cliente inesistente → exit 1; codice non valido → exit 1", () => {
  const ws = freshWs();
  assert.equal(runSessionCli(["use", "customer", "ZZZZ", "--workspace", ws, "--json"]).status, 1);
  assert.equal(runSessionCli(["use", "customer", "acme!", "--new", "--workspace", ws, "--json"]).status, 1);
  assert.equal(runSessionCli(["use", "customer", "STD", "--new", "--workspace", ws, "--json"]).status, 1);
});

test("CLI use customer: rifiuta (exit 3) il cambio se il cliente precedente ha compensazioni pendenti, e le elenca", () => {
  const ws = mkWs();
  seedSession(ws, { pending: { compensations: ["CMP.0012", "CMP.0013"], approvals: [], questions: [], expected_outcomes: [] } });
  const r = runSessionCli(["use", "customer", "BETA", "--workspace", ws, "--json"]);
  assert.equal(r.status, 3, r.stdout);
  assert.deepEqual(r.json.pending_compensations, ["CMP.0012", "CMP.0013"]);
  assert.equal(JSON.parse(readFileSync(join(ws, ".jvc/sessions/sess-1.json"), "utf8")).customer, "ACME", "puntatore invariato");
});

test("CLI use customer: cambio pulito porta il budget di sessione, audit dell'evento", () => {
  const ws = mkWs();
  seedSession(ws, { budget: { tokens: 150000, used: 5000, by_model: { haiku: 0, sonnet: 5000, opus: 0 } } });
  const r = runSessionCli(["use", "customer", "BETA", "--workspace", ws, "--json"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const { session } = loadSession(ws, "sess-1");
  assert.equal(session.customer, "BETA");
  assert.equal(session.budget.used, 5000);
  assert.equal(session.budget.tokens, 150000);
  assert.equal(session.scope, null);
  assert.deepEqual(session.allowed_paths.filter((p) => p.includes("/kb/")), []);
});

test("CLI use scope: validato contro registry; imposta allowed_paths", () => {
  const ws = mkWs();
  seedSession(ws, { scope: null, allowed_paths: [] });
  assert.equal(runSessionCli(["use", "scope", "XYZ", "--workspace", ws, "--json"]).status, 1);
  const r = runSessionCli(["use", "scope", "adm", "--workspace", ws, "--json"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const { session } = loadSession(ws, "sess-1");
  assert.equal(session.scope, "ADM");
  assert.ok(session.allowed_paths.includes("customers/ACME/kb/scopes/ADM/**"));
  assert.ok(session.allowed_paths.includes("customers/ACME/.sessions/sess-1/**"));
});

test("CLI use scope/mode senza cliente attivo → exit 1", () => {
  const ws = mkWs();
  seedSession(ws, { customer: null });
  assert.equal(runSessionCli(["use", "scope", "CAT", "--workspace", ws, "--json"]).status, 1);
  assert.equal(runSessionCli(["use", "mode", "diag", "--workspace", ws, "--json"]).status, 1);
});

test("CLI use mode: nrt|config|ops|diag (alias italiani), altro → exit 1", () => {
  const ws = mkWs();
  seedSession(ws);
  assert.equal(runSessionCli(["use", "mode", "diag", "--workspace", ws, "--json"]).status, 0);
  assert.equal(loadSession(ws, "sess-1").session.mode, "diag");
  assert.equal(runSessionCli(["use", "mode", "configurazione", "--workspace", ws, "--json"]).status, 0);
  assert.equal(loadSession(ws, "sess-1").session.mode, "config");
  assert.equal(runSessionCli(["use", "mode", "turbo", "--workspace", ws, "--json"]).status, 1);
});

test("CLI use budget: imposta i token e appende un evento di audit kind budget con catena valida", () => {
  const ws = mkWs();
  seedSession(ws);
  const r = runSessionCli(["use", "budget", "300k", "--workspace", ws, "--json"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(loadSession(ws, "sess-1").session.budget.tokens, 300000);
  const auditDir = join(ws, "customers/ACME/audit");
  const f = join(auditDir, readdirSync(auditDir).find((x) => x.endsWith(".jsonl")));
  const events = readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const b = events.find((e) => e.kind === "budget");
  assert.ok(b, "evento budget presente");
  assert.equal(b.payload.from, 200000);
  assert.equal(b.payload.to, 300000);
  assert.equal(verifyChain(f).ok, true);
  assert.equal(runSessionCli(["use", "budget", "-5", "--workspace", ws, "--json"]).status, 1);
  assert.equal(runSessionCli(["use", "budget", "abc", "--workspace", ws, "--json"]).status, 1);
});

test("CLI show --json e --help; nessuna sessione risolvibile → exit 1", () => {
  const ws = mkWs();
  seedSession(ws);
  const r = runSessionCli(["show", "--workspace", ws, "--json"]);
  assert.equal(r.status, 0);
  assert.equal(r.json.session.customer, "ACME");
  assert.equal(runSessionCli(["--help"]).status, 0);
  const empty = realpathSync.native(mkdtempSync(join(tmpdir(), "jvc-e-")));
  assert.equal(runSessionCli(["show", "--workspace", empty, "--json"]).status, 1);
});
