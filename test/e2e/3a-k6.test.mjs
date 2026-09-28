// K6 — il flusso 3A gira sullo stato scritto dal codice K6, non su uno stato seminato: active_plan e
// richieste di approvazione (pending.approvals) da step-check, snapshot dell'oggetto governato da
// observe-append, origine del browser dagli hook PostToolUse; A1 → A2 → A3 dalle frasi dell'utente;
// guard-config-scope (e gli altri guard) consentono il passo approvato una volta sola.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { copyFileSync, mkdirSync, writeFileSync, mkdtempSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import YAML from "yaml";
import { mkWs, seedSession, runHook, runSessionCli, decisionOf, reasonOf, cleanEnv, ROOT } from "../helpers/hook-env.mjs";
import { readSession, writePlan, writeSel } from "../helpers/env-fixture.mjs";
import { approvalsFile, readApprovals } from "../../scripts/admin/approvals.mjs";

const PLAN = "PLAN.ACME.K6.3A";
const P = "https://acme.jaggaer.com";
const DT = "mcp__chrome-devtools__";

test("3A su stato K6: step-check attiva il piano e chiede A1/A3, observe-append registra lo snapshot, A1 → A2 → A3, passo consentito una volta", () => {
  const ws = mkWs(); seedSession(ws, { scope: "ADM" });
  mkdirSync(join(ws, "customers/ACME/config"), { recursive: true });
  copyFileSync(join(ROOT, "test/fixtures/env/environments.yaml"), join(ws, "customers/ACME/config/environments.yaml"));
  writeFileSync(join(ws, "customers/ACME/config/remediation-scope.yaml"), YAML.stringify({ levels: { giallo: { areas: ["CL-CFG-020"], objects: ["C.ACME.ADM.CFG.0019"] } } }));
  const E = { JVC_WORKSPACE: ws, CLAUDE_PLUGIN_ROOT: ROOT, JVC_SESSION_ID: "sess-1" };
  assert.equal(runSessionCli(["use", "env", "prod", "--session", "sess-1"], E).status, 0);
  const node = (script, args) => spawnSync(process.execPath, [join(ROOT, script), ...args], { encoding: "utf8", env: cleanEnv(E) });
  assert.equal(node("scripts/chrome/env-check.mjs", ["--customer", "ACME", "--env", "prod", "--snapshot", join(ROOT, "test/fixtures/env/pages/prod.json"), "--write-session", "--session", "sess-1", "--json"]).status, 0);
  writeSel(ws, "C.ACME.ADM.SEL.0140", { role: "checkbox", effect: "write", label: "strict_import" });
  writeSel(ws, "C.ACME.ADM.SEL.0102", { role: "link", effect: "read", label: "Profili di import" });
  const cfg = { object: "C.ACME.ADM.CFG.0019", area: "CL-CFG-020", level: "giallo" };
  const plan = {
    plan_id: PLAN, customer: "ACME", env: "prod", goal: "Attivare strict_import", approvals: "3A",
    steps: [
      { n: 1, verb: "NAVIGATE", action_class: "ACT-OBS", target: { url_pattern: `${P}/setup/import-profiles` }, expect: { page_sig: "setup/import-profiles" } },
      { n: 2, verb: "TOGGLE", action_class: "ACT-CFG-CHANGE", target: "C.ACME.ADM.SEL.0140", data: true, risk: "R2", config: cfg, expect: { value: "true" } },
    ],
    repair_policy: { skip_allowed: [], substitute_allowed: [], abort_on: [2] },
  };
  const file = writePlan(ws, plan, "RUN.ACME.20260922.1104.ADM");
  const sc = (args) => { const r = node("scripts/decide/step-check.mjs", ["--plan", file, ...args, "--json"]); return JSON.parse(r.stdout); };
  const tr = join(mkdtempSync(join(tmpdir(), "k6-3a-")), "t.jsonl");
  writeFileSync(tr, "");
  const say = (prompt) => {
    appendFileSync(tr, `${JSON.stringify({ type: "user", isSidechain: false, userType: "external", message: { role: "user", content: prompt }, timestamp: new Date().toISOString() })}\n`);
    return runHook("approval-capture", { session_id: "sess-1", cwd: ws, hook_event_name: "UserPromptSubmit", prompt, transcript_path: tr }, E).json?.hookSpecificOutput?.additionalContext ?? "";
  };
  const call = (op, input, text) => {
    const tool = DT + op;
    const res = ["guard-environment", "guard-production", "guard-config-scope"].map((g) => ({ g, r: runHook(g, { session_id: "sess-1", cwd: ws, hook_event_name: "PreToolUse", tool_name: tool, tool_input: input, transcript_path: tr }, E) }));
    const denied = res.filter(({ r }) => decisionOf(r) === "deny").map(({ g, r }) => `${g}: ${reasonOf(r)}`);
    if (!denied.length) for (const h of ["browser-origin", "observe-append"]) runHook(h, { session_id: "sess-1", cwd: ws, hook_event_name: "PostToolUse", tool_name: tool, tool_input: input, tool_response: [{ type: "text", text }] }, E);
    return denied;
  };
  const page = (checked) => `## Latest page snapshot\nuid=1_0 RootWebArea "ACME Procurement" url="${P}/setup/import-profiles/7"\n  uid=1_1 heading "Profili di import" level="1"\n  uid=1_2 StaticText "strict_import "\n  uid=1_3 checkbox "strict_import "${checked ? " checked" : ""}\n`;
  const snapFile = (checked) => { const f = join(ws, "customers/ACME/.sessions/sess-1/p.txt"); writeFileSync(f, page(checked)); return f; };

  // WP07 giro 1 (C2 a): in produzione step-check non attiva il piano senza APPROVO PIANO; la richiesta A1 la scrive lui
  const a0 = sc(["--step", "1"]);
  assert.equal(a0.status, "approval_required"); assert.match(a0.ask, /APPROVO PIANO PLAN\.ACME\.K6\.3A DA <Nome Cognome>/);
  assert.equal(readSession(ws).active_plan ?? null, null);
  assert.deepEqual(readSession(ws).pending.approvals.map((a) => [a.kind, a.step ?? null]), [["A1", null]]);
  assert.match(say(`APPROVO PIANO ${PLAN} DA Mario Rossi`), /registrata: A1/);
  // ora step-check attiva il passo 1 (ACT-OBS), con l'impronta del piano
  assert.equal(sc(["--step", "1"]).status, "ok");
  const ap = readSession(ws).active_plan;
  assert.deepEqual({ ...ap, plan_sha256: undefined }, { plan_id: PLAN, file, step: 1, run: "RUN.ACME.20260922.1104.ADM", plan_sha256: undefined });
  assert.match(ap.plan_sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(call("navigate_page", { type: "url", url: `${P}/setup/import-profiles/7`, pageId: 1 }, `Successfully navigated to ${P}/setup/import-profiles/7.\n## Pages\n1: ACME Procurement (${P}/setup/import-profiles/7) [selected]`), []);
  call("take_snapshot", { pageId: 1 }, page(false));
  // passo 1 verificato ⇒ passo 2 (config in prod) richiede A1 e A3: le richieste le scrive step-check
  const r1 = sc(["--step", "1", "--snapshot", snapFile(false)]);
  assert.equal(r1.status, "ok"); assert.equal(r1.next.status, "approval_required");
  assert.match(r1.next.ask, /APPROVO PROVA PLAN\.ACME\.K6\.3A DA <Nome Cognome>/);
  assert.deepEqual(readSession(ws).pending.approvals.map((a) => [a.kind, a.step ?? null]), [["A2", null], ["A3", 2]]);
  // senza approvazioni il passo con effetto è negato
  assert.ok(call("click", { uid: "1_3", pageId: 1 }, "Successfully clicked").some((d) => /A2|APPROVO/.test(d)));
  assert.match(say(`APPROVO PROVA ${PLAN} DA Luca Bianchi`), /registrata: A2/);
  // lo snapshot dell'oggetto governato (§28.1) lo registra observe-append durante il passo di configurazione
  call("take_snapshot", { pageId: 1 }, page(false));
  assert.ok(readSession(ws).snapshots.some((x) => x.objects.includes("C.ACME.ADM.CFG.0019")));
  assert.ok(call("click", { uid: "1_3", pageId: 1 }, "Successfully clicked").some((d) => /APPROVO PASSO 2/.test(d)), "manca A3");
  call("take_snapshot", { pageId: 1 }, page(false));
  assert.match(say(`APPROVO PASSO 2 ${PLAN}`), /registrata: A3/);
  const ok = call("click", { uid: "1_3", pageId: 1 }, "Successfully clicked on the element");
  assert.deepEqual(ok, [], "i tre guard consentono il passo approvato");
  call("take_snapshot", { pageId: 1 }, page(true));
  const again = call("click", { uid: "1_3", pageId: 1 }, "Successfully clicked");
  assert.ok(again.some((d) => d.startsWith("guard-config-scope")), "token monouso");
  const r2 = sc(["--step", "2", "--snapshot", snapFile(true)]);
  assert.equal(r2.status, "ok", JSON.stringify(r2.divergences)); assert.equal(r2.plan_status, "completed");
  const recs = readApprovals(approvalsFile(ws, "ACME", "sess-1")).records.map((r) => `${r.kind}${r.step ? `:${r.step}` : ""}`);
  assert.deepEqual(recs, ["A1", "A2", "A3:2", "consume:2"]);
});
