// 29/10/2026 (decisione dell'utente: a ogni nuovo branch si alza la versione del plugin, altrimenti la cache di Claude Code
// non si rinnova): bump-version su un repository finto, e l'hook git che lo chiama solo alla creazione di un branch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bump, nextVersion } from "../../scripts/admin/bump-version.mjs";
import { ROOT } from "../helpers/hook-env.mjs";

test("nextVersion: patch, minor, major; versione non semver ⇒ errore", () => {
  assert.equal(nextVersion("0.1.0", "patch"), "0.1.1");
  assert.equal(nextVersion("0.1.7", "minor"), "0.2.0");
  assert.equal(nextVersion("0.9.3", "major"), "1.0.0");
  assert.throws(() => nextVersion("0.1", "minor"));
});

test("bump: plugin.json, package.json, package-lock.json, marketplace.json e voce in testa al CHANGELOG", () => {
  const repo = mkdtempSync(join(tmpdir(), "bump-"));
  const plugin = join(repo, "plugin");
  mkdirSync(join(plugin, ".claude-plugin"), { recursive: true });
  mkdirSync(join(repo, ".claude-plugin"), { recursive: true });
  writeFileSync(join(plugin, ".claude-plugin/plugin.json"), JSON.stringify({ name: "jaggaer-virtual-consultant", version: "0.2.0" }));
  writeFileSync(join(plugin, "package.json"), JSON.stringify({ name: "x", version: "0.2.0" }));
  writeFileSync(join(plugin, "package-lock.json"), JSON.stringify({ name: "x", version: "0.2.0", packages: { "": { version: "0.2.0" } } }));
  writeFileSync(join(repo, ".claude-plugin/marketplace.json"), JSON.stringify({ plugins: [{ name: "jaggaer-virtual-consultant", source: "./plugin", version: "0.2.0" }] }));
  writeFileSync(join(plugin, "CHANGELOG.md"), "# Changelog\n\n## 0.2.0 — 2026-10-29\n\n- prima voce\n");
  const r = bump({ plugin, repo, kind: "minor", branch: "feat/x", integrity: false, today: "2026-10-30" });
  assert.equal(r.from, "0.2.0");
  assert.equal(r.to, "0.3.0");
  for (const f of ["plugin/.claude-plugin/plugin.json", "plugin/package.json"]) assert.equal(JSON.parse(readFileSync(join(repo, f), "utf8")).version, "0.3.0", f);
  const lock = JSON.parse(readFileSync(join(plugin, "package-lock.json"), "utf8"));
  assert.equal(lock.version, "0.3.0");
  assert.equal(lock.packages[""].version, "0.3.0");
  assert.equal(JSON.parse(readFileSync(join(repo, ".claude-plugin/marketplace.json"), "utf8")).plugins[0].version, "0.3.0");
  const cl = readFileSync(join(plugin, "CHANGELOG.md"), "utf8");
  assert.ok(cl.indexOf("## 0.3.0 — 2026-10-30") < cl.indexOf("## 0.2.0"), cl);
  assert.match(cl, /branch `feat\/x`/);
});

test("hook git post-checkout: chiama bump-version solo per un branch nuovo (stesso commit, mai visto), mai su main", () => {
  const hook = readFileSync(join(ROOT, "..", ".githooks", "post-checkout"), "utf8");
  assert.match(hook, /^#!\/bin\/sh/);
  assert.match(hook, /\[ "\$3" = "1" \] \|\| exit 0/);
  assert.match(hook, /\[ "\$1" = "\$2" \] \|\| exit 0/);
  assert.match(hook, /main\|master\) exit 0/);
  assert.match(hook, /bump-version\.mjs" minor --branch/);
  assert.match(hook, /jvc-bumped-branches/);
});
