// 29/10/2026 (decisione dell'utente, punto 10 del piano): registro delle modifiche agli ambienti fatte durante la
// sessione. La ricarica di environments.yaml (hooks/lib/env-refresh.mjs) scrive nell'audit il riassunto del cambiamento
// rispetto al vecchio session.env (host aggiunti e tolti, URL di base, chiavi di policy, verifica azzerata); la console
// lo mostra in `agents status` e `agents envlog`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { envWs, browserCall, readSession, ROOT } from "../helpers/env-fixture.mjs";
import { cleanEnv } from "../helpers/hook-env.mjs";
import { envChanges } from "../../hooks/lib/env-refresh.mjs";

const SNAP = "mcp__chrome-devtools__take_snapshot";
const CLI = join(ROOT, "scripts/admin/agents.mjs");
const cli = (ws, args) => {
  const r = spawnSync(process.execPath, [CLI, ...args, "--workspace", ws, "--session", "sess-1"], { env: cleanEnv(), encoding: "utf8", timeout: 30000 });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* testo */ }
  return { ...r, json };
};
const refreshes = (ws) => {
  const d = join(ws, "customers/ACME/audit");
  return readdirSync(d).filter((f) => f.endsWith(".jsonl")).flatMap((f) => readFileSync(join(d, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)))
    .filter((e) => e.actor === "hook:env-refresh");
};
const edit = (ws, fn) => { const f = join(ws, "customers/ACME/config/environments.yaml"); writeFileSync(f, fn(readFileSync(f, "utf8"))); };

test("ricarica di environments.yaml: l'audit riporta host aggiunti/tolti, URL di base, chiavi di policy cambiate, verifica azzerata; la console le elenca", () => {
  const ws = envWs({ env: "sandbox", scope: "ADM" });
  assert.equal(readSession(ws).env.verified, true);
  // 1ª modifica: un host in più, due chiavi di policy cambiate
  edit(ws, (t) => t.replace('"cdn.jaggaer.com"]', '"cdn.jaggaer.com", "nuovo.acme.it"]').replace("evidence_profile: standard", "evidence_profile: strict").replace("budget_multiplier: 1.0", "budget_multiplier: 0.9"));
  browserCall("guard-environment", ws, SNAP, {});
  let ev = refreshes(ws);
  assert.equal(ev.length, 1);
  const p1 = ev[0].payload;
  assert.equal(p1.action, "env-refresh");
  assert.equal(p1.env, "sandbox");
  assert.notEqual(p1.from, p1.to);
  assert.deepEqual(p1.hosts_added, ["nuovo.acme.it"]);
  assert.deepEqual(p1.hosts_removed, []);
  assert.equal(p1.base_url_changed, false);
  assert.deepEqual(p1.policy_changed, ["budget_multiplier", "evidence_profile"]);
  assert.equal(p1.verified_reset, true, "host cambiati: la verifica dell'impronta va rifatta");
  assert.equal(p1.remediation_changed, false);
  assert.equal(readSession(ws).env.verified, false);
  // 2ª modifica: un host tolto, URL di base cambiato; la verifica era già azzerata
  edit(ws, (t) => t.replace(', "cdn.jaggaer.com"', "").replace('base_url: "https://acme-sbx.jaggaer.com"', 'base_url: "https://acme-sbx.jaggaer.com/portal"'));
  browserCall("guard-environment", ws, SNAP, {});
  ev = refreshes(ws);
  assert.equal(ev.length, 2);
  const p2 = ev[1].payload;
  assert.deepEqual(p2.hosts_added, []);
  assert.deepEqual(p2.hosts_removed, ["cdn.jaggaer.com"]);
  assert.equal(p2.base_url_changed, true);
  assert.deepEqual(p2.policy_changed, []);
  assert.equal(p2.verified_reset, false, "già non verificato: nulla da azzerare");
  // nessuna nuova modifica ⇒ nessuna nuova ricarica
  browserCall("guard-environment", ws, SNAP, {});
  assert.equal(refreshes(ws).length, 2);
  // console: agents status
  const st = cli(ws, ["status"]);
  assert.equal(st.status, 0, st.stderr);
  assert.match(st.stdout, /ambiente ricaricato 2 volte: \+host nuovo\.acme\.it, -host cdn\.jaggaer\.com, URL di base cambiato, policy: budget_multiplier, evidence_profile, verifica azzerata/);
  const sj = cli(ws, ["status", "--json"]);
  assert.equal(sj.json.env_refresh.length, 2);
  // console: agents envlog
  const j = cli(ws, ["envlog", "--json"]);
  assert.equal(j.status, 0, j.stderr);
  assert.deepEqual(j.json.env_refresh.map((x) => [x.env, x.hosts_added, x.hosts_removed, x.base_url_changed, x.policy_changed, x.verified_reset]), [
    ["sandbox", ["nuovo.acme.it"], [], false, ["budget_multiplier", "evidence_profile"], true],
    ["sandbox", [], ["cdn.jaggaer.com"], true, [], false],
  ]);
  assert.equal(j.json.env_refresh[0].to, j.json.env_refresh[1].from, "le ricariche si concatenano per impronta");
  const t = cli(ws, ["envlog"]);
  assert.equal(t.status, 0, t.stderr);
  assert.match(t.stdout, /^RICARICHE DELL'AMBIENTE {2}sess-1 · cliente ACME/);
  assert.match(t.stdout, /sandbox [0-9a-f]{12} → [0-9a-f]{12}: \+host nuovo\.acme\.it · policy: budget_multiplier, evidence_profile · verifica azzerata/);
  assert.match(t.stdout, /sandbox [0-9a-f]{12} → [0-9a-f]{12}: -host cdn\.jaggaer\.com · URL di base cambiato\n/);
});

test("sessione senza ricariche: nessuna riga AMBIENTE in status; envlog vuoto", () => {
  const ws = envWs({ env: "sandbox", scope: "ADM" });
  browserCall("guard-environment", ws, SNAP, {});
  const st = cli(ws, ["status"]);
  assert.equal(st.status, 0, st.stderr);
  assert.doesNotMatch(st.stdout, /ambiente ricaricato/);
  assert.deepEqual(cli(ws, ["envlog", "--json"]).json.env_refresh, []);
  assert.match(cli(ws, ["envlog"]).stdout, /nessuna ricarica in questa sessione/);
});

test("envChanges: policy annidate per chiave di primo livello, host senza distinzione di maiuscole", () => {
  const old = { base_url: "https://a.x", allowed_hosts: ["A.x", "b.x"], verified: true, policy: { approvals: { config_verde: 1 }, write_data: true }, remediation_sha256: null };
  const env = { base_url: "https://a.x", allowed_hosts: ["a.x", "c.x"], verified: false, policy: { approvals: { config_verde: 2 }, write_data: true, evidence_profile: "strict" }, remediation_sha256: "f".repeat(64) };
  assert.deepEqual(envChanges(old, env), { hosts_added: ["c.x"], hosts_removed: ["b.x"], base_url_changed: false, policy_changed: ["approvals", "evidence_profile"], verified_reset: true, remediation_changed: true });
});
