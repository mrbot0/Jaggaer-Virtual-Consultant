// Correzioni dopo la revisione indipendente (27/10/2026) del ramo esplorazione-libera, con le decisioni dell'utente:
// esplorazione in pre-produzione solo con Chrome DevTools (il browser di Claude resta di sola lettura fuori dalla sandbox,
// WP08); nessun tetto sul numero di elementi (restano solo i limiti in byte dei file).
//  1. take_snapshot con filePath: observe-append legge il file scritto dallo strumento (cartelle di lavoro della sessione,
//     evidenze, run; realpath confinato; limite in byte) come una lettura COMPLETA;
//  2. nessun tetto di ref, nomi, etichette, mappe sommate;
//  3. dopo un'azione senza snapshot la mappa è marcata after_action: il pezzo successivo apre una mappa nuova;
//  4. (atlas-build, test/kb/atlas-pezzi.test.mjs) pulsanti omonimi in pezzi diversi restano distinti;
//  5. firma stabile delle mappe di pezzi;
//  6. in un piano solo le letture complete legano al SEL; i pezzi legano solo in modalità esplorazione;
//  7. un find non svuota la mappa e aggiunge solo ref già legati nella storia con la stessa etichetta.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, mkdtempSync, appendFileSync, readFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { envWs, readSession, patchSession, writeSel, browserCall, ROOT } from "../helpers/env-fixture.mjs";
import { runHook, runSessionCli, decisionOf, reasonOf } from "../helpers/hook-env.mjs";
import { check } from "../../scripts/decide/step-check.mjs";

const CL = "mcp__claude-in-chrome__";
const DT = "mcp__chrome-devtools__";
const PW = "mcp__plugin_playwright_playwright__";
const SEL = "C.ACME.P2P.SEL.0010";
const E = (ws) => ({ JVC_WORKSPACE: ws, CLAUDE_PLUGIN_ROOT: ROOT });
const URLS = { preprod: "https://acme-pre.jaggaer.com/p2p/req/1", sandbox: "https://acme-sbx.jaggaer.com/p2p/req/1", prod: "https://acme.jaggaer.com/p2p/req/1" };
let seq = 0;
const post = (ws, tool, ti, blocks) => {
  const i = { session_id: "sess-1", cwd: ws, hook_event_name: "PostToolUse", tool_name: tool, tool_input: ti, tool_use_id: `toolu_cr_${++seq}`,
    tool_response: typeof blocks === "string" ? [{ type: "text", text: blocks }] : blocks };
  runHook("browser-origin", i, E(ws));
  return runHook("observe-append", i, E(ws));
};
const snapOf = (ws) => readSession(ws).browser.snapshot ?? {};
const ok = (r) => r.status === 0 && r.stdout.trim() === "";
const sessDir = (ws) => join(ws, "customers/ACME/.sessions/sess-1");
const pw = (url, body) => `### Page\n- Page URL: ${url}\n- Page Title: ACME\n### Snapshot\n\`\`\`yaml\n${body}\n\`\`\``;
const ctx = (url, tab = 101) => `\n\nTab Context:\n- Executed on tabId: ${tab}\n- Available tabs:\n  • tabId ${tab}: "ACME" (${url})`;
const claude = (body, url) => [{ type: "text", text: body }, { type: "text", text: ctx(url) }];

function explore(env, phrase) {
  const ws = envWs({ env, scope: "P2P" });
  const tr = join(mkdtempSync(join(tmpdir(), "cr-")), "t.jsonl"); writeFileSync(tr, "");
  appendFileSync(tr, `${JSON.stringify({ type: "user", isSidechain: false, userType: "external", message: { role: "user", content: phrase }, timestamp: new Date().toISOString() })}\n`);
  runHook("approval-capture", { session_id: "sess-1", cwd: ws, hook_event_name: "UserPromptSubmit", prompt: phrase, transcript_path: tr }, E(ws));
  assert.equal(runSessionCli(["use", "mode", "esplorazione", "--session", "sess-1"], { JVC_WORKSPACE: ws }).status, 0);
  patchSession(ws, (s) => { s.browser = { current_url: URLS[env], tab: null, updated_by: "browser-origin" }; });
  return { ws, tr, url: URLS[env], g: (tool, ti) => browserCall("guard-config-scope", ws, tool, ti, { transcript_path: tr }) };
}
async function planWs(envId, tab = null) {
  const ws = envWs({ env: envId, scope: "P2P" });
  patchSession(ws, (s) => { s.browser = { current_url: URLS[envId], tab, updated_by: "browser-origin" }; });
  writeSel(ws, SEL, { role: "link", effect: "read", label: "Elenco richieste" });
  const plan = { plan_id: "PLAN.ACME.X.0002", customer: "ACME", env: envId, goal: "lettura elenco",
    steps: [{ n: 1, verb: "CLICK", action_class: "ACT-OBS", target: SEL, expect: { page_sig: "p2p/requisition/list" } }],
    repair_policy: { skip_allowed: [], substitute_allowed: [], abort_on: [] } };
  mkdirSync(join(ws, "customers/ACME/runs/RUN.ACME.20260922.1106.ADM"), { recursive: true });
  writeFileSync(join(ws, "customers/ACME/runs/RUN.ACME.20260922.1106.ADM/plan.json"), JSON.stringify(plan));
  const file = "runs/RUN.ACME.20260922.1106.ADM/plan.json";
  const tr = join(mkdtempSync(join(tmpdir(), "crp-")), "t.jsonl"); writeFileSync(tr, "");
  await check({ ws, sid: "sess-1", planFile: file, step: 1 });
  const prompt = `APPROVO PIANO ${plan.plan_id} DA Mario Rossi`;
  appendFileSync(tr, `${JSON.stringify({ type: "user", isSidechain: false, userType: "external", message: { role: "user", content: prompt }, timestamp: new Date().toISOString() })}\n`);
  runHook("approval-capture", { session_id: "sess-1", cwd: ws, hook_event_name: "UserPromptSubmit", prompt, transcript_path: tr }, E(ws));
  assert.equal((await check({ ws, sid: "sess-1", planFile: file, step: 1 })).status, "ok");
  const guards = (tool, ti) => ["guard-environment", "guard-production", "guard-config-scope"].map((g) => browserCall(g, ws, tool, ti, { transcript_path: tr }));
  return { ws, tr, url: URLS[envId], guards };
}
// il file che il server DevTools scrive con take_snapshot { filePath }: solo l'albero
const tree = (url, lines) => `uid=1_0 RootWebArea "ACME" url="${url}"\n${lines.map((l) => `  ${l}`).join("\n")}\n`;
const savedResp = (file) => `# take_snapshot response\nSaved snapshot to ${file}.`;

test("correzione 1: take_snapshot con filePath nella cartella della sessione ⇒ lettura completa (nomi, legame, record del registro); click per uid consentito in esplorazione PREPROD", () => {
  const { ws, url, g } = explore("preprod", "ESPLORA PREPROD");
  const f = join(sessDir(ws), "snap-1.txt");
  writeFileSync(f, tree(url, [`uid=1_1 heading "Richieste" level="1"`, `uid=1_2 menuitem "Ordini"`, `uid=1_3 button "Salva bozza"`]));
  post(ws, DT + "take_snapshot", { filePath: f }, savedResp(f));
  const s = snapOf(ws);
  assert.equal(s.names?.["1_2"], "Ordini", JSON.stringify(s));
  assert.notEqual(s.partial, true, "lettura completa");
  const r = g(DT + "click", { uid: "1_2" });
  assert.ok(ok(r), reasonOf(r));
  const log = readFileSync(join(sessDir(ws), "atlas/pages.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((l) => l.kind === "page");
  assert.equal(log.length, 1);
  assert.ok(!log[0].partial && log[0].elements.some((e) => e.name === "Salva bozza"));
});

test("correzione 1: file fuori dalle cartelle di lavoro (kb, radice del cliente, cartella temporanea) o vecchio ⇒ non si legge", () => {
  for (const where of ["kb", "root", "tmp", "old"]) {
    const { ws, url, g } = explore("preprod", "ESPLORA PREPROD");
    const dir = where === "kb" ? join(ws, "customers/ACME/kb") : where === "root" ? join(ws, "customers/ACME") : where === "old" ? sessDir(ws) : mkdtempSync(join(tmpdir(), "crx-"));
    mkdirSync(dir, { recursive: true });
    const f = join(dir, "snap.txt");
    writeFileSync(f, tree(url, [`uid=1_2 menuitem "Ordini"`]));
    if (where === "old") { const t = new Date(Date.now() - 3600 * 1000); utimesSync(f, t, t); }
    post(ws, DT + "take_snapshot", { filePath: f }, savedResp(f));
    assert.ok(!Object.hasOwn(snapOf(ws).names ?? {}, "1_2"), `${where}: ${JSON.stringify(snapOf(ws))}`);
    assert.ok(!ok(g(DT + "click", { uid: "1_2" })), where);
  }
});

test("correzione 1: in un piano la lettura dal file lega al SEL del passo (DevTools in preprod)", async () => {
  const { ws, url, guards } = await planWs("preprod");
  const f = join(sessDir(ws), "snap-plan.txt");
  writeFileSync(f, tree(url, [`uid=1_5 link "Elenco richieste"`, `uid=1_6 button "Invia in approvazione"`]));
  post(ws, DT + "take_snapshot", { filePath: f }, savedResp(f));
  assert.equal(snapOf(ws).refs?.["1_5"], SEL, JSON.stringify(snapOf(ws)));
  const res = guards(DT + "click", { uid: "1_5" });
  assert.ok(res.every(ok), JSON.stringify(res.filter((r) => decisionOf(r) === "deny").map(reasonOf)));
});

test("correzione 2: nessun tetto di elementi — in una pagina di 5000 elementi l'ultimo menu ha il nome nella mappa e si clicca", () => {
  const { ws, url, g } = explore("preprod", "ESPLORA PREPROD");
  const lines = Array.from({ length: 5000 }, (_, i) => `uid=1_${i + 1} ${i === 4990 ? "menuitem \"Fatture passive\"" : `generic "Blocco ${i}"`}`);
  const f = join(sessDir(ws), "snap-big.txt");
  writeFileSync(f, tree(url, lines));
  const t0 = Date.now();
  post(ws, DT + "take_snapshot", { filePath: f }, savedResp(f));
  const ms = Date.now() - t0;
  assert.equal(snapOf(ws).names?.["1_4991"], "Fatture passive");
  const r = g(DT + "click", { uid: "1_4991" });
  assert.ok(ok(r), reasonOf(r));
  assert.ok(ms < 30000, `observe-append troppo lento: ${ms} ms`);
});

test("correzione 3: dopo un'azione senza snapshot nella risposta la mappa è marcata e il pezzo successivo sullo stesso URL apre una mappa nuova (stale.mjs)", () => {
  const { ws, url, g } = explore("preprod", "ESPLORA PREPROD");
  post(ws, PW + "browser_snapshot", { target: "e1" }, pw(url, `- button "Salva" [ref=e12]\n- link "Ordini" [ref=e13]`));
  assert.ok(Object.hasOwn(snapOf(ws).names ?? {}, "e12"));
  assert.ok(ok(g(PW + "browser_click", { ref: "e13", element: "Ordini" })));
  post(ws, PW + "browser_click", { ref: "e13", element: "Ordini" }, "### Ran Playwright code\n```js\nawait page.click();\n```");
  assert.equal(snapOf(ws).after_action, true, JSON.stringify(snapOf(ws)));
  post(ws, PW + "browser_snapshot", { target: "e20" }, pw(url, `- button "Nuova" [ref=e21]`));
  assert.deepEqual(Object.keys(snapOf(ws).names ?? {}), ["e21"], JSON.stringify(snapOf(ws)));
  assert.ok(!ok(g(PW + "browser_click", { ref: "e12", element: "Salva" })), "ref della mappa vecchia cliccabile");
});

test("correzione 5: la firma di una mappa di pezzi è il percorso (+ h1 solo se il pezzo lo mostra) o quella dell'ultima lettura completa dello stesso URL", () => {
  {
    const { ws, url } = explore("preprod", "ESPLORA PREPROD");
    post(ws, PW + "browser_snapshot", { target: "e1" }, pw(url, `- heading "Dettagli fornitore" [level=3] [ref=e2]\n- button "Salva" [ref=e3]`));
    assert.equal(snapOf(ws).sig, "p2p/req", JSON.stringify(snapOf(ws)));
  }
  {
    const { ws, url, g } = explore("preprod", "ESPLORA PREPROD");
    post(ws, PW + "browser_snapshot", {}, pw(url, `- heading "Richiesta 1" [level=1] [ref=e1]\n- link "Ordini" [ref=e2]`));
    const full = snapOf(ws).sig;
    assert.match(full, /#/);
    assert.ok(ok(g(PW + "browser_click", { ref: "e2", element: "Ordini" })));
    post(ws, PW + "browser_click", { ref: "e2", element: "Ordini" }, "### Ran Playwright code\n```js\nawait page.click();\n```");
    post(ws, PW + "browser_snapshot", { target: "e9" }, pw(url, `- heading "Sezione righe" [level=2] [ref=e10]`));
    assert.equal(snapOf(ws).sig, full, "stesso URL: firma dell'ultima lettura completa");
  }
});

test("correzione 6: in un piano solo le letture complete legano al SEL; i pezzi no (Playwright e Claude, preprod e sandbox)", async () => {
  {
    const { ws, url, guards } = await planWs("preprod");
    post(ws, PW + "browser_snapshot", { target: "e1" }, pw(url, `- link "Elenco richieste" [ref=e5]`));
    assert.equal(snapOf(ws).refs?.e5 ?? null, null, JSON.stringify(snapOf(ws)));
    assert.ok(!guards(PW + "browser_click", { ref: "e5", element: "Elenco richieste" }).every(ok));
    post(ws, PW + "browser_snapshot", {}, pw(url, `- link "Elenco richieste" [ref=e5]`));
    assert.equal(snapOf(ws).refs?.e5, SEL);
  }
  {
    const { ws, url, guards } = await planWs("sandbox", "101");
    post(ws, CL + "read_page", { tabId: 101, ref_id: "ref_2" }, claude(`link "Elenco richieste" [ref_3]`, url));
    assert.equal(snapOf(ws).refs?.ref_3 ?? null, null, JSON.stringify(snapOf(ws)));
    assert.ok(!guards(CL + "computer", { action: "left_click", ref: "ref_3", tabId: 101 }).every(ok));
  }
});

test("correzione 7: un find non svuota la mappa; aggiunge solo i ref già legati nella storia della scheda con la stessa etichetta", () => {
  const { ws, url, g } = explore("sandbox", "ESPLORA SANDBOX");
  patchSession(ws, (s) => { s.browser.tab = "101"; });
  post(ws, CL + "navigate", { url, tabId: 101 }, [{ type: "text", text: `Navigated to ${url}` }, { type: "text", text: ctx(url) }]);
  post(ws, CL + "read_page", { tabId: 101 }, claude(`menuitem "Ordini" [ref_3]\nmenuitem "Fatture" [ref_4]\n\nViewport: 490x417`, url));
  post(ws, CL + "read_page", { tabId: 101, ref_id: "ref_8" }, claude(`button "Salva" [ref_9]`, `${url}?tab=2`));
  assert.deepEqual(Object.keys(snapOf(ws).names ?? {}), ["ref_9"]);
  post(ws, CL + "find", { tabId: 101, query: "ordini" }, claude(`Found 2 matching elements\n- menuitem "Ordini" [ref_3]\n- button "Elimina" [ref_77]`, `${url}?tab=2`));
  const n = snapOf(ws).names ?? {};
  assert.equal(n.ref_9, "Salva", "il find non svuota la mappa");
  assert.equal(n.ref_3, "Ordini", "ref già visto con la stessa etichetta: aggiunto");
  assert.ok(!Object.hasOwn(n, "ref_77"), "ref nuovo del find: mai");
  assert.ok(!ok(g(CL + "computer", { action: "left_click", ref: "ref_77", tabId: 101 })));
});
