// WP10c giro 1 (minore 5): la console degli agenti tratta un "${CLAUDE_SESSION_ID}" non sostituito (o vuoto) come
// assente e ricade sulla sessione corrente, come resolveSessionId di session.mjs: le chiamate della skill agent-manager
// (agents status/show con --session "${CLAUDE_SESSION_ID}") non falliscono dove quelle di session.mjs funzionano.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { mkWs, seedSession, cleanEnv, ROOT } from "../helpers/hook-env.mjs";
import { resolveMonitorSession } from "../../scripts/admin/agents.mjs";

test("agents: --session con il segnaposto non sostituito o vuoto ricade sulla sessione corrente (come session.mjs)", () => {
  const ws = mkWs();
  seedSession(ws, { sid: "sess-1" });
  for (const arg of ["${CLAUDE_SESSION_ID}", "", "  "]) {
    const r = resolveMonitorSession(ws, arg, {});
    assert.equal(r.error, undefined, JSON.stringify(arg));
    assert.equal(r.sid, "sess-1");
    assert.equal(r.customer, "ACME");
  }
  const cli = spawnSync(process.execPath, [join(ROOT, "scripts/admin/agents.mjs"), "status", "--session", "${CLAUDE_SESSION_ID}", "--workspace", ws, "--json"], { env: cleanEnv(), encoding: "utf8" });
  assert.equal(cli.status, 0, cli.stdout + cli.stderr);
  assert.equal(JSON.parse(cli.stdout).session.session_id, "sess-1");
  const env = spawnSync(process.execPath, [join(ROOT, "scripts/admin/agents.mjs"), "status", "--workspace", ws, "--json"], { env: cleanEnv({ JVC_SESSION_ID: "${CLAUDE_SESSION_ID}" }), encoding: "utf8" });
  assert.equal(env.status, 0, env.stdout + env.stderr);
  // un id esplicito e sicuro resta quello: nessuna ricaduta silenziosa su un'altra sessione
  assert.match(resolveMonitorSession(ws, "sess-2", {}).error ?? "", /nessun cliente attivo|puntatore|sessione/);
});
