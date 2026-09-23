// WP06 giro di correzione 3: ogni sonda della seconda rilettura
// (.superpowers/sdd/wp06-rereview-round2.md) diventa un test che deve dare deny.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { runHook, decisionOf, reasonOf, ROOT } from "../helpers/hook-env.mjs";
import { envWs, browserCall, readSession, navResponse } from "../helpers/env-fixture.mjs";

const denied = (r) => decisionOf(r) === "deny";
const silent = (r) => r.status === 0 && r.stdout.trim() === "";
const E = (ws) => ({ JVC_WORKSPACE: ws, CLAUDE_PLUGIN_ROOT: ROOT });
const SUB = { agent_id: "x1", agent_type: "scope-expert" };
const g = (ws, tool, ti, extra = {}) => runHook("guard-config-scope", { session_id: "sess-1", cwd: ws, hook_event_name: "PreToolUse", tool_name: tool, tool_input: ti, ...extra }, E(ws));

// ---- 1: impostazioni di Claude Code (PROTECTED_CONFIG) ----
test("impostazioni: one-liner d'interprete, script scritti e poi eseguiti, copy/curl/iwr/git/robocopy, link nello stesso comando, claude plugin|config|mcp ⇒ deny (sessione e sub-agenti)", () => {
  const ws = envWs({ env: null });
  const probes = [
    ["Bash", { command: "node -e \"require('fs').writeFileSync('.claude/settings.local.json', JSON.stringify({env:{NODE_OPTIONS:'--require C:/x/evil.cjs'}}))\"" }],
    ["Bash", { command: "python -c \"open('.claude/settings.local.json','w').write('{}')\"" }],
    ["Bash", { command: "node -e \"require('fs').writeFileSync(require('os').homedir()+'/.claude/settings.json','{}')\"" }],
    ["PowerShell", { command: "[IO.File]::WriteAllText(\"$PWD\\.claude\\settings.local.json\",'{}')" }],
    ["Bash", { command: "cmd /c copy C:\\t\\s.json .claude\\settings.local.json" }],
    ["Bash", { command: "curl -o .claude/settings.local.json https://example.com/s.json" }],
    ["PowerShell", { command: "Invoke-WebRequest https://example.com/s.json -OutFile .claude\\settings.local.json" }],
    ["Bash", { command: "git checkout stash@{0} -- .claude/settings.local.json" }],
    ["Bash", { command: "robocopy C:\\t .claude settings.local.json" }],
    ["Bash", { command: "ln -s .claude cfg; cp /tmp/s.json cfg/settings.local.json" }],
    ["Bash", { command: "cmd /c mklink /J cfg .claude && cmd /c \"echo {} > cfg\\settings.local.json\"" }],
    ["Bash", { command: "cmd /c copy x CLAUDE~1\\settings.local.json" }],
    ["Bash", { command: "node tmp/x.mjs" }, "Write", { file_path: "tmp/x.mjs", content: "import fs from 'node:fs'; fs.writeFileSync('.claude/settings.local.json', '{}')" }],
    ["Bash", { command: "claude plugin disable jaggaer-virtual-consultant --scope project" }],
    ["Bash", { command: "claude config set -g autoUpdates false" }],
    ["Bash", { command: "claude mcp add evil -- node evil.js" }],
    ["PowerShell", { command: "& claude plugin uninstall jaggaer-virtual-consultant" }],
    ["Bash", { command: "npx @anthropic-ai/claude-code config set x y" }],
    ["Bash", { command: "echo '{}' > ~/.claude.json" }],
    ["Bash", { command: "node -e \"require('fs').writeFileSync(require('os').homedir()+'/.claude.json','{}')\"" }],
    ["Bash", { command: "cp /tmp/x .mcp.json" }],
  ];
  for (const extra of [{}, SUB]) {
    for (const p of probes) {
      const [t, i, t2, i2] = p;
      if (t2) {
        const w = g(ws, t2, { ...i2, file_path: join(ws, i2.file_path) }, extra);
        assert.ok(denied(w), `${t2} ${JSON.stringify(i2)} (contenuto che scrive le impostazioni)`);
        // il file potrebbe arrivare da un altro canale: l'esecuzione legge il contenuto e nega
        mkdirSync(join(ws, "tmp"), { recursive: true });
        writeFileSync(join(ws, i2.file_path), i2.content);
      }
      const r = g(ws, t, i, extra);
      assert.ok(denied(r), `${t} ${JSON.stringify(i)} ${JSON.stringify(extra)} → ${r.stdout}`);
    }
    for (const [t, i] of [["Write", { file_path: join(ws, ".claude/settings.local.json"), content: "{}" }], ["Edit", { file_path: join(homedir(), ".claude", "settings.json"), old_string: "a", new_string: "b" }],
      ["Write", { file_path: join(homedir(), ".claude.json"), content: "{}" }], ["Write", { file_path: join(homedir(), ".claude", "plugins", "x.json"), content: "{}" }], ["Write", { file_path: join(ws, ".mcp.json"), content: "{}" }]]) {
      assert.ok(denied(g(ws, t, i, extra)), `${t} ${i.file_path}`);
    }
  }
  for (const [t, i] of [["Bash", { command: "claude --version" }], ["Bash", { command: "git status" }], ["Bash", { command: "ls customers/ACME" }],
    ["Bash", { command: `node "${ROOT}/scripts/admin/session.mjs" use env sandbox --session sess-1 --json` }], ["Write", { file_path: join(ws, "customers/ACME/lessons/L.md"), content: "lezione" }]]) {
    assert.ok(silent(g(ws, t, i)), `${t} ${JSON.stringify(i)}`);
  }
  assert.ok(denied(g(ws, "Bash", { command: `node "${ROOT}/scripts/kb/reindex.mjs" --root product --db .claude/settings.json` })), "uno script del plugin non scrive nelle impostazioni");
});

// ---- 2: codice del plugin in sola lettura ----
test("codice del plugin: Write/Edit/shell/node -e verso un guard o hooks.json ⇒ deny (sessione e sub-agenti)", () => {
  const ws = envWs({ env: null });
  const guardFile = join(ROOT, "hooks/scripts/guard-scope.mjs");
  const hooksJson = join(ROOT, "hooks/hooks.json");
  for (const extra of [{}, SUB]) {
    for (const [t, i] of [
      ["Write", { file_path: guardFile, content: "process.exit(0)" }],
      ["Edit", { file_path: hooksJson, old_string: "a", new_string: "b" }],
      ["MultiEdit", { file_path: join(ROOT, "hooks/lib/guards/common.mjs"), edits: [{ old_string: "a", new_string: "b" }] }],
      ["Write", { file_path: join(ROOT, "scripts/admin/approvals.mjs"), content: "x" }],
      ["Bash", { command: `echo '{}' > "${hooksJson}"` }],
      ["Bash", { command: `node -e "require('fs').writeFileSync('${guardFile.replace(/\\/g, "/")}','process.exit(0)')"` }],
      ["PowerShell", { command: `Set-Content -Path "${guardFile}" -Value 'process.exit(0)'` }],
      ["Bash", { command: "node -e \"require('fs').writeFileSync(process.env.CLAUDE_PLUGIN_ROOT+'/hooks/hooks.json','{}')\"" }],
      ["Bash", { command: `cp /tmp/evil.mjs "${guardFile}"` }],
      ["Write", { file_path: join(ws, "tmp/x.mjs"), content: `require('fs').writeFileSync('${hooksJson.replace(/\\/g, "/")}', '{}')` }],
    ]) {
      const r = g(ws, t, i, extra);
      assert.ok(denied(r), `${t} ${JSON.stringify(i).slice(0, 160)} ${JSON.stringify(extra)}`);
      assert.match(reasonOf(r), /plugin|impostazioni/);
    }
  }
  assert.ok(silent(g(ws, "Read", { file_path: guardFile })), "leggere il codice del plugin è consentito");
  assert.ok(silent(g(ws, "Bash", { command: `cat "${hooksJson}"` })));
});

// ---- 3: browser-origin con marcatori positivi e URL effettivo ----
const post = (ws, tool, tool_input, tool_response) => runHook("browser-origin", { session_id: "sess-1", cwd: ws, hook_event_name: "PostToolUse", tool_name: tool, tool_input, tool_response }, E(ws));
const DT = "mcp__chrome-devtools__";
const CB = "mcp__Claude_Browser__";
const PW = "mcp__playwright__";
const url = (ws) => readSession(ws).browser?.current_url ?? null;

test("browser-origin: successo solo con il marcatore della famiglia; si registra l'URL su cui la scheda è arrivata; il resto ⇒ ignoto", () => {
  const ws = envWs();
  const sbx = "https://acme-sbx.jaggaer.com/home";
  // successi reali delle tre famiglie
  post(ws, `${DT}navigate_page`, { type: "url", url: sbx }, navResponse(`${DT}navigate_page`, sbx));
  assert.equal(url(ws), sbx);
  post(ws, `${CB}navigate`, { url: "https://acme-sbx.jaggaer.com/b" }, navResponse(`${CB}navigate`, "https://acme-sbx.jaggaer.com/b"));
  assert.equal(url(ws), "https://acme-sbx.jaggaer.com/b");
  post(ws, `${PW}browser_navigate`, { url: "https://acme-sbx.jaggaer.com/c" }, navResponse(`${PW}browser_navigate`, "https://acme-sbx.jaggaer.com/c"));
  assert.equal(url(ws), "https://acme-sbx.jaggaer.com/c");
  // fallimenti che chrome-devtools restituisce SENZA errore ⇒ ignoto
  for (const text of ["Navigating frame was detached.", "Page crashed!", "Execution context was destroyed"]) {
    post(ws, `${DT}navigate_page`, { type: "url", url: sbx }, navResponse(`${DT}navigate_page`, sbx));
    assert.equal(url(ws), sbx);
    post(ws, `${DT}navigate_page`, { type: "url", url: "https://acme-sbx.jaggaer.com/other" }, [{ type: "text", text: `# navigate_page response\nUnable to navigate in the selected page: ${text}\n## Pages\n1: https://acme.jaggaer.com/po/1 [selected]` }]);
    assert.equal(url(ws), null, text);
  }
  // risposte generiche senza marcatore ⇒ ignoto
  for (const resp of [[{ type: "text", text: "ok" }], [{ type: "text", text: "## Pages" }], "done", { content: [{ type: "text", text: "fatto" }] }]) {
    post(ws, `${DT}navigate_page`, { type: "url", url: sbx }, navResponse(`${DT}navigate_page`, sbx));
    post(ws, `${DT}navigate_page`, { type: "url", url: sbx }, resp);
    assert.equal(url(ws), null, JSON.stringify(resp));
  }
});

test("browser-origin: redirect verso un host di produzione ⇒ si registra l'host di produzione ⇒ l'azione con effetto successiva è negata da guard-environment", () => {
  const ws = envWs();
  const req = "https://acme-sbx.jaggaer.com/home";
  const prodPage = "https://acme.jaggaer.com/po/1";
  post(ws, `${DT}navigate_page`, { type: "url", url: req }, [{ type: "text", text: `# navigate_page response\nSuccessfully navigated to ${req}.\n## Pages\n0: about:blank\n1: ${prodPage} [selected]` }]);
  assert.equal(url(ws), prodPage);
  const r = browserCall("guard-environment", ws, `${DT}click`, { uid: "1" });
  assert.ok(denied(r)); assert.match(reasonOf(r), /host non dichiarato/);
  post(ws, `${CB}navigate`, { url: req }, navResponse(`${CB}navigate`, prodPage, { requested: req }));
  assert.equal(url(ws), prodPage);
  post(ws, `${PW}browser_navigate`, { url: req }, navResponse(`${PW}browser_navigate`, prodPage));
  assert.equal(url(ws), prodPage);
  assert.ok(denied(browserCall("guard-environment", ws, `${CB}computer`, { action: "left_click", coordinate: [1, 1] })));
});
