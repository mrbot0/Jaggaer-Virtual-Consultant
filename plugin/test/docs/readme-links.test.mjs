// WP10a — README.md (radice del plugin): ogni link relativo esiste; i prerequisiti del ruling 6 (npm install nella cartella
// del plugin, rischi residui, Chrome DevTools MCP fuori sandbox, JVC_DEV mai sulle macchine degli utenti); licenza.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { ROOT } from "../helpers/hook-env.mjs";

const readme = readFileSync(join(ROOT, "README.md"), "utf8");

test("README: ogni link relativo risolve a un file o una cartella esistente", () => {
  const links = [...readme.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]).filter((u) => !/^[a-z]+:/i.test(u) && !u.startsWith("#"));
  assert.ok(links.length >= 4, links.join(", "));
  const missing = links.filter((u) => !existsSync(join(ROOT, decodeURIComponent(u.split("#")[0]))));
  assert.deepEqual(missing, []);
  for (const l of ["docs/MANUAL.md", "docs/phase-reports/"]) assert.ok(links.some((u) => u.startsWith(l)), l);
  assert.ok(existsSync(join(dirname(join(ROOT, "README.md")), "docs", "MANUAL.md")));
});

test("README: prerequisiti e avvertenze del ruling 6, installazione in 6 passi, licenza UNLICENSED", () => {
  assert.match(readme, /npm install/);
  assert.match(readme, /cartella del plugin/);
  assert.match(readme, /non (sono )?una sandbox/i);
  assert.match(readme, /sola lettura/);
  assert.match(readme, /Chrome DevTools MCP/);
  assert.match(readme, /JVC_DEV/);
  assert.match(readme, /Node 22/);
  assert.match(readme, /UNLICENSED/);
  assert.match(readme, /vc doctor/);
});
