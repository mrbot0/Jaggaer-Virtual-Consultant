// Revisione finale — minori di B: frase di approvazione con lo spazio prima del punto (B#4), passo fermato da una
// sorpresa incompatibile ⇒ ERROR-BLOCKING (B#6), active_plan dopo un gate successivo negato (B#7), TTL delle
// invocazioni coerente con un limite di dispatch oltre 120 minuti (B#8).
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseApprovalPrompt } from "../../scripts/admin/approvals.mjs";
import { buildReport } from "../../scripts/report/build-report.mjs";
import { check } from "../../scripts/decide/step-check.mjs";
import { activeStep } from "../../hooks/lib/guards/plan-step.mjs";
import { OPEN_TTL_MS, ttlFor, sessionTtlMs, openFrom } from "../../hooks/lib/invocations.mjs";
import { appendControl, controlFile } from "../../hooks/lib/control.mjs";
import { envWs, patchSession, readSession, writePlan } from "../helpers/env-fixture.mjs";
import { mkWs, seedSession, runSessionCli } from "../helpers/hook-env.mjs";
import { demoAtlas, demoPlan, snap, PLAN } from "../helpers/k6-fixture.mjs";

// ---------- B#4 ----------
test("approvazione: «APPROVO PIANO X .» (spazio prima del punto finale) vale come «APPROVO PIANO X»; la grammatica non si allarga", () => {
  for (const p of ["APPROVO PIANO PLAN.0042", "APPROVO PIANO PLAN.0042.", "APPROVO PIANO PLAN.0042 .", "APPROVO PIANO PLAN.0042 !", "APPROVO PIANO PLAN.0042 DA Anna Bianchi ."]) {
    const r = parseApprovalPrompt(p);
    assert.equal(r?.kind, "A1", p); assert.equal(r.plan, "PLAN.0042", p);
  }
  for (const p of ["APPROVO PIANO PLAN.0042 ..", "APPROVO PIANO PLAN.0042 . ok", "approvo piano PLAN.0042 .", "APPROVO PIANO PLAN.0042 ;"]) assert.notEqual(parseApprovalPrompt(p)?.kind, "A1", p);
  assert.equal(parseApprovalPrompt("APPROVO PASSO 3 PLAN.0042 .")?.kind, "A3");
});

// ---------- B#6 ----------
function reportWs({ compat }) {
  const ws = envWs({ env: "sandbox", scope: "P2P" });
  const file = writePlan(ws, demoPlan(), "RUN.ACME.20260922.1100.ADM");
  patchSession(ws, (s) => { s.session_code = "SES.ACME.20260929.001"; s.surprises = [{ at: "2026-09-29T10:41:00.000Z", item: "C.ACME.P2P.SEL.0044", obs: null, plan: PLAN, step: 2, kind: "valore-diverso", compat }]; });
  const ev = [
    { kind: "task_start", payload: { task: "RdA", steps: [{ n: 1, class: "ACT-OBS", desc: "apertura" }, { n: 2, class: "ACT-CREATE", desc: "compilazione" }, { n: 3, class: "ACT-CREATE", desc: "salvataggio" }] } },
    { kind: "step_end", payload: { n: 1, status: "ok" } },
    { kind: "surprise", payload: { n: 2, kind: "valore-diverso" } },
    { kind: "step_end", payload: { n: 2, status: "stopped", reason: "sorpresa" } },
  ].map((e, i) => JSON.stringify({ seq: i + 1, ts: `2026-09-29T10:4${i}:00.000Z`, ...e }));
  writeFileSync(join(ws, "customers/ACME/.sessions/sess-1/workflow.jsonl"), `${ev.join("\n")}\n`);
  return { ws, file };
}

test("build-report: passo fermato da una sorpresa INCOMPATIBILE ⇒ ERROR-BLOCKING (Xray FAILED); compatibile ⇒ PARTIAL come prima", async () => {
  const a = reportWs({ compat: "incompatibile" });
  const r = await buildReport({ ws: a.ws, sid: "sess-1", kind: "action", planFile: a.file, title: "RdA fermata", now: new Date("2026-09-29T11:00:00Z") });
  assert.equal(r.outcome, "ERROR-BLOCKING");
  assert.match(r.reason ?? r.doc?.outcome?.reason ?? JSON.stringify(r), /sorpresa incompatibile/);
  const b = reportWs({ compat: "compatibile" });
  const r2 = await buildReport({ ws: b.ws, sid: "sess-1", kind: "action", planFile: b.file, title: "RdA parziale", now: new Date("2026-09-29T11:00:00Z") });
  assert.equal(r2.outcome, "PARTIAL");
});

// ---------- B#7 ----------
test("gate del passo successivo negato: active_plan resta sul passo verificato ma marcato; il guard non concede più azioni legate a quel passo", async () => {
  const ws = envWs({ env: "sandbox", scope: "P2P" });
  demoAtlas(ws);
  const bare = writePlan(ws, demoPlan({ compensations: [] }), "RUN.ACME.20260922.1100.ADM");
  await check({ ws, sid: "sess-1", planFile: bare, step: 1 });
  await check({ ws, sid: "sess-1", planFile: bare, step: 1, snapshot: snap("chrome-devtools", "ok").replace("/edit/10045", "/new") });
  const r = await check({ ws, sid: "sess-1", planFile: bare, step: 2, snapshot: snap("chrome-devtools", "ok") });
  assert.equal(r.next.status, "denied");
  const ap = readSession(ws).active_plan;
  assert.equal(ap.step, 2);
  assert.equal(ap.gate_denied?.step, 3);
  const st = await activeStep({ ws, customer: "ACME", session: readSession(ws) });
  assert.match(st.reason ?? "", /passo 3.*negato/);
  assert.equal(st.step, undefined, "nessun passo attivo per i guard");
});

// ---------- B#8 ----------
test("TTL delle invocazioni = max(2 h, limite di dispatch confermato): con LIMITI DISPATCH 200 180 un dispatch di 150 minuti fa è ancora aperto", () => {
  assert.equal(ttlFor(undefined), OPEN_TTL_MS);
  assert.equal(ttlFor(30), OPEN_TTL_MS);
  assert.equal(ttlFor(180), 180 * 60000);
  const ws = mkWs(); seedSession(ws);
  const sdir = join(ws, "customers/ACME/.sessions/sess-1");
  appendFileSync(join(sdir, "invocations.jsonl"), `${JSON.stringify({ ts: new Date(Date.now() - 150 * 60000).toISOString(), task_id: "MSG.sess-1.0001", subagent_type: "scope-expert", budget_tokens: 1000 })}\n`);
  assert.equal(sessionTtlMs(sdir), OPEN_TTL_MS, "senza limiti: 2 h");
  assert.equal(runSessionCli(["use", "scope", "ADM", "--workspace", ws, "--json"]).status, 0, "2 h: il dispatch di 150 minuti è scaduto");
  runSessionCli(["use", "scope", "CAT", "--workspace", ws, "--json"]);
  const f = controlFile(ws, "ACME", "sess-1");
  const lim = appendControl(f, { kind: "limits", calls: 200, minutes: 180, prompt_sha256: "0".repeat(64) });
  appendControl(f, { kind: "limits", calls: 200, minutes: 600 });   // non confermato: non conta
  appendControl(f, { kind: "confirm", ref: lim.hash });
  assert.equal(sessionTtlMs(sdir), 180 * 60000);
  assert.equal(openFrom([{ ts: new Date(Date.now() - 150 * 60000).toISOString() }], [], { ttlMs: sessionTtlMs(sdir) }).length, 1);
  const r = runSessionCli(["use", "scope", "ADM", "--workspace", ws, "--json"]);
  assert.equal(r.status, 3, `il dispatch è ancora nel suo limite di 180 minuti: ${r.stdout}`);
});
