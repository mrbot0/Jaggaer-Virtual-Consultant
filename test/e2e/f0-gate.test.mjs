// Criteri di uscita della fase F0 (spec §33 F0): cancellazione ⇒ deny in audit; produzione ⇒ bloccato; ID di incident in
// un test ⇒ bloccato (confine di dominio); lettura di un altro scope ⇒ bloccato; doctor verde su un workspace
// dimostrativo preparato. Ogni chiamata passa dai veri hook (processi separati), come in Claude Code.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { mkWs, seedSession, runHook, decisionOf, reasonOf, cleanEnv, ROOT } from "../helpers/hook-env.mjs";
import { envWs, patchSession } from "../helpers/env-fixture.mjs";
import { demoWorkspace, DEMO_ENV } from "../helpers/demo-workspace.mjs";

const E = (ws) => ({ JVC_WORKSPACE: ws, CLAUDE_PLUGIN_ROOT: ROOT });
const pre = (ws, tool, tool_input, extra = {}) => ({ session_id: "sess-1", cwd: ws, hook_event_name: "PreToolUse", tool_name: tool, tool_input, ...extra });
// tutti i guard che hooks.json registra per lo strumento (matcher come regex ancorata), nell'ordine
const HOOKS = JSON.parse(readFileSync(join(ROOT, "hooks/hooks.json"), "utf8")).hooks.PreToolUse;
function preToolUse(ws, tool, ti, extra = {}) {
  const names = HOOKS.filter((g) => new RegExp(`^(?:${g.matcher})$`).test(tool)).flatMap((g) => g.hooks.map((h) => /scripts\/([a-z-]+)\.mjs/.exec(h.command)[1]));
  return [...new Set(names)].map((g) => ({ g, r: runHook(g, pre(ws, tool, ti, extra), E(ws)) }));
}
const denied = (res) => res.filter(({ r }) => decisionOf(r) === "deny");
const audit = (ws, c = "ACME") => readdirSync(join(ws, "customers", c, "audit")).flatMap((f) => readFileSync(join(ws, "customers", c, "audit", f), "utf8").trim().split("\n")).filter(Boolean).map((l) => JSON.parse(l));

test("F0 — cancellazione ⇒ deny registrato in audit (shell, scrittura su audit, pulsante Elimina)", () => {
  const ws = mkWs();
  seedSession(ws);
  const d1 = denied(preToolUse(ws, "Bash", { command: "rm -rf customers/ACME/runs" }));
  assert.ok(d1.some(({ g }) => g === "guard-destructive"), JSON.stringify(d1.map(({ g }) => g)));
  const d2 = denied(preToolUse(ws, "PowerShell", { command: "Remove-Item -Recurse -Force customers\\ACME\\lessons" }));
  assert.ok(d2.some(({ g }) => g === "guard-destructive"));
  const w = envWs({ env: "sandbox", scope: "P2P" });
  const d3 = denied(preToolUse(w, "mcp__plugin_playwright_playwright__browser_click", { element: "Elimina richiesta", ref: "e3" }));
  assert.ok(d3.some(({ g, r }) => g === "guard-destructive" && /ACT-DELETE/.test(reasonOf(r))));
  const ev = audit(ws).filter((e) => e.kind === "guard" && e.actor === "hook:guard-destructive" && e.payload.decision === "deny");
  assert.ok(ev.length >= 2, "deny di guard-destructive in audit");
  assert.ok(ev.some((e) => /DR-SHELL-001/.test(e.payload.reason)));
  assert.ok(audit(w).some((e) => e.actor === "hook:guard-destructive" && /ACT-DELETE/.test(e.payload.reason)));
});

test("F0 — produzione ⇒ bloccato: scrittura di dati sul browser in prod negata (anche con DevTools), letture ammesse", () => {
  const ws = envWs({ env: "prod", scope: "P2P" });
  patchSession(ws, (s) => { s.browser = { current_url: "https://acme.jaggaer.com/p2p/req/1", tab: null, updated_by: "browser-origin" }; });
  for (const [tool, ti] of [["mcp__chrome-devtools__fill", { uid: "1_3", value: "5" }], ["mcp__chrome-devtools__click", { uid: "1_4" }],
    ["mcp__chrome-devtools__press_key", { key: "Enter" }], ["mcp__claude-in-chrome__form_input", { ref: "ref_3", value: "5", tabId: 101 }]]) {
    const d = denied(preToolUse(ws, tool, ti));
    assert.ok(d.length, `${tool} consentito in produzione`);
    assert.ok(d.some(({ g }) => g === "guard-production" || g === "guard-environment"), `${tool}: ${d.map(({ g }) => g)}`);
  }
  assert.ok(audit(ws).some((e) => e.actor === "hook:guard-production" && e.payload.decision === "deny"));
  assert.deepEqual(denied(preToolUse(ws, "mcp__chrome-devtools__take_snapshot", {})).map(({ g }) => g), [], "lettura in prod");
});

test("F0 — un ID di incident o un codice PAT scritto in un file di test (tests/**) ⇒ bloccato (confine di dominio)", () => {
  const ws = mkWs();
  seedSession(ws);
  const file = join(ws, "customers/ACME/tests/cases/CAT/NRT.ACME.CAT.TST.0001.yaml");
  for (const content of ["id: NRT.ACME.CAT.TST.0001\nnote: regressione di INC-1234\n", "id: NRT.ACME.CAT.TST.0001\ncausa: C.ACME.CAT.PAT.0003\n", "ref: customers/ACME/analysis/patterns/x.yaml\n"]) {
    const d = denied(preToolUse(ws, "Write", { file_path: file, content }));
    assert.ok(d.some(({ g }) => g === "guard-domain-boundary"), `${content}: ${JSON.stringify(d.map(({ g, r }) => [g, reasonOf(r)]))}`);
  }
  assert.ok(denied(preToolUse(ws, "Edit", { file_path: file, old_string: "a", new_string: "vedi TICKET-77" })).some(({ g }) => g === "guard-domain-boundary"));
  // lo stesso divieto sull'ALM (dominio dei test)
  assert.ok(denied(preToolUse(ws, "mcp__alm__alm_create_defect", { summary: "x", description: "vedi INC-1234" })).some(({ g }) => g === "guard-alm-write"));
  // un test senza riferimenti analitici passa
  assert.deepEqual(denied(preToolUse(ws, "Write", { file_path: file, content: "id: NRT.ACME.CAT.TST.0001\natteso: totale 10\n" })).map(({ g }) => g), []);
});

test("F0 — lettura di un altro scope o di un altro cliente ⇒ bloccato", () => {
  const ws = mkWs();
  seedSession(ws, { scope: "CAT" });
  const sub = { agent_type: "jaggaer-virtual-consultant:scope-expert", agent_id: "cat-1" };
  const d1 = denied(preToolUse(ws, "Read", { file_path: join(ws, "customers/ACME/kb/scopes/ADM/configs/C.ACME.ADM.CFG.0019.yaml") }, sub));
  assert.ok(d1.some(({ g }) => g === "guard-scope"), JSON.stringify(d1.map(({ g }) => g)));
  const d2 = denied(preToolUse(ws, "Grep", { pattern: "x", path: join(ws, "customers/ACME/kb/scopes/ADM") }, sub));
  assert.ok(d2.some(({ g }) => g === "guard-scope"));
  const d3 = denied(preToolUse(ws, "Read", { file_path: join(ws, "customers/BETA/kb/scopes/CAT/secret.yaml") }));
  assert.ok(d3.some(({ g }) => g === "guard-customer"));
  assert.deepEqual(denied(preToolUse(ws, "Read", { file_path: join(ws, "customers/ACME/kb/scopes/CAT/flows/C.ACME.CAT.FLW.0001.yaml") }, sub)).map(({ g }) => g), [], "la propria cella");
});

test("F0 — doctor verde (nessun rosso, exit 0) su un workspace dimostrativo preparato", () => {
  const ws = demoWorkspace();
  const r = spawnSync(process.execPath, [join(ROOT, "scripts/admin/doctor.mjs"), "--json"], { env: cleanEnv({ ...DEMO_ENV, JVC_WORKSPACE: ws }), encoding: "utf8", timeout: 60000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, true);
  assert.deepEqual(out.checks.filter((c) => c.status === "red"), []);
  // gialli ammessi solo dove la spec li prevede (browser non sondabile)
  assert.deepEqual(out.checks.filter((c) => c.status === "yellow").map((c) => c.id), ["browser"]);
  console.log(`doctor (demo): ${out.checks.map((c) => `${c.id}=${c.status}`).join(" ")}`);
});
