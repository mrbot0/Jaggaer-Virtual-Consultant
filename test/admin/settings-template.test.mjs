// F0.5 — templates/settings.template.json (§49.5, §53.3): .claude/settings.json minimo del workspace di conoscenza.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../helpers/hook-env.mjs";

test("template dei settings: JSON valido, plugin abilitato, permessi minimi e deny su .env, .auth, rm, git push --force, WebFetch", () => {
  const s = JSON.parse(readFileSync(join(ROOT, "templates/settings.template.json"), "utf8"));
  const enabled = Object.entries(s.enabledPlugins ?? {});
  assert.ok(enabled.some(([k, v]) => k.startsWith("jaggaer-virtual-consultant@") && v === true), "plugin abilitato");
  assert.deepEqual([...s.permissions.allow].sort(), ["Bash(node:*)", "Edit(customers/**)", "Read(customers/**)", "Read(product/**)"].sort());
  for (const d of ["Read(.env)", "Read(**/.env*)", "Read(.auth/**)", "Bash(rm:*)", "Bash(git push --force:*)", "Bash(git push -f:*)", "WebFetch"]) {
    assert.ok(s.permissions.deny.includes(d), `deny ${d}`);
  }
  // nessun allargamento: niente jolly, niente bypass dei permessi, niente variabili d'ambiente che spengono i guard
  assert.ok(!s.permissions.allow.some((a) => /^\w+$|\*\*\)$|^Bash\(\*|^Write/.test(a) && !/^Read\(|^Edit\(/.test(a)));
  assert.notEqual(s.permissions.defaultMode, "bypassPermissions");
  assert.equal(JSON.stringify(s).includes("JVC_DEV"), false);
  assert.equal(s.disableAllHooks ?? false, false);
});
