// Ops veloce (spec 2026-10-06 §3.5): attivazione del piano per livello di autonomia.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFileSync, mkdtempSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { envWs, writePlan, readSession } from "../helpers/env-fixture.mjs";
import { runHook, ROOT } from "../helpers/hook-env.mjs";
import { check, gateStep, planNeedsApproval } from "../../scripts/decide/step-check.mjs";
import { readApprovals, approvalsFile } from "../../scripts/admin/approvals.mjs";
import { autonomyLevel } from "../../hooks/lib/autonomy.mjs";
import { demoAtlas, demoPlan, PLAN } from "../helpers/k6-fixture.mjs";

const RUN = "RUN.ACME.20261007.1000.ADM";
const say = (ws, tr, prompt) => { appendFileSync(tr, `${JSON.stringify({ type: "user", isSidechain: false, userType: "external", message: { role: "user", content: prompt }, timestamp: new Date().toISOString() })}\n`); return runHook("approval-capture", { session_id: "sess-1", cwd: ws, hook_event_name: "UserPromptSubmit", prompt, transcript_path: tr }, { JVC_WORKSPACE: ws, CLAUDE_PLUGIN_ROOT: ROOT }); };
// demoPlan() ha già il passo 4 SUBMIT (ACT-SUBMIT, R2) sul SEL 0130 (effect write) con la compensazione dichiarata
const withSubmit = () => { const p = demoPlan({ env: "preprod" }); assert.ok(p.steps.some((s) => s.action_class === "ACT-SUBMIT" && s.risk === "R2")); return p; };

test("planNeedsApproval: preprod alto solo creazione ⇒ no; con R2 ⇒ sì; prod sempre; basso fuori sandbox sempre; sandbox basso mai", () => {
  const p = withSubmit();
  const create = { ...p, steps: p.steps.filter((s) => !["ACT-SUBMIT", "ACT-APPROVE", "ACT-TRANSMIT", "ACT-PUBLISH"].includes(s.action_class)) };
  assert.equal(planNeedsApproval(create, { type: "preprod", policy: {} }, "alto"), false);
  assert.equal(planNeedsApproval(p, { type: "preprod", policy: {} }, "alto"), true);
  assert.equal(planNeedsApproval(create, { type: "prod", policy: {} }, "medio"), true);
  assert.equal(planNeedsApproval(create, { type: "preprod", policy: {} }, "basso"), true);
  assert.equal(planNeedsApproval(create, { type: "sandbox", policy: {} }, "basso"), false);
});

test("preprod alto: una sola APPROVO PIANO, SUBMIT senza sì; AUTONOMIA BASSA a metà ⇒ il passo R2 chiede il sì", async () => {
  const ws = envWs({ env: "preprod", scope: "P2P", autonomy: null });
  demoAtlas(ws);
  const plan = withSubmit();
  const file = writePlan(ws, plan, RUN);
  const tr = join(mkdtempSync(join(tmpdir(), "as-")), "t.jsonl"); writeFileSync(tr, "");
  const a0 = await check({ ws, customer: "ACME", sid: "sess-1", planFile: file, step: 1, snapshot: null });
  assert.equal(a0.status, "approval_required", JSON.stringify(a0)); assert.match(a0.ask, /APPROVO PIANO/);
  say(ws, tr, `APPROVO PIANO ${PLAN}`);
  const a1 = await check({ ws, customer: "ACME", sid: "sess-1", planFile: file, step: 1, snapshot: null });
  assert.notEqual(a1.status, "approval_required", JSON.stringify(a1));
  const r2 = plan.steps.find((s) => s.action_class === "ACT-SUBMIT");
  const env = readSession(ws).env;
  const recs = readApprovals(approvalsFile(ws, "ACME", "sess-1")).records;
  assert.equal(gateStep({ plan, step: r2, env, records: recs, now: new Date(), planFile: file, autonomy: "alto" }).status, "ok");
  say(ws, tr, "AUTONOMIA BASSA");
  const recs2 = readApprovals(approvalsFile(ws, "ACME", "sess-1")).records;
  const lvl = autonomyLevel({ ws, customer: "ACME", records: recs2, envType: "preprod" }).level;
  assert.equal(lvl, "basso");
  assert.equal(gateStep({ plan, step: r2, env, records: recs2, now: new Date(), planFile: file, autonomy: lvl }).status, "approval_required");
});
