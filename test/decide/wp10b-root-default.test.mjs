// WP10b — i sub-agenti non possono citare in un comando una cartella antenata della cella (`--root customers/<C>`:
// guard-scope la nega, "niente grep -r su un antenato della cella"). Gli script che scrivono la DEC o validano le
// lezioni deducono allora la cartella del cliente dal DB (`<cartella>/knowledge.db`) quando --root manca: dt-eval
// --write-dec, learn validate, kb cluster admit/quarantine. Con --root esplicito il comportamento non cambia.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../scripts/kb/db.mjs";
import { rootFromDb } from "../../scripts/lib/root-from-db.mjs";
import { mkWs, seedSession, runHook, decisionOf, ROOT } from "../helpers/hook-env.mjs";

const node = (script, args) => spawnSync(process.execPath, [join(ROOT, script), ...args], { encoding: "utf8", timeout: 30000 });

test("rootFromDb: --root esplicito vince; altrimenti la cartella di knowledge.db; un DB con altro nome non basta", () => {
  assert.equal(rootFromDb({ root: "x", db: "customers/ACME/knowledge.db" }), "x");
  assert.equal(rootFromDb({ db: join("customers", "ACME", "knowledge.db") }).replace(/\\/g, "/").endsWith("customers/ACME"), true);
  assert.equal(rootFromDb({ db: "k.db" }), null);
  assert.equal(rootFromDb({}), null);
});

test("dt-eval --write-dec senza --root scrive la DEC nella cartella del DB; learn validate senza --root risponde", () => {
  const d = realpathSync.native(mkdtempSync(join(tmpdir(), "jvc-rd-")));
  const cust = join(d, "customers", "ACME");
  mkdirSync(cust, { recursive: true });
  const db = join(cust, "knowledge.db");
  openDb(db).close();
  const r = node("scripts/decide/dt-eval.mjs", ["--table", "DT-002", "risk=R1", "shape=consolidato", "mandatory_missing=false", "open_contradiction=false", "novelty=false",
    "--priors", "auto", "--customer", "ACME", "--scope", "CAT", "--db", db, "--write-dec", "--json"]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const code = JSON.parse(r.stdout).dec_code;
  assert.match(code, /^L\.ACME\.CAT\.DEC\.0001$/);
  assert.ok(existsSync(join(cust, "decisions", `${code}.yaml`)));
  const v = node("scripts/digest/learn.mjs", ["validate", "--db", db, "--json"]);
  assert.equal(v.status, 0, v.stderr + v.stdout);
  assert.equal(JSON.parse(v.stdout).ok, true);
  const bad = node("scripts/decide/dt-eval.mjs", ["--table", "DT-002", "risk=R1", "--customer", "ACME", "--scope", "CAT", "--db", join(d, "k.db"), "--write-dec", "--json"]);
  assert.equal(bad.status, 1, "DB con altro nome e senza --root");
});

test("guard-scope: il comando senza --root (solo --db) passa per un sub-agente; con --root customers/<C> resta negato", () => {
  const ws = mkWs(); seedSession(ws);
  const run = (command) => runHook("guard-scope", { session_id: "sess-1", cwd: ws, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, agent_type: "scope-expert", agent_id: "a1" }, { JVC_WORKSPACE: ws, CLAUDE_PLUGIN_ROOT: ROOT });
  const base = `node "${ROOT}/scripts/decide/dt-eval.mjs" --table DT-002 risk=R1 --customer ACME --scope CAT --db customers/ACME/knowledge.db --write-dec --json`;
  assert.equal(decisionOf(run(base)), null);
  assert.equal(decisionOf(run(`${base} --root customers/ACME`)), "deny");
});
