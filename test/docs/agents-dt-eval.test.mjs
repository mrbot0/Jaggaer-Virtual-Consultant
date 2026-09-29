// WP10b giro 1 (I1): le righe dt-eval documentate nei corpi degli agenti con input numerici a intervallo (DT-010 di
// weekly-digest, DT-022 di scope-digester) si ESEGUONO davvero, con valori d'esempio, in un workspace temporaneo con il
// DB del cliente: exit 0 ed esito della tabella. (agents-guards le valuta solo sotto i guard, con segnaposti X1.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT, cleanEnv } from "../helpers/hook-env.mjs";
import { simpleArgv } from "../../hooks/lib/exact-argv.mjs";
import { commandLines } from "../helpers/commands.mjs";
import { openDb } from "../../scripts/kb/db.mjs";
import { agentFiles, parseAgent } from "../helpers/agents-md.mjs";

const VALUES = { C: "ACME", S: "CAT", SES: "SES.ACME.20260929.001", codice: "C.ACME.CAT.CFG.0021", P: "0.9", deficit: "0.2", classe: "condizionata",
  "classe-qualità": "affidabile", "true-false": "false" };

test("le righe dt-eval con input a intervallo (DT-010, DT-022) documentate negli agenti riescono (exit 0)", () => {
  const ws = realpathSync.native(mkdtempSync(join(tmpdir(), "jvc-dt-")));
  mkdirSync(join(ws, "customers", "ACME"), { recursive: true });
  openDb(join(ws, "customers", "ACME", "knowledge.db")).close();
  const lines = [];
  for (const [name, text] of Object.entries(agentFiles())) {
    for (const l of commandLines(parseAgent(text).body)) if (/dt-eval\.mjs" --table DT-0(10|22)\b/.test(l)) lines.push([name, l]);
  }
  assert.deepEqual(lines.map(([n]) => n).sort(), ["scope-digester", "weekly-digest"]);
  for (const [name, line] of lines) {
    const rendered = line.replaceAll("${CLAUDE_PLUGIN_ROOT}", ROOT.replace(/\\/g, "/")).replace(/<([^<>]*)>/g, (_m, k) => {
      assert.ok(k in VALUES, `${name}: segnaposto senza valore d'esempio <${k}>`);
      return VALUES[k];
    });
    const argv = simpleArgv(rendered);
    const r = spawnSync(process.execPath, argv.slice(1), { cwd: ws, env: cleanEnv(), encoding: "utf8", timeout: 30000 });
    assert.equal(r.status, 0, `${name}: ${line}\n${r.stdout}${r.stderr}`);
    assert.ok(JSON.parse(r.stdout).outcome, name);
  }
});
