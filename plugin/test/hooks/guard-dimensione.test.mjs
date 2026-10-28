// Blocco dal vivo del 27/10/2026 (pre-produzione, Chrome DevTools, Analytics Launchpad: pagina piena di miniature in
// base64). Lo snapshot enorme faceva fallire observe-append (eccezione o timeout di 10 s): il marcatore obs_pending
// della chiamata restava aperto e pendingRefusal negava ogni click sulla scheda; l'URL con frammento non conta come nuovo
// documento e ogni nuovo snapshot falliva di nuovo ⇒ stallo permanente. Decisione dell'utente: «rimuoviamo il Guard
// sulla grandezza, risulta bloccante e inutile».
//  1. data URI in base64 sostituiti da un segnaposto PRIMA di ogni lettura (risposta in linea e file dello snapshot);
//  2. marcatore che guarisce: una lettura COMPLETA riuscita della scheda (o un navigate riuscito a un URL diverso, anche
//     con frammento) chiude i marcatori rimasti di quella famiglia e scheda; prima di allora i click restano negati;
//  3. tolti i limiti in byte (mappa, storia, file dello snapshot);
//  4. timeout dell'hook observe-append 60 s (e lettura dello stdin che non scade prima);
//  5. un guasto della registrazione (DB delle OBS, registro, novità) non lascia il marcatore aperto né la mappa vuota.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, mkdtempSync, appendFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { envWs, readSession, patchSession, browserCall, navResponse, ROOT } from "../helpers/env-fixture.mjs";
import { runHook, runSessionCli, reasonOf, hookScript, cleanEnv } from "../helpers/hook-env.mjs";

const DT = "mcp__chrome-devtools__";
const CL = "mcp__claude-in-chrome__";
const E = (ws) => ({ JVC_WORKSPACE: ws, CLAUDE_PLUGIN_ROOT: ROOT });
const URLS = { preprod: "https://acme-pre.jaggaer.com/esop/analysis-console/ac/analysisnew.do#reactReports", sandbox: "https://acme-sbx.jaggaer.com/p2p/req/1" };
let seq = 0;
const input = (ws, tool, ti, blocks, id = `toolu_gd_${++seq}`) => ({ session_id: "sess-1", cwd: ws, hook_event_name: "PostToolUse", tool_name: tool, tool_input: ti, tool_use_id: id,
  tool_response: typeof blocks === "string" ? [{ type: "text", text: blocks }] : blocks });
const post = (ws, tool, ti, blocks) => {
  const i = input(ws, tool, ti, blocks);
  runHook("browser-origin", i, E(ws));
  return runHook("observe-append", i, E(ws));
};
// chiamata che observe-append non registra (fallito o scaduto): solo browser-origin, che lascia il marcatore
const lost = (ws, tool, ti, blocks = "# take_snapshot response\n## Latest page snapshot\n") => runHook("browser-origin", input(ws, tool, ti, blocks), E(ws));
const snapOf = (ws) => readSession(ws).browser.snapshot ?? {};
const pendingOf = (ws) => readSession(ws).browser.obs_pending ?? {};
const customerPending = (ws) => { const f = join(ws, "customers/ACME/.sessions/ref-pending.json"); return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")).obs_pending : {}; };
const ok = (r) => r.status === 0 && r.stdout.trim() === "";
const sessDir = (ws) => join(ws, "customers/ACME/.sessions/sess-1");

function explore(env, phrase) {
  const ws = envWs({ env, scope: "P2P" });
  const tr = join(mkdtempSync(join(tmpdir(), "gd-")), "t.jsonl"); writeFileSync(tr, "");
  appendFileSync(tr, `${JSON.stringify({ type: "user", isSidechain: false, userType: "external", message: { role: "user", content: phrase }, timestamp: new Date().toISOString() })}\n`);
  runHook("approval-capture", { session_id: "sess-1", cwd: ws, hook_event_name: "UserPromptSubmit", prompt: phrase, transcript_path: tr }, E(ws));
  assert.equal(runSessionCli(["use", "mode", "esplorazione", "--session", "sess-1"], { JVC_WORKSPACE: ws }).status, 0);
  patchSession(ws, (s) => { s.browser = { current_url: URLS[env], tab: null, updated_by: "browser-origin" }; });
  return { ws, url: URLS[env], g: (tool, ti) => browserCall("guard-config-scope", ws, tool, ti, { transcript_path: tr }) };
}

// Pagina sintetica dell'Analytics Launchpad: n miniature (kb KB di base64 ciascuna, url="data:…"), una miniatura senza
// testo alternativo (il nome È il data URI), una con parametri (charset), un'anteprima enorme (hugeMb MB in un solo valore
// fra virgolette) e un link con nome per ogni miniatura.
const R = randomBytes(3 * 1024 * 1024).toString("base64");
const b64 = (i, len) => { const s = R.slice(i % 1000, (i % 1000) + Math.min(len, R.length - 1000)); return len <= s.length ? s : s.repeat(Math.ceil(len / s.length)).slice(0, len); };
const SAMPLE = R.slice(5000, 5040);
function heavyTree(url, { n = 400, kb = 20, hugeMb = 12 } = {}) {
  const L = [`uid=1_0 RootWebArea "Analytics Launchpad" url="${url}"`, `  uid=1_1 heading "Analytics Launchpad" level="1"`];
  let k = 2;
  for (let i = 0; i < n; i++) {
    L.push(`  uid=1_${k++} image "Miniatura ${i}" url="data:image/png;base64,${b64(i, kb * 1024)}"`);
    L.push(`  uid=1_${k++} link "Report ${i}" url="https://acme-pre.jaggaer.com/esop/report/${i}"`);
  }
  L.push(`  uid=1_${k++} image "data:image/jpeg;base64,${b64(7, kb * 1024)}"`);
  L.push(`  uid=1_${k++} image "Logo" url="data:image/svg+xml;charset=utf-8;base64,${b64(9, 4096)}"`);
  if (hugeMb) L.push(`  uid=1_${k++} image "Anteprima grande" url="data:image/png;base64,${b64(11, hugeMb * 1024 * 1024)}"`);
  L.push(`  uid=1_${k++} button "Nuovo report"`);
  return { text: `${L.join("\n")}\n`, lastLink: `1_${2 * n + 1}`, button: `1_${k - 1}` };
}
const inline = (tree) => `# take_snapshot response\n## Latest page snapshot\n${tree}`;
const noBase64 = (ws) => {
  const files = [join(sessDir(ws), "session.json"), join(sessDir(ws), "atlas/pages.jsonl"), ...readdirSync(join(ws, "customers/ACME/observations")).map((f) => join(ws, "customers/ACME/observations", f))];
  for (const f of files.filter(existsSync)) assert.ok(!readFileSync(f, "utf8").includes(SAMPLE), `base64 in ${f}`);
};

// 1 ----------------------------------------------------------------------------------------------------------------------
test("1: snapshot in linea pieno di miniature base64 (anche un valore di 12 MB) — observe-append chiude in fretta, mappa con i nomi, base64 omesso ovunque, click consentito in esplorazione", { timeout: 120000 }, () => {
  const { ws, url, g } = explore("preprod", "ESPLORA PREPROD");
  const t = heavyTree(url);
  const r = post(ws, DT + "take_snapshot", {}, inline(t.text));
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.json?.systemMessage, `avviso dell'hook: ${r.json?.systemMessage}`);
  console.log(`observe-append, pagina di ${(t.text.length / 1e6).toFixed(1)} MB di miniature base64: ${r.ms.toFixed(0)} ms`);
  assert.ok(r.ms < 15000, `${r.ms.toFixed(0)} ms`);
  assert.deepEqual(pendingOf(ws), {}, "marcatore della chiamata chiuso");
  const s = snapOf(ws);
  assert.equal(s.names?.[t.lastLink], "Report 399", JSON.stringify(s).slice(0, 300));
  assert.equal(s.names?.[t.button], "Nuovo report");
  assert.notEqual(s.unusable, true);
  noBase64(ws);
  const c = g(DT + "click", { uid: t.lastLink });
  assert.ok(ok(c), reasonOf(c));
});

test("1+3: snapshot su file (filePath) oltre 32 MB pieno di base64 — letto come lettura completa, base64 omesso, click consentito", { timeout: 120000 }, () => {
  const { ws, url, g } = explore("preprod", "ESPLORA PREPROD");
  const t = heavyTree(url, { n: 400, kb: 20, hugeMb: 26 });
  assert.ok(t.text.length > 32 * 1024 * 1024);
  const file = join(sessDir(ws), "snapshots", "launchpad.txt");
  const id = `toolu_gd_${++seq}`;
  const ti = { filePath: file };
  runHook("guard-environment", { session_id: "sess-1", cwd: ws, hook_event_name: "PreToolUse", tool_name: DT + "take_snapshot", tool_input: ti, tool_use_id: id }, E(ws));
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, t.text);
  const i = input(ws, DT + "take_snapshot", ti, `# take_snapshot response\nSaved snapshot to ${file}.`, id);
  runHook("browser-origin", i, E(ws));
  const r = runHook("observe-append", i, E(ws));
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.json?.systemMessage, `avviso dell'hook: ${r.json?.systemMessage}`);
  console.log(`observe-append, file di ${(t.text.length / 1e6).toFixed(1)} MB: ${r.ms.toFixed(0)} ms`);
  assert.deepEqual(pendingOf(ws), {});
  assert.equal(snapOf(ws).names?.[t.lastLink], "Report 399");
  noBase64(ws);
  const c = g(DT + "click", { uid: t.lastLink });
  assert.ok(ok(c), reasonOf(c));
});

test("1: i data URI si tolgono senza toccare i ref (uid, [ref], token nascosti dopo + o / restano contati)", async () => {
  const { stripDataUris } = await import("../../scripts/chrome/snapshot-parse.mjs");
  const s = `uid=1_2 image "Foto" url="data:image/png;base64,${"QUJD".repeat(100)}=="\nuid=1_3 link "Vai"`;
  const out = stripDataUris(s);
  assert.ok(!out.includes("QUJDQUJD"));
  assert.match(out, /uid=1_2 image "Foto" url="data:…\(base64 omesso\)"\nuid=1_3 link "Vai"/);
  assert.equal(stripDataUris(out), out, "idempotente");
  // un token di ref dentro una sequenza simile al base64 (dopo un carattere non di parola) non si nasconde
  const forged = `uid=1_2 image "x" url="data:image/png;base64,AAAA+uid=1_3"\nuid=1_3 link "Vai"`;
  assert.equal(stripDataUris(forged), forged);
  // nessun a capo inghiottito
  assert.equal(stripDataUris("a data:x;base64,QUJD\n  uid=1_4 b"), "a data:…(base64 omesso)\n  uid=1_4 b");
});

test("1: data URI lunghi NON in base64 (svg percent-encoded, base64url) si omettono; il logo di una sola riga da ~555.000 caratteri non blocca", async () => {
  const { stripDataUris } = await import("../../scripts/chrome/snapshot-parse.mjs");
  const svg = `data:image/svg+xml;utf8,${"%3Cpath%20d%3D%22M0%200L1%201%22%2F%3E".repeat(15000)}`;
  const out = stripDataUris(`uid=1_15 image "Logo" url="${svg}"\nuid=1_16 link "Vai"`);
  assert.equal(out, `uid=1_15 image "Logo" url="data:…(base64 omesso)${svg.slice(-40)}"\nuid=1_16 link "Vai"`);
  assert.equal(stripDataUris(`uid=1_2 image "x" url="data:image/png;base64,${"A-_b".repeat(100)}"`), `uid=1_2 image "x" url="data:…(base64 omesso)"`);
  assert.equal(stripDataUris(`uid=1_3 link "data:corto"`), `uid=1_3 link "data:corto"`);
  const { ws, url, g } = explore("preprod", "ESPLORA PREPROD");
  const r = post(ws, DT + "take_snapshot", {}, inline(`uid=1_0 RootWebArea "Analytics" url="${url}"\n  uid=1_15 image "Logo" url="${svg}"\n  uid=1_16 button "New Report"\n`));
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(pendingOf(ws), {});
  assert.ok(ok(g(DT + "click", { uid: "1_16" })));
});

// 2 ----------------------------------------------------------------------------------------------------------------------
test("1: una parola di cancellazione nel mezzo di un data URI lungo non si perde", async () => {
  const { stripDataUris } = await import("../../scripts/chrome/snapshot-parse.mjs");
  const { isDeleteLabel } = await import("../../hooks/lib/effect-labels.mjs");
  const v = `data:text/plain,${"a".repeat(300)} Elimina ${"b".repeat(300)}`;
  assert.ok(isDeleteLabel(stripDataUris(`uid=1_2 button "${v}"`)));
});

test("2: marcatore rimasto da una chiamata non registrata ⇒ click negato; una lettura completa riuscita della stessa scheda lo chiude ⇒ click consentito (anche il marcatore del cliente)", () => {
  const { ws, url, g } = explore("preprod", "ESPLORA PREPROD");
  const tree = `uid=1_0 RootWebArea "Analytics Launchpad" url="${url}"\n  uid=1_1 link "Report 1"\n  uid=1_2 button "Nuovo report"\n`;
  post(ws, DT + "take_snapshot", {}, inline(tree));
  assert.ok(ok(g(DT + "click", { uid: "1_1" })));
  lost(ws, DT + "take_snapshot", {});
  lost(ws, DT + "take_snapshot", {});
  assert.equal(Object.keys(pendingOf(ws)).length, 2);
  // 28/10/2026: in esplorazione il marcatore non nega più il click (decisione dell'utente)
  const d = g(DT + "click", { uid: "1_1" });
  assert.ok(ok(d), reasonOf(d));
  post(ws, DT + "take_snapshot", {}, inline(tree));
  assert.deepEqual(pendingOf(ws), {}, "marcatori della scheda chiusi dalla lettura completa");
  assert.deepEqual(customerPending(ws), {}, "anche quelli del cliente");
  const c = g(DT + "click", { uid: "1_1" });
  assert.ok(ok(c), reasonOf(c));
});

test("2: la guarigione vale solo per la famiglia e la scheda lette — le altre schede restano negate; una lettura parziale non guarisce", () => {
  const { ws, url, g } = explore("sandbox", "ESPLORA SANDBOX");
  patchSession(ws, (s) => { s.browser.tab = "101"; });
  const ctx = (tab, u = url) => `\n\nTab Context:\n- Executed on tabId: ${tab}\n- Available tabs:\n  • tabId ${tab}: "ACME" (${u})`;
  const page = (tab) => [{ type: "text", text: `menuitem "Ordini" [ref_3]\nmenuitem "Fatture" [ref_4]\n\nViewport: 490x417` }, { type: "text", text: ctx(tab) }];
  post(ws, CL + "navigate", { url, tabId: 101 }, [{ type: "text", text: `Navigated to ${url}` }, { type: "text", text: ctx(101) }]);
  post(ws, CL + "read_page", { tabId: 101 }, page(101));
  assert.ok(ok(g(CL + "computer", { action: "left_click", ref: "ref_3", tabId: 101 })));
  lost(ws, CL + "read_page", { tabId: 101 }, page(101));
  lost(ws, CL + "read_page", { tabId: 202 }, page(202));
  assert.ok(ok(g(CL + "computer", { action: "left_click", ref: "ref_3", tabId: 101 })), "28/10/2026: il marcatore non nega più il click in esplorazione");
  // una lettura ristretta (parziale) non ricostruisce la mappa: il marcatore resta
  post(ws, CL + "read_page", { tabId: 101, ref_id: "ref_1" }, [{ type: "text", text: `menuitem "Ordini" [ref_3]` }, { type: "text", text: ctx(101) }]);
  assert.ok(Object.values(pendingOf(ws)).some((v) => v.tab === "cl|101"), JSON.stringify(pendingOf(ws)));
  post(ws, CL + "read_page", { tabId: 101 }, page(101));
  const left = Object.values(pendingOf(ws)).map((v) => v.tab);
  assert.deepEqual(left, ["cl|202"], "resta solo il marcatore dell'altra scheda");
  const c = g(CL + "computer", { action: "left_click", ref: "ref_3", tabId: 101 });
  assert.ok(ok(c), reasonOf(c));
});

test("2: un navigate riuscito a un URL DIVERSO (anche con frammento) chiude i marcatori della scheda; allo stesso URL no", () => {
  const { ws, url } = explore("preprod", "ESPLORA PREPROD");
  const tree = `uid=1_0 RootWebArea "Analytics Launchpad" url="${url}"\n  uid=1_1 link "Report 1"\n`;
  post(ws, DT + "take_snapshot", {}, inline(tree));
  lost(ws, DT + "take_snapshot", {});
  post(ws, DT + "navigate_page", { type: "url", url }, navResponse(DT + "navigate_page", url));
  assert.equal(Object.keys(pendingOf(ws)).length, 1, "stesso URL: il marcatore resta");
  const other = "https://acme-pre.jaggaer.com/esop/analysis-console/ac/analysisnew.do#savedReports";
  post(ws, DT + "navigate_page", { type: "url", url: other }, navResponse(DT + "navigate_page", other));
  assert.deepEqual(pendingOf(ws), {});
  assert.deepEqual(customerPending(ws), {});
});

// 3 ----------------------------------------------------------------------------------------------------------------------
test("3: nessun limite in byte — mappa e storia grandi restano usabili; tolti i limiti esportati", async () => {
  const m = await import("../../hooks/lib/observe-append.mjs");
  const { classify } = await import("../../hooks/lib/browser-tools.mjs");
  assert.equal(m.MAP_MAX_BYTES, undefined);
  assert.equal(m.HISTORY_MAX_BYTES, undefined);
  assert.equal(m.SNAPSHOT_FILE_MAX_BYTES, undefined);
  const call = classify(DT + "take_snapshot", {});
  const refs = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`1_${i}`, null]));
  const names = Object.fromEntries(Object.keys(refs).map((r) => [r, `Voce ${r}`]));
  const base = { call, obs: "O1", ts: "t", envType: "preprod", mode: "complete", refs, pageUrl: "https://u", labels: Object.keys(refs).map((r) => [r, `k${r}`]), labelLoc: { url: "https://u" }, names, verified: Object.keys(refs), key: "u:x" };
  const r = m.nextBinding({}, { v: 1, tabs: {} }, { ...base, limits: { mapBytes: 500, histBytes: 500 } });
  assert.equal(r.browser.snapshot.unusable, undefined);
  assert.equal(Object.keys(r.browser.snapshot.names).length, 50);
  assert.ok(Object.values(r.hist.tabs).every((t) => t.full !== true));
  const guard = readFileSync(join(ROOT, "hooks/lib/guards/config-scope.mjs"), "utf8");
  assert.doesNotMatch(guard, /unusable|troppo grande per essere mappata/);
});

// 4 ----------------------------------------------------------------------------------------------------------------------
test("4: observe-append ha 60 s in hooks.json e non abbandona uno stdin lento (oltre 3 s)", { timeout: 60000 }, async () => {
  const hooks = JSON.parse(readFileSync(join(ROOT, "hooks/hooks.json"), "utf8"));
  const oa = Object.values(hooks.hooks).flat().flatMap((g0) => g0.hooks).filter((h) => h.command.includes("/observe-append.mjs"));
  assert.ok(oa.length >= 1 && oa.every((h) => h.timeout === 60), JSON.stringify(oa));
  const { ws, url } = explore("preprod", "ESPLORA PREPROD");
  const i = input(ws, DT + "take_snapshot", {}, inline(`uid=1_0 RootWebArea "Analytics Launchpad" url="${url}"\n  uid=1_1 link "Report 1"\n`));
  runHook("browser-origin", i, E(ws));
  const res = await new Promise((resolve) => {
    const p = spawn(process.execPath, [hookScript("observe-append")], { env: cleanEnv(E(ws)) });
    let out = "";
    p.stdout.on("data", (c) => { out += c; });
    p.on("close", (code) => resolve({ code, out }));
    const raw = JSON.stringify(i);
    p.stdin.write(raw.slice(0, 100));
    setTimeout(() => { p.stdin.end(raw.slice(100)); }, 3500);
  });
  assert.equal(res.code, 0);
  assert.doesNotMatch(res.out, /stdin non chiuso/);
  assert.deepEqual(pendingOf(ws), {});
  assert.equal(snapOf(ws).names?.["1_1"], "Report 1");
});

// 5 ----------------------------------------------------------------------------------------------------------------------
test("5: guasto della registrazione (DB delle OBS illeggibile) — avviso, ma marcatore chiuso, mappa scritta e click consentito", () => {
  const { ws, url, g } = explore("preprod", "ESPLORA PREPROD");
  mkdirSync(join(ws, "customers/ACME/knowledge.db"), { recursive: true });   // il DB non si apre
  const tree = `uid=1_0 RootWebArea "Analytics Launchpad" url="${url}"\n  uid=1_1 link "Report 1"\n  uid=1_2 button "Nuovo report"\n`;
  const r = post(ws, DT + "take_snapshot", {}, inline(tree));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.json?.systemMessage ?? "", /OBS non registrata/);
  assert.deepEqual(pendingOf(ws), {}, "marcatore chiuso");
  assert.deepEqual(customerPending(ws), {});
  assert.equal(snapOf(ws).names?.["1_1"], "Report 1");
  const c = g(DT + "click", { uid: "1_1" });
  assert.ok(ok(c), reasonOf(c));
});
