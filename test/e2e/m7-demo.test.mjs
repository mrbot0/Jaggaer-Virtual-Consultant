// K6 — criterio di uscita M7 (simulato): un intento in linguaggio naturale esegue ACT-OBS + ACT-CREATE sul
// tenant demo con workflow visibile, OBS automatiche, un ERR riconosciuto, RPT ed esito classificato; budget
// rispettato. Le chiamate MCP sono simulate con risultati pre-registrati (test/fixtures/demo-tenant/mcp/) e
// passano dai VERI hook (processi separati): PreToolUse guard-environment · guard-production ·
// guard-config-scope; PostToolUse browser-origin · observe-append · audit-append. Gli script (step-check,
// capture, workflow, build-report) girano come CLI, come li chiama l'agente.
import { test } from "node:test";
import { copyFileSync as copyPage } from "node:fs";
import assert from "node:assert/strict";
import { join } from "node:path";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import YAML from "yaml";
import { mkWs, seedSession, runHook, runSessionCli, decisionOf, reasonOf, cleanEnv, ROOT } from "../helpers/hook-env.mjs";
import { readSession, writePlan, writeSel } from "../helpers/env-fixture.mjs";
import { parseIntent } from "../../scripts/decide/intent.mjs";
import { validatePlan } from "../../scripts/decide/validate-plan.mjs";
import { estimateTask, checkRemaining } from "../../scripts/decide/budget.mjs";
import { verifyChain, auditFile } from "../../hooks/lib/audit.mjs";
import { encodePng } from "../../scripts/chrome/png.mjs";

const S = "https://acme-sbx.jaggaer.com";
const MCP = join(ROOT, "test/fixtures/demo-tenant/mcp");
const PLAN = "PLAN.ACME.M7.0001";
const DT = "mcp__chrome-devtools__";
const PRE = ["guard-environment", "guard-production", "guard-config-scope"];
const POST = ["browser-origin", "observe-append", "audit-append"];

// revisione finale: i file d'ingresso degli script stanno nel workspace degli hook (JVC_WORKSPACE): la pagina osservata dall'agente è salvata nel workspace
const pageIn = (ws, env) => { const rel = `customers/ACME/config/${env}.page.json`; copyPage(join(ROOT, `test/fixtures/env/pages/${env}.json`), join(ws, rel)); return rel; };

test("M7 — intento → ACT-OBS + ACT-CREATE sul tenant demo: guard, OBS, ERR riconosciuto, step-check, workflow, evidenza, RPT classificato, budget", () => {
  // ---- tenant demo: cliente ACME, sandbox dichiarata (use env) e verificata (env-check) ----
  const ws = mkWs();
  seedSession(ws, { scope: "P2P" });
  mkdirSync(join(ws, "customers/ACME/config"), { recursive: true });
  copyFileSync(join(ROOT, "test/fixtures/env/environments.yaml"), join(ws, "customers/ACME/config/environments.yaml"));
  const E = { JVC_WORKSPACE: ws, CLAUDE_PLUGIN_ROOT: ROOT, JVC_SESSION_ID: "sess-1" };
  for (const args of [["use", "customer", "ACME"], ["use", "scope", "P2P"], ["use", "mode", "ops"], ["use", "env", "sandbox"]]) {
    const r = runSessionCli([...args, "--session", "sess-1", "--json"], E);
    assert.equal(r.status, 0, `${args.join(" ")}: ${r.stdout}${r.stderr}`);
  }
  const node = (script, args) => spawnSync(process.execPath, [join(ROOT, script), ...args], { encoding: "utf8", env: cleanEnv(E) });
  const chk = node("scripts/chrome/env-check.mjs", ["--customer", "ACME", "--env", "sandbox", "--snapshot", pageIn(ws, "sandbox"), "--write-session", "--session", "sess-1", "--json"]);
  assert.equal(chk.status, 0, chk.stdout + chk.stderr);
  const code = readSession(ws).session_code;
  assert.match(code, /^SES\.ACME\.\d{8}\.001$/);

  // ---- 1. intento → DT-026 ----
  const intent = "Su ACME sandbox crea una RdA di prova per 5 sedie da catalogo, CdC IT-0442, lasciala in bozza";
  const it = parseIntent(intent, { customers: ["ACME", "BETA"] });
  assert.equal(it.outcome, "avvia"); assert.deepEqual(it.actions, ["ACT-OBS", "ACT-CREATE"]);
  assert.equal(it.env, "sandbox"); assert.equal(it.stop_at, "bozza"); assert.equal(it.data.cost_center, "IT-0442");

  // ---- 2. Atlas e piano con traccia attesa, validato contro catalogo e ambiente ----
  for (const [c, role, label, effect] of [["C.ACME.P2P.SEL.0048", "textbox", "Descrizione", "write"], ["C.ACME.P2P.SEL.0049", "textbox", "Articolo", "write"],
    ["C.ACME.P2P.SEL.0045", "spinbutton", "Quantità", "write"], ["C.ACME.P2P.SEL.0044", "textbox", "Centro di costo", "write"],
    ["C.ACME.P2P.SEL.0120", "button", "Salva bozza", "write"], ["C.ACME.P2P.SEL.0121", "status", "Bozza salvata", "read"],
    ["C.ACME.P2P.SEL.0050", "search_box", "Cerca", "read"]]) writeSel(ws, c, { role, label, effect });
  // WP07 giro 1 (C2 c): ogni input/click è legato al SEL del passo attivo ⇒ un passo FILL per campo
  const fill = (n, sel, data, value) => ({ n, verb: "FILL", action_class: "ACT-CREATE", target: sel, data, expect: { elements: [{ sel, value }], messages: [] } });
  const plan = {
    plan_id: PLAN, customer: "ACME", env: "sandbox", goal: "RdA di prova per 5 sedie da catalogo, CdC IT-0442, in bozza", strategy: "STR-VERIFY-FIRST",
    steps: [
      { n: 1, verb: "NAVIGATE", action_class: "ACT-OBS", target: { url_pattern: `${S}/cat/search?q=sedie` }, expect: { page_sig: "cat/search", messages: [] } },
      { n: 2, verb: "NAVIGATE", action_class: "ACT-CREATE", target: { url_pattern: `${S}/p2p/requisition/new?item=4711` }, expect: { page_sig: "p2p/requisition/new", elements: [{ sel: "C.ACME.P2P.SEL.0044", required: true }] } },
      fill(3, "C.ACME.P2P.SEL.0048", "RdA di prova - 5 sedie", "RdA di prova - 5 sedie"),
      fill(4, "C.ACME.P2P.SEL.0045", "5", "5"),
      fill(5, "C.ACME.P2P.SEL.0044", "IT-0442", "IT-0442"),
      { n: 6, verb: "SAVE", action_class: "ACT-CREATE", target: "C.ACME.P2P.SEL.0120", expect: { toast: "C.ACME.P2P.SEL.0121", page_sig: "p2p/requisition/edit" } },
    ],
    evidence: [{ at: 6, kind: "assertion", capture: "region", region: "C.ACME.P2P.SEL.0044", caption: "Bozza salvata con CdC IT-0442", redact: "standard" }],
    compensations: [{ step: 6, kind: "cancel", entity: "requisition", action: "requisition.cancel" }],
    repair_policy: { skip_allowed: [], substitute_allowed: [], abort_on: [] },
  };
  assert.deepEqual(validatePlan(plan, { env: { id: "sandbox", type: "sandbox" } }).errors, []);
  const planFile = writePlan(ws, plan, "RUN.ACME.20260922.1105.ADM");

  // ---- 3. budget: stima del compito (somma delle classi + 20%) nel residuo; guard-budget consente il dispatch ----
  const est = estimateTask(plan, readSession(ws).env);
  assert.equal(est.tokens, 24000);
  assert.equal(checkRemaining(readSession(ws), est.tokens).ok, true);
  const prompt = `\`\`\`yaml\n${YAML.stringify({ task_id: "M7-T1", customer: "ACME", scope: "P2P", allowed_paths: ["customers/ACME/**"], actions: ["ACT-OBS", "ACT-CREATE"], budget: { tokens: est.tokens } }).trim()}\n\`\`\`\n\nEsegui il piano ${PLAN}`;
  const disp = runHook("guard-budget", { session_id: "sess-1", cwd: ws, hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: { subagent_type: "p2p-expert", prompt } }, E);
  assert.equal(disp.stdout.trim(), "", reasonOf(disp));

  // ---- helper: chiamata MCP con i veri hook; snapshot salvato su file come fa l'agente ----
  const obsLines = [];
  const call = (op, input, text) => {
    const tool = DT + op;
    const pre = PRE.map((g) => ({ g, r: runHook(g, { session_id: "sess-1", cwd: ws, hook_event_name: "PreToolUse", tool_name: tool, tool_input: input }, E) }));
    const denied = pre.filter(({ r }) => decisionOf(r) === "deny").map(({ g, r }) => `${g}: ${reasonOf(r)}`);
    if (denied.length) return { denied };
    for (const h of POST) {
      const r = runHook(h, { session_id: "sess-1", cwd: ws, hook_event_name: "PostToolUse", tool_name: tool, tool_input: input, tool_response: [{ type: "text", text }] }, E);
      assert.equal(r.status, 0, `${h}: ${r.stderr}`);
      const ctx = r.json?.hookSpecificOutput?.additionalContext;
      if (h === "observe-append") { assert.match(ctx ?? "", /^OBS L\.ACME\.P2P\.OBS\.\d{4}/, r.stdout + r.stderr); obsLines.push(ctx); }
    }
    return { denied: [], obs: obsLines.at(-1) };
  };
  const snapFile = (name) => { const f = join(ws, `customers/ACME/.sessions/sess-1/${name}.txt`); writeFileSync(f, readFileSync(join(MCP, `${name}.snapshot.txt`), "utf8")); return f; };
  const snapshot = (name) => call("take_snapshot", { pageId: 1 }, readFileSync(join(MCP, `${name}.snapshot.txt`), "utf8"));
  const stepCheck = (n, name) => { const r = node("scripts/decide/step-check.mjs", ["--plan", planFile, "--step", String(n), ...(name ? ["--snapshot", snapFile(name)] : []), "--json"]); assert.ok([0, 3].includes(r.status), r.stdout + r.stderr); return JSON.parse(r.stdout); };
  const wf = (kind, payload) => assert.equal(node("scripts/admin/workflow.mjs", ["event", "--kind", kind, "--payload", JSON.stringify(payload), "--json"]).status, 0);
  const navigate = (url, title) => call("navigate_page", { type: "url", url, pageId: 1 }, `Successfully navigated to ${url}.\n## Pages\n1: ${title} (${url}) [selected]`);
  const ok = (r) => assert.ok(["ok", "novelty"].includes(r.status), JSON.stringify(r));   // "Codice progetto" non è nell'Atlas: resta una novità

  wf("task_start", { task: "RdA di prova in bozza", steps: [
    { n: 1, agent: "cat-expert", class: "ACT-OBS", desc: "ricerca \"sedie\" a catalogo" }, { n: 2, agent: "p2p-expert", class: "ACT-CREATE", desc: "nuova richiesta dall'articolo" },
    { n: 3, agent: "p2p-expert", class: "ACT-CREATE", desc: "descrizione" }, { n: 4, agent: "p2p-expert", class: "ACT-CREATE", desc: "quantità: 5 sedie" },
    { n: 5, agent: "p2p-expert", class: "ACT-CREATE", desc: "centro di costo IT-0442" }, { n: 6, agent: "p2p-expert", class: "ACT-CREATE", desc: "salvataggio in bozza" } ] });

  // senza piano attivo un'azione con effetto è negata
  assert.ok(navigate(`${S}/cat/search?q=sedie`, "Catalogo - ACME SBX").denied.length === 0);
  assert.ok(call("click", { uid: "1_10", pageId: 1 }, "Successfully clicked").denied.some((d) => /nessun piano attivo/.test(d)));

  // ---- passo 1: ACT-OBS ----
  assert.equal(stepCheck(1).status, "ok");
  assert.equal(readSession(ws).active_plan.step, 1);
  wf("step_start", { n: 1 });
  assert.deepEqual(navigate(`${S}/cat/search?q=sedie`, "Catalogo - ACME SBX").denied, []);
  assert.equal(readSession(ws).browser.current_url, `${S}/cat/search?q=sedie`);
  assert.deepEqual(snapshot("catalog").denied, []);
  const r1 = stepCheck(1, "catalog");
  assert.equal(r1.status, "ok", JSON.stringify(r1.divergences));
  assert.match(r1.observation, /^L\.ACME\.P2P\.OBS\.\d{4}$/, "step-check cita l'OBS dell'ultimo risultato");
  wf("step_end", { n: 1, status: "ok", note: "3 articoli" });

  // ---- passo 2: nuova richiesta dall'articolo ----
  wf("step_start", { n: 2 });
  assert.deepEqual(navigate(`${S}/p2p/requisition/new?item=4711`, "Nuova richiesta - ACME SBX").denied, []);
  snapshot("new");
  assert.equal(stepCheck(2, "new").status, "novelty", "Codice progetto non è nell'Atlas: novità, non sorpresa");
  wf("step_end", { n: 2, status: "ok", note: "modulo aperto · novità: Codice progetto" });

  // ---- passi 3–5: compilazione, un campo per passo (uid legato al SEL del passo nell'ultimo snapshot) ----
  // un campo che non è quello del passo è negato
  assert.ok(call("fill", { uid: "2_15", value: "IT-0442", pageId: 1 }, "Successfully filled out the element").denied.some((d) => /non corrisponde al SEL del passo/.test(d)));
  for (const [n, uid, value, note] of [[3, "2_9", "RdA di prova - 5 sedie", "descrizione"], [4, "2_13", "5", "5 sedie"], [5, "2_15", "IT-0442", "CdC IT-0442"]]) {
    wf("step_start", { n });
    assert.deepEqual(call("fill", { uid, value, pageId: 1 }, "Successfully filled out the element").denied, [], `passo ${n}`);
    snapshot("filled");
    const r = stepCheck(n, "filled");
    ok(r);
    wf("step_end", { n, status: "ok", note });
  }
  assert.deepEqual(readSession(ws).pending.compensations.map((c) => [c.plan, c.step, c.action]), [[PLAN, 6, "requisition.cancel"]], "compensazione registrata PRIMA del passo che crea");

  // ---- passo 6: SAVE — primo tentativo: toast di validazione ⇒ ERR riconosciuto, sorpresa, passo fermo ----
  wf("step_start", { n: 6 });
  assert.deepEqual(call("click", { uid: "2_18", pageId: 1 }, "Successfully clicked on the element").denied, []);
  assert.equal(readSession(ws).browser.current_url, null, "un click senza marcatore rende ignota la pagina");
  const errObs = snapshot("save-error");
  assert.match(errObs.obs, /ERR:REQ-VAL-014/);
  assert.equal(readSession(ws).browser.current_url, `${S}/p2p/requisition/new?item=4711`, "lo snapshot ripristina l'origine osservata");
  const r6a = stepCheck(6, "save-error");
  assert.equal(r6a.status, "surprise"); assert.equal(r6a.proceed, false); assert.equal(r6a.compat, "incompatibile");
  wf("surprise", { n: 6, kind: r6a.kind });
  // l'ERR grezzo è su disco e nel DB
  const rawDir = join(ws, "customers/ACME/kb/scopes/P2P/errors/_raw");
  const raw = YAML.parse(readFileSync(join(rawDir, readdirSync(rawDir)[0]), "utf8"));
  assert.equal(raw.code, "REQ-VAL-014"); assert.equal(raw.category, "validation");
  // ripresa (§47.2): il SAVE non si ripete senza la lettura di verifica; la lettura dice "non salvato" ⇒ passo 6 attivo
  const resume = JSON.parse(node("scripts/decide/step-check.mjs", ["--plan", planFile, "--resume", "6", "--json"]).stdout);
  assert.equal(resume.activated, false); assert.deepEqual(resume.reads.map((x) => [x.step, x.verb]), [[6, "READ"]]);
  const verified = JSON.parse(node("scripts/decide/step-check.mjs", ["--plan", planFile, "--resume", "6", "--snapshot", snapFile("save-error"), "--json"]).stdout);
  assert.equal(verified.status, "ok"); assert.ok(!verified.already_done);
  // si torna al passo 5 (CdC scelto dal lookup), poi di nuovo il salvataggio
  assert.equal(JSON.parse(node("scripts/decide/step-check.mjs", ["--plan", planFile, "--resume", "5", "--json"]).stdout).status, "ok");
  assert.equal(readSession(ws).active_plan.step, 5);
  assert.deepEqual(call("fill", { uid: "2_15", value: "IT-0442", pageId: 1 }, "Successfully filled out the element").denied, []);
  snapshot("filled");
  ok(stepCheck(5, "filled"));
  assert.deepEqual(call("click", { uid: "2_18", pageId: 1 }, "Successfully clicked on the element").denied, []);
  snapshot("saved");
  const r6 = stepCheck(6, "saved");
  ok(r6);
  assert.equal(r6.plan_status, "completed");
  assert.equal(readSession(ws).active_plan, null, "piano completato: nessuna azione con effetto ulteriore");
  assert.ok(existsSync(join(ws, "customers/ACME/runs/RUN.ACME.20260922.1105.ADM/result.yaml")));

  // ---- evidenza del passo 6 (senza script nella pagina) ----
  const prep = JSON.parse(node("scripts/chrome/capture.mjs", ["prepare", "--plan", planFile, "--step", "6", "--snapshot", snapFile("saved"), "--json"]).stdout);
  assert.equal(prep.no_page_script, true);
  writeFileSync(join(ws, prep.file), encodePng({ width: 200, height: 100, channels: 3, data: Buffer.alloc(200 * 100 * 3, 255) }));
  const rec = JSON.parse(node("scripts/chrome/capture.mjs", ["record", "--file", prep.file, "--step", "6", "--kind", "result", "--caption", "Bozza NRT-20260923-B2C1-REQ-001 salvata", "--json"]).stdout);
  assert.equal(rec.id, "EV-01"); assert.match(rec.sha256, /^[0-9a-f]{64}$/);
  wf("step_end", { n: 6, status: "ok", note: "NRT-20260923-B2C1-REQ-001 in bozza", evidence: ["EV-01"], compensation: "requisition.cancel", errors: 1 });

  // ---- RPT con esito classificato: errore inatteso, capito, compito completato ⇒ ERROR-AS-LESSON ----
  const rpt = node("scripts/report/build-report.mjs", ["--kind", "action", "--plan", planFile, "--title", "Creazione RdA di prova da catalogo in bozza", "--intent", intent,
    "--expected", "{\"state\":\"DRAFT\"}", "--observed", "{\"state\":\"DRAFT\"}", "--understood", "--estimated", String(est.tokens), "--json"]);
  assert.equal(rpt.status, 0, rpt.stdout + rpt.stderr);
  const R = JSON.parse(rpt.stdout);
  assert.match(R.code, /^RPT\.ACME\.\d{8}\.0001$/);
  assert.equal(R.outcome, "ERROR-AS-LESSON");
  const md = readFileSync(join(ws, R.files[0]), "utf8");
  assert.match(md, /Esito +ERROR-AS-LESSON/); assert.match(md, /REQ-VAL-014/); assert.match(md, /NRT-20260923-B2C1-REQ-001 · compensazione pendente: requisition\.cancel/);

  // ---- workflow visibile ----
  const text = node("scripts/admin/workflow.mjs", ["render"]).stdout;
  assert.match(text, /^┌ WORKFLOW  SES\.ACME\.\d{8}\.001 · ACME · SANDBOX · P2P · operativa/);
  for (const n of [1, 2, 3, 4, 5, 6]) assert.match(text, new RegExp(`✓ ${n} `));
  assert.match(text, /compensazione registrata: requisition\.cancel/);
  assert.match(text, new RegExp(`sorprese: 1 · errori: 1 · evidenze: 1 · report: ${R.code.replace(/\./g, "\\.")} · esito: ERROR-AS-LESSON`));

  // ---- budget rispettato, catene integre ----
  const s = readSession(ws);
  assert.ok(s.budget.used <= s.budget.tokens);
  assert.equal(verifyChain(auditFile(ws, "ACME")).ok, true);
  const audit = readFileSync(auditFile(ws, "ACME"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(audit.some((e) => e.actor === "step-check"));
  assert.ok(audit.some((e) => e.actor === "build-report"));
  const obs = readdirSync(join(ws, "customers/ACME/observations"));
  assert.ok(obs.length >= 10, `${obs.length} OBS`);
  console.log(`M7: ${obs.length} OBS · ERR REQ-VAL-014 · ${R.code} ${R.outcome} · stima ${est.tokens} token\n${text}`);
});
