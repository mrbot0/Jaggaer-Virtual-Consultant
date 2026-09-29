// WP10d D1 + D7: console degli agenti (status, show, history) dalle sole registrazioni degli hook.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { cleanEnv, ROOT } from "../helpers/hook-env.mjs";
import { agentsFixture, SID } from "../helpers/agents-fixture.mjs";
import { buildConsole, showTask, renderShow, renderStatus, history, resolveMonitorSession } from "../../scripts/admin/agents.mjs";

const CLI = join(ROOT, "scripts/admin/agents.mjs");
const cli = (ws, args) => {
  const r = spawnSync(process.execPath, [CLI, ...args, "--workspace", ws, "--session", SID], { env: cleanEnv(), encoding: "utf8", timeout: 30000 });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* testo */ }
  return { ...r, json };
};

test("D1 status: 3 dispatch (partial chiuso, in corso, scaduto) con stato, tier, budget/usato, ultima azione, sorprese, domande; riga di sintesi", () => {
  const { ws } = agentsFixture();
  const r = cli(ws, ["status", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  const rows = r.json.rows;
  assert.deepEqual(rows.map((x) => [x.task_id, x.state]), [["T-A", "partial"], ["T-B", "in-corso"], ["T-C", "scaduto"]]);
  const [a, b, c] = rows;
  assert.equal(a.type, "scope-expert"); assert.equal(a.scope, "CAT"); assert.equal(a.tier, "T1"); assert.equal(a.mode, "nrt");
  assert.equal(a.budget, 40000); assert.equal(a.used, 22000); assert.equal(a.calls, 4); assert.equal(a.denies, 1);
  assert.equal(a.report_surprises, 1); assert.equal(a.open_questions, 1);
  assert.deepEqual(a.output_codes, ["NRT.ACME.CAT.NEG.0031"]);
  assert.equal(a.agent_id, "a1");
  assert.match(a.last_action, /^Bash .*kb\.mjs find/);
  assert.doesNotMatch(JSON.stringify(r.json), /hunter22/, "riassunti redatti");
  assert.doesNotMatch(JSON.stringify(r.json), /contenuto mai mostrato/, "mai contenuti: solo codici");
  assert.equal(a.last_actions.length, 5);
  assert.equal(b.agent_id, "b1"); assert.equal(b.tier, "T0"); assert.equal(b.used, null); assert.equal(b.open, true);
  assert.match(b.last_action, /take_snapshot/);
  assert.equal(c.state, "scaduto"); assert.match(c.why, /nessun rapporto/);
  assert.equal(r.json.summary.running, 1); assert.equal(r.json.summary.waiting, 0);
  assert.equal(r.json.summary.tokens_used, 22000); assert.equal(r.json.summary.tokens_total, 200000);
  assert.equal(r.json.audit_chain.ok, true);
  assert.deepEqual(r.json.workflow && [r.json.workflow.step, r.json.workflow.state], [2, "▶"]);
  // testo
  const t = cli(ws, ["status"]);
  assert.equal(t.status, 0);
  assert.match(t.stdout, /AGENTI {2}SES\.ACME\.20260929\.001/);
  assert.match(t.stdout, /1 in corso · 0 in attesa dell'utente · token 22000\/200000/);
  assert.match(t.stdout, /T-C .*scaduto/);
});

test("D1: incoerenza rapporto ↔ audit (dichiara 2 strumenti, l'audit ne registra 4) segnalata come incoerente", () => {
  const { ws } = agentsFixture();
  const r = cli(ws, ["status", "--json"]);
  const a = r.json.rows[0];
  assert.equal(a.flag, "incoerente");
  assert.match(a.coherence.flags.join(" "), /dichiara 2 strumenti usati, l'audit ne registra 4/);
  assert.match(renderStatus(buildConsole(ws, "ACME", SID, resolveMonitorSession(ws, SID).session)), /INCOERENTE: il rapporto dichiara 2/);
});

test("D7 show <task_id>: dispatch, cronologia degli strumenti con deny e motivo, passi Chrome e OBS, traccia cognitiva, token e durata", () => {
  const { ws } = agentsFixture();
  const md = cli(ws, ["show", "T-A"]);
  assert.equal(md.status, 0, md.stderr);
  for (const re of [/# Agente T-A \(dispatch #0\) — partial/, /tier T1/, /compito: Test negativi CAT/, /allowed_paths: customers\/ACME\/tests/, /output atteso: \{"type":"nrt-cases"\}/,
    /Chiamate di strumento \(4/, /DENY guard-scope Read: fuori cella/, /richiamo: semantica C\.ACME\.CAT\.KEY\.0002/, /forma epistemica: C\.ACME\.CAT\.KEY\.0002 consolidato → contraddittorio/,
    /strategia: STR-REPLAY/, /decisioni: L\.ACME\.CAT\.DEC\.0421 \(perché: \/vc why <DEC>\)/, /why: .*DT-002/, /sorprese: 1 \(S\.STD\.CAT\.SEL\.0140\)/, /self-check: 9\/10, falliti 3/,
    /lezione: L\.ACME\.CAT\.LSN\.0090/, /token 22000 \(sonnet 22000\) · fonte transcript · durata 12m/, /INCOERENTE/]) assert.match(md.stdout, re);
  assert.doesNotMatch(md.stdout, /hunter22/);
  const b = cli(ws, ["show", "T-B", "--json"]);
  assert.equal(b.status, 0);
  const v = b.json.dispatches[0];
  assert.deepEqual(v.chrome.steps.map((s) => [s.plan, s.step, s.status]), [["PLAN.0042", 2, "surprise"]]);
  assert.deepEqual(v.chrome.observations.map((o) => o.obs), ["L.ACME.ADM.OBS.0301"]);
  assert.equal(v.trace, null);
  assert.equal(cli(ws, ["show", "T-ZZZ"]).status, 1);
});

test("D1 history: filtro per scope e ultimi N; libreria: un solo dispatch per task, fermo sullo stato vero", () => {
  const { ws } = agentsFixture();
  const r = cli(ws, ["history", "--scope", "CAT", "--last", "1", "--json"]);
  assert.equal(r.status, 0);
  assert.deepEqual(r.json.history.map((x) => x.task_id), ["T-B"]);
  const c = buildConsole(ws, "ACME", SID, resolveMonitorSession(ws, SID).session);
  assert.deepEqual(history(c).map((x) => x.task_id), ["T-A", "T-B", "T-C"]);
  assert.match(renderShow(showTask(c, "T-B")), /nessun rapporto/);
  assert.equal(cli(ws, ["history", "--last", "0"]).status, 1);
});
