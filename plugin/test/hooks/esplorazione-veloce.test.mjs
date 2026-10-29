// 28/10/2026 (decisioni dell'utente): file di ambiente scrivibili dagli agenti e ricaricati dai guard; cattura integrale
// dell'esplorazione (pagine, mappa del sito con i click, riassunto compatto); agenti di manutenzione (workspace-manager,
// health-keeper) che partono anche senza cliente attivo e senza celle di scope.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, appendFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { envWs, readSession, patchSession, browserCall, ROOT } from "../helpers/env-fixture.mjs";
import { runHook, runSessionCli, decisionOf, reasonOf, mkWs } from "../helpers/hook-env.mjs";

const DT = "mcp__chrome-devtools__";
const E = (ws) => ({ JVC_WORKSPACE: ws, CLAUDE_PLUGIN_ROOT: ROOT });
const denied = (r) => decisionOf(r) === "deny";
let seq = 0;

test("environments.yaml e remediation-scope.yaml scrivibili da sessione e sub-agenti; xray.yaml no", () => {
  const ws = envWs({ env: "sandbox", scope: "ADM" });
  const g = (file, agent) => runHook("guard-config-scope", { session_id: "sess-1", cwd: ws, hook_event_name: "PreToolUse", tool_name: "Write",
    tool_input: { file_path: join(ws, "customers/ACME/config", file), content: "x" }, ...(agent ? { agent_id: "a1", agent_type: "jaggaer-virtual-consultant:workspace-manager" } : {}) }, E(ws));
  for (const agent of [false, true]) {
    assert.ok(!denied(g("environments.yaml", agent)), reasonOf(g("environments.yaml", agent)));
    assert.ok(!denied(g("remediation-scope.yaml", agent)));
    assert.ok(denied(g("xray.yaml", agent)));
  }
});

test("environments.yaml cambiato dopo use env: i guard ricaricano l'ambiente (host nuovo valido) invece di negare; tipo cambiato ⇒ deny", () => {
  const ws = envWs({ env: "sandbox", scope: "ADM" });
  const f = join(ws, "customers/ACME/config/environments.yaml");
  const nav = (url) => browserCall("guard-environment", ws, DT + "navigate_page", { type: "url", url });
  assert.ok(denied(nav("https://nuovo.acme.it/x")), "host non ancora dichiarato");
  writeFileSync(f, readFileSync(f, "utf8").replace('"cdn.jaggaer.com"]', '"cdn.jaggaer.com", "nuovo.acme.it"]'));
  const r = nav("https://nuovo.acme.it/x");
  assert.ok(!denied(r), reasonOf(r));
  assert.ok(readSession(ws).env.allowed_hosts.includes("nuovo.acme.it"));
  assert.ok(readSession(ws).env.refreshed_at);
  writeFileSync(f, readFileSync(f, "utf8").replace("type: sandbox", "type: preprod"));
  const t = nav("https://acme-sbx.jaggaer.com/home");
  assert.ok(denied(t));
  assert.match(reasonOf(t), /tipo dell'ambiente/);
});

function explore() {
  const ws = envWs({ env: "sandbox", scope: "P2P" });
  const tr = join(mkdtempSync(join(tmpdir(), "ev-")), "t.jsonl");
  writeFileSync(tr, "");
  appendFileSync(tr, `${JSON.stringify({ type: "user", isSidechain: false, userType: "external", message: { role: "user", content: "ESPLORA SANDBOX" }, timestamp: new Date().toISOString() })}\n`);
  runHook("approval-capture", { session_id: "sess-1", cwd: ws, hook_event_name: "UserPromptSubmit", prompt: "ESPLORA SANDBOX", transcript_path: tr }, E(ws));
  assert.equal(runSessionCli(["use", "mode", "esplorazione", "--session", "sess-1"], { JVC_WORKSPACE: ws }).status, 0);
  patchSession(ws, (s) => { s.browser = { current_url: "https://acme-sbx.jaggaer.com/home", tab: null, updated_by: "browser-origin" }; });
  return ws;
}
const post = (ws, tool, ti, text) => {
  const i = { session_id: "sess-1", cwd: ws, hook_event_name: "PostToolUse", tool_name: tool, tool_input: ti, tool_use_id: `toolu_ev_${++seq}`, tool_response: [{ type: "text", text }] };
  runHook("browser-origin", i, E(ws));
  return runHook("observe-append", i, E(ws));
};
const snap = (url, title, lines) => `# take_snapshot response\n## Latest page snapshot\nuid=1_0 RootWebArea "${title}" url="${url}"\n${lines.join("\n")}\n`;

test("esplorazione: testo integrale delle pagine, mappa del sito con l'arco del click, riassunto compatto per le pagine grandi", () => {
  const ws = explore();
  const big = Array.from({ length: 600 }, (_, i) => `  uid=1_${i + 10} link "Report numero ${i} con un titolo lungo"`);
  const r1 = post(ws, DT + "take_snapshot", {}, snap("https://acme-sbx.jaggaer.com/home", "Home", [`  uid=1_1 heading "Cruscotto" level="1"`, `  uid=1_2 button "Analytics"`, ...big]));
  assert.equal(r1.status, 0, r1.stderr);
  const ctx = r1.json?.hookSpecificOutput?.additionalContext ?? "";
  assert.match(ctx, /Elementi interattivi/);
  assert.match(ctx, /1_2 button "Analytics"/);
  const dir = join(ws, "customers/ACME/explore");
  const pages = readdirSync(join(dir, "pages"));
  assert.equal(pages.length, 1);
  assert.match(readFileSync(join(dir, "pages", pages[0]), "utf8"), /Report numero 599/);
  post(ws, DT + "click", { uid: "1_2" }, "Successfully clicked");
  post(ws, DT + "take_snapshot", {}, snap("https://acme-sbx.jaggaer.com/analytics", "Analytics", [`  uid=2_1 button "New Report"`]));
  const m = JSON.parse(readFileSync(join(dir, "sitemap.json"), "utf8"));
  assert.equal(Object.keys(m.pages).length, 2);
  assert.ok(m.edges.some((e) => e.via === "Analytics"), JSON.stringify(m.edges));
  assert.ok(Object.values(m.pages).some((p) => p.elements.some(([r, n]) => r === "button" && n === "New Report")));
});

// 29/10/2026 (punto 4 del piano approvato): storia corta delle letture con hash stabile, attraverso observe-append
test("esplorazione: la stessa pagina riletta con uid nuovi ha lo stesso sha256 (changed false); un elemento in più ⇒ changed true", () => {
  const ws = explore();
  const home = (p, extra = []) => snap("https://acme-sbx.jaggaer.com/home", "Home", [`  uid=${p}_1 heading "Cruscotto" level="1"`, `  uid=${p}_2 button "Analytics"`, ...extra]);
  const page = () => Object.values(JSON.parse(readFileSync(join(ws, "customers/ACME/explore/sitemap.json"), "utf8")).pages);
  post(ws, DT + "take_snapshot", {}, home(1));
  post(ws, DT + "take_snapshot", {}, home(5));
  let [p] = page();
  assert.equal(page().length, 1);
  assert.equal(p.history.length, 2);
  assert.equal(p.history[1].sha256, p.history[0].sha256);
  assert.equal(p.changed, false);
  post(ws, DT + "take_snapshot", {}, home(9, [`  uid=9_3 button "Esporta"`]));
  [p] = page();
  assert.equal(p.history.length, 3);
  assert.equal(p.changed, true);
  assert.equal(p.history[2].elements, p.history[1].elements + 1);
});

test("fuori dall'esplorazione nessuna cattura", () => {
  const ws = envWs({ env: "sandbox", scope: "P2P" });
  patchSession(ws, (s) => { s.browser = { current_url: "https://acme-sbx.jaggaer.com/home", tab: null, updated_by: "browser-origin" }; });
  post(ws, DT + "take_snapshot", {}, snap("https://acme-sbx.jaggaer.com/home", "Home", [`  uid=1_2 button "Analytics"`]));
  assert.equal(existsSync(join(ws, "customers/ACME/explore")), false);
});

test("revisione di sicurezza: in produzione environments.yaml cambiato non si ricarica (serve /use env); host cambiati azzerano la verifica", () => {
  const ws = envWs({ env: "prod", scope: "ADM" });
  const f = join(ws, "customers/ACME/config/environments.yaml");
  appendFileSync(f, "\n# modificato\n");
  const r = browserCall("guard-environment", ws, DT + "take_snapshot", {});
  assert.ok(denied(r));
  assert.match(reasonOf(r), /produzione serve \/use env/);
  const sb = envWs({ env: "sandbox", scope: "ADM" });
  const g = join(sb, "customers/ACME/config/environments.yaml");
  writeFileSync(g, readFileSync(g, "utf8").replace('"cdn.jaggaer.com"]', '"cdn.jaggaer.com", "nuovo.acme.it"]'));
  browserCall("guard-environment", sb, DT + "take_snapshot", {});
  assert.equal(readSession(sb).env.verified, false);
});

test("revisione di sicurezza: agenti di manutenzione con session.mjs solo use customer|env|scope|show; mai node -e né budget", () => {
  const ws = envWs({ env: "sandbox", scope: "ADM" });
  const S = `${ROOT.replace(/\\/g, "/")}/scripts/admin/session.mjs`;
  const sh = (command) => runHook("guard-budget", { session_id: "sess-1", cwd: ws, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command },
    agent_id: "k1", agent_type: "jaggaer-virtual-consultant:workspace-manager" }, E(ws));
  assert.ok(!denied(sh(`node "${S}" use customer ACME --json`)));
  assert.ok(!denied(sh(`node "${S}" show --json`)));
  assert.ok(denied(sh(`node "${S}" use customer BETA --new --json`)), "cambio di cliente");
  assert.ok(denied(sh(`node "${S}" use env prod --json`)), "l'ambiente lo dichiara la sessione principale");
  assert.ok(denied(sh(`node "${S}" use scope P2P --json`)));
  // revisione di sicurezza: tokenizzazione, non regex sul testo
  assert.ok(denied(sh(`node "${S}" use customer ACME use customer BETA --json`)), "due verbi use");
  assert.ok(denied(sh(`node "${S}" use customer ACME --session altra --json`)), "--session");
  assert.ok(denied(sh(`node "${S}" use customer ACME --workspace /tmp/altro --json`)), "--workspace");
  assert.ok(denied(sh(`node "${S}" show && node "${S}" use customer BETA --new`)), "separatore");
  assert.ok(denied(sh(`JVC_WORKSPACE=/tmp/altro node "${S}" use customer ACME`)), "variabile d'ambiente");
  assert.ok(denied(sh(`node "${S}" use budget 999999999 --json`)));
  assert.ok(denied(sh(`node "${S}" use mode esplorazione --json`)));
  assert.ok(denied(sh(`node -e "import('${S}')"`)));
  // un sub-agente non invoca gli agenti di manutenzione
  const a = runHook("guard-budget", { session_id: "sess-1", cwd: ws, hook_event_name: "PreToolUse", tool_name: "Agent", agent_id: "x1",
    tool_input: { subagent_type: "jaggaer-virtual-consultant:health-keeper", prompt: "x" } }, E(ws));
  assert.ok(denied(a));
});

test("agenti di manutenzione: dispatch anche senza cliente attivo e senza header; gli altri agenti no", () => {
  const ws = mkWs();
  const a = (type) => runHook("guard-budget", { session_id: "sess-x", cwd: ws, hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: { subagent_type: type, prompt: "controlla il workspace" } }, E(ws));
  assert.ok(!denied(a("jaggaer-virtual-consultant:workspace-manager")));
  assert.ok(!denied(a("jaggaer-virtual-consultant:health-keeper")));
  assert.ok(denied(a("jaggaer-virtual-consultant:scope-expert")));
  assert.ok(denied(a("altro-plugin:health-keeper")));
});
