// K5.1 — schema degli ambienti (§51.1, §52.1 strato 1): le regole di produzione
// sono imposte dallo schema (if/then), non da un avviso (Review Focus 2).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import YAML from "yaml";
import { validateEnvironments, normalizeEnvironment } from "../../scripts/kb/validate-env.mjs";
import { ROOT, cleanEnv } from "../helpers/hook-env.mjs";

const FIXTURE = join(ROOT, "test/fixtures/env/environments.yaml");
const load = () => YAML.parse(readFileSync(FIXTURE, "utf8"));
const env = (doc, id) => doc.environments.find((e) => e.id === id);
const CLI = join(ROOT, "scripts/kb/validate-env.mjs");
// correzione mirata finale: il file è un ingresso confinato nel workspace degli hook (qui la cartella temporanea)
const cli = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: cleanEnv({ JVC_WORKSPACE: tmpdir() }) });
const tmpYaml = (doc) => { const f = join(mkdtempSync(join(tmpdir(), "env-")), "environments.yaml"); writeFileSync(f, YAML.stringify(doc)); return f; };

test("l'esempio di §51.1 è valido", () => {
  const r = validateEnvironments(load());
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
});

test("RF2 (Review Focus 2): type prod + write_data true → rifiuto dello schema, violazione di policy", () => {
  const doc = load();
  env(doc, "prod").policy.write_data = true;
  const r = validateEnvironments(doc);
  assert.equal(r.ok, false);
  assert.ok(r.policy.length > 0, "è una violazione di policy, non un file malformato");
  assert.ok(r.errors.some((e) => /write_data/.test(e)), r.errors.join("\n"));
});

test("prod: ogni livello di approvazione deve essere 3; rosso vietato in config_levels", () => {
  const a = load(); env(a, "prod").policy.approvals.config_giallo = 2;
  assert.equal(validateEnvironments(a).ok, false);
  assert.ok(validateEnvironments(a).policy.length > 0);
  const b = load(); env(b, "prod").policy.approvals.config_verde = 1;
  assert.equal(validateEnvironments(b).ok, false);
  const c = load(); env(c, "prod").policy.config_levels = ["verde", "giallo", "rosso"]; env(c, "prod").policy.approvals.config_rosso = 3;
  const rc = validateEnvironments(c);
  assert.equal(rc.ok, false);
  assert.ok(rc.policy.length > 0);
  // un livello dichiarato senza il suo numero di approvazioni è malformato
  const d = load(); delete env(d, "sandbox").policy.approvals.config_rosso;
  assert.equal(validateEnvironments(d).ok, false);
});

test("impronta: meno di 2 segnali fra title_pattern/banner/tenant_id/login_url_pattern → rifiuto", () => {
  const doc = load();
  env(doc, "preprod").fingerprint = { title_pattern: "^ACME PRE", banner: null };
  const r = validateEnvironments(doc);
  assert.equal(r.ok, false);
  assert.equal(r.policy.length, 0, "malformato, non policy");
  const ok = load();
  env(ok, "preprod").fingerprint = { title_pattern: "^ACME PRE", login_url_pattern: "^https://sso\\.acme\\.it/" };
  assert.equal(validateEnvironments(ok).ok, true);
});

test("allowed_hosts obbligatorio e non vuoto; base_url dentro allowed_hosts; host in minuscolo ASCII", () => {
  const a = load(); delete env(a, "sandbox").allowed_hosts;
  assert.equal(validateEnvironments(a).ok, false);
  const b = load(); env(b, "sandbox").allowed_hosts = [];
  assert.equal(validateEnvironments(b).ok, false);
  const c = load(); env(c, "sandbox").allowed_hosts = ["sso-test.acme.it"];
  assert.ok(validateEnvironments(c).errors.some((e) => /base_url/.test(e)));
  const d = load(); env(d, "sandbox").allowed_hosts.push("https://evil.io/");
  assert.equal(validateEnvironments(d).ok, false);
  const e = load(); env(e, "sandbox").allowed_hosts.push("10.0.0.1");
  assert.equal(validateEnvironments(e).ok, false, "gli IP letterali non si dichiarano");
});

test("id univoci e regex valide", () => {
  const a = load(); env(a, "preprod").id = "sandbox";
  assert.equal(validateEnvironments(a).ok, false);
  const b = load(); env(b, "sandbox").fingerprint.title_pattern = "([";
  assert.equal(validateEnvironments(b).ok, false);
});

test("normalizeEnvironment: prod_allowed_red default [], finestra 60, secondo approvatore in prod per default", () => {
  const doc = load();
  const p = { ...env(doc, "prod"), policy: { ...env(doc, "prod").policy } };
  delete p.policy.prod_allowed_red; delete p.policy.config_window_minutes; delete p.policy.second_approver_required;
  const n = normalizeEnvironment(p);
  assert.deepEqual(n.policy.prod_allowed_red, []);
  assert.equal(n.policy.config_window_minutes, 60);
  assert.equal(n.policy.second_approver_required, true);
  assert.equal(normalizeEnvironment(env(doc, "sandbox")).policy.second_approver_required, false);
});

test("CLI validate-env: 0 valido · 3 violazione di policy (RF2) · 1 malformato · --help", () => {
  assert.equal(cli([tmpYaml(load()), "--json"]).status, 0);
  const rf2 = load(); env(rf2, "prod").policy.write_data = true;
  const r3 = cli([tmpYaml(rf2), "--json"]);
  assert.equal(r3.status, 3, r3.stdout + r3.stderr);
  assert.equal(JSON.parse(r3.stdout).ok, false);
  const bad = load(); delete env(bad, "sandbox").allowed_hosts;
  assert.equal(cli([tmpYaml(bad), "--json"]).status, 1);
  const f = join(mkdtempSync(join(tmpdir(), "env-")), "x.yaml"); writeFileSync(f, "environments: [: :");
  assert.equal(cli([f, "--json"]).status, 1, "YAML non valido = input malformato");
  assert.equal(cli(["--help"]).status, 0);
  assert.equal(cli([]).status, 1);
});
