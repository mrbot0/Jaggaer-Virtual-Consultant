// 29/10/2026 (decisione dell'utente, punto 1 del piano): versioni e distribuzione. Claude Code tiene i plugin in cache per
// versione, quindi la versione si alza a ogni rilascio e deve essere coerente fra plugin.json, package.json (e il suo
// lockfile) e integrity.json, con la voce in CHANGELOG.md; doctor plugin-version è giallo se il marketplace installato ha
// una versione più nuova, rosso se plugin.json e integrity.json non concordano, giallo «non verificabile» senza i file;
// SessionStart riporta la versione in uso e l'avviso.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runChecks, checkPluginVersion } from "../../scripts/admin/doctor.mjs";
import { compareVersions } from "../../hooks/lib/plugin-version.mjs";
import { demoWorkspace, DEMO_ENV } from "../helpers/demo-workspace.mjs";
import { copyPlugin } from "../helpers/plugin-copy.mjs";
import { ROOT, mkWs, runHook } from "../helpers/hook-env.mjs";

const NAME = "jaggaer-virtual-consultant";
const readJson = (rel) => JSON.parse(readFileSync(join(ROOT, rel), "utf8"));
const VERSION = readJson(".claude-plugin/plugin.json").version;
const byId = (checks, id) => checks.find((c) => c.id === id) ?? assert.fail(`controllo ${id} assente: ${checks.map((c) => c.id).join(", ")}`);
const ctxOf = (r) => r.json?.hookSpecificOutput?.additionalContext ?? "";

// Cartella di configurazione di Claude Code finta (CLAUDE_CONFIG_DIR) con un marketplace che distribuisce il plugin alla
// versione data. known: false ⇒ niente known_marketplaces.json (si scandisce plugins/marketplaces/*).
function fakeClaude(version, { known = true, mkName = "jaggaer-vc" } = {}) {
  const cfg = realpathSync.native(mkdtempSync(join(tmpdir(), "jvc-claude-")));
  const loc = join(cfg, "plugins", "marketplaces", mkName);
  mkdirSync(join(loc, ".claude-plugin"), { recursive: true });
  mkdirSync(join(loc, "plugin", ".claude-plugin"), { recursive: true });
  writeFileSync(join(loc, ".claude-plugin", "marketplace.json"), JSON.stringify({ name: mkName, owner: { name: "x" }, plugins: [{ name: NAME, source: "./plugin" }] }));
  writeFileSync(join(loc, "plugin", ".claude-plugin", "plugin.json"), JSON.stringify({ name: NAME, version }));
  if (known) writeFileSync(join(cfg, "plugins", "known_marketplaces.json"), JSON.stringify({ [mkName]: { source: { source: "git", url: "https://example.invalid/x.git" }, installLocation: loc } }));
  return cfg;
}
const emptyClaude = () => realpathSync.native(mkdtempSync(join(tmpdir(), "jvc-claude-vuoto-")));

test("versioni coerenti: plugin.json = package.json = package-lock.json = integrity.json, formato x.y.z", () => {
  assert.match(VERSION, /^\d+\.\d+\.\d+$/);
  assert.equal(readJson("package.json").version, VERSION);
  const lock = readJson("package-lock.json");
  assert.equal(lock.version, VERSION);
  assert.equal(lock.packages[""].version, VERSION);
  assert.equal(readJson("integrity.json").version, VERSION, "rigenerare integrity.json: node scripts/admin/integrity.mjs build");
});

test("CHANGELOG.md ha la voce della versione corrente", () => {
  const text = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8");
  assert.match(text, new RegExp(`^## ${VERSION.replace(/\./g, "\\.")}\\b`, "m"));
});

test("compareVersions: ordine numerico, pre-release prima del rilascio, null se non è x.y.z", () => {
  assert.equal(compareVersions("0.2.0", "0.1.0"), 1);
  assert.equal(compareVersions("0.10.0", "0.9.9"), 1);
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
  assert.equal(compareVersions("1.0.0-rc.1", "1.0.0"), -1);
  assert.equal(compareVersions("f8c5e7a1dcb7", "0.2.0"), null);
});

test("doctor plugin-version: marketplace installato con una versione più nuova ⇒ giallo «reinstalla il plugin»", async () => {
  const ws = demoWorkspace();
  for (const known of [true, false]) {
    const c = byId(await runChecks({ ws, plugin: ROOT, env: { ...DEMO_ENV, CLAUDE_CONFIG_DIR: fakeClaude("9.9.9", { known }) } }), "plugin-version");
    assert.equal(c.status, "yellow", JSON.stringify(c));
    assert.match(c.detail, new RegExp(`reinstalla il plugin: la copia in uso è ${VERSION.replace(/\./g, "\\.")}, disponibile 9\\.9\\.9`));
    assert.match(c.fix, /jaggaer-virtual-consultant@jaggaer-vc/);
  }
});

test("doctor plugin-version: stessa versione (o più vecchia) nel marketplace e integrity.json concorde ⇒ verde", async () => {
  const ws = demoWorkspace();
  for (const v of [VERSION, "0.0.1"]) {
    const c = byId(await runChecks({ ws, plugin: ROOT, env: { ...DEMO_ENV, CLAUDE_CONFIG_DIR: fakeClaude(v) } }), "plugin-version");
    assert.equal(c.status, "green", JSON.stringify(c));
    assert.match(c.detail, new RegExp(`jaggaer-vc ${v.replace(/\./g, "\\.")}`));
  }
});

test("doctor plugin-version: senza marketplace o senza integrity.json giallo «non verificabile», mai un errore; plugin.json ≠ integrity.json rosso", () => {
  const none = checkPluginVersion(ROOT, { CLAUDE_CONFIG_DIR: emptyClaude() });
  assert.equal(none.status, "yellow");
  assert.match(none.detail, /non verificabile: nessun marketplace/);
  const p = copyPlugin();   // la copia non ha integrity.json
  const noManifest = checkPluginVersion(p, { CLAUDE_CONFIG_DIR: fakeClaude(VERSION) });
  assert.equal(noManifest.status, "yellow");
  assert.match(noManifest.detail, /integrity\.json assente/);
  writeFileSync(join(p, "integrity.json"), JSON.stringify({ version: "0.0.9", files: {} }));
  const red = checkPluginVersion(p, { CLAUDE_CONFIG_DIR: fakeClaude(VERSION) });
  assert.equal(red.status, "red");
  assert.match(red.detail, new RegExp(`plugin\\.json dice ${VERSION.replace(/\./g, "\\.")} ma integrity\\.json 0\\.0\\.9`));
  writeFileSync(join(p, ".claude-plugin", "plugin.json"), "{ rotto");
  assert.equal(checkPluginVersion(p, { CLAUDE_CONFIG_DIR: emptyClaude() }).status, "yellow");
  // marketplace.json illeggibile o di un altro plugin: nessuna eccezione
  const cfg = fakeClaude("9.9.9");
  writeFileSync(join(cfg, "plugins", "marketplaces", "jaggaer-vc", ".claude-plugin", "marketplace.json"), JSON.stringify({ name: "altro", plugins: [{ name: "altro-plugin", source: "./plugin" }] }));
  assert.equal(checkPluginVersion(ROOT, { CLAUDE_CONFIG_DIR: cfg }).status, "yellow");
  assert.match(checkPluginVersion(ROOT, { CLAUDE_CONFIG_DIR: cfg }).detail, /non verificabile/);
});

test("SessionStart: riga con la versione del plugin in uso e, con un marketplace più nuovo, l'avviso di doctor plugin-version", () => {
  const ws = mkWs();
  const env = (cfg) => ({ JVC_WORKSPACE: ws, CLAUDE_PLUGIN_ROOT: ROOT, CLAUDE_CONFIG_DIR: cfg });
  const ok = runHook("session-context", { session_id: "pv-1", source: "startup", cwd: ws }, env(fakeClaude(VERSION)));
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ctxOf(ok), new RegExp(`Versione del plugin in uso: ${VERSION.replace(/\./g, "\\.")}\\.`));
  assert.doesNotMatch(ctxOf(ok), /plugin-version giallo/);
  const old = runHook("session-context", { session_id: "pv-2", source: "startup", cwd: ws }, env(fakeClaude("9.9.9")));
  assert.equal(old.status, 0, old.stderr);
  assert.match(ctxOf(old), /Avviso \(doctor plugin-version giallo\): reinstalla il plugin: la copia in uso è .*, disponibile 9\.9\.9/);
  assert.equal(old.stderr.trim(), "", "nessun avviso su stderr");
});
