// 18/11/2026 (ciclo di bug fixing, area sessione, ambienti e amministrazione): il ciclo di vita di un consulente nuovo
// percorso da zero (workspace vuoto, cliente --new, environments.yaml, use env, env-check, scope, esplorazione, doctor,
// console) e sulla copia della conoscenza reale (AVVA, ENEL). Un test per ogni difetto trovato.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT, runSessionCli, runHook, cleanEnv, seedSession } from "../helpers/hook-env.mjs";
import { runChecks } from "../../scripts/admin/doctor.mjs";
import { refreshEnv } from "../../hooks/lib/env-refresh.mjs";
import { denyFamily, adviceFor, ADVICE } from "../../hooks/lib/deny-hints.mjs";
import { suggestedActions } from "../../scripts/admin/status.mjs";

const freshWs = () => realpathSync.native(mkdtempSync(join(tmpdir(), "jvc-c3-")));
const cli = (ws, args) => runSessionCli([...args, "--json"], { JVC_WORKSPACE: ws });
const script = (ws, rel, args) => {
  const r = spawnSync(process.execPath, [join(ROOT, rel), ...args], { env: cleanEnv({ JVC_WORKSPACE: ws }), encoding: "utf8", timeout: 30000 });
  let json = null;
  try { json = JSON.parse(r.stdout.trim().split("\n").pop()); } catch { /* non JSON */ }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
};

// Ambiente minimo, senza `label` (facoltativo nello schema), con l'impronta login_url + app_url di ENEL.
const ENVS = [
  "environments:",
  "  - id: sbx",
  "    type: sandbox",
  "    base_url: \"https://acme-sbx.app.jaggaer.com/esop/guest/login.do\"",
  "    allowed_hosts: [\"acme-sbx.app.jaggaer.com\"]",
  "    fingerprint:",
  "      login_url_pattern: '^https://acme-sbx\\.app\\.jaggaer\\.com/esop/guest/login\\.do'",
  "      app_url_pattern: '^https://acme-sbx\\.app\\.jaggaer\\.com/esop/'",
  "    policy:",
  "      write_data: true",
  "      config_levels: [verde, giallo]",
  "      approvals: { config_verde: 1, config_giallo: 1 }",
  "    credentials_prefix: \"NRT_SBX_\"",
  "  - id: prep",
  "    type: preprod",
  "    label: \"ACME pre-produzione\"",
  "    base_url: \"https://acme-prep.app.jaggaer.com/esop/guest/login.do\"",
  "    allowed_hosts: [\"acme-prep.app.jaggaer.com\"]",
  "    fingerprint:",
  "      title_pattern: \"^JAGGAER\"",
  "      app_url_pattern: '^https://acme-prep\\.app\\.jaggaer\\.com/esop/'",
  "    policy:",
  "      write_data: true",
  "      config_levels: [verde]",
  "      approvals: { config_verde: 1 }",
  "",
].join("\n");

function newCustomer(ws, sid = "s1") {
  const r = cli(ws, ["use", "customer", "ACME", "--new", "--session", sid]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  writeFileSync(join(ws, "customers/ACME/config/environments.yaml"), ENVS);
  return join(ws, "customers/ACME/.sessions", sid, "session.json");
}

test("use show senza cliente attivo: exit 0 con session null e l'indicazione di cosa fare (era «errore di sistema», exit 2)", () => {
  const ws = freshWs();
  const r = cli(ws, ["show", "--session", "s1"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.session, null);
  assert.match(r.json.hint, /use customer <ID>/);
  const t = runSessionCli(["use", "show", "--session", "s1"], { JVC_WORKSPACE: ws });
  assert.equal(t.status, 0);
  assert.match(t.stdout, /nessun cliente attivo/);
  assert.doesNotMatch(t.stdout + t.stderr, /Cannot read properties/);
});

test("use env su un ambiente senza label: dichiarato (exit 0), niente label: null in session.json; la ricarica in sessione lo conserva valido", async () => {
  const ws = freshWs();
  const sf = newCustomer(ws);
  const r = cli(ws, ["use", "env", "sbx", "--session", "s1"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const s = JSON.parse(readFileSync(sf, "utf8"));
  assert.equal(s.env.id, "sbx");
  assert.ok(!("label" in s.env), "label assente, non null");
  // environments.yaml cambiato in sessione (host aggiunto): la ricarica scrive davvero session.json
  writeFileSync(join(ws, "customers/ACME/config/environments.yaml"), ENVS.replace('allowed_hosts: ["acme-sbx.app.jaggaer.com"]', 'allowed_hosts: ["acme-sbx.app.jaggaer.com", "us-analytics.jaggaer.com"]'));
  const f = await refreshEnv({ ws, customer: "ACME", sessionFile: sf, session: s });
  assert.ok(f.env, f.reason);
  const after = JSON.parse(readFileSync(sf, "utf8"));
  assert.ok(after.env.refreshed_at, "la ricarica è stata scritta (prima falliva in silenzio sulla validazione)");
  assert.deepEqual(after.env.allowed_hosts, ["acme-sbx.app.jaggaer.com", "us-analytics.jaggaer.com"]);
  assert.ok(!("label" in after.env));
  // con l'etichetta, resta
  assert.equal(cli(ws, ["use", "env", "prep", "--session", "s1"]).status, 0);
  assert.equal(JSON.parse(readFileSync(sf, "utf8")).env.label, "ACME pre-produzione");
});

test("env-check: impronta login_url + app_url verificata sulla pagina di login (snapshot di take_snapshot)", () => {
  const ws = freshWs();
  newCustomer(ws);
  assert.equal(cli(ws, ["use", "env", "sbx", "--session", "s1"]).status, 0);
  const snap = join(ws, "customers/ACME/.sessions/s1/env-page.txt");
  writeFileSync(snap, 'uid=1_0 RootWebArea "JAGGAER - Login" url="https://acme-sbx.app.jaggaer.com/esop/guest/login.do"\n  uid=1_1 button "Login"\n');
  const r = script(ws, "scripts/chrome/env-check.mjs", ["--env", "sbx", "--snapshot", snap, "--write-session", "--session", "s1", "--json"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(r.json.signals_matched, ["login_url", "app_url"]);
  // dopo il login la stessa impronta ha un solo segnale: exit 3 con l'indicazione di cosa fare (non solo «1 segnali su 2»)
  const inner = join(ws, "customers/ACME/.sessions/s1/home.txt");
  writeFileSync(inner, 'uid=3_0 RootWebArea "Home" url="https://acme-sbx.app.jaggaer.com/esop/toolkit/home.do"\n');
  const r2 = script(ws, "scripts/chrome/env-check.mjs", ["--env", "sbx", "--snapshot", inner, "--customer", "ACME", "--json"]);
  assert.equal(r2.status, 3);
  assert.deepEqual(r2.json.signals_matched, ["app_url"]);
  assert.match(r2.json.hint, /workspace-manager.*title_pattern/);
  // con un segnale contrario nessun invito a completare l'impronta
  const other = join(ws, "customers/ACME/.sessions/s1/altro.txt");
  writeFileSync(other, 'uid=1_0 RootWebArea "X" url="https://evil.example.com/esop/"\n');
  const r3 = script(ws, "scripts/chrome/env-check.mjs", ["--env", "sbx", "--snapshot", other, "--customer", "ACME", "--json"]);
  assert.equal(r3.status, 3);
  assert.equal(r3.json.hint, undefined);
});

test("doctor hardening n. 1: app_url_pattern conta come segnale (login_url + app_url = 2, niente rosso spurio)", async () => {
  const ws = freshWs();
  newCustomer(ws);
  const h = (await runChecks({ ws, plugin: ROOT, env: {} })).find((c) => c.id === "hardening");
  const i1 = h.items.find((i) => i.n === 1);
  assert.equal(i1.status, "green", i1.detail);
  assert.doesNotMatch(h.detail, /1 segnali/);
  // n. 9 senza produzione dichiarata: non si applica (era giallo senza dettaglio)
  const i9 = h.items.find((i) => i.n === 9);
  assert.equal(i9.status, "green");
  assert.match(i9.detail, /nessun ambiente di produzione/);
});

test("doctor credentials: ambiente attivo senza NRT_<ENV>_* ⇒ giallo (corsia compilata opzionale), mai rosso", async () => {
  const ws = freshWs();
  newCustomer(ws);
  assert.equal(cli(ws, ["use", "env", "sbx", "--session", "s1"]).status, 0);
  const checks = await runChecks({ ws, plugin: ROOT, env: {}, session: "s1" });
  const c = checks.find((x) => x.id === "credentials");
  assert.equal(c.status, "yellow", c.detail);
  assert.match(c.detail, /NRT_SBX_\*.*corsia compilata/);
  const ok = (await runChecks({ ws, plugin: ROOT, env: { NRT_SBX_USER: "u" }, session: "s1" })).find((x) => x.id === "credentials");
  assert.equal(ok.status, "green");
});

test("session-context con puntatore illeggibile: contesto con agent-manager e la via di riparazione, current-session scritto", () => {
  const ws = freshWs();
  newCustomer(ws, "c1");
  writeFileSync(join(ws, ".jvc/sessions/c1.json"), "{rotto");
  writeFileSync(join(ws, ".jvc/current-session"), "altra\n");
  const r = runHook("session-context", { session_id: "c1", source: "resume", cwd: ws, hook_event_name: "SessionStart" }, { JVC_WORKSPACE: ws, CLAUDE_PLUGIN_ROOT: ROOT });
  assert.equal(r.status, 0, r.stderr);
  const ctx = r.json?.hookSpecificOutput?.additionalContext ?? "";
  assert.match(ctx, /agent-manager/);
  assert.match(ctx, /Puntatore di sessione illeggibile/);
  assert.match(ctx, /use customer <ID> \(clienti nel workspace: ACME\)/);
  assert.equal(readFileSync(join(ws, ".jvc/current-session"), "utf8").trim(), "c1");
  // la riparazione indicata funziona
  assert.equal(cli(ws, ["use", "customer", "ACME", "--session", "c1"]).status, 0);
});

test("environments.yaml assente: use env e validate-env dicono cosa fare (non solo «illeggibile (ENOENT)»)", () => {
  const ws = freshWs();
  assert.equal(cli(ws, ["use", "customer", "ACME", "--new", "--session", "s1"]).status, 0);
  const r = cli(ws, ["use", "env", "sbx", "--session", "s1"]);
  assert.equal(r.status, 1);
  assert.match(r.json.error, /environments\.yaml assente/);
  assert.match(r.json.error, /workspace-manager/);
  assert.match(r.json.error, /use env <id>/);
  const v = script(ws, "scripts/kb/validate-env.mjs", ["--customer", "ACME", "--json"]);
  assert.equal(v.status, 1);
  assert.match(v.json.error, /assente.*schemas\/environments\.schema\.json/);
});

test("use env verso un altro ambiente chiude la modalità esplorazione (la frase vale per l'ambiente in cui è stata scritta)", () => {
  const ws = freshWs();
  const sf = newCustomer(ws);
  assert.equal(cli(ws, ["use", "env", "sbx", "--session", "s1"]).status, 0);
  const p = runHook("approval-capture", { session_id: "s1", prompt: "ESPLORA SANDBOX", cwd: ws, hook_event_name: "UserPromptSubmit" }, { JVC_WORKSPACE: ws, CLAUDE_PLUGIN_ROOT: ROOT });
  assert.match(p.json?.hookSpecificOutput?.additionalContext ?? "", /Approvazione registrata: esplorazione sbx/);
  assert.equal(cli(ws, ["use", "mode", "esplorazione", "--session", "s1"]).status, 0);
  // stesso ambiente ridichiarato: la modalità resta
  assert.equal(cli(ws, ["use", "env", "sbx", "--session", "s1"]).json.session.mode, "esplorazione");
  const r = cli(ws, ["use", "env", "prep", "--session", "s1"]);
  assert.equal(r.status, 0);
  assert.equal(r.json.session.mode, "nrt");
  assert.equal(r.json.session.mode_approval, null);
  assert.match(r.json.note, /esplorazione chiusa/);
  assert.equal(JSON.parse(readFileSync(sf, "utf8")).mode, "nrt");
});

test("approval-capture: «esplora sandbox» in minuscolo riceve la frase esatta (prima nessuna risposta), senza token; una richiesta normale con «esplora» resta muta", async () => {
  const { parseApprovalPrompt } = await import("../../scripts/admin/approvals.mjs");
  assert.deepEqual(parseApprovalPrompt("esplora sandbox"), { kind: "attempt", explore: "ESPLORA SANDBOX" });
  assert.deepEqual(parseApprovalPrompt("Esplora Preprod completa."), { kind: "attempt", explore: "ESPLORA PREPROD COMPLETA" });
  assert.equal(parseApprovalPrompt("esplora la pagina degli ordini").explore, undefined);
  const ws = freshWs();
  newCustomer(ws);
  assert.equal(cli(ws, ["use", "env", "sbx", "--session", "s1"]).status, 0);
  const cap = (prompt) => runHook("approval-capture", { session_id: "s1", prompt, cwd: ws, hook_event_name: "UserPromptSubmit" }, { JVC_WORKSPACE: ws, CLAUDE_PLUGIN_ROOT: ROOT });
  const r = cap("esplora sandbox");
  assert.match(r.json?.hookSpecificOutput?.additionalContext ?? "", /scrivi esattamente `ESPLORA SANDBOX`/);
  assert.equal(existsSync(join(ws, "customers/ACME/.sessions/s1/approvals.jsonl")), false, "nessun token");
  assert.equal(cap("esplora la pagina degli ordini").stdout.trim(), "");
});

test("status: con l'ambiente non verificato l'azione suggerita è env-check (ridichiarare con use env non verifica)", () => {
  const base = { customer: "ACME", scope: "P2P", mode: "nrt", pending: { compensations: 0, approvals: 0, questions: 0, expected_outcomes: 0 }, kb: { quarantine_debt: { count: 0 } }, xray_queue: { pending: 0, failed: 0 } };
  const s = suggestedActions({ session: { ...base, env: { id: "sbx", type: "sandbox", verified: false } } });
  assert.ok(s.some((a) => /env-check --env sbx/.test(a.action)), JSON.stringify(s));
});

test("console dei dinieghi: «server MCP … non ammesso» non manda a workspace-manager (non può ammettere uno strumento)", () => {
  const reason = "server MCP ccd_turn non ammesso con un ambiente dichiarato: non è una famiglia del browser classificata né è in hooks/lib/mcp-allowlist.json del plugin (uno strumento non classificato può agire sul tenant)";
  assert.equal(denyFamily(reason), "other");
  assert.equal(adviceFor(reason), ADVICE.other);
  assert.equal(denyFamily("host non dichiarato: x.example (ambiente sandbox)"), "workspace", "gli host restano a workspace-manager");
});

test("stato illeggibile: approvals status ed env-check sono errori utente con la via di riparazione (non «errore di sistema»)", () => {
  const ws = freshWs();
  const sf = newCustomer(ws);
  writeFileSync(sf, readFileSync(sf, "utf8").slice(0, 120));
  const a = script(ws, "scripts/admin/approvals.mjs", ["status", "--session", "s1", "--json"]);
  assert.equal(a.status, 1, a.stdout);
  assert.match(a.json.error, /use customer <ID>/);
  const snap = join(ws, "customers/ACME/.sessions/s1/p.txt");
  writeFileSync(snap, "Title: x\n");
  const e = script(ws, "scripts/chrome/env-check.mjs", ["--env", "sbx", "--snapshot", snap, "--write-session", "--session", "s1", "--json"]);
  assert.equal(e.status, 1);
  assert.match(e.json.error, /use customer <ID>, poi use env sbx/);
  assert.doesNotMatch(e.json.error, /illeggibile: stato di sessione illeggibile/);
  const s = cli(ws, ["show", "--session", "s1"]);
  assert.equal(s.status, 1);
  assert.doesNotMatch(s.json.error, /illeggibile \(stato di sessione illeggibile/);
});

test("console degli agenti senza cliente: l'errore dice come uscirne", () => {
  const ws = freshWs();
  mkdirSync(join(ws, ".jvc/sessions"), { recursive: true });
  writeFileSync(join(ws, ".jvc/sessions/n1.json"), JSON.stringify({ session_id: "n1", customer: null, path: null }));
  const r = script(ws, "scripts/admin/agents.mjs", ["status", "--session", "n1", "--json"]);
  assert.equal(r.status, 1);
  assert.match(r.json.error, /use customer <ID>/);
});

test("commands/vc.md: status e doctor ricevono la sessione esplicita (con più sessioni current-session è l'ultima avviata)", () => {
  const body = readFileSync(join(ROOT, "commands/vc.md"), "utf8");
  assert.match(body, /status\.mjs" --session "\$\{CLAUDE_SESSION_ID\}" --json/);
  assert.match(body, /doctor\.mjs" --session "\$\{CLAUDE_SESSION_ID\}" --json/);
  // il gate d'integrità ammette doctor con --session (la sola forma consentita con il pacchetto alterato)
  const gate = readFileSync(join(ROOT, "hooks/lib/integrity-gate.mjs"), "utf8");
  assert.match(gate, /"--session": SID/);
  const hk = readFileSync(join(ROOT, "agents/health-keeper.md"), "utf8");
  assert.doesNotMatch(hk, /npm rebuild better-sqlite3/);
  assert.ok(existsSync(join(ROOT, "agents/health-keeper.md")));
});

test("subagent-trace: il rapporto consegnato con SubagentHandback vale (prima «rapporto mancante», blocco e compito «scaduto» nella console)", async () => {
  const { mkWs } = await import("../helpers/hook-env.mjs");
  const YAML = (await import("yaml")).default;
  const ws = mkWs();
  seedSession(ws, { budget: { tokens: 200000, used: 1000, by_model: { haiku: 0, sonnet: 1000, opus: 0 } } });
  const header = `\`\`\`yaml\n${YAML.stringify({ task_id: "MSG.sess-1.0001", customer: "ACME", scope: "CAT", mode: "nrt", tier: "T1", depth: "standard", budget: { tokens: 40000, minutes: 15 }, allowed_paths: ["customers/ACME/kb/scopes/CAT/**"], task: "Generare i test negativi" }).trim()}\n\`\`\`\n\nIstruzioni fisse…`;
  const g = runHook("guard-budget", { session_id: "sess-1", cwd: ws, hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: { subagent_type: "jaggaer-virtual-consultant:scope-expert", description: "test negativi", prompt: header, model: "sonnet" } }, { JVC_WORKSPACE: ws, CLAUDE_PLUGIN_ROOT: ROOT });
  assert.equal(g.stdout.trim(), "", g.stdout);
  // il transcript della fixture valida, con il rapporto spostato dal testo finale a una chiamata SubagentHandback
  const lines = readFileSync(join(ROOT, "test/fixtures/transcripts/valid-report.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const last = lines.findLastIndex((l) => l.type === "assistant");
  const report = lines[last].message.content.find((c) => c.type === "text").text;
  lines[last] = { ...lines[last], message: { ...lines[last].message, content: [{ type: "text", text: "Consegno il rapporto." }, { type: "tool_use", id: "toolu_1", name: "SubagentHandback", input: { message: report } }] } };
  lines.push({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "{\"success\":true,\"message\":\"Report delivered to your caller.\"}" }] }] } });
  const tr = join(ws, "t-agent-a1.jsonl");
  writeFileSync(tr, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  writeFileSync(join(ws, "main-transcript.jsonl"), "");
  const r = runHook("subagent-trace", { session_id: "sess-1", cwd: ws, hook_event_name: "SubagentStop", transcript_path: join(ws, "main-transcript.jsonl"), agent_id: "agent-a1", agent_type: "jaggaer-virtual-consultant:scope-expert", stop_hook_active: false, last_assistant_message: "Consegno il rapporto.", agent_transcript_path: tr }, { JVC_WORKSPACE: ws });
  assert.equal(r.status, 0, r.stderr);
  assert.notEqual(r.json?.decision, "block", r.stdout);
  const s = JSON.parse(readFileSync(join(ws, "customers/ACME/.sessions/sess-1/session.json"), "utf8"));
  const inv = s.ledger.invocations.find((i) => i.agent_id === "agent-a1");
  assert.equal(inv.task_id, "MSG.sess-1.0001");
  assert.equal(inv.status_effective, "ok");
  assert.ok(inv.completed_at, "invocazione chiusa nel ledger");
  assert.equal(s.budget.used, 1000 + 4000, "token del sub-agente contati");
});

test("bump-version: argomento sconosciuto o due tipi d'aumento ⇒ exit 1 senza scrivere (prima «pacth» alzava la minor in silenzio)", () => {
  const bv = (args) => spawnSync(process.execPath, [join(ROOT, "scripts/admin/bump-version.mjs"), ...args], { encoding: "utf8" });
  const typo = bv(["pacth", "--check"]);
  assert.equal(typo.status, 1);
  assert.match(typo.stderr, /argomenti sconosciuti: pacth/);
  assert.equal(bv(["patch", "major", "--check"]).status, 1);
  const ok = bv(["patch", "--check", "--json"]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).kind, "patch");
  // il valore di --branch non è un tipo d'aumento (post-checkout passa il nome del branch)
  const br = bv(["--branch", "major", "--check", "--json"]);
  assert.equal(br.status, 0, br.stderr);
  assert.equal(JSON.parse(br.stdout).kind, "minor");
});

test("sessioni parallele: doctor --session legge la propria sessione anche se current-session indica l'altra", async () => {
  const ws = freshWs();
  newCustomer(ws, "s1");
  assert.equal(cli(ws, ["use", "env", "sbx", "--session", "s1"]).status, 0);
  seedSession(ws, { sid: "s2", customer: "ACME", scope: null });   // l'altra sessione, avviata dopo
  assert.equal(readFileSync(join(ws, ".jvc/current-session"), "utf8").trim(), "s2");
  const c = (await runChecks({ ws, plugin: ROOT, env: {}, session: "s1" })).find((x) => x.id === "credentials");
  assert.match(c.detail, /ambiente attivo sbx/, "la sessione s1, con il suo ambiente");
});
