// K5 — criterio di uscita M6: 3A end-to-end su un tenant demo simulato (§52.2).
// use env prod → env-check (impronta della pagina demo) → piano validato con
// approvals: 3A → A1 (M. Rossi) → A2 (L. Bianchi) → A3 per passo → i tre guard del
// browser consentono il passo approvato una volta sola; il passo senza A3 è
// negato; una scrittura di dati in prod è negata; catena delle approvazioni e
// audit verificati.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { copyFileSync, mkdirSync, writeFileSync, mkdtempSync, appendFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import YAML from "yaml";
import { mkWs, seedSession, runHook, runSessionCli, decisionOf, reasonOf, cleanEnv, ROOT } from "../helpers/hook-env.mjs";
import { browserCall, patchSession, readSession, writePlan, writeSel, navResponse, sealActivePlan } from "../helpers/env-fixture.mjs";
import { approvalsFile, readApprovals } from "../../scripts/admin/approvals.mjs";
import { validatePlan } from "../../scripts/decide/validate-plan.mjs";
import { verifyChain, auditFile } from "../../hooks/lib/audit.mjs";

const PLAN = "PLAN.DEMO.0001";
const GUARDS = ["guard-environment", "guard-production", "guard-config-scope"];
const E = (ws) => ({ JVC_WORKSPACE: ws, CLAUDE_PLUGIN_ROOT: ROOT });
const node = (script, args, ws) => spawnSync(process.execPath, [join(ROOT, script), ...args], { encoding: "utf8", env: cleanEnv(E(ws)) });

test("M6 — 3A end-to-end sul tenant demo: A1 → A2 → A3 per passo → passi consentiti una volta; catena delle approvazioni verificata", () => {
  // tenant demo: cliente ACME, ambiente prod dichiarato e verificato dall'impronta
  const ws = mkWs(); seedSession(ws, { scope: "ADM" });
  mkdirSync(join(ws, "customers/ACME/config"), { recursive: true });
  copyFileSync(join(ROOT, "test/fixtures/env/environments.yaml"), join(ws, "customers/ACME/config/environments.yaml"));
  writeFileSync(join(ws, "customers/ACME/config/remediation-scope.yaml"), YAML.stringify({ levels: { giallo: { areas: ["CL-CFG-020"], objects: ["C.ACME.ADM.CFG.0019"] } } }));
  assert.equal(runSessionCli(["use", "env", "prod", "--session", "sess-1"], E(ws)).status, 0);
  const chk = node("scripts/chrome/env-check.mjs", ["--customer", "ACME", "--env", "prod", "--snapshot", join(ROOT, "test/fixtures/env/pages/prod.json"), "--write-session", "--session", "sess-1", "--json"], ws);
  assert.equal(chk.status, 0, chk.stdout + chk.stderr);
  assert.equal(readSession(ws).env.verified, true);

  // piano di configurazione (CL-CFG-020 strict_import), validato contro catalogo e ambiente
  writeSel(ws, "C.ACME.ADM.SEL.0140", { role: "checkbox", effect: "write", label: "strict_import" });
  writeSel(ws, "C.ACME.ADM.SEL.0120", { role: "button", effect: "write", label: "Salva" });
  const cfg = { object: "C.ACME.ADM.CFG.0019", area: "CL-CFG-020", level: "giallo" };
  const plan = {
    plan_id: PLAN, customer: "ACME", env: "prod", goal: "Attivare strict_import sul profilo di import catalogo", approvals: "3A",
    steps: [
      { n: 1, verb: "NAVIGATE", action_class: "ACT-OBS", target: "S.STD.ADM.SEL.0102", expect: { page_sig: "adm/setup/import-profiles" } },
      { n: 2, verb: "TOGGLE", action_class: "ACT-CFG-CHANGE", target: "C.ACME.ADM.SEL.0140", data: true, risk: "R2", config: cfg, expect: { value: true } },
      { n: 3, verb: "SAVE", action_class: "ACT-CFG-CHANGE", target: "C.ACME.ADM.SEL.0120", risk: "R2", config: cfg, expect: { toast: "S.STD.ADM.SEL.0121" } },
    ],
    repair_policy: { skip_allowed: [], substitute_allowed: [], abort_on: [2, 3] },
  };
  assert.deepEqual(validatePlan(plan, { env: { id: "prod", type: "prod" } }).errors, []);
  const file = writePlan(ws, plan, "RUN.DEMO.0001");
  // step-check (K6) attiva il piano e chiede A1: qui lo si simula scrivendo lo stato
  patchSession(ws, (s) => { s.active_plan = { plan_id: PLAN, file, step: 1 }; s.pending.approvals = [{ kind: "A1", plan: PLAN, file }]; });
  // WP07 giro 1: impronta del piano e ultimo snapshot osservato (uid → SEL), come li scrivono step-check e observe-append
  sealActivePlan(ws, { url: "https://acme.jaggaer.com/setup/import-profiles", refs: { "4_12": "C.ACME.ADM.SEL.0140", "4_20": "C.ACME.ADM.SEL.0120", "9_1": "C.ACME.ADM.SEL.0120" } });

  const tr = join(mkdtempSync(join(tmpdir(), "demo-tr-")), "sess-1.jsonl");
  writeFileSync(tr, "");
  const say = (prompt) => {
    // riga del transcript come la scrive Claude Code per un prompt dell'utente
    appendFileSync(tr, `${JSON.stringify({ type: "user", isSidechain: false, userType: "external", message: { role: "user", content: prompt }, timestamp: new Date().toISOString() })}\n`);
    const r = runHook("approval-capture", { session_id: "sess-1", cwd: ws, hook_event_name: "UserPromptSubmit", prompt, transcript_path: tr }, E(ws));
    return r.json?.hookSpecificOutput?.additionalContext ?? "";
  };
  // ciclo di vita completo di una chiamata: i tre guard PreToolUse; se nessuno nega, la chiamata
  // "riesce" e il PostToolUse browser-origin registra l'origine (giro 2, N1); WP07 giro 5: come in Claude Code, sulla
  // stessa chiamata corre anche observe-append (senza, la chiamata resta "non osservata" e i guard non legano: regola 5)
  const guards = (tool, input, order = GUARDS) => {
    const res = order.map((g) => ({ g, r: browserCall(g, ws, tool, input, { transcript_path: tr }) }));
    if (res.every(({ r }) => r.status === 0 && r.stdout.trim() === "")) {
      const post = { session_id: "sess-1", cwd: ws, hook_event_name: "PostToolUse", tool_name: tool, tool_input: input, tool_response: typeof input.url === "string" ? navResponse(tool, input.url) : [{ type: "text", text: "ok" }] };
      runHook("browser-origin", post, E(ws));
      runHook("observe-append", post, E(ws));
    }
    return res;
  };
  const allSilent = (res) => res.every(({ r }) => r.status === 0 && r.stdout.trim() === "");
  const denyOf = (res) => res.filter(({ r }) => decisionOf(r) === "deny").map(({ g, r }) => `${g}: ${reasonOf(r)}`);
  const snapshot = () => patchSession(ws, (s) => { s.snapshots = [{ objects: ["C.ACME.ADM.CFG.0019"], ts: new Date().toISOString() }]; });

  // passo 1: osservare (nessuna approvazione necessaria)
  assert.ok(allSilent(guards("mcp__chrome-devtools__navigate_page", { url: "https://acme.jaggaer.com/setup/import-profiles" })));
  assert.ok(allSilent(guards("mcp__chrome-devtools__take_snapshot", {})));

  // A1 → A2 (persona diversa) → A3 passo 2
  assert.match(say("ok procedi"), /Approvazione non valida/);
  assert.match(say("APPROVO PIANO PLAN.DEMO.0001 DA Mario Rossi"), /registrata: A1/);
  assert.match(say("APPROVO PROVA PLAN.DEMO.0001 DA Mario Rossi"), /persona diversa/);
  assert.match(say("APPROVO PROVA PLAN.DEMO.0001 DA Luca Bianchi"), /registrata: A2/);
  patchSession(ws, (s) => { s.active_plan.step = 2; });
  snapshot();
  const noToken = guards("mcp__chrome-devtools__click", { uid: "4_12" });
  assert.ok(denyOf(noToken).some((d) => /APPROVO PASSO 2/.test(d)), denyOf(noToken).join("\n"));
  assert.match(say("APPROVO PASSO 2 PLAN.DEMO.0001"), /registrata: A3 PLAN\.DEMO\.0001 passo 2/);

  // passo 2 consentito dai tre guard, una volta sola
  const ok2 = guards("mcp__chrome-devtools__click", { uid: "4_12" });
  assert.ok(allSilent(ok2), denyOf(ok2).join("\n"));
  assert.ok(allSilent(guards("mcp__chrome-devtools__navigate_page", { url: "https://acme.jaggaer.com/setup/import-profiles" })));
  const again = guards("mcp__chrome-devtools__click", { uid: "4_12" });
  assert.ok(denyOf(again).some((d) => d.startsWith("guard-config-scope") && /già stato usato|APPROVO PASSO 2/.test(d)), "token monouso");

  // passo 3: senza A3 negato; con A3 consentito (ordine inverso dei guard: consumo e verifica paralleli)
  patchSession(ws, (s) => { s.active_plan.step = 3; });
  snapshot();
  assert.ok(denyOf(guards("mcp__chrome-devtools__click", { uid: "4_20" })).length >= 2);
  assert.match(say("APPROVO PASSO 3 PLAN.DEMO.0001"), /registrata: A3/);
  // WP07 giro 1 (I3): un click senza marcatore rende ignota la pagina anche per browser-origin ⇒ si torna
  // sulla pagina con un navigate (o uno snapshot, in observe-append) prima dell'azione successiva
  assert.ok(allSilent(guards("mcp__chrome-devtools__navigate_page", { url: "https://acme.jaggaer.com/setup/import-profiles" })));
  const ok3 = guards("mcp__chrome-devtools__click", { uid: "4_20" }, ["guard-config-scope", "guard-environment", "guard-production"]);
  assert.ok(allSilent(ok3), denyOf(ok3).join("\n"));

  // una scrittura di dati in prod resta negata anche dentro la finestra 3A
  const createPlan = { ...plan, plan_id: "PLAN.DEMO.0002", steps: [{ n: 1, verb: "SAVE", action_class: "ACT-CREATE", target: "C.ACME.ADM.SEL.0120", expect: { x: 1 } }] };
  assert.equal(validatePlan(createPlan, { env: { id: "prod", type: "prod" } }).ok, false);
  patchSession(ws, (s) => { s.active_plan = { plan_id: "PLAN.DEMO.0002", file: writePlan(ws, createPlan, "RUN.DEMO.0002"), step: 1 }; s.pending.compensations = [{ plan: "PLAN.DEMO.0002", step: 1, kind: "cancel" }]; });
  { const snapKeep = readSession(ws).browser.snapshot; sealActivePlan(ws); patchSession(ws, (s) => { s.browser.snapshot = snapKeep; }); }
  const w = guards("mcp__chrome-devtools__click", { uid: "9_1" });
  assert.ok(denyOf(w).some((d) => /In produzione non si scrivono dati/.test(d)));

  // catena delle approvazioni e audit
  const f = approvalsFile(ws, "ACME", "sess-1");
  assert.equal(verifyChain(f).ok, true);
  const recs = readApprovals(f).records;
  assert.deepEqual(recs.map((r) => `${r.kind}${r.step ? `:${r.step}` : ""}`), ["A1", "A2", "A3:2", "consume:2", "A3:3", "consume:3"]);
  assert.equal(recs[0].approver_declared, "Mario Rossi");
  assert.equal(recs[1].approver_declared, "Luca Bianchi");
  assert.equal(node("scripts/admin/approvals.mjs", ["verify", "--session", "sess-1", "--json"], ws).status, 0);
  assert.equal(verifyChain(auditFile(ws, "ACME")).ok, true);
  const audit = readFileSync(auditFile(ws, "ACME"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(audit.filter((e) => e.actor === "hook:approval-capture").length >= 5);
  assert.ok(audit.some((e) => e.actor === "hook:guard-config-scope" && e.payload.decision === "allow"));
  assert.ok(audit.some((e) => e.actor === "hook:guard-production" && e.payload.decision === "deny"));
  console.log(`3A demo: approvazioni ${recs.map((r) => r.kind).join(" → ")} · audit ${audit.length} eventi, catene integre`);
});
