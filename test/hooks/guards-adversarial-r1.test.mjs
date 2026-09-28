// Fix round 1 (review WP03): ogni caso riproduce l'input del revisore.
// Contesto: mkWs() + seedSession(ws), env CLAUDE_PROJECT_DIR=<ws>,
// input { session_id: "sess-1", cwd: <ws>, agent_id: "a1", agent_type: "scope-expert" }, sessione ACME×CAT.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { symlinkSync, mkdirSync, writeFileSync, appendFileSync, mkdtempSync, realpathSync, readFileSync } from "node:fs";
import { mkWs, seedSession, runHook, decisionOf, reasonOf, ROOT } from "../helpers/hook-env.mjs";

const IS_WIN = process.platform === "win32";
const readFile = (f) => readFileSync(f, "utf8");
const SUB = { agent_id: "a1", agent_type: "scope-expert" };
const call = (guard, ws, tool, tool_input, extra = SUB) =>
  runHook(guard, { session_id: "sess-1", cwd: ws, hook_event_name: "PreToolUse", tool_name: tool, tool_input, ...extra }, { CLAUDE_PROJECT_DIR: ws, CLAUDE_PLUGIN_ROOT: ROOT });
const denied = (r) => decisionOf(r) === "deny";
const silent = (r) => r.status === 0 && r.stdout.trim() === "";
const GUARDS = ["guard-domain-boundary", "guard-scope", "guard-customer"];
const setup = (o) => { const ws = mkWs(); seedSession(ws, o); return ws; };
const noDrive = (p) => p.replace(/^[A-Za-z]:/, "").replace(/\//g, "\\");

test("#1 prefissi di dispositivo non in forma X:\\ (Volume{GUID}, GLOBALROOT, //./) → deny da tutti i guard", () => {
  const ws = setup();
  const adm = join(ws, "customers/ACME/kb/scopes/ADM/configs/C.ACME.ADM.CFG.0019.yaml");
  const forms = [
    `\\\\?\\Volume{12345678-1234-1234-1234-123456789abc}${noDrive(adm)}`,
    `\\\\.\\Volume{12345678-1234-1234-1234-123456789abc}${noDrive(adm)}`,
    `\\\\?\\GLOBALROOT\\Device\\HarddiskVolume3${noDrive(adm)}`,
    `//?/Volume{12345678-1234-1234-1234-123456789abc}${noDrive(adm).replace(/\\/g, "/")}`,
    `//./Volume{12345678-1234-1234-1234-123456789abc}${noDrive(adm).replace(/\\/g, "/")}`,
  ];
  for (const f of forms) for (const g of GUARDS) assert.ok(denied(call(g, ws, "Read", { file_path: f })), `${g} ${f}`);
  const prod = `\\\\?\\Volume{12345678-1234-1234-1234-123456789abc}${noDrive(join(ws, "product/kb/x.yaml"))}`;
  assert.ok(denied(call("guard-scope", ws, "Write", { file_path: prod, content: "x" })));
  if (IS_WIN) {
    assert.ok(silent(call("guard-scope", ws, "Read", { file_path: `\\\\?\\${join(ws, "customers/ACME/kb/scopes/CAT/flows/C.ACME.CAT.FLW.0001.yaml")}` })), "\\\\?\\C:\\ resta valutato normalmente");
    assert.ok(denied(call("guard-scope", ws, "Read", { file_path: `\\\\?\\${adm}` })));
  }
});

test("#2 UNC (share amministrativa) → deny da tutti i guard; percorsi assoluti fuori dal workspace con segmenti governati → deny", () => {
  const ws = setup();
  const adm = join(ws, "customers/ACME/kb/scopes/ADM/configs/C.ACME.ADM.CFG.0019.yaml");
  const unc = IS_WIN ? `\\\\localhost\\${adm[0]}$${adm.slice(2)}` : `\\\\localhost\\share${adm.replace(/\//g, "\\")}`;
  for (const g of GUARDS) assert.ok(denied(call(g, ws, "Read", { file_path: unc })), `${g} ${unc}`);
  assert.ok(denied(call("guard-scope", ws, "Read", { file_path: `\\\\?\\UNC\\localhost\\C$\\x\\customers\\ACME\\kb\\scopes\\ADM\\x.yaml` })));
  assert.ok(denied(call("guard-scope", ws, "Write", { file_path: unc.replace(/customers.*$/, "product\\kb\\x.yaml"), content: "x" })));
  const other = realpathSync.native(mkdtempSync(join(tmpdir(), "copy-")));
  assert.ok(denied(call("guard-scope", ws, "Read", { file_path: join(other, "customers/ACME/kb/scopes/ADM/configs/x.yaml") })), "copia fuori dal workspace, altro scope");
  assert.ok(denied(call("guard-domain-boundary", ws, "Read", { file_path: join(other, "customers/ACME/analysis/patterns/x.yaml") })));
  assert.ok(denied(call("guard-scope", ws, "Write", { file_path: join(other, "product/kb/x.yaml"), content: "x" })));
});

test("#3 segmento inesistente seguito da .. e da una junction verso un altro cliente → deny", (t) => {
  const ws = setup();
  const j = join(ws, "customers/ACME/lessons/j");
  try { symlinkSync(join(ws, "customers/BETA/kb"), j, IS_WIN ? "junction" : "dir"); } catch (err) { t.skip(`symlink non consentito: ${err.code}`); return; }
  const sep = IS_WIN ? "\\" : "/";
  const p = [ws, "customers", "ACME", "lessons", "nonexist", "..", "j", "scopes", "CAT", "secret.yaml"].join(sep);
  assert.ok(denied(call("guard-customer", ws, "Read", { file_path: p })), p);
  assert.ok(denied(call("guard-scope", ws, "Read", { file_path: p })), p);
});

test("#4 un sub-agente non invoca session.mjs in nessuna forma; la sessione principale può use budget", () => {
  const ws = setup();
  const bash = (command, extra = SUB) => runHook("guard-budget", { session_id: "sess-1", cwd: ws, tool_name: "Bash", tool_input: { command }, ...extra }, { CLAUDE_PROJECT_DIR: ws, CLAUDE_PLUGIN_ROOT: ROOT });
  for (const c of [
    "node scripts/admin/session.mjs --json use budget 9999999",
    "node scripts/admin/session.mjs --json use scope ADM",
    `node "${ROOT}/scripts/admin/session.mjs" show --json`,
    "node scripts/admin/sess*.mjs use budget 1",
    "node scripts/admin/sess?on.mjs use budget 1",
    "node -e \"import('./scripts/admin/session.mjs')\"",
    "node scripts\\admin\\session.mjs --session x use budget 5",
  ]) assert.ok(denied(bash(c)), c);
  assert.ok(silent(bash(`node "${ROOT}/scripts/admin/session.mjs" use budget 300000 --json`, {})));
});

test("#5 sub-agente: ricerca ricorsiva su un antenato della cella via shell → deny; cd + token senza slash", () => {
  const ws = setup();
  for (const c of ["grep -r CFG customers/ACME/kb", "cd customers/ACME/kb && grep -r CFG scopes", "grep -rn x product", "cd customers/ACME/kb/scopes && ls"]) {
    assert.ok(denied(call("guard-scope", ws, "Bash", { command: c })), c);
  }
  for (const c of ["grep -r CFG customers/ACME/kb/scopes/CAT", "cat customers/ACME/lessons/x.md", "ls", "cd customers/ACME/kb/scopes/CAT && ls flows", "node scripts/kb/kb.mjs find --scope CAT --json"]) {
    assert.ok(silent(call("guard-scope", ws, "Bash", { command: c })), c);
  }
});

test("#6 scrittura negata a tutti su audit, blackboard, session.json ovunque, .jvc/**", () => {
  const ws = setup();
  for (const f of ["customers/ACME/audit/2026-09.jsonl", "customers/ACME/.sessions/sess-1/blackboard/MSG.x.yaml", "customers/ACME/lessons/session.json", ".jvc/current-session", "customers/ACME/.sessions/other/blackboard/y.yaml"]) {
    for (const extra of [SUB, {}]) assert.ok(denied(call("guard-scope", ws, "Write", { file_path: join(ws, f), content: "x" }, extra)), f);
  }
});

test("#7 scrittura in customers/*/kb/** negata a tutti (§29.6); _inbox, tests, runs, lessons, reports, evidence, observations restano scrivibili nella cella", () => {
  const ws = setup();
  for (const extra of [SUB, {}]) {
    assert.ok(denied(call("guard-scope", ws, "Write", { file_path: join(ws, "customers/ACME/kb/scopes/CAT/flows/C.ACME.CAT.FLW.0002.yaml"), content: "id: x\n" }, extra)));
    assert.ok(denied(call("guard-scope", ws, "Edit", { file_path: join(ws, "customers/ACME/kb/handoffs/C.ACME.XSC.HND.0004.yaml"), old_string: "a", new_string: "b" }, extra)));
  }
  for (const f of ["_inbox/CAT/x.md", "tests/cases/CAT/NRT.ACME.CAT.NEG.0031.yaml", "runs/RUN.ACME.20260922.1115.ADM/x.json", "lessons/L.ACME.CAT.LSN.0090.md", "reports/r.md", "evidence/e.png", "observations/o.yaml"]) {
    assert.ok(silent(call("guard-scope", ws, "Write", { file_path: join(ws, "customers/ACME", f), content: "x" })), f);
  }
});

test("#8 use scope/use customer negati mentre ci sono sotto-compiti aperti", () => {
  const ws = setup();
  const inv = join(ws, "customers/ACME/.sessions/sess-1/invocations.jsonl");
  appendFileSync(inv, `${JSON.stringify({ ts: new Date().toISOString(), task_id: "MSG.sess-1.0001", subagent_type: "scope-expert", budget_tokens: 1000 })}\n`);
  const bash = (command) => runHook("guard-budget", { session_id: "sess-1", cwd: ws, tool_name: "Bash", tool_input: { command } }, { CLAUDE_PROJECT_DIR: ws, CLAUDE_PLUGIN_ROOT: ROOT });
  for (const c of [`node "${ROOT}/scripts/admin/session.mjs" use scope ADM --json`, `node "${ROOT}/scripts/admin/session.mjs" use customer BETA --json`]) {
    const r = bash(c);
    assert.ok(denied(r), c);
    assert.match(reasonOf(r), /attendi la chiusura dei sotto-compiti aperti/);
  }
  assert.ok(silent(bash(`node "${ROOT}/scripts/admin/session.mjs" use budget 300000 --json`)));
  const ws2 = setup();
  appendFileSync(join(ws2, "customers/ACME/.sessions/sess-1/invocations.jsonl"), `${JSON.stringify({ ts: new Date().toISOString(), task_id: "MSG.sess-1.0001", subagent_type: "scope-expert" })}\n`);
  const f = join(ws2, "customers/ACME/.sessions/sess-1/session.json");
  const s = JSON.parse(readFile(f)); s.ledger.invocations.push({ agent_id: "a1", task_id: "MSG.sess-1.0001" }); writeFileSync(f, JSON.stringify(s));
  assert.ok(silent(runHook("guard-budget", { session_id: "sess-1", cwd: ws2, tool_name: "Bash", tool_input: { command: `node "${ROOT}/scripts/admin/session.mjs" use scope ADM` } }, { CLAUDE_PROJECT_DIR: ws2, CLAUDE_PLUGIN_ROOT: ROOT })), "compito chiuso: consentito");
});

test("#12 handoff nominati per codice: Read consentita se lo YAML dichiara lo scope attivo; altrimenti, YAML rotto o > 64 KB → deny", () => {
  const ws = setup();
  const h = (name, text) => { const f = join(ws, "customers/ACME/kb/handoffs", name); writeFileSync(f, text); return f; };
  const ok = h("C.ACME.XSC.HND.0004.yaml", "id: C.ACME.XSC.HND.0004\nfrom_scope: CAT\nto_scope: ADM\ncontract: strict_import\n");
  const ok2 = h("C.ACME.XSC.HND.0005.yaml", "id: C.ACME.XSC.HND.0005\nscopes: [SRC, CAT]\n");
  const other = h("C.ACME.XSC.HND.0006.yaml", "id: C.ACME.XSC.HND.0006\nfrom_scope: SRC\nto_scope: ADM\n");
  const broken = h("C.ACME.XSC.HND.0007.yaml", "from_scope: [CAT\n: :");
  const big = h("C.ACME.XSC.HND.0008.yaml", `from_scope: CAT\nnote: "${"x".repeat(70 * 1024)}"\n`);
  assert.ok(silent(call("guard-scope", ws, "Read", { file_path: ok })));
  assert.ok(silent(call("guard-scope", ws, "Read", { file_path: ok2 })));
  for (const f of [other, broken, big]) assert.ok(denied(call("guard-scope", ws, "Read", { file_path: f })), f);
  mkdirSync(join(ws, "product/kb/handoffs"), { recursive: true });
  writeFileSync(join(ws, "product/kb/handoffs/S.STD.XSC.HND.0001.yaml"), "to_scope: CAT\n");
  assert.ok(silent(call("guard-scope", ws, "Read", { file_path: join(ws, "product/kb/handoffs/S.STD.XSC.HND.0001.yaml") })));
});

test("#13 senza cliente l'eccezione vale solo per lo session.mjs del plugin", () => {
  const ws = setup({ customer: null });
  assert.ok(silent(call("guard-customer", ws, "Bash", { command: `node "${join(ROOT, "scripts/admin/session.mjs")}" use customer ACME --new --json` }, {})));
  for (const c of ["node ./session.mjs use customer ACME customers/BETA/kb", "node C:/evil/scripts/admin/session.mjs use customer ACME customers/BETA", "node session.mjs use customer ACME customers/ACME/x"]) {
    assert.ok(denied(call("guard-customer", ws, "Bash", { command: c }, {})), c);
  }
});

test("#16 session.json o puntatore corrotti: il comando di riparazione passa, tutto il resto è negato", () => {
  const ws = setup();
  writeFileSync(join(ws, "customers/ACME/.sessions/sess-1/session.json"), "{rotto");
  const repair = [`node "${join(ROOT, "scripts/admin/session.mjs")}" use customer ACME --json`, `node "${join(ROOT, "scripts/admin/session.mjs")}" show --json`];
  for (const g of ["guard-customer", "guard-scope", "guard-budget", "guard-domain-boundary"]) {
    for (const c of repair) assert.ok(silent(call(g, ws, "Bash", { command: c }, {})), `${g}: ${c}`);
    assert.ok(denied(call(g, ws, "Bash", { command: "cat customers/ACME/lessons/x" }, {})) || g === "guard-domain-boundary", g);
  }
  for (const g of GUARDS) assert.ok(denied(call(g, ws, "Read", { file_path: join(ws, "customers/ACME/lessons/x.md") }, {})), g);
  assert.ok(denied(call("guard-customer", ws, "Bash", { command: `${repair[0]}; cat customers/BETA/x` }, {})), "niente concatenazioni");
  const ws2 = setup();
  writeFileSync(join(ws2, ".jvc/sessions/sess-1.json"), "{rotto");
  assert.ok(silent(call("guard-customer", ws2, "Bash", { command: repair[0] }, {})));
  assert.ok(denied(call("guard-customer", ws2, "Read", { file_path: join(ws2, "customers/ACME/lessons/x.md") }, {})));
});
