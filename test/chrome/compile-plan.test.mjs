// K6.8 — compile-plan (corsia compilata, OPZIONALE): spec Playwright solo da un piano verde ≥ 3 volte
// (runs/*/result.yaml con lo stesso hash), target con la catena dell'Atlas (testid → role → label → css;
// css solo se ammesso), hash nell'intestazione; piano cambiato ⇒ verify invalida; nessun import di playwright.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import YAML from "yaml";
import { envWs, writePlan, ROOT } from "../helpers/env-fixture.mjs";
import { cleanEnv } from "../helpers/hook-env.mjs";
import { demoPlan } from "../helpers/k6-fixture.mjs";
import { planHash } from "../../scripts/chrome/compile-plan.mjs";

function sel(ws, code, doc) {
  const dir = join(ws, "customers/ACME/kb/scopes/P2P/selectors");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${code}.yaml`), YAML.stringify({ id: code, type: "SEL", title: code, summary: "x", ...doc }));
}
function setup({ green = 3 } = {}) {
  const ws = envWs({ env: "sandbox", scope: "P2P" });
  sel(ws, "C.ACME.P2P.SEL.0044", { role: "textbox", strategies: [{ kind: "testid", value: "cdc-input" }, { kind: "label", value: "Centro di costo" }] });
  sel(ws, "C.ACME.P2P.SEL.0047", { role: "checkbox", strategies: [{ kind: "role", value: "checkbox", name: "Urgente" }] });
  sel(ws, "C.ACME.P2P.SEL.0120", { role: "button", strategies: [{ kind: "role", value: "button", name: "Salva bozza" }] });
  sel(ws, "C.ACME.P2P.SEL.0121", { role: "status", strategies: [{ kind: "label", value: "Bozza salvata" }] });
  sel(ws, "C.ACME.P2P.SEL.0130", { role: "button", stability: "fragile", strategies: [{ kind: "css", value: "#submit" }] });
  const plan = demoPlan();
  plan.steps = plan.steps.slice(0, 3);
  const file = writePlan(ws, plan, "RUN.ACME.20260922.1100.ADM");
  const hash = planHash(plan);
  for (let i = 0; i < green; i++) {
    mkdirSync(join(ws, `customers/ACME/runs/RUN.ACME.20260922.1109.ADM${i}`), { recursive: true });
    writeFileSync(join(ws, `customers/ACME/runs/RUN.ACME.20260922.1109.ADM${i}/result.yaml`), YAML.stringify({ plan_id: plan.plan_id, plan_hash: hash, status: "green" }));
  }
  return { ws, file, plan, hash };
}
const cli = (ws, args) => spawnSync(process.execPath, [join(ROOT, "scripts/chrome/compile-plan.mjs"), ...args, "--json"], { encoding: "utf8", env: cleanEnv({ JVC_WORKSPACE: ws, JVC_SESSION_ID: "sess-1" }) });

test("< 3 esecuzioni verdi con lo stesso hash ⇒ rifiuto (exit 3)", () => {
  const { ws, file } = setup({ green: 2 });
  const r = cli(ws, ["--plan", file]);
  assert.equal(r.status, 3, r.stdout);
  assert.match(JSON.parse(r.stdout).error, /2 esecuzioni verdi.*3/);
});

test("≥ 3 verdi ⇒ spec in customers/<C>/tests/specs/<scope>/<plan>.spec.ts con hash e catena dell'Atlas; verify valido", () => {
  const { ws, file, hash } = setup();
  const r = cli(ws, ["--plan", file]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.spec, "customers/ACME/tests/specs/P2P/PLAN.ACME.K6.0001.spec.ts");
  const ts = readFileSync(join(ws, out.spec), "utf8");
  assert.match(ts, new RegExp(`^// plan-hash: ${hash}$`, "m"));
  assert.match(ts, /page\.getByTestId\("cdc-input"\)\.fill\("IT-0442"\)/);
  assert.match(ts, /page\.goto\("https:\/\/acme-sbx\.jaggaer\.com\/p2p\/requisition\/new"\)/);
  assert.match(ts, /page\.getByRole\("button", \{ name: "Salva bozza" \}\)\.click\(\)/);
  assert.match(ts, /expect\(page\.getByLabel\("Bozza salvata"\)\)\.toBeVisible\(\)/);
  assert.equal(cli(ws, ["verify", "--plan", file, "--spec", out.spec]).status, 0);
});

test("piano cambiato ⇒ verify invalida lo spec (exit 3)", () => {
  const { ws, file, plan } = setup();
  const out = JSON.parse(cli(ws, ["--plan", file]).stdout);
  plan.steps[1].data = "IT-9999";
  writeFileSync(join(ws, "customers/ACME", file), JSON.stringify(plan, null, 2));
  const v = cli(ws, ["verify", "--plan", file, "--spec", out.spec]);
  assert.equal(v.status, 3);
  assert.match(JSON.parse(v.stdout).error, /invalidato/);
});

test("css solo se la stabilità fragile è ammessa; lo script genera testo e non importa playwright", () => {
  const { ws } = setup();
  const plan = demoPlan();
  const file = writePlan(ws, plan, "RUN.ACME.20260922.1102.ADM");
  const hash = planHash(plan);
  for (let i = 0; i < 3; i++) { mkdirSync(join(ws, `customers/ACME/runs/RUN.ACME.20260922.1110.ADM${i}`), { recursive: true }); writeFileSync(join(ws, `customers/ACME/runs/RUN.ACME.20260922.1110.ADM${i}/result.yaml`), YAML.stringify({ plan_id: plan.plan_id, plan_hash: hash, status: "green" })); }
  const no = cli(ws, ["--plan", file]);
  assert.equal(no.status, 3); assert.match(JSON.parse(no.stdout).error, /fragile/);
  const yes = cli(ws, ["--plan", file, "--allow-fragile"]);
  assert.equal(yes.status, 0, yes.stdout);
  assert.match(readFileSync(join(ws, JSON.parse(yes.stdout).spec), "utf8"), /page\.locator\("#submit"\)\.click\(\)/);
  const src = readFileSync(join(ROOT, "scripts/chrome/compile-plan.mjs"), "utf8");
  assert.doesNotMatch(src, /^\s*import[^\n]*["']@?playwright/m);
  assert.doesNotMatch(src, /import\(\s*["']@?playwright/);
  assert.ok(existsSync(join(ws, "customers/ACME/tests/specs/P2P")));
});

test("step-check scrive runs/<RUN>/result.yaml a piano completato (verde senza sorprese): è ciò che compile-plan conta", async () => {
  const { check } = await import("../../scripts/decide/step-check.mjs");
  const { demoAtlas } = await import("../helpers/k6-fixture.mjs");
  const ws = envWs({ env: "sandbox", scope: "P2P" });
  demoAtlas(ws);
  const plan = { ...demoPlan(), steps: [demoPlan().steps[0]] };
  const file = writePlan(ws, plan, "RUN.ACME.20260922.1114.ADM");
  await check({ ws, sid: "sess-1", planFile: file, step: 1, snapshot: null });
  const page = readFileSync(join(ROOT, "test/golden/step-check/chrome-devtools/ok.txt"), "utf8").replace("/edit/10045", "/new");
  const r = await check({ ws, sid: "sess-1", planFile: file, step: 1, snapshot: page });
  assert.equal(r.plan_status, "completed");
  const y = YAML.parse(readFileSync(join(ws, "customers/ACME/runs/RUN.ACME.20260922.1114.ADM/result.yaml"), "utf8"));
  assert.equal(y.status, "green"); assert.equal(y.plan_hash, planHash(plan));
});
