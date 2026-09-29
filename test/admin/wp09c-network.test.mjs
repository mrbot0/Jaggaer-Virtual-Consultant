// WP09c — NETWORK.md (§53.2) e doctor --network: le cinque categorie (jaggaer, alm, npm, claude, telemetry = none)
// lette dalla tabella; solo gli host della tabella entrano nell'allow-list (non i nomi di file nel testo libero);
// NETWORK.md assente o con telemetria ⇒ rosso; il file è sotto integrità.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { parseNetworkMd, checkNetworkCategories, runChecks, NETWORK_CATEGORIES } from "../../scripts/admin/doctor.mjs";
import { scopeFiles } from "../../hooks/lib/integrity.mjs";
import { copyPlugin } from "../helpers/plugin-copy.mjs";
import { mkWs, ROOT } from "../helpers/hook-env.mjs";

test("NETWORK.md del pacchetto: cinque categorie, telemetria none, host alm e npm dichiarati; sotto integrità", () => {
  const n = parseNetworkMd(ROOT);
  assert.equal(n.ok, true);
  assert.deepEqual(Object.keys(n.categories).sort(), [...NETWORK_CATEGORIES].sort());
  assert.deepEqual(n.categories.telemetry, { hosts: [], none: true });
  assert.deepEqual(n.categories.alm.hosts, ["*.atlassian.net", "*.getxray.app"]);
  assert.deepEqual(n.categories.npm.hosts, ["registry.npmjs.org"]);
  assert.equal(checkNetworkCategories(ROOT).status, "green");
  assert.ok(scopeFiles(ROOT).includes("NETWORK.md"));
  // i pacchetti npx di .mcp.json sono quelli dichiarati nella categoria npm
  const mcp = JSON.parse(readFileSync(join(ROOT, ".mcp.json"), "utf8")).mcpServers;
  const text = readFileSync(join(ROOT, "NETWORK.md"), "utf8");
  for (const s of Object.values(mcp).filter((x) => x.command === "npx")) assert.ok(text.includes(s.args.at(-1)), s.args.at(-1));
});

test("doctor --network: network-categories rosso con NETWORK.md assente, telemetria dichiarata o categoria mancante", async () => {
  const p = copyPlugin();
  const f = join(p, "NETWORK.md");
  const orig = readFileSync(f, "utf8");
  writeFileSync(f, orig.replace("| telemetry | none | mai | — |", "| telemetry | `stats.example.com` | sempre | — |"));
  assert.equal(checkNetworkCategories(p).status, "red");
  writeFileSync(f, orig.replace(/^\| npm \|.*$/m, ""));
  assert.match(checkNetworkCategories(p).detail, /categorie mancanti: npm/);
  writeFileSync(f, `${orig}\nNote: vedi \`environments.yaml\` e \`evil.example.com\`.\n`);
  assert.ok(!Object.values(parseNetworkMd(p).categories).flatMap((c) => c.hosts).includes("evil.example.com"), "solo la tabella conta");
  unlinkSync(f);
  assert.equal(checkNetworkCategories(p).status, "red");
  const checks = await runChecks({ ws: mkWs(), plugin: p, env: {}, network: true, resolver: async () => ["10.0.0.1"], fetcher: async () => ({ status: 200 }) });
  assert.equal(checks.find((c) => c.id === "network-categories").status, "red");
  const ok = await runChecks({ ws: mkWs(), plugin: ROOT, env: {}, network: true, resolver: async () => ["10.0.0.1"], fetcher: async () => ({ status: 200 }) });
  assert.equal(ok.find((c) => c.id === "network-categories").status, "green");
});
