// WP10b (ruling del controller 2) — lettura trasversale di process-mapper e weekly-digest (§44.2, §46.1, R4):
// la sessione principale (skill agent-manager) scrive con `session.mjs use paths --agent <tipo> --grant` un permesso di
// sola lettura in session.json PRIMA del dispatch e lo toglie con `--restore` dopo il ritorno (in audit). guard-scope e
// guard-customer lo onorano solo per quel tipo di agente e solo per Read/Glob/Grep; mai analysis/, mai altri clienti per
// process-mapper; i sub-agenti non invocano session.mjs (guard-budget).
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { mkWs, seedSession, runHook, runSessionCli, decisionOf, reasonOf, ROOT } from "../helpers/hook-env.mjs";
import { validateSession } from "../../scripts/admin/session.mjs";
import { verifyChain } from "../../hooks/lib/audit.mjs";

const call = (guard, ws, tool, tool_input, extra = {}) =>
  runHook(guard, { session_id: "sess-1", cwd: ws, hook_event_name: "PreToolUse", tool_name: tool, tool_input, ...extra }, { JVC_WORKSPACE: ws, CLAUDE_PLUGIN_ROOT: ROOT });
const denied = (r) => decisionOf(r) === "deny";
const silent = (r) => r.status === 0 && r.stdout.trim() === "";
const cli = (ws, args) => runSessionCli([...args, "--session", "sess-1", "--workspace", ws, "--json"], { CLAUDECODE: "1" });
const sessionOf = (ws) => JSON.parse(readFileSync(join(ws, "customers/ACME/.sessions/sess-1/session.json"), "utf8"));
const PM = { agent_type: "jaggaer-virtual-consultant:process-mapper", agent_id: "pm-1" };
const WD = { agent_type: "weekly-digest", agent_id: "wd-1" };
const EXPERT = { agent_type: "scope-expert", agent_id: "x-1" };

function ws0() {
  const ws = mkWs();
  seedSession(ws);
  for (const d of ["product/kb/scopes/ADM/flows", "product/kb/handoffs", "customers/BETA/kb/scopes/ADM"]) mkdirSync(join(ws, d), { recursive: true });
  writeFileSync(join(ws, "product/kb/scopes/ADM/flows/S.STD.ADM.FLW.0001.yaml"), "id: S.STD.ADM.FLW.0001\n");
  return ws;
}

test("use paths --agent process-mapper --grant: sola lettura di tutti gli scope del cliente attivo e del prodotto, mai analysis/ né altri clienti; in audit; --restore lo toglie", () => {
  const ws = ws0();
  const g = cli(ws, ["use", "paths", "--agent", "process-mapper", "--grant"]);
  assert.equal(g.status, 0, g.stderr + g.stdout);
  const cr = sessionOf(ws).cross_read["process-mapper"];
  assert.deepEqual([...cr.allowed_paths].sort(), ["customers/ACME/kb/handoffs/**", "customers/ACME/kb/scopes/**", "product/kb/handoffs/**", "product/kb/scopes/**"]);
  assert.ok(!cr.allowed_paths.some((p) => /analysis|BETA|\*\/kb|customers\/\*/.test(p)));
  assert.equal(cr.mode, "read");
  assert.ok(Date.parse(cr.expires_at) > Date.parse(cr.granted_at));
  assert.equal(cr.granted_by, "main-session");
  assert.ok(sessionOf(ws).allowed_paths.every((p) => !/kb\/scopes\/\*\*$/.test(p)), "la cella degli altri agenti non si allarga");
  assert.equal(validateSession(sessionOf(ws)).ok, true);
  const r = cli(ws, ["use", "paths", "--agent", "process-mapper", "--restore"]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(sessionOf(ws).cross_read?.["process-mapper"], undefined);
  const dir = join(ws, "customers/ACME/audit");
  const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  const events = files.flatMap((f) => readFileSync(join(dir, f), "utf8").trim().split("\n").map((l) => JSON.parse(l)));
  const acts = events.filter((e) => e.kind === "session").map((e) => e.payload.action);
  assert.ok(acts.includes("cross-read-grant") && acts.includes("cross-read-restore"), acts.join(","));
  assert.equal(events.find((e) => e.payload.action === "cross-read-grant").payload.agent, "process-mapper");
  for (const f of files) assert.equal(verifyChain(join(dir, f)).ok, true, f);
});

test("use paths: weekly-digest ha i kb di tutti i clienti (compatibile con l'eccezione esistente); agente non ammesso o senza --grant/--restore ⇒ exit 1", () => {
  const ws = ws0();
  assert.equal(cli(ws, ["use", "paths", "--agent", "weekly-digest", "--grant"]).status, 0);
  assert.ok(sessionOf(ws).cross_read["weekly-digest"].allowed_paths.includes("customers/*/kb/scopes/**"));
  for (const args of [["use", "paths", "--agent", "scope-expert", "--grant"], ["use", "paths", "--grant"], ["use", "paths", "--agent", "process-mapper"],
    ["use", "paths", "--agent", "process-mapper", "--grant", "--restore"]]) {
    const r = cli(ws, args);
    assert.equal(r.status, 1, `${args.join(" ")}: ${r.stdout}`);
  }
});

test("schema session: cross_read con percorsi analysis/ o agente non ammesso è invalido", () => {
  const ws = ws0();
  const s = sessionOf(ws);
  const now = new Date();
  const grant = (paths, agent = "process-mapper") => ({ ...s, cross_read: { [agent]: { mode: "read", allowed_paths: paths, granted_at: now.toISOString(), expires_at: new Date(+now + 3600e3).toISOString(), granted_by: "main-session" } } });
  assert.equal(validateSession(grant(["product/kb/scopes/**"])).ok, true);
  assert.equal(validateSession(grant(["customers/ACME/analysis/**"])).ok, false);
  assert.equal(validateSession(grant(["product/kb/scopes/**"], "scope-expert")).ok, false);
});

test("guard-scope: con il permesso process-mapper legge (Read/Glob/Grep) gli altri scope del cliente e del prodotto; mai scrive; mai _inbox/tests; senza permesso o per un altro tipo ⇒ deny", () => {
  const ws = ws0();
  const admC = join(ws, "customers/ACME/kb/scopes/ADM/configs/C.ACME.ADM.CFG.0019.yaml");
  const admS = join(ws, "product/kb/scopes/ADM/flows/S.STD.ADM.FLW.0001.yaml");
  assert.ok(denied(call("guard-scope", ws, "Read", { file_path: admC }, PM)), "senza permesso la cella è quella dello scope");
  assert.equal(cli(ws, ["use", "paths", "--agent", "process-mapper", "--grant"]).status, 0);
  assert.ok(silent(call("guard-scope", ws, "Read", { file_path: admC }, PM)));
  assert.ok(silent(call("guard-scope", ws, "Read", { file_path: admS }, PM)));
  assert.ok(silent(call("guard-scope", ws, "Glob", { pattern: "customers/ACME/kb/scopes/*/**", path: ws }, PM)));
  assert.ok(silent(call("guard-scope", ws, "Grep", { pattern: "FLW", path: join(ws, "product/kb/scopes") }, PM)));
  assert.ok(silent(call("guard-scope", ws, "Read", { file_path: join(ws, "customers/ACME/kb/handoffs/C.ACME.XSC.HND.0001.yaml") }, PM)));
  // mai scrittura, mai fuori dal permesso, mai per un altro tipo di agente, mai via shell
  assert.ok(denied(call("guard-scope", ws, "Write", { file_path: admC, content: "x" }, PM)));
  assert.ok(denied(call("guard-scope", ws, "Read", { file_path: join(ws, "customers/ACME/_inbox/ADM/x.md") }, PM)));
  assert.ok(denied(call("guard-scope", ws, "Read", { file_path: admC }, EXPERT)), "il permesso vale solo per process-mapper");
  assert.ok(denied(call("guard-scope", ws, "Read", { file_path: admS }, WD)), "né per weekly-digest (che ha solo l'eccezione storica sui customers/*/kb)");
  assert.ok(denied(call("guard-scope", ws, "Bash", { command: "cat customers/ACME/kb/scopes/ADM/configs/C.ACME.ADM.CFG.0019.yaml" }, PM)), "solo strumenti di lettura");
  const rr = call("guard-scope", ws, "Read", { file_path: admC }, { agent_type: "scope-expert", agent_id: "x-2" });
  assert.match(reasonOf(rr), /allowed_paths/);
  // restore ⇒ di nuovo negato
  assert.equal(cli(ws, ["use", "paths", "--agent", "process-mapper", "--restore"]).status, 0);
  assert.ok(denied(call("guard-scope", ws, "Read", { file_path: admC }, PM)));
});

test("guard-scope/guard-customer: permesso scaduto o manomesso (analysis/, altro cliente) non vale per process-mapper", () => {
  const ws = ws0();
  const f = join(ws, "customers/ACME/.sessions/sess-1/session.json");
  const s = sessionOf(ws);
  const past = new Date(Date.now() - 3600e3);
  s.cross_read = { "process-mapper": { mode: "read", allowed_paths: ["customers/ACME/kb/scopes/**"], granted_at: new Date(+past - 60e3).toISOString(), expires_at: past.toISOString(), granted_by: "main-session" } };
  writeFileSync(f, JSON.stringify(s, null, 2));
  assert.ok(denied(call("guard-scope", ws, "Read", { file_path: join(ws, "customers/ACME/kb/scopes/ADM/configs/C.ACME.ADM.CFG.0019.yaml") }, PM)), "scaduto");
  const fut = new Date(Date.now() + 3600e3).toISOString();
  s.cross_read = { "process-mapper": { mode: "read", allowed_paths: ["customers/*/kb/scopes/**", "customers/ACME/kb/**"], granted_at: new Date().toISOString(), expires_at: fut, granted_by: "main-session" } };
  writeFileSync(f, JSON.stringify(s, null, 2));
  assert.ok(denied(call("guard-customer", ws, "Read", { file_path: join(ws, "customers/BETA/kb/scopes/CAT/secret.yaml") }, PM)), "mai altri clienti per process-mapper");
  assert.ok(denied(call("guard-scope", ws, "Read", { file_path: join(ws, "customers/BETA/kb/scopes/CAT/secret.yaml") }, PM)));
  assert.ok(denied(call("guard-domain-boundary", ws, "Read", { file_path: join(ws, "customers/ACME/analysis/patterns/C.ACME.CAT.PAT.0001.yaml") }, PM)), "mai analysis/");
});

test("weekly-digest: l'eccezione esistente resta; con il permesso legge anche product/kb/scopes di ogni scope; mai scrive", () => {
  const ws = ws0();
  const admS = join(ws, "product/kb/scopes/ADM/flows/S.STD.ADM.FLW.0001.yaml");
  assert.ok(silent(call("guard-customer", ws, "Read", { file_path: join(ws, "customers/BETA/lessons/L.BETA.CAT.LSN.0001.md") }, WD)), "compatibile: senza permesso");
  assert.ok(silent(call("guard-scope", ws, "Read", { file_path: join(ws, "customers/BETA/kb/scopes/CAT/secret.yaml") }, WD)));
  assert.ok(denied(call("guard-scope", ws, "Read", { file_path: admS }, WD)));
  assert.equal(cli(ws, ["use", "paths", "--agent", "weekly-digest", "--grant"]).status, 0);
  assert.ok(silent(call("guard-scope", ws, "Read", { file_path: admS }, WD)));
  assert.ok(silent(call("guard-customer", ws, "Read", { file_path: join(ws, "customers/BETA/kb/scopes/ADM/x.yaml") }, WD)));
  assert.ok(denied(call("guard-scope", ws, "Write", { file_path: admS, content: "x" }, WD)));
  assert.ok(denied(call("guard-customer", ws, "Write", { file_path: join(ws, "customers/BETA/kb/scopes/ADM/x.yaml"), content: "x" }, WD)));
});

test("guard-budget: un sub-agente non invoca `session.mjs use paths` (né grant né restore); la sessione principale sì", () => {
  const ws = ws0();
  for (const c of [`node "${ROOT}/scripts/admin/session.mjs" use paths --agent process-mapper --grant`, `node "${ROOT}/scripts/admin/session.mjs" use paths --agent process-mapper --restore`]) {
    assert.ok(denied(call("guard-budget", ws, "Bash", { command: c }, PM)), c);
    assert.ok(silent(call("guard-budget", ws, "Bash", { command: c })), `sessione principale: ${c}`);
  }
});
