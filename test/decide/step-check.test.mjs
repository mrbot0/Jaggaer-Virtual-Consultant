// K6.1 — step-check: snapshot golden per ogni tipo di divergenza nei tre formati MCP, classificazione
// (ok · surprise · novelty · approval_required · denied), checkpoint, active_plan, compensazioni,
// richieste di approvazione, contatori di sorprese, on_divergence, would_change_my_mind, --resume.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { envWs, readSession, patchSession, writePlan, browserCall, ROOT } from "../helpers/env-fixture.mjs";
import { cleanEnv, decisionOf, reasonOf } from "../helpers/hook-env.mjs";
import { parseSnapshot, pageSignature } from "../../scripts/chrome/snapshot-parse.mjs";
import { check } from "../../scripts/decide/step-check.mjs";
import { PLAN, snap, demoAtlas, demoPlan } from "../helpers/k6-fixture.mjs";

const FORMATS = ["chrome-devtools", "claude-browser", "playwright"];

function setup(plan = demoPlan(), opts = {}) {
  const ws = envWs({ env: "sandbox", scope: "P2P", ...opts });
  demoAtlas(ws);
  const file = writePlan(ws, plan, "RUN.ACME.K6");
  return { ws, file };
}
const ctx = (ws) => ({ ws, customer: "ACME", sid: "sess-1" });
const at = (ws, file, n, snapshot, extra = {}) => check({ ...ctx(ws), planFile: file, step: n, snapshot, ...extra });
// porta il piano al passo 2 (attivazione + passo 1 verificato con uno snapshot della pagina nuova)
async function toStep2(ws, file) {
  await at(ws, file, 1, null);
  const page1 = snap("chrome-devtools", "ok").replace("/edit/10045", "/new").replace("Richiesta d'acquisto\" level", "Nuova richiesta\" level");
  const r1 = await at(ws, file, 1, page1);
  assert.equal(r1.status, "ok", JSON.stringify(r1.divergences));
}

test("snapshot-parse: i tre formati danno URL, titolo, firma e gli stessi elementi", () => {
  for (const f of FORMATS) {
    const p = parseSnapshot(snap(f, "attributo-diverso"));
    assert.equal(p.format, f);
    assert.equal(p.url, "https://acme-sbx.jaggaer.com/p2p/requisition/edit/10045");
    assert.equal(p.title, "Richiesta d'acquisto - ACME SBX");
    assert.equal(pageSignature(p), "p2p/requisition/edit#richiesta-d-acquisto");
    const cdc = p.elements.find((e) => e.name === "Centro di costo");
    assert.equal(cdc.role, "textbox"); assert.equal(cdc.value, "IT-0442"); assert.equal(cdc.required, true);
    assert.deepEqual(p.elements.filter((e) => e.role === "option").map((e) => e.name), ["Arredi", "Informatica"]);
  }
});

test("snapshot-parse: output reali catturati dagli strumenti (DevTools take_snapshot, Claude read_page)", () => {
  const dt = parseSnapshot(readFileSync(join(ROOT, "test/golden/snapshot-parse/devtools-real.txt"), "utf8"));
  assert.equal(dt.title, "Nuova richiesta - ACME SBX");
  assert.match(dt.url, /requisition\.html$/);
  assert.deepEqual(dt.messages, [{ text: "Il centro di costo è obbligatorio (REQ-VAL-014)", role: "alert" }]);
  assert.equal(dt.elements.find((e) => e.name === "Centro di costo").required, true);
  assert.equal(dt.elements.find((e) => e.name === "Invia in approvazione").disabled, true);
  const cl = parseSnapshot(readFileSync(join(ROOT, "test/golden/snapshot-parse/claude-real.txt"), "utf8"));
  assert.equal(cl.tab, "tab-4");
  assert.equal(cl.elements.find((e) => e.name === "Referente").value, "mario.rossi@acme.it");
  assert.deepEqual(cl.messages.map((m) => m.text), ["Il centro di costo è obbligatorio (REQ-VAL-014)"]);
});

// Golden: ogni tipo di divergenza in ciascuno dei tre formati.
const GOLDEN = [
  ["ok", {}, { status: "ok" }],
  ["elemento-assente", {}, { status: "surprise", kind: "elemento-assente", compat: "incompatibile" }],
  ["stato-diverso", {}, { status: "surprise", kind: "stato-diverso", compat: "incompatibile" }],
  ["attributo-diverso", {}, { status: "surprise", kind: "attributo-diverso", compat: "compatibile" }],
  ["elemento-in-piu", {}, { status: "surprise", kind: "elemento-in-piu", compat: "compatibile" }],
  ["messaggio-inatteso", {}, { status: "surprise", kind: "messaggio-inatteso", compat: "compatibile" }],
  ["ok", { elapsedMs: 21000 }, { status: "surprise", kind: "tempo-fuori-norma", compat: "compatibile" }],
  ["novelty", {}, { status: "novelty" }],
];

for (const f of FORMATS) {
  test(`golden step-check (${f}): ogni tipo di divergenza classificato con DT-016`, async () => {
    for (const [name, extra, want] of GOLDEN) {
      const { ws, file } = setup();
      await toStep2(ws, file);
      const r = await at(ws, file, 2, snap(f, name), extra);
      assert.equal(r.status, want.status, `${f}/${name}: ${JSON.stringify(r.divergences)}`);
      if (want.kind) { assert.equal(r.kind, want.kind, `${f}/${name}`); assert.equal(r.compat, want.compat, `${f}/${name}`); assert.equal(r.proceed, want.compat === "compatibile"); }
      if (name === "novelty") assert.deepEqual(r.novelties, [{ role: "textbox", label: "Codice progetto" }]);
      assert.ok(existsSync(join(ws, "customers/ACME/runs/RUN.ACME.K6/checkpoints/2.json")), "checkpoint");
    }
  });
}

test("would_change_my_mind osservato ⇒ sorpresa prioritaria, il passo si ferma anche a R1 (§17.5)", async () => {
  for (const f of FORMATS) {
    const { ws, file } = setup();
    await toStep2(ws, file);
    const why = { would_change_my_mind: ["un avviso \"verrà riconvalidata\" sulla schermata di salvataggio"] };
    const r = await at(ws, file, 2, snap(f, "would-change"), { why });
    assert.equal(r.status, "surprise"); assert.equal(r.priority, true); assert.equal(r.proceed, false); assert.equal(r.compat, "incompatibile");
    assert.equal(readSession(ws).active_plan.step, 2, "il piano non avanza");
  }
});

test("attivazione: active_plan {plan_id, file, step, run}; passo ok ⇒ avanza e scrive il checkpoint atomico", async () => {
  const { ws, file } = setup();
  const g = await at(ws, file, 1, null);
  assert.equal(g.status, "ok");
  assert.deepEqual(readSession(ws).active_plan, { plan_id: PLAN, file, step: 1, run: "RUN.ACME.K6" });
  await toStep2(ws, file);
  assert.equal(readSession(ws).active_plan.step, 2);
  const r = await at(ws, file, 2, snap("playwright", "ok"));
  assert.equal(r.status, "ok");
  const cp = JSON.parse(readFileSync(join(ws, "customers/ACME/runs/RUN.ACME.K6/checkpoints/2.json"), "utf8"));
  assert.equal(cp.step, 2); assert.equal(cp.status, "ok"); assert.equal(cp.plan_id, PLAN); assert.match(cp.plan_sha256, /^[0-9a-f]{64}$/);
  assert.equal(cp.page_signature, "p2p/requisition/edit#richiesta-d-acquisto");
  // il passo 3 (SAVE ACT-CREATE) è preparato: compensazione registrata PRIMA del passo (§29.6)
  assert.equal(r.next.step, 3); assert.equal(r.next.status, "ok");
  const s = readSession(ws);
  assert.equal(s.active_plan.step, 3);
  assert.deepEqual(s.pending.compensations.map((c) => [c.plan, c.step, c.kind]), [[PLAN, 3, "cancel"]]);
  assert.match(readFileSync(join(ws, "customers/ACME/runs/RUN.ACME.K6/compensations.yaml"), "utf8"), /requisition\.cancel/);
});

test("guard-config-scope consente il SAVE sullo stato scritto da step-check (compensazione registrata); senza compensazione nel piano step-check nega", async () => {
  const { ws, file } = setup();
  await toStep2(ws, file);
  await at(ws, file, 2, snap("chrome-devtools", "ok"));
  const ok = browserCall("guard-config-scope", ws, "mcp__chrome-devtools__click", { uid: "1_22" });
  assert.equal(ok.stdout.trim(), "", reasonOf(ok));
  const bare = setup(demoPlan({ compensations: [] }));
  await toStep2(bare.ws, bare.file);
  const r = await at(bare.ws, bare.file, 2, snap("chrome-devtools", "ok"));
  assert.equal(r.next.status, "denied");
  assert.match(r.next.reason, /compensazione/);
  const no = browserCall("guard-config-scope", bare.ws, "mcp__chrome-devtools__click", { uid: "1_22" });
  assert.equal(decisionOf(no), "deny");
});

test("passo R2 senza token ⇒ approval_required e richiesta aperta in pending.approvals (il 'sì' la soddisfa)", async () => {
  const { ws, file } = setup();
  await toStep2(ws, file);
  await at(ws, file, 2, snap("chrome-devtools", "ok"));
  const r3 = await at(ws, file, 3, snap("chrome-devtools", "ok").replace('uid=1_1 banner', 'uid=1_1 status\n    uid=1_99 StaticText "Bozza salvata"\n  uid=1_98 banner'));
  assert.equal(r3.status, "ok", JSON.stringify(r3.divergences));
  assert.equal(r3.next.step, 4); assert.equal(r3.next.status, "approval_required");
  assert.match(r3.next.ask, /sì/);
  const s = readSession(ws);
  assert.deepEqual(s.pending.approvals, [{ kind: "action", plan: PLAN, step: 4, file }]);
  const g = await at(ws, file, 4, null);
  assert.equal(g.status, "approval_required");
});

// sorprese incompatibili: il piano resta al passo 2 e il compito le accumula
test("tre sorprese nel compito ⇒ escalate; la seconda alza il tier", async () => {
  const { ws, file } = setup();
  await toStep2(ws, file);
  const r1 = await at(ws, file, 2, snap("claude-browser", "elemento-assente"));
  assert.equal(r1.surprises_in_task, 1); assert.ok(!r1.tier_up);
  const r2 = await at(ws, file, 2, snap("claude-browser", "stato-diverso"));
  assert.equal(r2.surprises_in_task, 2); assert.equal(r2.tier_up, true);
  const r3 = await at(ws, file, 2, snap("claude-browser", "elemento-assente"));
  assert.equal(r3.surprises_in_task, 3); assert.equal(r3.escalate, true); assert.equal(r3.proceed, false);
  assert.equal(readSession(ws).surprises.filter((x) => x.plan === PLAN).length, 3);
});

test("on_divergence onorato: valore già al target ⇒ stop 'nulla da fare' (§10.5 passo 3)", async () => {
  const plan = demoPlan();
  plan.steps[1] = { n: 2, verb: "READ", action_class: "ACT-OBS", target: "C.ACME.P2P.SEL.0047", expect: { value: "false" }, on_divergence: { true: "stop: nulla da fare, registra", other: "surprise" } };
  const { ws, file } = setup(plan);
  await toStep2(ws, file);
  const r = await at(ws, file, 2, snap("chrome-devtools", "stato-diverso"));
  assert.equal(r.status, "ok"); assert.equal(r.stop, true); assert.match(r.on_divergence, /nulla da fare/);
});

test("denied: piano non ammesso nell'ambiente, passo fuori sequenza, piano diverso già attivo", async () => {
  const { ws, file } = setup(demoPlan({ env: "prod" }));
  patchSession(ws, (s) => { s.env = { ...s.env, id: "prod", type: "prod" }; });
  const r = await at(ws, file, 1, null);
  assert.equal(r.status, "denied"); assert.match(r.reason, /produzione|prod/);
  const b = setup();
  await at(b.ws, b.file, 1, null);
  const skip = await at(b.ws, b.file, 3, snap("chrome-devtools", "ok"));
  assert.equal(skip.status, "denied"); assert.match(skip.reason, /sequenza/);
  const other = writePlan(b.ws, demoPlan({ plan_id: "PLAN.ACME.K6.0002" }), "RUN.ACME.K6B");
  const o = await at(b.ws, other, 1, null);
  assert.equal(o.status, "denied"); assert.match(o.reason, /PLAN\.ACME\.K6\.0001/);
});

test("--resume n: letture richieste prima di ripetere un passo con effetto (§47.2 #2)", async () => {
  const { ws, file } = setup();
  await toStep2(ws, file);
  await at(ws, file, 2, snap("chrome-devtools", "ok"));
  const r = await check({ ...ctx(ws), planFile: file, resume: 3 });
  assert.equal(r.status, "ok"); assert.equal(r.resume_from, 3); assert.equal(r.last_checkpoint, 2);
  assert.deepEqual(r.reads.map((x) => [x.step, x.verb, x.target]), [[3, "READ", "C.ACME.P2P.SEL.0120"]]);
  assert.equal(readSession(ws).active_plan.step, 3);
});

test("CLI: --help, argomenti mancanti (1), esito JSON, denied (3)", async () => {
  const { ws, file } = setup();
  const cli = (args) => spawnSync(process.execPath, [join(ROOT, "scripts/decide/step-check.mjs"), ...args], { encoding: "utf8", env: cleanEnv({ JVC_WORKSPACE: ws, JVC_SESSION_ID: "sess-1" }) });
  assert.equal(cli(["--help"]).status, 0);
  assert.equal(cli(["--json"]).status, 1);
  const act = cli(["--plan", file, "--step", "1", "--json"]);
  assert.equal(act.status, 0, act.stdout + act.stderr);
  assert.equal(JSON.parse(act.stdout).status, "ok");
  const f = join(ws, "customers/ACME/.sessions/sess-1/snap.txt");
  writeFileSync(f, snap("chrome-devtools", "ok"));
  const bad = cli(["--plan", file, "--step", "3", "--snapshot", f, "--json"]);
  assert.equal(bad.status, 3);
  assert.equal(JSON.parse(bad.stdout).status, "denied");
});
