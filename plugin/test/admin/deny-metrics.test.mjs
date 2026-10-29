// 29/10/2026 (decisione dell'utente, punto 3 del piano): la console degli agenti misura i blocchi dei guard — chiamate
// registrate (eseguite + negate, una chiamata negata da più guard conta una volta), tasso di diniego, motivi principali
// per guard e motivo normalizzato con il consiglio — in `agents status` (riga di sintesi) e in `agents denies`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { cleanEnv, ROOT } from "../helpers/hook-env.mjs";
import { agentsFixture, SID } from "../helpers/agents-fixture.mjs";
import { envWs, browserCall } from "../helpers/env-fixture.mjs";
import { appendAudit } from "../../hooks/lib/audit.mjs";
import { denyStats } from "../../scripts/admin/agents.mjs";

const CLI = join(ROOT, "scripts/admin/agents.mjs");
const cli = (ws, args, sid = SID) => {
  const r = spawnSync(process.execPath, [CLI, ...args, "--workspace", ws, "--session", sid], { env: cleanEnv(), encoding: "utf8", timeout: 30000 });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* testo */ }
  return { ...r, json };
};
const ENV_REASON = "ambiente sandbox dichiarato ma non verificato: esegui env-check (impronta a ≥ 2 segnali) prima di azioni diverse da navigazione verso un URL e lettura (§51.2)";

// agentsFixture: 7 chiamate eseguite e 1 diniego (guard-scope, a1). Qui altri 6 dinieghi in 5 chiamate.
function fixture() {
  const { ws, now } = agentsFixture();
  const D = (actor, payload, msAgo) => appendAudit(ws, { session: SID, customer: "ACME", scope: "CAT", kind: "guard", actor, payload: { decision: "deny", ...payload } }, { date: new Date(now - msAgo) });
  const nav = (url) => `{"type":"url","url":"${url}"}`;
  D("hook:guard-environment", { tool: "mcp__chrome-devtools__navigate_page", reason: ENV_REASON, input_summary: nav("https://acme-sbx.jaggaer.com/a"), agent_type: "scope-expert", agent_id: "b1" }, 50000);
  // stessa chiamata negata anche da un secondo guard in parallelo: una sola chiamata negata
  D("hook:guard-production", { tool: "mcp__chrome-devtools__navigate_page", reason: "nessun piano attivo: in produzione input, click e caricamenti solo dentro un passo di piano", input_summary: nav("https://acme-sbx.jaggaer.com/a"), agent_type: "scope-expert", agent_id: "b1" }, 49800);
  D("hook:guard-environment", { tool: "mcp__chrome-devtools__click", reason: ENV_REASON, input_summary: "{\"uid\":\"1_7\"}", agent_type: "scope-expert", agent_id: "b1" }, 40000);
  D("hook:guard-environment", { tool: "mcp__chrome-devtools__click", reason: ENV_REASON, input_summary: "{\"uid\":\"1_9\"}", agent_type: "scope-expert", agent_id: "b1", repeat: 3, hint: "il manager invochi workspace-manager" }, 30000);
  D("hook:guard-scope", { tool: "Read", reason: "fuori cella (cella ACME×CAT): customers/acme/kb/scopes/adm/altro/y.yaml", input_summary: "{\"file_path\":\"y.yaml\"}", agent_type: "scope-expert", agent_id: "a1" }, 20000);
  D("hook:guard-budget", { tool: "Bash", reason: "lock attivo su knowledge.lock (password=hunter22): digestione in corso", input_summary: "{\"command\":\"node kb.mjs reindex\"}", agent_type: null, agent_id: null }, 10000);
  return ws;
}

test("agents status: riga di sintesi dei dinieghi — chiamate registrate, negate, tasso, primi motivi raggruppati per guard e motivo normalizzato, con il consiglio", () => {
  const ws = fixture();
  const r = cli(ws, ["status", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  const d = r.json.denies;
  assert.equal(d.calls_executed, 7);
  assert.equal(d.deny_rows, 7);
  assert.equal(d.calls_denied, 6, "la chiamata negata da due guard in parallelo conta una volta");
  assert.equal(d.calls_total, 13);
  assert.equal(Math.round(d.rate * 100), 46);
  assert.deepEqual(d.top.map((g) => [g.guard, g.count, g.family]), [
    ["guard-environment", 3, "workspace"], ["guard-scope", 2, "other"], ["guard-budget", 1, "health"], ["guard-production", 1, "other"],
  ]);
  assert.match(d.top[1].reason, /^fuori cella \(cella ACME×CAT\): <percorso>$/, "percorsi diversi, stesso motivo");
  assert.equal(d.top[0].advice, "il manager invochi workspace-manager");
  assert.equal(d.top[2].advice, "il manager invochi health-keeper");
  assert.equal(d.top[1].advice, "non riprovare la stessa chiamata: riporta il motivo al manager");
  assert.deepEqual(d.last, [], "status: senza l'elenco dei singoli dinieghi");
  assert.doesNotMatch(JSON.stringify(r.json), /hunter22/, "motivi redatti");
  const t = cli(ws, ["status"]);
  assert.equal(t.status, 0, t.stderr);
  assert.match(t.stdout, /DINIEGHI: 13 chiamate registrate \(7 eseguite, 6 negate\) · tasso di diniego 46%/);
  assert.match(t.stdout, /×3 guard-environment «ambiente sandbox dichiarato ma non verificato: esegui env-check[^»]*» → il manager invochi workspace-manager/);
  assert.match(t.stdout, /×1 guard-budget «lock attivo su knowledge\.lock \(password=\*\*\*[^»]*» → il manager invochi health-keeper/);
  assert.doesNotMatch(t.stdout, /hunter22/);
});

test("agents denies [--last N] [--json]: sintesi, motivi principali e ultimi N dinieghi con il consiglio", () => {
  const ws = fixture();
  const j = cli(ws, ["denies", "--last", "3", "--json"]);
  assert.equal(j.status, 0, j.stderr);
  assert.equal(j.json.ok, true);
  assert.equal(j.json.denies.calls_denied, 6);
  assert.equal(j.json.denies.last.length, 3);
  assert.deepEqual(j.json.denies.last.map((x) => x.guard), ["guard-environment", "guard-scope", "guard-budget"]);
  assert.equal(j.json.denies.last[0].repeat, 3);
  assert.equal(j.json.denies.last[2].advice, "il manager invochi health-keeper");
  assert.equal(j.json.session.session_code, "SES.ACME.20260929.001");
  const all = cli(ws, ["denies", "--json"]);
  assert.equal(all.json.denies.last.length, 7, "default: ultimi 20");
  const t = cli(ws, ["denies"]);
  assert.equal(t.status, 0, t.stderr);
  assert.match(t.stdout, /^DINIEGHI {2}SES\.ACME\.20260929\.001 · cliente ACME/);
  assert.match(t.stdout, /Ultimi 7 dinieghi:/);
  assert.match(t.stdout, /guard-environment mcp__chrome-devtools__click \[scope-expert b1\]: ambiente sandbox .*\(3ª volta → il manager invochi workspace-manager\)/);
  assert.match(t.stdout, /guard-budget Bash \[manager\]: lock attivo/);
  assert.doesNotMatch(t.stdout, /hunter22/);
  assert.equal(cli(ws, ["denies", "--last", "0"]).status, 1);
  assert.equal(cli(ws, ["denies", "--last", "x", "--json"]).json.ok, false);
});

test("sessione senza dinieghi: tasso 0%, nessun motivo; denyStats su eventi vuoti", () => {
  const d = denyStats([]);
  assert.equal(d.calls_total, 0); assert.equal(d.rate, null); assert.deepEqual(d.top, []);
  const e = denyStats([{ kind: "tool", ts: "2026-10-29T10:00:00.000Z", payload: { tool: "Read" } }]);
  assert.equal(e.rate, 0);
});

test("dinieghi veri dei guard (envWs): la console li conta e riporta la ripetizione segnalata dal guard", () => {
  const ws = envWs({ env: "sandbox", scope: "ADM" });
  for (const p of ["a", "b", "c"]) browserCall("guard-environment", ws, "mcp__chrome-devtools__navigate_page", { type: "url", url: `https://evil.example.org/${p}` });
  const r = cli(ws, ["denies", "--json"], "sess-1");
  assert.equal(r.status, 0, r.stderr);
  const d = r.json.denies;
  assert.equal(d.calls_denied, 3);
  assert.equal(d.calls_total, 3);
  assert.equal(d.rate, 1);
  assert.equal(d.top[0].count, 3);
  assert.equal(d.top[0].guard, "guard-environment");
  assert.equal(d.top[0].advice, "il manager invochi workspace-manager");
  assert.deepEqual(d.last.map((x) => x.repeat), [null, null, 3]);
});
