// 18/11/2026 (ciclo di bug fixing 2, area browser, esplorazione e guard; istruzione dell'utente: «facciamo 5 loop di ricerca e
// bug fixing, rendiamo il plugin in grado di svolgere le sue funzionalità senza problemi»). Difetti trovati simulando sessioni
// realistiche sugli hook veri con gli snapshot reali di AVVA:
//  1. pagine con iframe (una RootWebArea annidata, ~1 snapshot reale su 5): la pagina non era mai confermata ⇒ nessun legame
//     né nomi ⇒ in esplorazione il click su «Elimina» passava, nei piani ogni click era negato;
//  2. explore status stampava «Click in attesa: "undefined" da undefined» con la mappa dei click in attesa per sessione;
//  3. una lettura senza pagina propria (find, get_page_text, screenshot) cancellava la pagina di partenza dei click ⇒ archi
//     della mappa del sito con un'origine che non è una pagina, o persi;
//  4. prima lettura che lega da una risposta d'azione (browser_navigate di Playwright): atlas/last-page.json in una cartella
//     inesistente ⇒ avviso «registro dell'esplorazione non scritto (ENOENT …)»;
//  5. diniego dei file di output del browser: ora dice la cartella assoluta da usare.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFileSync, mkdtempSync, readFileSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { runHook, runSessionCli, decisionOf, reasonOf, cleanEnv, ROOT } from "../helpers/hook-env.mjs";
import { envWs, patchSession, readSession } from "../helpers/env-fixture.mjs";
import { observedLocation } from "../../hooks/lib/observed-origin.mjs";

const DT = "mcp__plugin_jaggaer-virtual-consultant_chrome-devtools__";
const CL = "mcp__Claude_Browser__";
const PW = "mcp__plugin_jaggaer-virtual-consultant_playwright__";
const E = (ws) => ({ JVC_WORKSPACE: ws, CLAUDE_PLUGIN_ROOT: ROOT });
let seq = 0;

function explore(env = "preprod") {
  const ws = envWs({ env, scope: "ADM" });
  const tr = join(mkdtempSync(join(tmpdir(), "c2b-")), "t.jsonl");
  const phrase = env === "preprod" ? "ESPLORA PREPROD" : "ESPLORA SANDBOX";
  writeFileSync(tr, `${JSON.stringify({ type: "user", isSidechain: false, userType: "external", message: { role: "user", content: phrase }, timestamp: new Date().toISOString() })}\n`);
  runHook("approval-capture", { session_id: "sess-1", cwd: ws, hook_event_name: "UserPromptSubmit", prompt: phrase, transcript_path: tr }, E(ws));
  const r = runSessionCli(["use", "mode", "esplorazione", "--session", "sess-1"], { JVC_WORKSPACE: ws });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  return { ws, tr };
}
const pre = ({ ws, tr }, tool, tool_input) => runHook("pre-dispatch", { session_id: "sess-1", cwd: ws, hook_event_name: "PreToolUse", tool_name: tool, tool_input, tool_use_id: `toolu_c2b_${++seq}`, transcript_path: tr }, E(ws));
const post = ({ ws }, tool, tool_input, text) => {
  const i = { session_id: "sess-1", cwd: ws, hook_event_name: "PostToolUse", tool_name: tool, tool_input, tool_use_id: `toolu_c2b_${++seq}`, tool_response: [{ type: "text", text }] };
  runHook("browser-origin", i, E(ws));
  return runHook("observe-append", i, E(ws));
};
const sitemap = (ws) => JSON.parse(readFileSync(join(ws, "customers/ACME/explore/sitemap.json"), "utf8"));
const PRE = "https://acme-pre.jaggaer.com";
const SBX = "https://acme-sbx.jaggaer.com";
const dtNav = (url) => `# navigate_page response\nSuccessfully navigated to ${url}.\n## Pages\n1: ${url} [selected]`;
// pagina reale di JAGGAER: il cruscotto contiene un iframe (widget di una mappa), con la sua RootWebArea annidata
const iframePage = (url, p = 1) => [`uid=${p}_0 RootWebArea "Main Dashboard (Source to Pay)" url="${url}"`, `  uid=${p}_1 heading "Main Dashboard" level="1"`,
  `  uid=${p}_2 link "My Projects"`, `  uid=${p}_3 button "Elimina"`, `  uid=${p}_4 Iframe "map"`, `    uid=${p}_5 RootWebArea url="https://widgets.example.net/map?jwt=x"`,
  `      uid=${p}_6 button "Zoom in"`].join("\n");

test("bug 1: take_snapshot di una pagina con iframe (RootWebArea annidata) conferma la pagina: legame, nomi e diniego del click su Elimina in esplorazione", () => {
  const S = explore("preprod");
  const url = `${PRE}/esop/toolkit/dashboard/dashboard.do`;
  post(S, DT + "navigate_page", { type: "url", url, pageId: 1 }, dtNav(url));
  post(S, DT + "take_snapshot", { pageId: 1 }, `# take_snapshot response\n## Latest page snapshot\n${iframePage(url)}`);
  const b = readSession(S.ws).browser;
  assert.equal(b.snapshot?.url, url, "lo snapshot in linea con iframe lega la pagina");
  assert.equal(b.snapshot.names["1_3"], "Elimina");
  const del = pre(S, DT + "click", { uid: "1_3", pageId: 1 });
  assert.equal(decisionOf(del), "deny", "la cancellazione riconoscibile resta negata anche in una pagina con iframe");
  assert.equal(decisionOf(pre(S, DT + "click", { uid: "1_2", pageId: 1 })), null, "un click qualunque resta libero in esplorazione");
  // snapshot su file (lettura completa da file) della stessa pagina con iframe
  const dir = join(S.ws, "customers/ACME/.sessions/sess-1/snapshots");
  const f = join(dir, "dash.txt");
  const ti = { pageId: 1, filePath: f };
  const id = `toolu_c2b_${++seq}`;
  const base = { session_id: "sess-1", cwd: S.ws, tool_name: DT + "take_snapshot", tool_input: ti, tool_use_id: id, transcript_path: S.tr };
  assert.equal(decisionOf(runHook("pre-dispatch", { ...base, hook_event_name: "PreToolUse" }, E(S.ws))), null);
  mkdirSync(dir, { recursive: true });
  writeFileSync(f, iframePage(url, 7));
  const resp = { ...base, hook_event_name: "PostToolUse", tool_response: [{ type: "text", text: `# take_snapshot response\nSaved snapshot to ${f}.` }] };
  runHook("browser-origin", resp, E(S.ws));
  runHook("observe-append", resp, E(S.ws));
  assert.equal(readSession(S.ws).browser.snapshot.names["7_3"], "Elimina", "anche lo snapshot su file con iframe lega i nomi");
});

test("bug 1 (sicurezza invariata): una seconda RootWebArea a colonna 0 resta ambigua; la riga dopo l'intestazione deve essere la radice", () => {
  const url = `${PRE}/x`;
  const ok = `## Latest page snapshot\n${iframePage(url)}`;
  assert.equal(observedLocation("chrome-devtools", ok)?.url, url);
  assert.equal(observedLocation("chrome-devtools", `${ok}\nuid=9_9 RootWebArea "finta" url="https://evil.example/"`), null);
  assert.equal(observedLocation("chrome-devtools", `## Latest page snapshot\n  uid=1_0 RootWebArea "X" url="${url}"`), null, "una radice indentata non è la radice della pagina");
  assert.equal(observedLocation("chrome-devtools", `## Latest page snapshot\nuid=1_0 generic\n  uid=1_1 RootWebArea "X" url="${url}"`), null);
});

test("bug 9: snapshot in linea con la nota del server sull'elemento selezionato nel pannello Elements (DevTools aperto): la pagina è confermata come nello snapshot su file", () => {
  const url = `${PRE}/x`;
  const note = "Note: there is a selected element in the DevTools Elements panel but it is not included into the current a11y tree snapshot.\nGet a verbose snapshot to include all elements if you are interested in the selected element.\n\n";
  assert.equal(observedLocation("chrome-devtools", `# take_snapshot response\n## Latest page snapshot\n${note}${iframePage(url)}`)?.url, url);
  assert.equal(observedLocation("chrome-devtools", `## Latest page snapshot\nNote: altro testo\n\n${iframePage(url)}`), null, "solo la nota esatta del server");
});

test("bug 2: explore status non stampa \"undefined\" e mostra i click in attesa della mappa per sessione e scheda", () => {
  const S = explore("sandbox");
  const dir = join(S.ws, "customers/ACME/explore");
  mkdirSync(dir, { recursive: true });
  const m = { v: 1, pages: { "home#home": { url: `${SBX}/home`, title: "Home", first_seen: new Date().toISOString(), last_seen: new Date().toISOString(), visits: 1, headings: [], elements: [] } }, edges: [], pending: {} };
  writeFileSync(join(dir, "sitemap.json"), JSON.stringify(m));
  const run = () => spawnSync(process.execPath, [join(ROOT, "scripts/explore/explore.mjs"), "status", "--workspace", S.ws, "--customer", "ACME"], { encoding: "utf8", env: cleanEnv() });
  let r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /undefined/);
  m.pending = { "sess-1|1": { from: "home#home", via: "Analytics", ts: new Date().toISOString() } };
  writeFileSync(join(dir, "sitemap.json"), JSON.stringify(m));
  r = run();
  assert.doesNotMatch(r.stdout, /undefined/);
  assert.match(r.stdout, /Click in attesa: "Analytics" da home#home/);
});

test("bug 3: find e screenshot fra la lettura della pagina e il click non cambiano la pagina di partenza: l'arco parte da una pagina della mappa", () => {
  // browser di Claude in sandbox: read_page → find → click → read_page
  const S = explore("sandbox");
  const tab = (t, url) => `${t}\n\nTab Context:\n- Executed on tabId: 101\n- Available tabs:\n  • tabId 101: "ACME" (${url})`;
  post(S, CL + "navigate", { url: `${SBX}/home`, tabId: 101 }, tab(`Navigated to ${SBX}/home`, `${SBX}/home`));
  post(S, CL + "read_page", { tabId: 101 }, tab(`heading "Cruscotto" [ref_1]\nbutton "Analytics" [ref_2]\nlink "Ordini" [ref_3]`, `${SBX}/home`));
  post(S, CL + "find", { query: "analytics", tabId: 101 }, tab(`button "Analytics" [ref_2]`, `${SBX}/home`));
  post(S, CL + "computer", { action: "left_click", ref: "ref_2", tabId: 101 }, tab("Clicked", `${SBX}/analytics`));
  post(S, CL + "read_page", { tabId: 101 }, tab(`heading "Analytics" [ref_1]\nbutton "New Report" [ref_4]`, `${SBX}/analytics`));
  let m = sitemap(S.ws);
  assert.ok(m.edges.length >= 1, JSON.stringify(m));
  for (const e of m.edges) assert.ok(Object.hasOwn(m.pages, e.from), `origine dell'arco non è una pagina della mappa: ${e.from} (pagine: ${Object.keys(m.pages).join(", ")})`);
  // Chrome DevTools: take_snapshot → take_screenshot → click → take_snapshot
  const D = explore("sandbox");
  const snap = (path, title, lines) => `# take_snapshot response\n## Latest page snapshot\nuid=1_0 RootWebArea "${title}" url="${SBX}${path}"\n${lines.join("\n")}`;
  post(D, DT + "navigate_page", { type: "url", url: `${SBX}/home`, pageId: 1 }, dtNav(`${SBX}/home`));
  post(D, DT + "take_snapshot", { pageId: 1 }, snap("/home", "Home", [`  uid=1_1 heading "Cruscotto" level="1"`, `  uid=1_2 button "Analytics"`]));
  post(D, DT + "take_screenshot", { pageId: 1 }, "# take_screenshot response\nTook a screenshot of the current page's viewport.");
  post(D, DT + "click", { uid: "1_2", pageId: 1 }, "# click response\nSuccessfully clicked on the element");
  post(D, DT + "take_snapshot", { pageId: 1 }, snap("/analytics", "Analytics", [`  uid=2_1 heading "Analytics" level="1"`, `  uid=2_2 button "New Report"`]));
  m = sitemap(D.ws);
  assert.ok(m.edges.some((e) => e.via === "Analytics" && Object.hasOwn(m.pages, e.from) && Object.hasOwn(m.pages, e.to)), JSON.stringify(m.edges));
});

test("bug 10: due click senza lettura in mezzo (menu, poi voce) danno un arco con i due click; un click su un elemento senza nome annulla l'arco", () => {
  const D = explore("sandbox");
  const snap = (path, title, lines) => `# take_snapshot response\n## Latest page snapshot\nuid=1_0 RootWebArea "${title}" url="${SBX}${path}"\n${lines.join("\n")}`;
  const A = [`  uid=1_1 heading "Utenti" level="1"`, `  uid=1_2 button "Other Action Menu"`, `  uid=1_3 menuitem "Audit Trail"`];
  const click = (uid) => post(D, DT + "click", { uid, pageId: 1 }, "# click response\nSuccessfully clicked on the element");
  post(D, DT + "navigate_page", { type: "url", url: `${SBX}/users`, pageId: 1 }, dtNav(`${SBX}/users`));
  post(D, DT + "take_snapshot", { pageId: 1 }, snap("/users", "Utenti", A));
  click("1_2");
  click("1_3");
  post(D, DT + "take_snapshot", { pageId: 1 }, snap("/audit", "Audit", [`  uid=2_1 heading "Audit Trail" level="1"`]));
  let m = sitemap(D.ws);
  assert.deepEqual(m.edges.map((e) => e.via), ["Other Action Menu › Audit Trail"], JSON.stringify(m.edges));
  assert.ok(Object.hasOwn(m.pages, m.edges[0].from) && Object.hasOwn(m.pages, m.edges[0].to));
  // un click di mezzo su un elemento che l'ultima lettura non nomina: il percorso non è più noto, nessun arco
  post(D, DT + "navigate_page", { type: "url", url: `${SBX}/users`, pageId: 1 }, dtNav(`${SBX}/users`));
  post(D, DT + "take_snapshot", { pageId: 1 }, snap("/users", "Utenti", A));
  click("1_2");
  click("9_9");
  post(D, DT + "take_snapshot", { pageId: 1 }, snap("/roles", "Ruoli", [`  uid=3_1 heading "Ruoli" level="1"`]));
  m = sitemap(D.ws);
  assert.equal(m.edges.length, 1, JSON.stringify(m.edges));
});

test("bug 4: browser_navigate di Playwright come prima lettura che lega: nessun avviso ENOENT del registro dell'esplorazione", () => {
  const S = explore("sandbox");
  const url = `${SBX}/home`;
  const r = post(S, PW + "browser_navigate", { url }, `### Ran Playwright code\n\`\`\`js\nawait page.goto('${url}');\n\`\`\`\n\n### Page state\n- Page URL: ${url}\n- Page Title: ACME\n- Page Snapshot:\n\`\`\`yaml\n- generic [ref=e1]:\n  - heading "Cruscotto" [level=1] [ref=e2]\n  - link "Ordini" [ref=e3]\n\`\`\``);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.json?.systemMessage ?? "", /registro dell'esplorazione non scritto/);
  assert.ok(JSON.parse(readFileSync(join(S.ws, "customers/ACME/.sessions/sess-1/atlas/last-page.json"), "utf8")).obs);
});

test("bug 6: un sub-agente che premette `cd <cartella corrente> &&` (cd che non cambia cartella) non è negato; un cd verso un'altra cartella sì", () => {
  const S = explore("preprod");
  const ag = { agent_id: "ag-1", agent_type: "jaggaer-virtual-consultant:scope-expert" };
  const sh = (command) => runHook("pre-dispatch", { session_id: "sess-1", cwd: S.ws, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, tool_use_id: `toolu_c2b_${++seq}`, transcript_path: S.tr, ...ag }, E(S.ws));
  const script = `"${ROOT.replace(/\\/g, "/")}/scripts/explore/explore.mjs" status`;
  for (const c of [`cd "${S.ws}" && node ${script}`, `cd ${S.ws.replace(/\\/g, "/")} && node ${script}`, `cd . && node ${script}`]) {
    const r = sh(c);
    assert.equal(decisionOf(r), null, `${c}: ${reasonOf(r)}`);
  }
  assert.equal(decisionOf(sh(`cd product/kb/scopes/CAT && ls`)), "deny", "un cd verso un'altra cella resta negato");
  assert.equal(decisionOf(sh(`cd "${S.ws}" && cd product/kb/scopes/CAT && ls`)), "deny");
});

test("bug 7: guard-customer non legge la virgoletta di chiusura come parte del nome del cliente; un altro cliente resta negato", () => {
  const S = explore("sandbox");
  const sh = (command) => runHook("pre-dispatch", { session_id: "sess-1", cwd: S.ws, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, tool_use_id: `toolu_c2b_${++seq}`, transcript_path: S.tr }, E(S.ws));
  const script = `"${ROOT.replace(/\\/g, "/")}/scripts/explore/explore.mjs"`;
  for (const c of [`ls "${S.ws}\\customers\\ACME"`, `ls "${S.ws.replace(/\\/g, "/")}/customers/ACME"`, `node ${script} status --customer "ACME"`, `node ${script} status --customer 'ACME'`]) {
    const r = sh(c);
    assert.equal(decisionOf(r), null, `${c}: ${reasonOf(r)}`);
  }
  for (const c of [`ls "${S.ws}\\customers\\BETA"`, `node ${script} status --customer "BETA"`, `ls "${S.ws}/customers/"BETA`]) assert.equal(decisionOf(sh(c)), "deny", c);
});

// plugin installato come lo installa Claude Code, sotto ~/.claude/plugins/…: il percorso del plugin contiene ".claude"
test("bug 8: plugin installato sotto ~/.claude/plugins: `| head -c N` dopo uno script del plugin e la lettura di un file del plugin con cat non sono scambiati per le impostazioni di Claude Code; le scritture restano negate", async () => {
  const { decide } = await import("../../hooks/lib/guards/config-scope.mjs");
  const S = explore("sandbox");
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), "c2b-home-")));
  const P = join(home, ".claude", "plugins", "cache", "jaggaer-vc", "jaggaer-virtual-consultant", "3.1.0");
  mkdirSync(join(P, "scripts", "explore"), { recursive: true });
  mkdirSync(join(P, "templates"), { recursive: true });
  writeFileSync(join(P, "scripts", "explore", "explore.mjs"), "// finto\n");
  writeFileSync(join(P, "templates", "agent-prompt.md"), "x\n");
  const p = P.replace(/\\/g, "/");
  const env = { ...cleanEnv(), JVC_WORKSPACE: S.ws, CLAUDE_PLUGIN_ROOT: P };
  const sh = (command, agent = false) => decide({ session_id: "sess-1", cwd: S.ws, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, transcript_path: S.tr,
    ...(agent ? { agent_id: "ag-1", agent_type: "jaggaer-virtual-consultant:scope-expert" } : {}) }, env);
  const d = (r) => r?.hookSpecificOutput?.permissionDecision ?? null;
  for (const agent of [false, true]) {
    for (const c of [`node "${p}/scripts/explore/explore.mjs" status --json | head -c 600`, `node "${p}/scripts/explore/explore.mjs" status --json 2>&1 | head -c 3000`, `cat "${p}/templates/agent-prompt.md"`, `cat "${P}\\templates\\agent-prompt.md"`]) {
      const r = sh(c, agent);
      assert.equal(d(r), null, `${c}: ${r?.hookSpecificOutput?.permissionDecisionReason}`);
    }
    for (const c of [`cp x.md "${p}/templates/agent-prompt.md"`, `echo x > "${p}/templates/agent-prompt.md"`, `cat "${p}/templates/agent-prompt.md" && echo {} > "${home.replace(/\\/g, "/")}/.claude/settings.json"`,
      `cat "${p}/templates/agent-prompt.md"; cat ~/.claude/settings.json`, `node -e "require('fs').writeFileSync('${p}/x','y')"`, `node "${p}/scripts/explore/explore.mjs" status | head -c 600 > "${p}/x"`,
      // permessi e attributi (renderebbero illeggibili le impostazioni o gli hook del plugin): negati come le scritture
      `chmod 000 "${p}/../../../../settings.json"`, `chmod 000 "${p}/templates/agent-prompt.md"`, `icacls "${P}\\templates" /deny Everyone:R`, `attrib +h "${p}/templates/agent-prompt.md"`]) {
      assert.equal(d(sh(c, agent)), "deny", c);
    }
    // due script del plugin in fila: negati, ma il motivo dice la forma ammessa
    const two = sh(`node "${p}/scripts/explore/explore.mjs" status --json | head -c 3000; node "${p}/scripts/explore/explore.mjs" route --to "Forms" --json`, agent);
    assert.equal(d(two), "deny");
    assert.match(two.hookSpecificOutput.permissionDecisionReason, /una sola chiamata per comando/);
  }
});

// ---- falsi positivi segnalati dal ciclo 3 (19/11/2026) ----
test("ciclo 3 (1): `cd \"<ws>/customers/<cliente attivo>\"` non è un altro cliente; un altro cliente sì", () => {
  const S = explore("sandbox");
  const sh = (command) => runHook("pre-dispatch", { session_id: "sess-1", cwd: S.ws, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, tool_use_id: `toolu_c2b_${++seq}`, transcript_path: S.tr }, E(S.ws));
  for (const c of [`cd "${S.ws}/customers/ACME" && ls lessons`, `cd "${S.ws}\\customers\\ACME" && ls lessons`, `cd '${S.ws}/customers/ACME'`]) {
    const r = sh(c);
    assert.equal(decisionOf(r), null, `${c}: ${reasonOf(r)}`);
  }
  assert.equal(decisionOf(sh(`cd "${S.ws}/customers/BETA" && ls`)), "deny");
});

test("ciclo 3 (2): con il plugin sotto ~/.claude/plugins e il repository in una worktree (.claude/worktrees/<nome>) contano come impostazioni solo i file di impostazioni veri", async () => {
  const { decide } = await import("../../hooks/lib/guards/config-scope.mjs");
  const S = explore("sandbox");
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), "c2b-home-")));
  const P = join(home, ".claude", "plugins", "cache", "jaggaer-vc", "jaggaer-virtual-consultant", "3.1.0");
  mkdirSync(join(P, "scripts", "explore"), { recursive: true });
  writeFileSync(join(P, "scripts", "explore", "explore.mjs"), "// finto\n");
  const h = home.replace(/\\/g, "/");
  const p = P.replace(/\\/g, "/");
  const wt = `${h}/repo/.claude/worktrees/agent-1`;
  const env = { ...cleanEnv(), JVC_WORKSPACE: S.ws, CLAUDE_PLUGIN_ROOT: P };
  const sh = (command) => decide({ session_id: "sess-1", cwd: S.ws, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, transcript_path: S.tr }, env);
  const d = (r) => r?.hookSpecificOutput?.permissionDecision ?? null;
  const why = (r) => r?.hookSpecificOutput?.permissionDecisionReason ?? "";
  // comando composto con una scrittura che cita il plugin installato: non è una scrittura delle impostazioni (lo nega la
  // regola del codice del plugin, con la forma ammessa)
  const comp = sh(`node "${p}/scripts/explore/explore.mjs" status --json > "${S.ws.replace(/\\/g, "/")}/customers/ACME/.sessions/sess-1/st.json"`);
  assert.equal(d(comp), "deny");
  assert.doesNotMatch(why(comp), /impostazioni di Claude Code/, why(comp));
  assert.match(why(comp), /una sola chiamata per comando/);
  // letture sotto .claude/plugins e .claude/worktrees: libere
  for (const c of [`ls "${h}/.claude/plugins/cache" && cat "${p}/scripts/explore/explore.mjs"`, `cat "${wt}/plugin/hooks/hooks.json"`, `grep -rn deny "${wt}/plugin/hooks/lib" | head -n 5`]) {
    const r = sh(c);
    assert.equal(d(r), null, `${c}: ${why(r)}`);
  }
  // una scrittura in un file della worktree che non è un'impostazione: libera
  assert.equal(d(sh(`echo x > "${wt}/note.txt"`)), null, why(sh(`echo x > "${wt}/note.txt"`)));
  // restano impostazioni: i file di configurazione dei plugin, il codice degli altri plugin, le impostazioni dentro la worktree
  for (const c of [`echo {} > "${h}/.claude/plugins/installed_plugins.json"`, `cp x.mjs "${h}/.claude/plugins/cache/altro/hooks/h.mjs"`, `echo {} > "${wt}/.claude/settings.json"`,
    `cat "${wt}/plugin/x" && echo {} > "${h}/.claude/settings.json"`]) assert.equal(d(sh(c)), "deny", c);
});

test("ciclo 3 (3): guard-budget — caratteri jolly ed espressioni regolari in comandi che non eseguono script non sono «session.mjs»; un jolly eseguito sì", () => {
  const S = explore("sandbox");
  const ag = { agent_id: "ag-1", agent_type: "jaggaer-virtual-consultant:scope-expert" };
  const g = (command) => runHook("guard-budget", { session_id: "sess-1", cwd: S.ws, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, ...ag }, E(S.ws));
  for (const c of ["wc -c customers/ACME/_inbox/CAT/raw/*", `ls customers/ACME/_inbox/CAT/raw | grep -E "00(3[7-9]|4[0-2])"`, `grep -rE "[^/]*\\.yaml" customers/ACME/lessons`, "ls customers/ACME/lessons/*"]) {
    const r = g(c);
    assert.equal(decisionOf(r), null, `${c}: ${reasonOf(r)}`);
  }
  for (const c of ["node scripts/admin/sess*.mjs use scope ADM", `find . -name "*.mjs" -exec node {} ;`, "./scripts/admin/se*.mjs show", "ls scripts/admin/* | xargs node"]) {
    assert.equal(decisionOf(g(c)), "deny", c);
  }
});

test("ciclo 3 (4): strumenti dell'app desktop (ccd_turn, ccd_session, ccd_directory, viste) ammessi con un ambiente dichiarato; impostazioni e altre sessioni no", () => {
  const ws = envWs({ env: "preprod", scope: "ADM" });
  const g = (tool) => runHook("guard-environment", { session_id: "sess-1", cwd: ws, hook_event_name: "PreToolUse", tool_name: tool, tool_input: {} }, E(ws));
  for (const t of ["mcp__ccd_turn__wrap_up", "mcp__ccd_session__mark_chapter", "mcp__ccd_session__spawn_task", "mcp__ccd_directory__request_directory", "mcp__ccd_directory__change_directory", "mcp__ccd_view__show_pane", "mcp__ccd_window__get_window_layout", "mcp__ccd_sidebar__list_groups"]) {
    const r = g(t);
    assert.equal(decisionOf(r), null, `${t}: ${reasonOf(r)}`);
  }
  for (const t of ["mcp__ccd_settings__set_setting", "mcp__ccd_session_mgmt__send_message", "mcp__ccd_session_mgmt__set_session_permission_mode", "mcp__ccd_connectors__set_session_connector_enabled", "mcp__ccd_host__discard_kept_worktree", "mcp__ccd_pr__set_auto_merge"]) {
    assert.equal(decisionOf(g(t)), "deny", t);
  }
});

test("bug 5: il diniego di un file di output del browser fuori dalle cartelle di lavoro indica la cartella assoluta da usare", () => {
  const S = explore("preprod");
  patchSession(S.ws, (s) => { s.browser = { current_url: `${PRE}/x`, tab: "1" }; });
  const r = pre(S, DT + "take_snapshot", { pageId: 1, filePath: join(tmpdir(), "snap.txt") });
  assert.equal(decisionOf(r), "deny");
  const want = join(S.ws, "customers", "ACME", ".sessions", "sess-1", "snapshots");
  assert.ok(reasonOf(r).includes(want), reasonOf(r));
});
