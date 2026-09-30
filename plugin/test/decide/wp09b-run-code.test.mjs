// WP09b carry 3: step-check accetta solo codici RUN completi RUN.<C>.<AAAAMMDD>.<HHMM>.<S> (ruling WP07), del cliente
// della sessione, con i controlli di realpath/figlio diretto invariati; senza --run né percorso il run di default è completo.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { RUN_RE, runRefusal, check } from "../../scripts/decide/step-check.mjs";
import { parseRunCode, formatRunCode } from "../../scripts/lib/run-code.mjs";
import { envWs, readSession } from "../helpers/env-fixture.mjs";

test("grammatica: cinque segmenti, data e ora reali, scope del registro, cliente di 4 caratteri", () => {
  assert.ok(RUN_RE.test("RUN.ACME.20260929.1430.CAT"));
  assert.deepEqual(parseRunCode("RUN.ACME.20260929.1430.CAT"), { customer: "ACME", date: "20260929", time: "1430", scope: "CAT" });
  for (const bad of ["RUN.ACME.K6", "RUN.ACME.20260929.CAT", "RUN.ACME.20261329.1430.CAT", "RUN.ACME.20260931.1430.CAT", "RUN.ACME.20260929.2460.CAT",
    "RUN.ACME.20260929.1430.ZZZ", "RUN.STD.20260929.1430.CAT", "RUN.ACME.20260929.1430.CAT.X", "run.acme.20260929.1430.cat"]) assert.equal(parseRunCode(bad), null, bad);
  assert.equal(formatRunCode({ customer: "ACME", scope: "P2P", date: new Date(2026, 8, 29, 9, 5) }), "RUN.ACME.20260929.0905.P2P");
});

test("runRefusal: forma corta e cliente diverso negati; forma completa ammessa", () => {
  const ws = envWs();
  assert.match(runRefusal(ws, "ACME", "RUN.ACME.K6"), /nome di run non valido/);
  assert.match(runRefusal(ws, "ACME", "RUN.BETA.20260929.1430.ADM"), /del cliente BETA/);
  assert.equal(runRefusal(ws, "ACME", "RUN.ACME.20260929.1430.ADM"), null);
});

test("step-check: senza --run né percorso runs/<RUN>/ il run di default è RUN.<C>.<AAAAMMDD>.<HHMM>.<scope della sessione>", async () => {
  const ws = envWs({ env: "sandbox" });
  mkdirSync(join(ws, "customers/ACME/plans"), { recursive: true });
  writeFileSync(join(ws, "customers/ACME/plans/p.json"), JSON.stringify({ plan_id: "PLAN.WP09B.RUN", customer: "ACME", env: "sandbox", goal: "leggere", steps: [{ n: 1, verb: "READ", action_class: "ACT-READ", target: { url_pattern: "https://acme-sbx.jaggaer.com/x" }, expect: { page_sig: "x" } }], repair_policy: { skip_allowed: [], substitute_allowed: [], abort_on: [] } }));
  const r = await check({ ws, sid: "sess-1", planFile: "plans/p.json", step: 1, now: new Date(2026, 8, 29, 14, 30) });
  assert.equal(r.status, "ok", r.reason);
  assert.equal(readSession(ws).active_plan.run, "RUN.ACME.20260929.1430.ADM");
});
