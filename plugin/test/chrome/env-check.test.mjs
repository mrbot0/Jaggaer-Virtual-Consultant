// K5.2 — env-check (§51.2): impronta a ≥ 2 segnali; < 2 ⇒ unknown; segnale
// contrario (absence_required, banner assente, host non dichiarato) ⇒ unknown.
// `use env` dichiara l'ambiente (verified:false); cambiarlo invalida la verifica.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import YAML from "yaml";
import { check, parseSnapshot } from "../../scripts/chrome/env-check.mjs";
import { verifyChain, auditFile } from "../../hooks/lib/audit.mjs";
import { ROOT, mkWs, seedSession, runSessionCli, cleanEnv } from "../helpers/hook-env.mjs";

const FIX = join(ROOT, "test/fixtures/env");
const DOC = YAML.parse(readFileSync(join(FIX, "environments.yaml"), "utf8"));
const decl = (id) => DOC.environments.find((e) => e.id === id);
const page = (f) => parseSnapshot(readFileSync(join(FIX, "pages", f), "utf8"));
const CLI = join(ROOT, "scripts/chrome/env-check.mjs");
const envCheck = (args, env = {}) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: cleanEnv(env) });
  let json = null; try { json = JSON.parse(r.stdout.trim().split("\n").pop()); } catch { /* non JSON */ }
  return { ...r, json };
};

// revisione finale: lo snapshot (file d'ingresso) sta nel workspace degli hook — copiato dalla fixture
const snapIn = (ws, f) => { const rel = `customers/ACME/.sessions/sess-1/${f.split("/").join("-")}`; mkdirSync(join(ws, "customers/ACME/.sessions/sess-1"), { recursive: true }); copyFileSync(join(FIX, f), join(ws, rel)); return rel; };

function wsWithEnv() {
  const ws = mkWs(); seedSession(ws);
  mkdirSync(join(ws, "customers/ACME/config"), { recursive: true });
  copyFileSync(join(FIX, "environments.yaml"), join(ws, "customers/ACME/config/environments.yaml"));
  return ws;
}
const sessionOf = (ws) => JSON.parse(readFileSync(join(ws, "customers/ACME/.sessions/sess-1/session.json"), "utf8"));
const E = (ws) => ({ JVC_WORKSPACE: ws });

test("tenant demo: la sandbox è riconosciuta (titolo, banner, tenant id) → verified", () => {
  const r = check(decl("sandbox"), page("sandbox.json"));
  assert.equal(r.env, "sandbox");
  assert.equal(r.verified, true);
  assert.ok(r.signals_matched.length >= 2, JSON.stringify(r));
  assert.deepEqual(r.signals_contrary, []);
  assert.equal(check(decl("preprod"), page("preprod.json")).env, "preprod");
  assert.equal(check(decl("prod"), page("prod.json")).env, "prod");
});

test("1 solo segnale → unknown (§58: 'Ambiente non riconosciuto (1 segnale su 2)')", () => {
  const r = check(decl("sandbox"), page("ambiguous.json"));
  assert.equal(r.env, "unknown");
  assert.equal(r.verified, false);
  assert.equal(r.signals_matched.length, 1);
});

test("segnale contrario: banner SANDBOX in un ambiente dichiarato prod → unknown", () => {
  const r = check(decl("prod"), page("prod-with-sandbox-banner.json"));
  assert.equal(r.env, "unknown");
  assert.ok(r.signals_contrary.some((s) => /SANDBOX/.test(s)), JSON.stringify(r));
});

test("segnale contrario: banner assente in un ambiente dichiarato sandbox → unknown (anche con 2 segnali)", () => {
  const r = check(decl("sandbox"), page("sandbox-no-banner.json"));
  assert.ok(r.signals_matched.length >= 2);
  assert.equal(r.env, "unknown");
  assert.ok(r.signals_contrary.some((s) => /banner/.test(s)));
});

test("la pagina della sandbox non verifica la produzione (host non dichiarato, tenant diverso)", () => {
  const r = check(decl("prod"), page("sandbox.json"));
  assert.equal(r.env, "unknown");
  assert.ok(r.signals_contrary.some((s) => /host/.test(s)));
});

test("parseSnapshot: testo di take_snapshot (RootWebArea) → titolo, URL, testo", () => {
  const p = page("sandbox-devtools.txt");
  assert.equal(p.title, "ACME SBX - Home");
  assert.equal(p.url, "https://acme-sbx.jaggaer.com/home");
  const r = check(decl("sandbox"), p);
  assert.equal(r.env, "sandbox", JSON.stringify(r));
});

test("use env: dichiara (verified:false, allow-list e policy dal file, hash del file); ambiente inesistente → exit 1", () => {
  const ws = wsWithEnv();
  const r = runSessionCli(["use", "env", "sandbox", "--session", "sess-1", "--json"], E(ws));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const s = sessionOf(ws);
  assert.equal(s.env.id, "sandbox");
  assert.equal(s.env.type, "sandbox");
  assert.equal(s.env.verified, false);
  assert.deepEqual(s.env.allowed_hosts, ["acme-sbx.jaggaer.com", "sso-test.acme.it", "cdn.jaggaer.com"]);
  assert.match(s.env.source_sha256, /^[0-9a-f]{64}$/);
  assert.equal(runSessionCli(["use", "env", "qa", "--session", "sess-1", "--json"], E(ws)).status, 1);
  const chain = verifyChain(auditFile(ws, "ACME"));
  assert.equal(chain.ok, true);
  assert.ok(readFileSync(auditFile(ws, "ACME"), "utf8").includes("use-env"));
});

test("use env: environments.yaml con violazione di policy di produzione (approvazioni di configurazione) → exit 3, nessun ambiente dichiarato", () => {
  const ws = wsWithEnv();
  const doc = structuredClone(DOC); doc.environments.find((e) => e.id === "prod").policy.approvals.config_giallo = 2;
  writeFileSync(join(ws, "customers/ACME/config/environments.yaml"), YAML.stringify(doc));
  const r = runSessionCli(["use", "env", "prod", "--session", "sess-1", "--json"], E(ws));
  assert.equal(r.status, 3, r.stdout);
  assert.equal(sessionOf(ws).env, null);
});

test("env-check --write-session: verifica l'ambiente dichiarato; cambiare ambiente invalida la verifica", () => {
  const ws = wsWithEnv();
  assert.equal(runSessionCli(["use", "env", "sandbox", "--session", "sess-1"], E(ws)).status, 0);
  const snap = snapIn(ws, "pages/sandbox.json");
  const r = envCheck(["--customer", "ACME", "--env", "sandbox", "--snapshot", snap, "--write-session", "--session", "sess-1", "--json"], E(ws));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.json.env, "sandbox");
  let s = sessionOf(ws);
  assert.equal(s.env.verified, true);
  assert.match(s.env.verified_at, /^\d{4}-/);
  assert.ok(s.env.signals.matched.length >= 2);
  // cambio di ambiente ⇒ verifica persa
  assert.equal(runSessionCli(["use", "env", "preprod", "--session", "sess-1"], E(ws)).status, 0);
  s = sessionOf(ws);
  assert.equal(s.env.id, "preprod");
  assert.equal(s.env.verified, false);
  assert.equal(s.env.verified_at, null);
});

test("env-check --write-session: pagina ambigua → exit 3, verified:false; env diverso dal dichiarato → exit 3", () => {
  const ws = wsWithEnv();
  runSessionCli(["use", "env", "sandbox", "--session", "sess-1"], E(ws));
  const r = envCheck(["--customer", "ACME", "--env", "sandbox", "--snapshot", snapIn(ws, "pages/ambiguous.json"), "--write-session", "--session", "sess-1", "--json"], E(ws));
  assert.equal(r.status, 3);
  assert.equal(r.json.env, "unknown");
  assert.equal(sessionOf(ws).env.verified, false);
  const r2 = envCheck(["--customer", "ACME", "--env", "prod", "--snapshot", snapIn(ws, "pages/prod.json"), "--write-session", "--session", "sess-1", "--json"], E(ws));
  assert.equal(r2.status, 3, "si verifica solo l'ambiente dichiarato con /use env");
  assert.equal(sessionOf(ws).env.id, "sandbox");
  assert.equal(sessionOf(ws).env.verified, false);
});

test("env-check: environments.yaml cambiato dopo use env → ambiente ricaricato e verificato (28/10/2026); tipo cambiato → exit 3", () => {
  const ws = wsWithEnv();
  runSessionCli(["use", "env", "sandbox", "--session", "sess-1"], E(ws));
  const f = join(ws, "customers/ACME/config/environments.yaml");
  writeFileSync(f, readFileSync(f, "utf8").replace('"cdn.jaggaer.com"', '"cdn.jaggaer.com", "evil.io"'));
  const r = envCheck(["--customer", "ACME", "--env", "sandbox", "--snapshot", snapIn(ws, "pages/sandbox.json"), "--write-session", "--session", "sess-1", "--json"], E(ws));
  assert.equal(r.status, 0, r.stdout);
  assert.equal(sessionOf(ws).env.verified, true);
  assert.ok(sessionOf(ws).env.allowed_hosts.includes("evil.io"));
  writeFileSync(f, readFileSync(f, "utf8").replace("type: sandbox", "type: preprod"));
  const t = envCheck(["--customer", "ACME", "--env", "sandbox", "--snapshot", snapIn(ws, "pages/sandbox.json"), "--write-session", "--session", "sess-1", "--json"], E(ws));
  assert.equal(t.status, 3, t.stdout);
  assert.equal(sessionOf(ws).env.verified, false);
});

test("env-check senza --write-session: solo diagnosi, --help", () => {
  const r = envCheck(["--env-file", join(FIX, "environments.yaml"), "--env", "prod", "--snapshot", join(FIX, "pages/prod.json"), "--json"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.json.verified, true);
  assert.equal(envCheck(["--help"]).status, 0);
  assert.equal(envCheck([]).status, 1);
});

test("K5.6 use env: remediation-scope.yaml validato e copiato in session.env con il suo hash; invalido → exit 1", () => {
  const ws = wsWithEnv();
  const f = join(ws, "customers/ACME/config/remediation-scope.yaml");
  writeFileSync(f, YAML.stringify({ levels: { verde: { areas: ["CL-CFG-006"], objects: [] }, giallo: { areas: ["CL-CFG-020"], objects: ["C.ACME.ADM.CFG.0019"] } } }));
  assert.equal(runSessionCli(["use", "env", "sandbox", "--session", "sess-1"], E(ws)).status, 0);
  const s = sessionOf(ws);
  assert.deepEqual(s.env.remediation.levels.giallo.objects, ["C.ACME.ADM.CFG.0019"]);
  assert.match(s.env.remediation_sha256, /^[0-9a-f]{64}$/);
  writeFileSync(f, YAML.stringify({ levels: { blu: { areas: ["X"] } } }));
  assert.equal(runSessionCli(["use", "env", "sandbox", "--session", "sess-1", "--json"], E(ws)).status, 1);
});
