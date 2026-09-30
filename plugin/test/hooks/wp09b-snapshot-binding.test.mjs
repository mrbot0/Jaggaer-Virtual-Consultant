// WP09b carry 2 (WP07 security minor 1): observe-append registra lo snapshot dell'oggetto governato (session.snapshots)
// solo se la pagina osservata durante il passo ACT-CFG-CHANGE mostra l'elemento del SEL del passo; lo snapshot di
// un'altra pagina non conta come snapshot dell'oggetto.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runHook, ROOT } from "../helpers/hook-env.mjs";
import { envWs, patchSession, readSession, writePlan, writeSel, sealActivePlan } from "../helpers/env-fixture.mjs";

const P = "https://acme-sbx.jaggaer.com";
const DT = "mcp__chrome-devtools__";
const page = (path, withTarget) => `## Latest page snapshot\nuid=1_0 RootWebArea "ACME SBX" url="${P}${path}"\n  uid=1_1 heading "Setup" level="1"\n${withTarget ? '  uid=1_3 checkbox "strict_import"\n' : '  uid=1_4 link "Altra pagina"\n'}`;

test("observe-append: snapshot della pagina con l'elemento del SEL del passo ⇒ session.snapshots; pagina senza l'elemento ⇒ nessuno snapshot", () => {
  const ws = envWs({ env: "sandbox" });
  writeSel(ws, "C.ACME.ADM.SEL.0140", { role: "checkbox", effect: "write", label: "strict_import" });
  const plan = { plan_id: "PLAN.0050", customer: "ACME", env: "sandbox", goal: "strict", steps: [
    { n: 1, verb: "TOGGLE", action_class: "ACT-CFG-CHANGE", target: "C.ACME.ADM.SEL.0140", data: true, risk: "R2", config: { object: "C.ACME.ADM.CFG.0019", area: "CL-CFG-020", level: "giallo" }, expect: { value: "true" } }],
    repair_policy: { skip_allowed: [], substitute_allowed: [], abort_on: [] } };
  patchSession(ws, (s) => { s.active_plan = { plan_id: "PLAN.0050", file: writePlan(ws, plan, "RUN.ACME.20260929.1000.ADM"), step: 1, run: "RUN.ACME.20260929.1000.ADM" }; s.snapshots = []; });
  sealActivePlan(ws);
  const E = { JVC_WORKSPACE: ws, CLAUDE_PLUGIN_ROOT: ROOT, JVC_SESSION_ID: "sess-1" };
  const post = (tool, input, text) => { for (const h of ["browser-origin", "observe-append"]) runHook(h, { session_id: "sess-1", cwd: ws, hook_event_name: "PostToolUse", tool_name: DT + tool, tool_input: input, tool_response: [{ type: "text", text }] }, E); };
  post("navigate_page", { type: "url", url: `${P}/setup/other`, pageId: 1 }, `Successfully navigated to ${P}/setup/other.\n## Pages\n1: ACME SBX (${P}/setup/other) [selected]`);
  post("take_snapshot", { pageId: 1 }, page("/setup/other", false));
  assert.deepEqual(readSession(ws).snapshots, [], "pagina senza l'elemento del passo: nessuno snapshot dell'oggetto");
  post("navigate_page", { type: "url", url: `${P}/setup/import-profiles/7`, pageId: 1 }, `Successfully navigated to ${P}/setup/import-profiles/7.\n## Pages\n1: ACME SBX (${P}/setup/import-profiles/7) [selected]`);
  post("take_snapshot", { pageId: 1 }, page("/setup/import-profiles/7", true));
  const snaps = readSession(ws).snapshots;
  assert.equal(snaps.length, 1);
  assert.deepEqual(snaps[0].objects, ["C.ACME.ADM.CFG.0019"]);
  assert.equal(snaps[0].source, "observe-append");
  assert.match(snaps[0].obs, /^L\.ACME\.ADM\.OBS\.\d{4}$/);
});
