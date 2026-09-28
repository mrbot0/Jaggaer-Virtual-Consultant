// K6.7 — budget rigidi (§29.10): per classe (catalogo × moltiplicatore d'ambiente), per compito (somma + 20%),
// per sessione con le invocazioni aperte PRENOTATE (debito di WP03), per documento; rilevatori di spreco
// (query kb ripetuta ⇒ controllo fallito; file aperto quando bastava il summary).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import YAML from "yaml";
import { mkWs, seedSession, runHook, decisionOf, reasonOf, cleanEnv, ROOT } from "../helpers/hook-env.mjs";
import { ACT_BUDGET, classBudget, estimateTask, checkRemaining, enforceClass, checkDocument, filesOpenedUnused, DOC_BUDGET, UNIT_BUDGET } from "../../scripts/decide/budget.mjs";
import { selfCheck } from "../../scripts/decide/self-check.mjs";
import { openDb } from "../../scripts/kb/db.mjs";

const SBX = { type: "sandbox", policy: { budget_multiplier: 1.0 } };
const PRE = { type: "preprod", policy: { budget_multiplier: 0.8 } };
const PRD = { type: "prod", policy: { budget_multiplier: 0.5 } };

test("budget per classe = catalogo (budget_tokens) × moltiplicatore dell'ambiente; la tabella coincide con product/kb/actions", () => {
  const dir = join(ROOT, "product/kb/actions");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".yaml"))) {
    const it = YAML.parse(readFileSync(join(dir, f), "utf8"));
    assert.equal(ACT_BUDGET[it.code]?.tokens ?? null, it.budget_tokens ?? null, it.code);
    if (it.budget_tokens_rosso) assert.equal(ACT_BUDGET[it.code].rosso, it.budget_tokens_rosso);
  }
  assert.equal(classBudget("ACT-CREATE", SBX), 15000);
  assert.equal(classBudget("ACT-CREATE", PRE), 12000);
  assert.equal(classBudget("ACT-OBS", PRD), 2500);
  assert.equal(classBudget("ACT-CFG-CHANGE", SBX, { level: "rosso" }), 60000);
  assert.equal(classBudget("ACT-DELETE", SBX), 0);
});

test("budget per compito: somma delle azioni del piano + 20% (§29.5: OBS+CREATE+SUBMIT+READ ≈ 55k)", () => {
  const plan = { steps: [
    { n: 1, action_class: "ACT-OBS" }, { n: 2, action_class: "ACT-CREATE" }, { n: 3, action_class: "ACT-CREATE" },
    { n: 4, action_class: "ACT-SUBMIT" }, { n: 5, action_class: "ACT-READ" } ] };
  const e = estimateTask(plan, SBX);
  assert.deepEqual(e.actions.map((a) => a.class), ["ACT-OBS", "ACT-CREATE", "ACT-SUBMIT", "ACT-READ"]);
  assert.equal(e.sum, 48000); assert.equal(e.tokens, 57600);
  assert.equal(estimateTask(plan, PRE).tokens, 46080);
});

test("residuo di sessione: le invocazioni aperte prenotano il loro budget; all'80% haiku", () => {
  const session = { budget: { tokens: 200000, used: 150000 } };
  assert.equal(checkRemaining(session, 40000, { open: [] }).ok, true);
  const r = checkRemaining(session, 40000, { open: [{ budget_tokens: 40000 }] });
  assert.equal(r.ok, false); assert.equal(r.remaining, 10000); assert.equal(r.reserved, 40000);
  assert.match(r.reason, /40000.*10000/);
  assert.equal(checkRemaining({ budget: { tokens: 100, used: 80 } }, 1).downgrade, true);
});

test("enforceClass: l'invocazione non supera il budget delle sue classi; documento 80k / 3k per unità", () => {
  assert.equal(enforceClass({ action_class: "ACT-CREATE", budget_tokens: 15000 }, SBX).ok, true);
  const no = enforceClass({ action_class: "ACT-CREATE", budget_tokens: 16000 }, SBX);
  assert.equal(no.ok, false); assert.match(no.reason, /15000/);
  assert.equal(enforceClass({ actions: ["ACT-OBS", "ACT-CREATE"], budget_tokens: 24000 }, SBX).ok, true);
  assert.equal(enforceClass({ actions: ["ACT-OBS", "ACT-CREATE"], budget_tokens: 24001 }, SBX).ok, false);
  assert.equal(enforceClass({ budget_tokens: 99999 }, SBX).ok, true, "senza classe dichiarata vale solo il residuo");
  assert.equal(enforceClass({ action_class: "ACT-DELETE", budget_tokens: 1 }, SBX).ok, false);
  assert.equal(DOC_BUDGET, 80000); assert.equal(UNIT_BUDGET, 3000);
  assert.equal(checkDocument({ used: 79000, units: 2, unitTokens: [2000, 3500] }).ok, false);
  assert.equal(checkDocument({ used: 81000 }).ok, false);
});

const header = (budget, extra = {}) => `\`\`\`yaml\n${YAML.stringify({ task_id: "T-1", customer: "ACME", scope: "CAT", allowed_paths: ["customers/ACME/**"], budget: { tokens: budget }, ...extra }).trim()}\n\`\`\`\n\nIstruzioni`;
const agent = (ws, prompt) => runHook("guard-budget", { session_id: "sess-1", cwd: ws, hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: { subagent_type: "scope-expert", prompt } }, { JVC_WORKSPACE: ws, CLAUDE_PLUGIN_ROOT: ROOT });

test("guard-budget: due compiti da 40k con 50k di residuo ⇒ il secondo è negato (prenotazione delle invocazioni aperte)", () => {
  const ws = mkWs(); seedSession(ws, { budget: { tokens: 200000, used: 150000, by_model: { haiku: 0, sonnet: 150000, opus: 0 } } });
  const a = agent(ws, header(40000));
  assert.equal(a.stdout.trim(), "", reasonOf(a));
  const b = agent(ws, header(40000, { task_id: "T-2" }));
  assert.equal(decisionOf(b), "deny");
  assert.match(reasonOf(b), /40000.*10000.*prenotat/);
});

test("guard-budget: budget del compito oltre il budget della classe dichiarata ⇒ deny", () => {
  const ws = mkWs(); seedSession(ws);
  const r = agent(ws, header(30000, { action_class: "ACT-CREATE" }));
  assert.equal(decisionOf(r), "deny");
  // ambiente non dichiarato ⇒ il moltiplicatore più restrittivo (0.5, come la produzione): 15000 × 0.5
  assert.match(reasonOf(r), /ACT-CREATE: 7500/);
});

test("spreco: la stessa query kb ripetuta con gli stessi argomenti ⇒ il self-check #12 fallisce (ledger delle chiamate)", () => {
  const ws = mkWs(); seedSession(ws);
  const db = openDb(join(ws, "customers/ACME/knowledge.db")); db.close();
  const kb = (args) => spawnSync(process.execPath, [join(ROOT, "scripts/kb/kb.mjs"), ...args, "--db", join(ws, "customers/ACME/knowledge.db"), "--json"], { encoding: "utf8", env: cleanEnv({ JVC_WORKSPACE: ws, JVC_SESSION_ID: "sess-1" }) });
  assert.equal(kb(["find", "--scope", "CAT", "--type", "FLW"]).status, 0);
  assert.equal(kb(["find", "--scope", "CAT", "--type", "FLW"]).status, 0);
  assert.equal(kb(["find", "--scope", "CAT", "--type", "CFG"]).status, 0);
  const s = JSON.parse(readFileSync(join(ws, "customers/ACME/.sessions/sess-1/session.json"), "utf8"));
  assert.equal(s.ledger.calls.length, 3);
  assert.equal(s.ledger.calls[0].args_hash, s.ledger.calls[1].args_hash);
  assert.notEqual(s.ledger.calls[0].args_hash, s.ledger.calls[2].args_hash);
  const r = selfCheck({ report: { task_id: "T", status: "ok", output: {} }, session: s, kbExists: () => true });
  const f12 = r.failed.find((f) => f.n === 12);
  assert.ok(f12, JSON.stringify(r.failed)); assert.match(f12.reason, /usa il risultato precedente/);
});

test("spreco a livello di report: file aperto quando il summary bastava (nessun codice del file citato nel risultato)", () => {
  const audit = [
    { kind: "tool", payload: { tool: "Read", input_summary: JSON.stringify({ file_path: "customers/ACME/kb/scopes/CAT/flows/C.ACME.CAT.FLW.0001.yaml" }) } },
    { kind: "tool", payload: { tool: "Read", input_summary: JSON.stringify({ file_path: "customers/ACME/kb/scopes/CAT/flows/C.ACME.CAT.FLW.0002.yaml" }) } },
  ];
  assert.deepEqual(filesOpenedUnused(audit, { output: { used: ["C.ACME.CAT.FLW.0001"] } }), ["C.ACME.CAT.FLW.0002"]);
});
