// WP09b D — baseline (ADR-15), auth-setup (storageState per persona, segreti solo in .auth/, prod solo admin) e
// corsia integration (L1 diff con tolleranze, L2 DT-013 con default queued_accepted e timeout classificati, L3 solo sandbox).
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { record, compare } from "../../scripts/run/baseline.mjs";
import { register, status, personasOf, AuthError } from "../../scripts/run/auth-setup.mjs";
import { diffPayload, expectedStage, classifyCheckpoint, stubDescriptor, IntegrationError } from "../../scripts/run/integration.mjs";
import { kbWs, writeYaml, writeItem, int } from "../helpers/wp09b-items.mjs";
import { ROOT } from "../helpers/hook-env.mjs";

const AUTH = fileURLToPath(new URL("../../scripts/run/auth-setup.mjs", import.meta.url));
const INTEG = fileURLToPath(new URL("../../scripts/run/integration.mjs", import.meta.url));

test("baseline (ADR-15): registrata come dichiarazione, confrontata con tolleranze; sostituirla richiede un motivo e conserva la storia", () => {
  const w = kbWs();
  const b = record(w, { customer: "ACME", caseId: "NRT.ACME.P2P.BSL.0001", observed: { stato: "Bozza", totale: 100.0, righe: [{ n: 1 }, { n: 2 }] }, tolerances: { numeric: { totale: 0.01 }, order_insensitive: ["righe"] }, declaredBy: "M. Rossi" });
  assert.equal(b.version, 1);
  assert.equal(compare(w, { customer: "ACME", caseId: "NRT.ACME.P2P.BSL.0001", observed: { stato: "Bozza", totale: 100.005, righe: [{ n: 2 }, { n: 1 }] } }).match, true);
  const d = compare(w, { customer: "ACME", caseId: "NRT.ACME.P2P.BSL.0001", observed: { stato: "Inviata", totale: 101, righe: [{ n: 1 }, { n: 2 }] } });
  assert.equal(d.match, false); assert.deepEqual(d.diffs.map((x) => x.path).sort(), ["stato", "totale"]);
  assert.throws(() => record(w, { customer: "ACME", caseId: "NRT.ACME.P2P.BSL.0001", observed: { stato: "X" } }), /già registrata/);
  assert.throws(() => record(w, { customer: "ACME", caseId: "NRT.ACME.P2P.BSL.0001", observed: { stato: "X" }, replace: true }), /--reason/);
  const b2 = record(w, { customer: "ACME", caseId: "NRT.ACME.P2P.BSL.0001", observed: { stato: "Inviata" }, replace: true, reason: "release 25.3: invio automatico" });
  assert.equal(b2.version, 2); assert.equal(b2.history[0].observed.stato, "Bozza");
});

test("auth-setup: persone da environments.yaml, storageState in .auth/<persona>.json con metadati senza segreti, TTL e scadenza dei cookie; prod solo admin", () => {
  const w = kbWs();
  copyFileSync(join(ROOT, "test/fixtures/env/environments.yaml"), join(w, "customers/ACME/config/environments.yaml"));
  assert.deepEqual(personasOf(w, "ACME", "sandbox").personas, ["buyer", "approver", "admin", "supplier"]);
  assert.deepEqual(personasOf(w, "ACME", "prod").personas, ["admin-readonly", "admin-config"]);
  const src = join(w, "tmp/state.json");
  mkdirSync(join(w, "tmp"), { recursive: true });
  const now = new Date("2026-09-29T10:00:00Z");
  writeFileSync(src, JSON.stringify({ cookies: [{ name: "JSESSIONID", value: "SEGRETO-123", expires: now.getTime() / 1000 + 3600 }], origins: [] }));
  const meta = register(w, { customer: "ACME", envId: "sandbox", persona: "buyer", file: src, now });
  assert.equal(meta.expires_at, "2026-09-29T11:00:00.000Z", "la scadenza del cookie vince sul TTL di 8 h");
  assert.ok(!readFileSync(join(w, ".auth/buyer.meta.json"), "utf8").includes("SEGRETO"), "nessun segreto nei metadati");
  assert.ok(existsSync(join(w, ".auth/buyer.json")));
  const st = status(w, { customer: "ACME", envId: "sandbox", now });
  assert.deepEqual(st.map((x) => [x.persona, x.state]), [["buyer", "valid"], ["approver", "missing"], ["admin", "missing"], ["supplier", "missing"]]);
  assert.equal(status(w, { customer: "ACME", envId: "sandbox", now: new Date("2026-09-29T12:00:00Z") })[0].state, "expired");
  assert.throws(() => register(w, { customer: "ACME", envId: "prod", persona: "buyer", file: src, now }), /non è dichiarata/);
  const envs = YAML.parse(readFileSync(join(w, "customers/ACME/config/environments.yaml"), "utf8"));
  envs.environments.find((e) => e.id === "prod").personas.push("buyer");
  writeFileSync(join(w, "customers/ACME/config/environments.yaml"), YAML.stringify(envs));
  assert.throws(() => personasOf(w, "ACME", "prod"), (e) => e instanceof AuthError && e.code === 3);
  const cli = spawnSync(process.execPath, [AUTH, "check", "--env", "sandbox", "--customer", "ACME", "--workspace", w, "--json"], { encoding: "utf8" });
  assert.equal(cli.status, 3);
  assert.ok(!cli.stdout.includes("SEGRETO"));
});

test("L1: diff sul golden con tolleranze numeriche, campi ignorati, array senza ordine, formati di data", () => {
  const g = { EDI_DC40: { CREDAT: "20260929" }, E1EDK01: { BELNR: "4500001", DATUM: "20260929" }, E1EDP01: [{ POSEX: "10", MENGE: "5.000" }, { POSEX: "20", MENGE: 2 }] };
  const tol = { numeric: { "E1EDP01/MENGE": 0.001 }, ignore_fields: ["EDI_DC40/CREDAT"], order_insensitive: ["E1EDP01"], date_formats: ["YYYYMMDD", "YYYY-MM-DD"] };
  const ok = { EDI_DC40: { CREDAT: "20261001" }, E1EDK01: { BELNR: "4500001", DATUM: "2026-09-29" }, E1EDP01: [{ POSEX: "20", MENGE: 2.0005 }, { POSEX: "10", MENGE: 5 }] };
  assert.deepEqual(diffPayload(g, ok, tol), { match: true, diffs: [] });
  const bad = structuredClone(ok); bad.E1EDP01[1].MENGE = 5.01; bad.E1EDK01.BELNR = "4500002"; delete bad.E1EDK01.DATUM; bad.EXTRA = 1;
  assert.deepEqual(diffPayload(g, bad, tol).diffs.map((d) => [d.kind, d.path]).sort(), [["extra", "EXTRA"], ["missing", "E1EDK01/DATUM"], ["value", "E1EDK01/BELNR"], ["value", "E1EDP01/0/MENGE"]], "percorso con l'indice del golden");
  assert.equal(diffPayload(g, ok, {}).match, false, "senza tolleranze l'ordine e le date contano");
});

test("L2: DT-013 — default queued_accepted (ADR-13); timeout entro la p95 ⇒ E2, oltre ⇒ osservazione (non difetto); errore ⇒ fail", () => {
  assert.equal(expectedStage(int("S.STD.P2P.INT.0001")).stage, "acknowledged", "blocking + silenzio possibile (0.55)");
  assert.equal(expectedStage(int("S.STD.P2P.INT.0001", { silence_semantics: { silent_failure_possible: false } })).stage, "processed", "solo blocking (0.30)");
  const quiet = int("S.STD.P2P.INT.0001", { document_impact: { severity: "none" }, silence_semantics: { silent_failure_possible: false } });
  assert.equal(expectedStage(quiet).stage, "queued_accepted");
  assert.equal(classifyCheckpoint({ expected: "queued_accepted", reached: "processed" }).outcome, "pass");
  assert.equal(classifyCheckpoint({ expected: "processed", reached: "queued_accepted", timedOut: true, elapsedS: 200, p95S: 300 }).outcome, "E2");
  const late = classifyCheckpoint({ expected: "processed", reached: "queued_accepted", timedOut: true, elapsedS: 900, p95S: 300 });
  assert.equal(late.outcome, "observation"); assert.match(late.reason, /non un difetto/);
  assert.equal(classifyCheckpoint({ expected: "processed", error: true }).outcome, "fail");
  const w = kbWs();
  writeItem(w, int("S.STD.P2P.INT.0001"));
  const r = spawnSync(process.execPath, [INTEG, "checkpoint", "--int", "S.STD.P2P.INT.0001", "--reached", "none", "--elapsed-s", "900", "--timed-out", "--workspace", w, "--customer", "ACME", "--json"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.equal(JSON.parse(r.stdout).outcome, "observation");
});

test("L3: descrittore dello stub inbound solo in sandbox e solo per interfacce in ingresso", () => {
  const inbound = int("S.STD.P2P.INT.0002", { direction: "inbound" });
  const d = stubDescriptor(inbound, { envType: "sandbox" });
  assert.equal(d.env, "sandbox"); assert.deepEqual(d.mandatory, ["E1EDK01/BELNR"]); assert.equal(d.expected_checkpoint, "queued_accepted");
  assert.throws(() => stubDescriptor(inbound, { envType: "preprod" }), (e) => e instanceof IntegrationError && e.code === 3);
  assert.throws(() => stubDescriptor(int("S.STD.P2P.INT.0001"), { envType: "sandbox" }), /ingresso/);
  const w = kbWs();
  const g = writeYaml(w, "tmp/g.yaml", { a: 1 }); const a = writeYaml(w, "tmp/a.yaml", { a: 2 });
  assert.equal(spawnSync(process.execPath, [INTEG, "diff", "--golden", g, "--actual", a, "--json"], { encoding: "utf8" }).status, 3);
});
