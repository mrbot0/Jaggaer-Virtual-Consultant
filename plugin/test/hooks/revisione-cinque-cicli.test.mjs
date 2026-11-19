// 19/11/2026 (unione dei cinque cicli di bug fixing): rilievi della revisione automatica di sicurezza sulle correzioni dei
// cicli 2 e 4, ciascuno riprodotto:
//  1. config-scope: il prefisso di una worktree (.claude/worktrees/<nome>) e la radice del plugin si toglievano anche con una
//     risalita (`…/worktrees/../settings.json`, `<plugin>/../../settings.json`) ⇒ impostazioni vere non riconosciute;
//  2. config-scope: .claude/plugins si toglieva per ogni comando senza primitive di scrittura NOTE ⇒ uno scrittore non
//     elencato (ex, vim -c, python senza interprete riconosciuto…) passava;
//  3. guard-budget: il controllo dell'interprete sostituiva le virgolette con spazi ⇒ n"o"de, no\de, n^ode con un jolly
//     su session.mjs non erano riconosciuti;
//  4. mcp-allowlist: server interi dell'app desktop (ccd_session con spawn_task, ccd_directory) — coperto in
//     ciclo2-browser.test.mjs «ciclo 3 (4)»;
//  5. backcheck: `/s+/g` al posto di `/\s+/g` toglieva le «s» dal testo delle affermazioni libere; un'affermazione libera
//     senza termini verificabili passava come «parziale».
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFileSync, mkdtempSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { runHook, runSessionCli, decisionOf, reasonOf, cleanEnv, ROOT } from "../helpers/hook-env.mjs";
import { envWs } from "../helpers/env-fixture.mjs";
import { shellSegments, readOnlyShell } from "../../hooks/lib/guards/common.mjs";
import { backcheck, claimsOf } from "../../scripts/kb/backcheck.mjs";

const E = (ws) => ({ JVC_WORKSPACE: ws, CLAUDE_PLUGIN_ROOT: ROOT });

function explore(env = "sandbox") {
  const ws = envWs({ env, scope: "ADM" });
  const tr = join(mkdtempSync(join(tmpdir(), "rev5-")), "t.jsonl");
  const phrase = env === "preprod" ? "ESPLORA PREPROD" : "ESPLORA SANDBOX";
  writeFileSync(tr, `${JSON.stringify({ type: "user", isSidechain: false, userType: "external", message: { role: "user", content: phrase }, timestamp: new Date().toISOString() })}\n`);
  runHook("approval-capture", { session_id: "sess-1", cwd: ws, hook_event_name: "UserPromptSubmit", prompt: phrase, transcript_path: tr }, E(ws));
  const r = runSessionCli(["use", "mode", "esplorazione", "--session", "sess-1"], { JVC_WORKSPACE: ws });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  return { ws, tr };
}

test("shellSegments: il nome del comando come lo esegue la shell; separatori fra virgolette ignorati; sostituzioni ⇒ null", () => {
  assert.deepEqual(shellSegments(`ls raw | grep -E "00(3[7-9]|4[0-2])"`), [["ls", "raw"], ["grep", "-E", "00(3[7-9]|4[0-2])"]]);
  assert.equal(shellSegments(`n"o"de x.mjs`)[0][0], "node");
  assert.equal(shellSegments("no\\de x.mjs")[0][0], "node");
  assert.equal(shellSegments("n^ode x.mjs")[0][0], "node");
  assert.deepEqual(shellSegments("ls 2>&1 | head -n 5"), [["ls"], ["head", "-n", "5"]]);
  assert.deepEqual(shellSegments("cat a > b"), [["cat", "a"]]);
  for (const c of ["echo $(node x)", "echo `node x`", `echo "$(node x)"`, "cat <(node x)", `echo "aperta`]) assert.equal(shellSegments(c), null, c);
  assert.equal(readOnlyShell("ls x && cat y | wc -l"), true);
  for (const c of ["./ls x", "find . -exec node {} ;", "rg --pre node x", "sort --compress-program=node x", "env node x", "FOO=1 ls", "xargs node"]) assert.equal(readOnlyShell(c), false, c);
});

test("guard-budget: un interprete mascherato da virgolette o escape con un jolly su session.mjs è negato; le letture con jolly restano libere", () => {
  const S = explore("sandbox");
  const ag = { agent_id: "ag-1", agent_type: "jaggaer-virtual-consultant:scope-expert" };
  const g = (command) => runHook("guard-budget", { session_id: "sess-1", cwd: S.ws, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, ...ag }, E(S.ws));
  for (const c of [`n"o"de scripts/admin/sess*.mjs use scope ADM`, "no\\de scripts/admin/sess*.mjs show", "n^ode scripts/admin/sess*.mjs show", `"node" scripts/admin/se?sion.mjs show`,
    "env node scripts/admin/sess*.mjs show", "rg --pre node x scripts/admin/sess*", "echo $(ls scripts/admin/sess*)"]) {
    assert.equal(decisionOf(g(c)), "deny", c);
  }
  for (const c of ["wc -c customers/ACME/_inbox/CAT/raw/*", `ls customers/ACME/_inbox/CAT/raw | grep -E "00(3[7-9]|4[0-2])"`]) {
    const r = g(c);
    assert.equal(decisionOf(r), null, `${c}: ${reasonOf(r)}`);
  }
});

test("config-scope: con una risalita nessun prefisso si toglie (worktree, radice del plugin); .claude/plugins solo per comandi di sola lettura", async () => {
  const { decide } = await import("../../hooks/lib/guards/config-scope.mjs");
  const S = explore("sandbox");
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), "rev5-home-")));
  const P = join(home, ".claude", "plugins", "cache", "jaggaer-vc", "jaggaer-virtual-consultant", "3.2.0");
  mkdirSync(join(P, "scripts"), { recursive: true });
  const h = home.replace(/\\/g, "/");
  const p = P.replace(/\\/g, "/");
  const wt = `${h}/repo/.claude/worktrees/agent-1`;
  const env = { ...cleanEnv(), JVC_WORKSPACE: S.ws, CLAUDE_PLUGIN_ROOT: P };
  const sh = (command) => decide({ session_id: "sess-1", cwd: S.ws, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, transcript_path: S.tr }, env);
  const d = (r) => r?.hookSpecificOutput?.permissionDecision ?? null;
  const why = (r) => r?.hookSpecificOutput?.permissionDecisionReason ?? "";
  for (const c of [`cat "${wt}/../../settings.json"`, `cat "${h}/repo/.claude/worktrees/../settings.json"`, `echo {} > "${wt}/../../settings.local.json"`,
    `cat "${p}/../../../../../settings.json"`, `ex -sc "wq" "${h}/.claude/plugins/installed_plugins.json"`, `vim -es -c wq "${h}/.claude/plugins/known_marketplaces.json"`]) {
    assert.equal(d(sh(c)), "deny", c);
  }
  // restano libere le letture vere
  for (const c of [`cat "${wt}/plugin/hooks/hooks.json"`, `ls "${h}/.claude/plugins/cache"`, `cat "${h}/.claude/plugins/installed_plugins.json" | head -n 5`]) {
    const r = sh(c);
    assert.equal(d(r), null, `${c}: ${why(r)}`);
  }
});

test("backcheck: il testo di un'affermazione libera conserva le «s»; senza termini verificabili non è supportata", () => {
  const item = { id: "C.ACME.XSC.REQ.0001", type: "XXX", claims: [{ attribute: "claim", text: "sessione scaduta dopo trenta minuti", units: ["U.DOC0001.0001"] }, { attribute: "vuota", text: "si", units: ["U.DOC0001.0001"] }] };
  const claims = claimsOf(item);
  assert.equal(claims[0].text, "sessione scaduta dopo trenta minuti");
  const r = backcheck(item, () => "La sessione è scaduta dopo trenta minuti di inattività");
  const v = Object.fromEntries(r.results.map((x) => [x.attribute, x.verdict]));
  assert.equal(v.claim, "supportata", JSON.stringify(r.results));
  assert.equal(v.vuota, "non-supportata", "un'affermazione libera senza termini verificabili resta bloccata");
  assert.equal(r.blocked, true);
});

// Decisione dell'utente («in prep non vogliamo più blocchi sui click solo sulle cancellazioni»): il divieto WP08 sugli
// effetti del browser di Claude fuori dalla sandbox non vale più nell'esplorazione senza piano (capacità
// browser_claude_fuori_sandbox del profilo esplorazione); resta in modalità standard, nei piani e in produzione.
test("browser di Claude in pre-produzione: in esplorazione il click passa e «Elimina» è negato; fuori dall'esplorazione resta negato", () => {
  const CL = "mcp__Claude_Browser__";
  const PRE = "https://acme-pre.jaggaer.com";
  const tab = (t, url) => `${t}\n\nTab Context:\n- Executed on tabId: 101\n- Available tabs:\n  • tabId 101: "ACME" (${url})`;
  let n = 0;
  const run = (S) => ({
    post: (tool, tool_input, text) => {
      const i = { session_id: "sess-1", cwd: S.ws, hook_event_name: "PostToolUse", tool_name: tool, tool_input, tool_use_id: `toolu_rev5_${++n}`, tool_response: [{ type: "text", text }] };
      runHook("browser-origin", i, E(S.ws));
      runHook("observe-append", i, E(S.ws));
    },
    pre: (tool, tool_input) => runHook("pre-dispatch", { session_id: "sess-1", cwd: S.ws, hook_event_name: "PreToolUse", tool_name: tool, tool_input, tool_use_id: `toolu_rev5_${++n}`, transcript_path: S.tr }, E(S.ws)),
  });
  const page = (h) => {
    h.post(CL + "navigate", { url: `${PRE}/home`, tabId: 101 }, tab(`Navigated to ${PRE}/home`, `${PRE}/home`));
    h.post(CL + "read_page", { tabId: 101 }, tab(`heading "Cruscotto" [ref_1]\nbutton "Analytics" [ref_2]\nbutton "Elimina" [ref_3]`, `${PRE}/home`));
  };
  const X = run(explore("preprod"));
  page(X);
  const ok = X.pre(CL + "computer", { action: "left_click", ref: "ref_2", tabId: 101 });
  assert.equal(decisionOf(ok), null, reasonOf(ok));
  assert.equal(decisionOf(X.pre(CL + "computer", { action: "left_click", ref: "ref_3", tabId: 101 })), "deny", "le cancellazioni restano negate");
  const ws = envWs({ env: "preprod", scope: "ADM" });
  const tr = join(mkdtempSync(join(tmpdir(), "rev5-nrt-")), "t.jsonl");
  writeFileSync(tr, "");
  const N = run({ ws, tr });
  page(N);
  const no = N.pre(CL + "computer", { action: "left_click", ref: "ref_2", tabId: 101 });
  assert.equal(decisionOf(no), "deny");
  assert.match(reasonOf(no), /browser di Claude/);
});

test("subagent-trace: lo stop di un agente che non è del plugin non apre voci vuote nel ledger; un agente del plugin sì", async () => {
  const { readSession } = await import("../helpers/env-fixture.mjs");
  const ws = envWs({ env: "sandbox", scope: "ADM" });
  const stop = (agent_id, agent_type) => runHook("subagent-trace", { session_id: "sess-1", cwd: ws, hook_event_name: "SubagentStop", agent_id, agent_type, last_assistant_message: "fatto" }, E(ws));
  const count = () => (readSession(ws).ledger?.invocations ?? []).length;
  const before = count();
  stop("estraneo-1", null);
  stop("estraneo-2", "general-purpose");
  assert.equal(count(), before, "nessuna voce per gli agenti estranei");
  stop("foglia-1", "jaggaer-virtual-consultant:scope-expert");
  assert.equal(count(), before + 1, "l'agente del plugin resta tracciato");
});

test("redazione: un orario dopo una data e le dimensioni in byte non sono telefoni; i telefoni veri restano mascherati; segreti d'ambiente sostituiti", async () => {
  const { redactText } = await import("../../scripts/chrome/redact.mjs");
  const keep = (t) => assert.equal(redactText(t, { env: {} }).text, t, t);
  keep("Scansione 2026-09-09 161136.pdf");
  keep("dimensione 345678901 byte");
  for (const t of ["chiamare il 347 123 4567", "ufficio 06 12345678", "+39 06 1234 5678"]) assert.match(redactText(t, { env: {} }).text, /\[tel\]/, t);
  const r = redactText("chiave sk-ABCDEFGH1234 nel log, ancora sk-ABCDEFGH1234", { env: { NRT_SBX_PASSWORD: "sk-ABCDEFGH1234" } });
  assert.equal(r.text, "chiave [segreto] nel log, ancora [segreto]");
  assert.ok(r.masks.includes("env"));
});

test("learn tickets: intestazioni tipiche degli export ServiceNow e Jira riconosciute", async () => {
  const { mapColumns } = await import("../../scripts/analysis/ticket-import.mjs");
  const sn = mapColumns(["Number", "Short description", "State", "Close notes", "Opened at", "Caller", "Configuration item"]);
  for (const k of ["id", "summary", "status", "resolution", "created", "reporter", "module"]) assert.ok(sn[k] !== undefined, `ServiceNow: ${k}`);
  const jira = mapColumns(["Issue key", "Summary", "Status", "Resolution", "Component/s", "Created", "Reporter", "Assignee"]);
  for (const k of ["id", "summary", "status", "resolution", "module", "created", "reporter", "assignee"]) assert.ok(jira[k] !== undefined, `Jira: ${k}`);
});
