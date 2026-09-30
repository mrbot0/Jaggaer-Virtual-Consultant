// WP09b giro di correzione 3 — esiti dei run protetti come session.json (citarli in un comando d'interprete o in uno
// script eseguito da un interprete è negato, come per lo stato di sessione); kb snapshot interroga il DB per i codici
// dell'anello (righe forgiate con codici alti non spingono fuori le OBS vere); url_pattern con la stessa
// normalizzazione dei segmenti ID del percorso.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { runHook, decisionOf, ROOT } from "../helpers/hook-env.mjs";
import { envWs } from "../helpers/env-fixture.mjs";
import { takeSnapshot, obsMatchesLocation } from "../../scripts/kb/snapshot.mjs";
import { openDb } from "../../scripts/kb/db.mjs";
import { writeItem, cfg, recordObs } from "../helpers/wp09b-items.mjs";

const RUN = "RUN.ACME.20260929.1000.ADM";
const P = "https://acme-sbx.jaggaer.com";

test("esiti dei run come session.json: script .py eseguito che li apre in scrittura e one-liner pathlib negati (sessione e sub-agente), come per session.json", () => {
  const ws = envWs({ env: "sandbox" });
  const call = (command, extra) => runHook("guard-config-scope", { session_id: "sess-1", cwd: ws, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, ...extra }, { JVC_WORKSPACE: ws, CLAUDE_PLUGIN_ROOT: ROOT });
  const targets = [`customers/ACME/runs/${RUN}/result.yaml`, `customers/ACME/runs/${RUN}/results/PLAN.X.yaml`, "customers/ACME/.sessions/sess-1/session.json"];
  for (const extra of [{}, { agent_id: "a1", agent_type: "scope-expert" }]) {
    for (const [i, t] of targets.entries()) {
      writeFileSync(join(ws, `w${i}.py`), `f = open("${t}", "w")\nf.write("status: green\\n")\n`);
      assert.equal(decisionOf(call(`python w${i}.py`, extra)), "deny", `script su ${t}`);
      assert.equal(decisionOf(call(`python -c "import pathlib; pathlib.Path('${t}').write_text('status: green')"`, extra)), "deny", `pathlib su ${t}`);
    }
  }
  // controllo: uno script che non cita esiti né stato resta ammesso
  writeFileSync(join(ws, "ok.py"), `open("tmp/x.txt", "w").write("x")\n`);
  assert.notEqual(decisionOf(call("python ok.py", {})), "deny");
});

test("kb snapshot: le OBS si cercano per i codici dell'anello — 520 righe forgiate con codici più alti non spingono fuori l'OBS vera", () => {
  const ws = envWs({ env: "sandbox" });
  writeItem(ws, cfg("C.ACME.ADM.CFG.0019", { location: { page_sig: "setup/import-profiles" } }));
  recordObs(ws, "L.ACME.ADM.OBS.0001", { page_signature: "setup/import-profiles#setup", url: `${P}/setup/import-profiles/7` });
  const db = openDb(join(ws, "customers/ACME/knowledge.db"));
  const ins = db.prepare("insert into observations(code, session, scope, page_sig, payload, confirmed_count) values (?,?,?,?,?,1)");
  db.transaction(() => { for (let n = 5000; n < 5520; n++) ins.run(`L.ACME.ADM.OBS.${n}`, "x", "ADM", "altro", JSON.stringify({ id: `L.ACME.ADM.OBS.${n}`, ts: new Date().toISOString() })); })();
  db.close();
  assert.equal(takeSnapshot({ ws, sid: "sess-1", objects: ["C.ACME.ADM.CFG.0019"], run: RUN }).objects[0].obs, "L.ACME.ADM.OBS.0001");
});

test("url_pattern con la normalizzazione dei segmenti ID: /setup/import-profiles/* coincide con …/import-profiles/7; percorsi di soli ID mai uguali", () => {
  const at = (url) => ({ url, page_signature: null, elements_seen: [] });
  assert.equal(obsMatchesLocation(at(`${P}/setup/import-profiles/7`), { url_pattern: "/setup/import-profiles/*" }), true);
  assert.equal(obsMatchesLocation(at(`${P}/setup/import-profiles/7`), { url_pattern: "/setup/import-profiles/12" }), true, "un ID vale l'altro");
  assert.equal(obsMatchesLocation(at(`${P}/setup/import-profiles/7`), { url_pattern: "/setup/import-profiles" }), false, "ancorato: il segmento ID in più conta");
  assert.equal(obsMatchesLocation(at(`${P}/setup/import-profiles/7/edit`), { url_pattern: "/setup/import-profiles/*" }), false);
  assert.equal(obsMatchesLocation(at(`${P}/123`), { url_pattern: "/456" }), false, "percorso di soli ID");
  assert.equal(obsMatchesLocation(at(`${P}/123/456`), { url_pattern: "/*/*" }), false, "un pattern senza segmenti letterali non lega");
});
