// K6.5 — workflow visibile (§29.5, §51.3, §52.4, §57.3): rendering deterministico (byte per byte) da
// workflow.jsonl, banner di ambiente, ⏸ seguito dalla domanda, ✗ dal motivo, CLI event/render/watch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { envWs, patchSession, readSession, ROOT } from "../helpers/env-fixture.mjs";
import { cleanEnv } from "../helpers/hook-env.mjs";
import { render, banner } from "../../scripts/admin/workflow.mjs";

const GOLD = join(ROOT, "test/golden/workflow");
const EVENTS = [
  { seq: 1, ts: "2026-09-23T10:41:00.000Z", kind: "task_start", payload: { task: "RdA di prova", steps: [
    { n: 1, agent: "cat-expert", class: "ACT-OBS", desc: "ricerca \"sedie\" a catalogo" },
    { n: 2, agent: "p2p-expert", class: "ACT-CREATE", desc: "richiesta con 1 riga ×5, CdC IT-0442" },
    { n: 3, agent: "p2p-expert", class: "ACT-SUBMIT", desc: "invio all'approvazione" },
    { n: 4, agent: "p2p-expert", class: "ACT-READ", desc: "lettura catena di approvazione" },
  ] } },
  { seq: 2, ts: "2026-09-23T10:41:05.000Z", kind: "step_start", payload: { n: 1 } },
  { seq: 3, ts: "2026-09-23T10:41:30.000Z", kind: "step_end", payload: { n: 1, status: "ok", note: "3 articoli", evidence: ["EV-01"] } },
  { seq: 4, ts: "2026-09-23T10:41:31.000Z", kind: "step_start", payload: { n: 2 } },
  { seq: 5, ts: "2026-09-23T10:42:10.000Z", kind: "step_end", payload: { n: 2, status: "ok", note: "NRT-20260923-B2C1-REQ-001", evidence: ["EV-02", "EV-03"], compensation: "requisition.cancel" } },
  { seq: 6, ts: "2026-09-23T10:42:11.000Z", kind: "approval", payload: { n: 3, state: "pending", text: "Confermi l'invio all'approvazione della richiesta NRT-…-REQ-001 (importo 3.190 €, 2 livelli previsti)?  [sì / no / mostra piano]" } },
];
const SESSION = (env) => ({ session_id: "sess-1", session_code: "SES.ACME.20260923.004", customer: "ACME", scope: "P2P", mode: "ops", budget: { tokens: 200000, used: 23000 }, env });
const SBX = { id: "sandbox", type: "sandbox", label: "ACME Sandbox", verified: true };

test("render: blocco byte-identico al golden (sandbox, ⏸ seguito dalla domanda, compensazione, totali)", () => {
  const text = render(EVENTS, SESSION(SBX));
  assert.equal(text, readFileSync(join(GOLD, "sandbox.txt"), "utf8"));
  assert.equal(render(EVENTS, SESSION(SBX)), text, "deterministico");
});

test("render: step fermato ✗ seguito dal motivo e da cosa serve per riprendere; esito e RPT nei totali", () => {
  const ev = [...EVENTS.slice(0, 5),
    { seq: 6, ts: "2026-09-23T10:43:00.000Z", kind: "step_start", payload: { n: 3 } },
    { seq: 7, ts: "2026-09-23T10:43:20.000Z", kind: "surprise", payload: { n: 3, kind: "elemento-assente" } },
    { seq: 8, ts: "2026-09-23T10:43:21.000Z", kind: "step_end", payload: { n: 3, status: "stopped", reason: "pulsante Invia assente (C.ACME.P2P.SEL.0130)", resume: "step-check --resume 3 dopo aver verificato i permessi del ruolo", errors: 1 } },
    { seq: 9, ts: "2026-09-23T10:44:00.000Z", kind: "outcome", payload: { status: "ERROR-BLOCKING" } },
    { seq: 10, ts: "2026-09-23T10:44:01.000Z", kind: "report", payload: { code: "RPT.ACME.20260923.0004" } }];
  const text = render(ev, SESSION(SBX));
  assert.equal(text, readFileSync(join(GOLD, "stopped.txt"), "utf8"));
  const lines = text.split("\n");
  const i = lines.findIndex((l) => l.includes("✗ 3"));
  assert.match(lines[i + 1], /motivo: pulsante Invia assente/);
  assert.match(lines[i + 2], /per riprendere: step-check --resume 3/);
});

test("banner di ambiente (§51.3, §52.4): assente, non verificato, sandbox, pre-prod, produzione con stato 3A", () => {
  assert.match(banner(null), /⚠ AMBIENTE NON DICHIARATO/);
  assert.match(banner({ id: "sandbox", type: "sandbox", label: "ACME Sandbox", verified: false }), /ACME Sandbox \(sandbox\) — NON VERIFICATO/);
  assert.equal(banner(SBX), "SANDBOX");
  assert.equal(banner({ ...SBX, type: "preprod" }), "PRE-PROD");
  assert.equal(banner({ ...SBX, type: "prod" }), "⚠ PRODUZIONE — sola lettura sui dati");
  const three = { a1: { ts: "2026-09-23T10:02:00.000Z" }, a2: { ts: "2026-09-23T10:19:00.000Z", approver_declared: "M. Rossi" }, step: 4, of: 7, a3: false };
  const text = render(EVENTS.slice(0, 1), SESSION({ ...SBX, type: "prod" }), { threeA: three });
  assert.equal(text.split("\n")[0], readFileSync(join(GOLD, "prod-3a.txt"), "utf8").split("\n")[0]);
  assert.match(text.split("\n")[0], /⚠ PRODUZIONE — sola lettura sui dati · configurazione 3A: A1 ✓ 10:02 · A2 ✓ 10:19 \(M\. Rossi\) · A3 passo 4\/7 ⏸/);
});

test("CLI: event appende a workflow.jsonl (kind validato), render stampa il blocco, watch <SES> è in sola lettura", () => {
  const ws = envWs({ env: "sandbox", scope: "P2P" });
  patchSession(ws, (s) => { s.session_code = "SES.ACME.20260923.004"; s.mode = "ops"; });
  const cli = (args) => spawnSync(process.execPath, [join(ROOT, "scripts/admin/workflow.mjs"), ...args], { encoding: "utf8", env: cleanEnv({ JVC_WORKSPACE: ws, JVC_SESSION_ID: "sess-1" }) });
  assert.equal(cli(["--help"]).status, 0);
  assert.equal(cli(["event", "--kind", "boh", "--payload", "{}"]).status, 1);
  assert.equal(cli(["event", "--kind", "task_start", "--payload", "non json"]).status, 1);
  for (const e of EVENTS) assert.equal(cli(["event", "--kind", e.kind, "--payload", JSON.stringify(e.payload), "--json"]).status, 0);
  const f = join(ws, "customers/ACME/.sessions/sess-1/workflow.jsonl");
  assert.equal(readFileSync(f, "utf8").trim().split("\n").length, EVENTS.length);
  const r = cli(["render"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^┌ WORKFLOW  SES\.ACME\.20260923\.004 · ACME · SANDBOX · P2P · operativa/);
  const before = statSync(f).mtimeMs;
  const sBefore = readFileSync(join(ws, "customers/ACME/.sessions/sess-1/session.json"), "utf8");
  const w = spawnSync(process.execPath, [join(ROOT, "scripts/admin/workflow.mjs"), "watch", "SES.ACME.20260923.004"], { encoding: "utf8", env: cleanEnv({ JVC_WORKSPACE: ws }) });
  assert.equal(w.status, 0, w.stderr);
  assert.equal(w.stdout, r.stdout);
  assert.equal(statSync(f).mtimeMs, before);
  assert.equal(readFileSync(join(ws, "customers/ACME/.sessions/sess-1/session.json"), "utf8"), sBefore);
  assert.equal(spawnSync(process.execPath, [join(ROOT, "scripts/admin/workflow.mjs"), "watch", "SES.ACME.20260923.999"], { encoding: "utf8", env: cleanEnv({ JVC_WORKSPACE: ws }) }).status, 1);
  assert.ok(existsSync(f)); assert.equal(readSession(ws).customer, "ACME");
});
