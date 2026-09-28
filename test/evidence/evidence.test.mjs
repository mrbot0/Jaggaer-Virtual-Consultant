// WP09b E — evidence select (DT-009: sette tipi di punto, failure sempre, sink dossier/desk/xray con profilo strict e
// tetto di allegati) e contact sheet (HTML offline release → scope → caso, link relativi, cartella desk).
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { selectEvidence } from "../../scripts/evidence/select.mjs";
import { buildDesk } from "../../scripts/evidence/contact-sheet.mjs";
import { kbWs } from "../helpers/wp09b-items.mjs";

const CS = fileURLToPath(new URL("../../scripts/evidence/contact-sheet.mjs", import.meta.url));
const RUN = "RUN.ACME.20260929.1000.P2P";
const CASE = "NRT.ACME.P2P.NEG.0001";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

function run(w, evs) {
  const cdir = join(w, "customers/ACME/runs", RUN, "cases", CASE);
  mkdirSync(join(cdir, "evidence"), { recursive: true });
  writeFileSync(join(cdir, "plan.json"), JSON.stringify({ plan_id: `PLAN.${CASE}`, customer: "ACME", env: "sandbox", goal: "g",
    steps: [{ n: 1, verb: "NAVIGATE", action_class: "ACT-OBS" }, { n: 2, verb: "FILL", action_class: "ACT-OBS" }, { n: 3, verb: "SAVE", action_class: "ACT-CREATE" }, { n: 4, verb: "SUBMIT", action_class: "ACT-SUBMIT" }],
    evidence: [{ at: 4, kind: "assertion" }] }));
  evs.forEach((e, i) => {
    const nn = String(i + 1).padStart(2, "0");
    writeFileSync(join(cdir, "evidence", `${nn}.png`), Buffer.concat([PNG, Buffer.from(e.bytes ?? nn)]));
    writeFileSync(join(cdir, "evidence", `${nn}.yaml`), YAML.stringify({ id: `EV-${nn}`, type: "EVD", plan: `PLAN.${CASE}`, step: e.step, scope: "P2P", kind: e.kind, caption: e.caption ?? `passo ${e.step}`,
      file: `customers/ACME/runs/${RUN}/cases/${CASE}/evidence/${nn}.png`, sha256: e.sha ?? `sha-${nn}`, profile: e.profile ?? "strict", publishable: e.publishable ?? true, ts: "2026-09-29T10:00:00Z" }));
  });
}

test("DT-009: failure sempre; assertion dichiarata dal piano sì; entry non richiesta no; transition richiesta da ACT-CREATE sì; duplicato no; non pubblicabile solo nel dossier; standard fuori da Xray", () => {
  const w = kbWs();
  run(w, [
    { step: 1, kind: "entry" },                                   // ACT-OBS richiede entry ⇒ required_by_action
    { step: 2, kind: "input" },                                   // ACT-OBS: non richiesto, non citato ⇒ 0.3 < 0.5
    { step: 3, kind: "transition", profile: "standard" },         // ACT-CREATE richiede input+transition
    { step: 1, kind: "entry", sha: "sha-01" },                    // duplicato di EV-01: 0.52 → 0.42 < 0.5
    { step: 4, kind: "assertion", publishable: false },           // citato dal piano, non pubblicabile
    { step: 4, kind: "failure", sha: "sha-03" },                  // failure: sempre, anche se duplicato
  ]);
  const c = selectEvidence(w, { customer: "ACME", run: RUN }).cases[CASE];
  assert.equal(c.scope, "P2P");
  assert.deepEqual(c.dossier.map((e) => e.id), ["EV-01", "EV-03", "EV-05", "EV-06"]);
  assert.deepEqual(c.desk.map((e) => e.id), ["EV-01", "EV-03", "EV-06"]);
  assert.deepEqual(c.xray.map((e) => e.id).sort(), ["EV-01", "EV-06"]);
  const why = Object.fromEntries(c.rejected.map((r) => [`${r.id}${r.sink ? `:${r.sink}` : ""}`, r.reason]));
  assert.match(why["EV-02"], /DT-009/); assert.match(why["EV-04"], /DT-009/);
  assert.match(why["EV-05:desk/xray"], /non pubblicabile/);
  assert.match(why["EV-03:xray"], /strict/);
});

test("Xray: tetto di allegati per caso, i failure per primi", () => {
  const w = kbWs();
  run(w, [{ step: 4, kind: "assertion" }, { step: 3, kind: "transition" }, { step: 4, kind: "failure" }, { step: 1, kind: "entry" }]);
  const c = selectEvidence(w, { customer: "ACME", run: RUN, xrayCap: 2 }).cases[CASE];
  assert.equal(c.xray.length, 2);
  assert.equal(c.xray.some((e) => e.kind === "failure"), true);
  assert.equal(c.rejected.filter((r) => /tetto/.test(r.reason)).length, c.desk.length - 2);
});

test("contact sheet: <desk>/<release>/index.html offline con link relativi; immagini copiate in <scope>/<caso>/; testo con escape; originali intatti", () => {
  const w = kbWs();
  run(w, [{ step: 4, kind: "assertion", caption: "<script>alert(1)</script> RdA rifiutata" }, { step: 4, kind: "failure" }, { step: 2, kind: "input" }]);
  const r = buildDesk(w, { customer: "ACME", release: "R25.3", runs: [RUN] });
  assert.equal(r.images, 2); assert.equal(r.cases, 1);
  const html = readFileSync(r.index, "utf8");
  assert.ok(!/<script>/.test(html), "caption con escape");
  assert.match(html, /&lt;script&gt;/);
  assert.ok(!/https?:\/\//.test(html), "nessuna risorsa esterna");
  const hrefs = [...html.matchAll(/src="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(hrefs.map((h) => h.split("/").slice(0, 2).join("/")), ["P2P/NRT.ACME.P2P.NEG.0001", "P2P/NRT.ACME.P2P.NEG.0001"]);
  for (const h of hrefs) assert.ok(existsSync(join(w, "customers/ACME/evidence/desk/R25.3", h)), h);
  assert.ok(existsSync(join(w, "customers/ACME/runs", RUN, "cases", CASE, "evidence", "01.png")), "l'originale resta nel dossier");
  const cli = spawnSync(process.execPath, [CS, "--release", "R25.3", "--run", RUN, "--customer", "ACME", "--workspace", w, "--desk", join(w, "desk"), "--json"], { encoding: "utf8" });
  assert.equal(cli.status, 0, cli.stdout + cli.stderr);
  assert.ok(existsSync(join(w, "desk/R25.3/index.html")));
});
