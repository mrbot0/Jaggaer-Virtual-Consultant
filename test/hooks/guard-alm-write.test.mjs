// F0.2 — guard-alm-write (PreToolUse mcp__.*(alm|jira|atlassian).*__.*, FAIL-CLOSED) e alm-record (PostToolUse,
// fail-open): mai delete/remove/transizione verso "cancellato"; mai sovrascrivere contenuto umano (update solo su issue
// create dal plugin in questa sessione, session.alm.created[]; alm_import_results solo su esecuzioni create qui); mai un
// Incident (solo Defect, ADR-27); mai issue di tipo Test senza allow_test_issue_creation: true in config/xray.yaml
// (ADR-21); mai un payload che cita PAT/PBK/BRF/RUL, INC-/TICKET- o analysis/ (confine di dominio). Un test per divieto.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { mkWs, seedSession, runHook, decisionOf, reasonOf, ROOT } from "../helpers/hook-env.mjs";

const G = "guard-alm-write";
const ALM = "mcp__plugin_jaggaer-virtual-consultant_alm__";
const ATL = "mcp__claude_ai_Atlassian__";
const JIRA = "mcp__jira__";
const E = (ws, extra = {}) => ({ JVC_WORKSPACE: ws, CLAUDE_PLUGIN_ROOT: ROOT, ...extra });
const call = (ws, tool, tool_input, env = {}) => runHook(G, { session_id: "sess-1", cwd: ws, hook_event_name: "PreToolUse", tool_name: tool, tool_input }, E(ws, env));
const record = (ws, tool, tool_input, text, extra = {}) => runHook("alm-record", { session_id: "sess-1", cwd: ws, hook_event_name: "PostToolUse", tool_name: tool, tool_input, tool_response: [{ type: "text", text }], ...extra }, E(ws));
const denied = (r) => decisionOf(r) === "deny";
const silent = (r) => r.status === 0 && r.stdout.trim() === "";
const readSession = (ws) => JSON.parse(readFileSync(join(ws, "customers/ACME/.sessions/sess-1/session.json"), "utf8"));
function setup(created = []) { const ws = mkWs(); seedSession(ws, { extra: created.length ? { alm: { created } } : {} }); return ws; }

test("letture ALM, Jira e Atlassian ⇒ nessuna opinione", () => {
  const ws = setup();
  for (const [tool, ti] of [[ALM + "alm_get_test", { key: "NRT-1" }], [ALM + "alm_find_tests", { plan: "PLAN-1" }], [ALM + "alm_queue_status", {}],
    [ATL + "getJiraIssue", { cloudId: "x", issueIdOrKey: "PROJ-1" }], [ATL + "searchJiraIssuesUsingJql", { cloudId: "x", jql: "project = PROJ" }],
    [ATL + "getTransitionsForJiraIssue", { cloudId: "x", issueIdOrKey: "PROJ-1" }], [JIRA + "jira_get_issue", { issue_key: "PROJ-1" }], [ATL + "atlassianUserInfo", {}]]) {
    const r = call(ws, tool, ti);
    assert.ok(silent(r), `${tool} → ${r.stdout}`);
  }
});

test("divieto 1 — delete/remove/archive e transizione verso uno stato di cancellazione ⇒ deny (anche su issue create dal plugin)", () => {
  const ws = setup([{ key: "PROJ-9", kind: "defect" }]);
  for (const [tool, ti] of [[ATL + "deleteJiraIssue", { issueIdOrKey: "PROJ-9" }], [JIRA + "jira_delete_issue", { issue_key: "PROJ-9" }],
    [JIRA + "jira_remove_issue_link", { link_id: "1" }], [ATL + "archiveConfluencePage", { pageId: "1" }], [ALM + "alm_delete_execution", { key: "PROJ-9" }],
    [ATL + "transitionJiraIssue", { issueIdOrKey: "PROJ-9", transition: { id: "31", name: "Deleted" } }], [JIRA + "jira_transition_issue", { issue_key: "PROJ-9", transition: "Elimina" }],
    [ATL + "editJiraIssue", { issueIdOrKey: "PROJ-9", fields: { status: "Cancellato" } }]]) {
    const r = call(ws, tool, ti);
    assert.ok(denied(r), `${tool} ${JSON.stringify(ti)} → ${r.stdout}`);
  }
  assert.ok(silent(call(ws, ATL + "transitionJiraIssue", { issueIdOrKey: "PROJ-9", transition: { id: "21", name: "Done" } })), "transizione normale di una issue del plugin");
});

test("divieto 2 — overwrite di contenuto umano: update/transition solo su issue create dal plugin in questa sessione; alm_import_results solo su esecuzioni create qui", () => {
  const ws = setup();
  assert.ok(denied(call(ws, ATL + "editJiraIssue", { issueIdOrKey: "PROJ-1", fields: { summary: "x" } })), "issue umana");
  assert.ok(denied(call(ws, JIRA + "jira_update_issue", { issue_key: "PROJ-1", fields: "{}" })));
  assert.ok(denied(call(ws, ATL + "updateConfluencePage", { pageId: "12345", body: "x" })));
  assert.ok(denied(call(ws, ATL + "editJiraIssue", { fields: { summary: "x" } })), "bersaglio non identificabile");
  assert.ok(denied(call(ws, ALM + "alm_import_results", { executionKey: "PROJ-77", results: [] })), "esecuzione non creata dal plugin");
  // il plugin crea l'esecuzione: alm-record la registra in session.alm.created (solo con risposta riuscita)
  record(ws, ALM + "alm_create_execution", { plan: "PLAN-1" }, "errore: rete non raggiungibile", { tool_response: { isError: true, content: [{ type: "text", text: "Error" }] } });
  assert.deepEqual(readSession(ws).alm?.created ?? [], []);
  record(ws, ALM + "alm_create_execution", { plan: "PLAN-1" }, JSON.stringify({ key: "PROJ-77" }));
  record(ws, ATL + "createJiraIssue", { projectKey: "PROJ", issueTypeName: "Bug", summary: "difetto" }, JSON.stringify({ id: "10009", key: "PROJ-78", self: "https://x" }));
  const created = readSession(ws).alm.created.map((c) => c.key);
  assert.deepEqual(created, ["PROJ-77", "PROJ-78"]);
  assert.ok(silent(call(ws, ALM + "alm_import_results", { executionKey: "PROJ-77", results: [] })));
  assert.ok(silent(call(ws, ATL + "editJiraIssue", { issueIdOrKey: "PROJ-78", fields: { summary: "aggiornato" } })));
  assert.ok(denied(call(ws, ATL + "editJiraIssue", { issueIdOrKey: "PROJ-1", fields: { summary: "aggiornato" }, other: "PROJ-78" })));
  // aggiunte (commento, link) non sovrascrivono: consentite anche su issue umane
  assert.ok(silent(call(ws, ATL + "addCommentToJiraIssue", { issueIdOrKey: "PROJ-1", commentBody: "esecuzione PROJ-77 completata" })));
  assert.ok(silent(call(ws, ALM + "alm_link", { from: "PROJ-77", to: "PROJ-1", kind: "tests" })));
});

test("divieto 3 — Incident: mai (solo Defect, ADR-27); tipo non determinabile ⇒ deny", () => {
  const ws = setup();
  for (const [tool, ti] of [[ATL + "createJiraIssue", { projectKey: "SUP", issueTypeName: "Incident", summary: "x" }],
    [JIRA + "jira_create_issue", { project_key: "SUP", issue_type: "incident", summary: "x" }], [ALM + "alm_create_defect", { summary: "x", type: "Incident" }],
    [ATL + "createJiraIssue", { projectKey: "SUP", fields: { issuetype: { name: "IT Incident" } }, summary: "x" }], [JIRA + "jira_create_incident", { summary: "x" }],
    [ATL + "createJiraIssue", { projectKey: "SUP", issueTypeName: "Story", summary: "x" }], [ATL + "createJiraIssue", { projectKey: "SUP", summary: "x" }]]) {
    const r = call(ws, tool, ti);
    assert.ok(denied(r), `${tool} ${JSON.stringify(ti)} → ${r.stdout}`);
  }
  assert.match(reasonOf(call(ws, ATL + "createJiraIssue", { projectKey: "SUP", issueTypeName: "Incident", summary: "x" })), /ADR-27/);
  for (const [tool, ti] of [[ALM + "alm_create_defect", { summary: "Totale errato", description: "atteso 10, visto 12" }], [ATL + "createJiraIssue", { projectKey: "PROJ", issueTypeName: "Bug", summary: "x" }],
    [JIRA + "jira_create_issue", { project_key: "PROJ", issue_type: "Defect", summary: "x" }], [ALM + "alm_create_execution", { plan: "PLAN-1", summary: "NRT run" }]]) {
    assert.ok(silent(call(ws, tool, ti)), `${tool} ${JSON.stringify(ti)}`);
  }
});

test("divieto 4 — issue di tipo Test solo con allow_test_issue_creation: true in customers/<C>/config/xray.yaml (ADR-21)", () => {
  const ws = setup();
  const t1 = [ATL + "createJiraIssue", { projectKey: "PROJ", issueTypeName: "Test", summary: "caso" }];
  const t2 = [JIRA + "xray_create_test", { project_key: "PROJ", summary: "caso" }];
  assert.ok(denied(call(ws, ...t1)));
  assert.match(reasonOf(call(ws, ...t2)), /ADR-21/);
  mkdirSync(join(ws, "customers/ACME/config"), { recursive: true });
  writeFileSync(join(ws, "customers/ACME/config/xray.yaml"), "deployment: cloud\nallow_test_issue_creation: false\n");
  assert.ok(denied(call(ws, ...t1)));
  writeFileSync(join(ws, "customers/ACME/config/xray.yaml"), "deployment: cloud\nallow_test_issue_creation: true   # deroga concordata\n");
  assert.ok(silent(call(ws, ...t1)));
  assert.ok(silent(call(ws, ...t2)));
});

test("divieto 5 — confine di dominio: un payload che cita PAT/PBK/BRF/RUL, INC-/TICKET- o analysis/ ⇒ deny", () => {
  const ws = setup([{ key: "PROJ-9", kind: "defect" }]);
  for (const [tool, ti] of [[ALM + "alm_create_defect", { summary: "x", description: "causa in C.ACME.P2P.PAT.0003" }],
    [ALM + "alm_create_defect", { summary: "x", description: "vedi customers/ACME/analysis/patterns/x.yaml" }],
    [ATL + "addCommentToJiraIssue", { issueIdOrKey: "PROJ-1", commentBody: "collegato a INC-1234" }],
    [ATL + "editJiraIssue", { issueIdOrKey: "PROJ-9", fields: { description: "S.STD.P2P.BRF.0001" } }],
    [ALM + "alm_link", { from: "PROJ-9", to: "TICKET-77", kind: "defect" }]]) {
    const r = call(ws, tool, ti);
    assert.ok(denied(r), `${tool} ${JSON.stringify(ti)} → ${r.stdout}`);
    assert.match(reasonOf(r), /dominio/);
  }
});

test("operazione ALM non classificata ⇒ deny; eccezione ⇒ deny; ogni deny in audit; inerte fuori da un workspace JVC e su server non ALM", () => {
  const ws = setup();
  assert.ok(denied(call(ws, ATL + "frobnicateJiraThing", { x: 1 })));
  assert.ok(denied(call(ws, ALM + "alm_get_test", { key: "NRT-1" }, { JVC_TEST_THROW: "1" })));
  const audit = readdirSync(join(ws, "customers/ACME/audit")).flatMap((f) => readFileSync(join(ws, "customers/ACME/audit", f), "utf8").trim().split("\n")).map((l) => JSON.parse(l));
  assert.ok(audit.some((e) => e.actor === "hook:guard-alm-write" && e.payload.decision === "deny"));
  assert.ok(silent(call(ws, "mcp__palmtree__delete_everything", {})), "server non ALM (il matcher è largo, il guard ricontrolla)");
  const plain = join(mkWs("p-"), "..", `nojvc-${process.pid}-${Date.now()}`);
  mkdirSync(plain, { recursive: true });
  assert.ok(silent(runHook(G, { session_id: "s", cwd: plain, hook_event_name: "PreToolUse", tool_name: ATL + "deleteJiraIssue", tool_input: { issueIdOrKey: "X-1" } }, E(plain))));
  // senza cliente attivo: letture sì, scritture no
  const nc = mkWs();
  seedSession(nc, { customer: null });
  assert.ok(silent(call(nc, ALM + "alm_get_test", { key: "NRT-1" })));
  assert.ok(denied(call(nc, ALM + "alm_create_defect", { summary: "x" })));
});
