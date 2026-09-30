// Soluzione A (spec 2026-09-30 §4, E2E): esplorazione simulata (observe-append) → atlas-build → compose-plan → piano
// valido per crea ordine, senza che nessuno scriva selettori o passi a mano.
import { test } from "node:test";
import assert from "node:assert/strict";
import { envWs, patchSession, readSession, ROOT } from "../helpers/env-fixture.mjs";
import { runHook } from "../helpers/hook-env.mjs";
import { atlasBuild } from "../../scripts/kb/atlas-build.mjs";
import { composePlan } from "../../scripts/decide/compose-plan.mjs";
import { validatePlan } from "../../scripts/decide/validate-plan.mjs";

const DT = "mcp__chrome-devtools__";
const H = "https://acme-sbx.jaggaer.com";
const T = (text) => [{ type: "text", text }];
const snap = (path, title, body) => `## Latest page snapshot\nuid=1_0 RootWebArea "${title} - ACME SBX" url="${H}${path}"\n  uid=1_1 heading "${title}" level="1"\n${body}`;
const HOME = snap("/home", "Benvenuto", `  uid=1_2 link "Ordini"\n`);
const LIST = snap("/p2p/po", "Ordini", `  uid=1_2 button "Nuovo ordine"\n`);
const FORM = snap("/p2p/po/new", "Nuovo ordine", `  uid=1_2 group "Testata"\n    uid=1_3 textbox "Descrizione " required\n    uid=1_4 textbox "Centro di costo " required\n  uid=1_5 button "Salva bozza"\n`);

test("esplorazione simulata → atlas-build → compose-plan: piano valido per crea ordine", () => {
  const ws = envWs({ env: "sandbox", scope: "P2P" });
  const post = (tool, ti, resp) => runHook("observe-append", { session_id: "sess-1", cwd: ws, hook_event_name: "PostToolUse", tool_name: tool, tool_input: ti, tool_response: resp }, { JVC_WORKSPACE: ws, CLAUDE_PLUGIN_ROOT: ROOT });
  const at = (path) => patchSession(ws, (s) => { s.browser = { ...(s.browser ?? {}), current_url: `${H}${path}`, tab: "1", updated_by: "browser-origin" }; });
  at("/home"); post(`${DT}take_snapshot`, { pageId: 1 }, T(HOME));
  post(`${DT}click`, { uid: "1_2", pageId: 1 }, T("Successfully clicked on the element"));
  at("/p2p/po"); post(`${DT}take_snapshot`, { pageId: 1 }, T(LIST));
  post(`${DT}click`, { uid: "1_2", pageId: 1 }, T("Successfully clicked on the element"));
  at("/p2p/po/new"); post(`${DT}take_snapshot`, { pageId: 1 }, T(FORM));
  const b = atlasBuild({ ws, customer: "ACME", scope: "P2P", sid: "sess-1" });
  assert.ok(b.written.length > 0, JSON.stringify(b));
  const env = readSession(ws).env;
  const r = composePlan({ ws, customer: "ACME", scope: "P2P", env: { id: env.id, type: env.type }, goal: "crea ordine", data: { Descrizione: "Sedie", "Centro di costo": "IT-0442" }, planId: "PLAN.ACME.E2E.0001" });
  assert.ok(r.plan, JSON.stringify(r.gaps));
  assert.deepEqual(r.plan.steps.map((s) => s.verb), ["NAVIGATE", "CLICK", "CLICK", "FILL", "FILL", "SAVE"]);
  assert.deepEqual(validatePlan(r.plan, { env: { id: env.id, type: env.type } }).errors, []);
});
