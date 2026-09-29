import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { selfCheck } from "../../scripts/decide/self-check.mjs";
import { validateWith } from "../../scripts/lib/schemas.mjs";
import { openDb } from "../../scripts/kb/db.mjs";

const CLI = fileURLToPath(new URL("../../scripts/decide/self-check.mjs", import.meta.url));

const DEC = "L.ACME.ADM.DEC.0518";
const RPT = "L.ACME.ADM.RPT.0031";
const KNOWN = new Set(["C.ACME.ADM.CFG.0019", "S.STD.ADM.SEL.0102", "S.STD.ADM.SEL.0103", "S.STD.ADM.SEL.0140", "S.STD.ADM.SEL.0120",
  "S.STD.ADM.SEL.0121", "S.STD.ADM.SEL.0099", "C.ACME.ADM.SEL.0007", DEC, RPT, "L.ACME.ADM.LSN.0104", "L.ACME.ADM.OBS.0231", "L.ACME.ADM.CTR.0012"]);

// §10.5: il piano come traccia attesa (con l'intestazione di §46.3).
const PLAN = YAML.parse(`
plan_id: PLAN.0042
customer: ACME
env: sandbox
persona: admin
storage_state: .auth/admin.json
goal: "impostare strict_import = true su C.ACME.ADM.CFG.0019"
strategy: "STR-DRY-RUN → STR-VERIFY-FIRST"
steps:
  - { n: 1, verb: NAVIGATE, target: S.STD.ADM.SEL.0102, expect: { page_sig: "adm/setup/import-profiles", elements: [S.STD.ADM.SEL.0103] } }
  - { n: 2, verb: SELECT,   target: S.STD.ADM.SEL.0103, data: "Catalogo standard", expect: { page_sig: "adm/setup/import-profile#edit", elements: [C.ACME.ADM.SEL.0007, S.STD.ADM.SEL.0140] } }
  - { n: 3, verb: READ,     target: S.STD.ADM.SEL.0140, expect: { value: "false" }, on_divergence: { "true": "stop: nulla da fare, registra", other: "surprise" } }
  - { n: 4, verb: TOGGLE,   target: S.STD.ADM.SEL.0140, data: true, risk: R2, approval: required, expect: { value: "true", messages: [] } }
  - { n: 5, verb: SAVE,     target: S.STD.ADM.SEL.0120, wait_for: S.STD.ADM.SEL.0121, expect: { toast: S.STD.ADM.SEL.0121, page_sig: "adm/setup/import-profiles" } }
  - { n: 6, verb: VERIFY,   check: NRT.ACME.ADM.CFG.0031, expect: { result: pass } }
evidence: [{ at: 5, kind: assertion, capture: region, region: S.STD.ADM.SEL.0120, caption: "salvataggio", redact: strict }]
repair_policy: { skip_allowed: [], substitute_allowed: [{ step: 1, with: "NAVIGATE via menu alternativo S.STD.ADM.SEL.0099" }], abort_on: [4, 5] }
compensations: [{ step: 4, kind: restore, ref: C.ACME.ADM.CFG.0019, note: "strict_import torna a false" }]
checkpoint_dir: runs/RUN.ACME.20260922.1130.ADM/checkpoints/
`);

const LESSON = `---
id: L.ACME.ADM.LSN.0104
agent: adm-expert
session: SES.ACME.20260922.003
task: "impostare strict_import"
scope: ADM
mode: config
decision_refs: [${DEC}]
strategy: STR-DRY-RUN
epistemic_before: libresco
epistemic_after: libresco
surprises: 1
expected_outcomes: [{ decision: ${DEC}, expect: "NRT.ACME.ADM.CFG.0031 verde" }]
status: proposed
confidence: 0.8
portability_hypothesis: { class: specifica }
cluster_proposal: null
---
## 1. Contesto
C.ACME.ADM.CFG.0019
## 2. Cosa ho tentato
dry-run
## 3. Cosa ho osservato
L.ACME.ADM.OBS.0231
## 4. Decisioni prese
${DEC}
## 5. Esito
ok
## 6. Lezione
il gap impacts è ricorrente: proporre attributo obbligatorio
## 7. Cosa NON generalizzerei
dipende dalla versione del modulo catalogo ACME (F5)
## 8. Domande aperte
nessuna
`;

function ctx(over = {}) {
  const report = {
    task_id: "T-7",
    status: "ok",
    output: { summary: `strict_import impostato su C.ACME.ADM.CFG.0019`, report: RPT, effects: [{ decision: DEC, change: "strict_import=true" }] },
    cognitive_trace: {
      depth: "standard",
      recalled: { semantic: ["C.ACME.ADM.CFG.0019"], episodic: [DEC], working: ["L.ACME.ADM.OBS.0231"] },
      epistemic: { subject: "C.ACME.ADM.CFG.0019", shape_before: "libresco", shape_after: "libresco" },
      strategy: "STR-DRY-RUN",
      hypotheses: null,
      decisions: [DEC],
      surprises: [{ obs: "L.ACME.ADM.OBS.0231", ctr: "L.ACME.ADM.CTR.0012" }],
      self_check: { passed: 10, failed: [] },
    },
    lesson: "L.ACME.ADM.LSN.0104",
  };
  const session = {
    session_id: "sess-1", customer: "ACME", scope: "ADM",
    allowed_paths: ["customers/ACME/kb/scopes/ADM/**", "product/kb/scopes/ADM/**"],
    pending: { compensations: [], approvals: [], questions: [], expected_outcomes: [] },
    surprises: [{ at: "2026-09-22T10:41:00Z", item: "C.ACME.ADM.CFG.0019", obs: "L.ACME.ADM.OBS.0231" }],
    ledger: { invocations: [], trace_blocks: {} },
  };
  const audit = [
    { kind: "tool", actor: "adm-expert", payload: { tool: "Read", input_summary: JSON.stringify({ file_path: "C:\\ws\\customers\\ACME\\kb\\scopes\\ADM\\configs\\C.ACME.ADM.CFG.0019.yaml" }), agent_id: "a1" } },
    { kind: "tool", actor: "adm-expert", payload: { tool: "Bash", input_summary: JSON.stringify({ command: "node scripts/kb/kb.mjs find --scope ADM --type CFG" }), agent_id: "a1" } },
    { kind: "tool", actor: "adm-expert", payload: { tool: "Bash", input_summary: JSON.stringify({ command: "node scripts/kb/kb.mjs precedents C.ACME.ADM.CFG.0019 --top 3" }), agent_id: "a1" } },
  ];
  const decisions = { [DEC]: { table: "DT-007", strategy: "STR-DRY-RUN", effects: true } };
  return {
    report, session, audit, plan: structuredClone(PLAN), lesson: LESSON,
    kbExists: (c) => KNOWN.has(c), getDecision: (c) => decisions[c] ?? null,
    observations: [{ kind: "snapshot", page_sig: "adm/setup/import-profiles" }, { kind: "action" }, { kind: "snapshot", page_sig: "adm/setup/import-profiles" }],
    agentId: "a1",
    ...over,
  };
}
const failed = (r) => r.failed.map((f) => f.n);

test("il piano di §10.5 valida lo schema execution-plan (§46.3); SELECT ammesso (§10.5, §5.5), DELETE e verbi ignoti no", () => {
  assert.ok(validateWith("execution-plan.schema.json", PLAN).ok, validateWith("execution-plan.schema.json", PLAN).errors.join("; "));
  const del = structuredClone(PLAN); del.steps[3].verb = "DELETE";
  assert.equal(validateWith("execution-plan.schema.json", del).ok, false);
  const unk = structuredClone(PLAN); unk.steps[0].verb = "HOVER";
  assert.equal(validateWith("execution-plan.schema.json", unk).ok, false);
  const noExpect = structuredClone(PLAN); delete noExpect.steps[2].expect;
  assert.equal(validateWith("execution-plan.schema.json", noExpect).ok, false);
  const urlTarget = structuredClone(PLAN); urlTarget.steps[0].target = { url_pattern: "*/setup/import-profiles*" };
  assert.ok(validateWith("execution-plan.schema.json", urlTarget).ok);
  const noRepair = structuredClone(PLAN); delete noRepair.repair_policy;
  assert.equal(validateWith("execution-plan.schema.json", noRepair).ok, false);
});

test("§17.1 self-check: il caso completo passa tutti i controlli (1–10, #11 RPT, rilevatori di spreco)", () => {
  const r = selfCheck(ctx());
  assert.deepEqual(r.failed, []);
  assert.equal(r.blocked, false);
  assert.equal(r.status_effective, "ok");
  assert.deepEqual(r.trace_self_check, { passed: 10, failed: [] });
  assert.equal(r.passed, 13);
});

test("§10.5 controllo 4 esteso: piano senza expect → controllo 4 fallito (blocco)", () => {
  const c = ctx();
  delete c.plan.steps[3].expect;
  const r = selfCheck(c);
  assert.deepEqual(failed(r), [4]);
  assert.equal(r.failed[0].action, "block");
  assert.match(r.failed[0].reason, /passo 4/);
  assert.equal(r.blocked, true);
  assert.equal(r.status_effective, "partial");
  // DEC con effetti senza strategia → controllo 4
  const c2 = ctx({ getDecision: () => ({ table: "DT-007", strategy: null, effects: true }) });
  assert.deepEqual(failed(selfCheck(c2)), [4]);
});

test("controlli 1, 2, 3: codice inesistente, lettura fuori cella dall'audit, entità creata senza compensazione", () => {
  const c1 = ctx(); c1.report.output.summary += " vedi C.ACME.ADM.CFG.0999";
  assert.deepEqual(failed(selfCheck(c1)), [1]);
  const c2 = ctx(); c2.audit.push({ kind: "tool", actor: "adm-expert", payload: { tool: "Read", input_summary: JSON.stringify({ file_path: "customers/ACME/kb/scopes/CAT/flows/C.ACME.CAT.FLW.0001.yaml" }), agent_id: "a1" } });
  const r2 = selfCheck(c2);
  assert.deepEqual(failed(r2), [2]);
  assert.match(r2.failed[0].reason, /CAT/);
  // un tentativo negato dal guard non è una lettura: segnalato, non fallito
  const c2b = ctx(); c2b.audit.push({ kind: "guard", actor: "hook:guard-scope", payload: { decision: "deny", tool: "Read", agent_id: "a1", input_summary: "{}" } });
  const r2b = selfCheck(c2b);
  assert.deepEqual(failed(r2b), []);
  assert.equal(r2b.signals.length, 1);
  const c3 = ctx(); c3.report.output.created = ["NRT-20260922-A7F3-EVT-001"]; c3.plan.compensations = [];
  assert.deepEqual(failed(selfCheck(c3)), [3]);
  const c3ok = ctx(); c3ok.report.output.created = ["NRT-20260922-A7F3-EVT-001"];
  c3ok.session.pending.compensations = [{ entity: "NRT-20260922-A7F3-EVT-001", action: "sourcing.event.cancel-draft" }];
  assert.deepEqual(failed(selfCheck(c3ok)), []);
});

test("controlli 5, 6, 7: esito atteso mancante, sorpresa senza CTR, forma finale non registrata", () => {
  const c5 = ctx({ lesson: LESSON.replace(`expected_outcomes: [{ decision: ${DEC}, expect: "NRT.ACME.ADM.CFG.0031 verde" }]`, "expected_outcomes: []") });
  assert.deepEqual(failed(selfCheck(c5)), [5]);
  const c6 = ctx(); c6.report.cognitive_trace.surprises = [{ obs: "L.ACME.ADM.OBS.0231" }];
  assert.deepEqual(failed(selfCheck(c6)), [6]);
  const c6ok = ctx(); c6ok.report.cognitive_trace.surprises = []; c6ok.session.surprises[0].ctr = "L.ACME.ADM.CTR.0012";
  assert.deepEqual(failed(selfCheck(c6ok)), []);
  const c7 = ctx(); delete c7.report.cognitive_trace.epistemic.shape_after;
  assert.deepEqual(failed(selfCheck(c7)), [7]);
});

test("controlli 8, 9, 10, 11: prosa → riformatta; §7 vuota → blocco; domande aperte → partial; azione senza RPT → blocco", () => {
  const c8 = ctx(); c8.report.output.summary = Array.from({ length: 70 }, (_, i) => `parola${i}`).join(" ");
  const r8 = selfCheck(c8);
  assert.deepEqual(failed(r8), [8]);
  assert.equal(r8.failed[0].action, "reformat");
  assert.equal(r8.blocked, false);
  const c9 = ctx({ lesson: LESSON.replace("dipende dalla versione del modulo catalogo ACME (F5)", "") });
  assert.deepEqual(failed(selfCheck(c9)), [9]);
  // senza lezione manca anche l'esito atteso dichiarato (§10.2 passo 6): 5 e 9
  const c9b = ctx({ lesson: null });
  assert.deepEqual(failed(selfCheck(c9b)), [5, 9]);
  const c10 = ctx(); c10.report.open_questions = ["serve riconvalidare i cataloghi pubblicati?"];
  const r10 = selfCheck(c10);
  assert.deepEqual(failed(r10), [10]);
  assert.equal(r10.failed[0].action, "reclassify");
  assert.equal(r10.status_effective, "partial");
  const c10ok = ctx(); c10ok.report.open_questions = [{ question: "serve riconvalidare?", blocking: false }];
  assert.deepEqual(failed(selfCheck(c10ok)), []);
  const c11 = ctx(); delete c11.report.output.report;
  const r11 = selfCheck(c11);
  assert.deepEqual(failed(r11), [11]);
  assert.match(r11.failed[0].control, /RPT/);
});

test("§29.10 rilevatori di spreco: query kb ripetuta identica; snapshot della stessa pagina senza azione in mezzo", () => {
  const c = ctx(); c.audit.push(structuredClone(c.audit[1]));
  const r = selfCheck(c);
  assert.deepEqual(failed(r), [12]);
  assert.match(r.failed[0].reason, /usa il risultato precedente/);
  // lo stesso nel ledger delle chiamate (K6 call-ledger)
  const cl = ctx(); cl.session.ledger.calls = [{ cmd: "kb find", args: "--scope ADM" }, { cmd: "kb find", args: "--scope ADM" }];
  assert.deepEqual(failed(selfCheck(cl)), [12]);
  const s = ctx(); s.observations = [{ kind: "snapshot", page_sig: "adm/x" }, { kind: "snapshot", page_sig: "adm/x" }];
  assert.deepEqual(failed(selfCheck(s)), [13]);
  // chiamate di un altro sub-agente non contano
  const other = ctx(); other.audit.push({ ...structuredClone(other.audit[1]), payload: { ...other.audit[1].payload, agent_id: "b2" } });
  assert.deepEqual(failed(selfCheck(other)), []);
});

test("§10.4 profondità rapida: auto-verifica ridotta (1, 3, 9) più #11", () => {
  const c = ctx({ depth: "rapida" });
  delete c.report.cognitive_trace.epistemic.shape_after;          // #7 non si esegue in rapida
  const r = selfCheck(c);
  assert.deepEqual(r.controls_run, [1, 3, 9, 11]);
  assert.deepEqual(failed(r), []);
  // WP10b giro 1 (I3): passed conta i quattro controlli della profondità rapida (#11 compreso)
  assert.deepEqual(r.trace_self_check, { passed: 4, failed: [] });
});

test("CLI self-check --report --session --audit --plan --lesson --db: exit 0 se passa, 3 se blocca", () => {
  const dir = mkdtempSync(join(tmpdir(), "sc-"));
  const c = ctx();
  const dbFile = join(dir, "knowledge.db");
  const db = openDb(dbFile);
  for (const code of KNOWN) {
    if (code.includes(".DEC.")) {
      db.prepare("insert into decisions(code,table_code,strategy,inputs,outcome) values (?,?,?,?,?)").run(code, "DT-007", "STR-DRY-RUN", "{}", "R2");
      db.prepare("insert into decision_context(decision_code,effects) values (?,1)").run(code);
    } else if (code.includes(".LSN.")) db.prepare("insert into lessons(code) values (?)").run(code);
    else if (code.includes(".OBS.")) db.prepare("insert into observations(code) values (?)").run(code);
    else if (code.includes(".CTR.")) db.prepare("insert into contradictions(code) values (?)").run(code);
    else db.prepare("insert into items(code,level,customer,scope,type,title,summary,facets,status,path,hash,updated_at) values (?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(code, code[0], code.split(".")[1], code.split(".")[2], code.split(".")[3], "t", "s", "{}", "validato", "p", "h", "2026-09-22");
  }
  db.close();
  writeFileSync(join(dir, "report.md"), `Fatto.\n\n\`\`\`yaml\n${YAML.stringify(c.report)}\`\`\`\n`);
  writeFileSync(join(dir, "session.json"), JSON.stringify(c.session));
  writeFileSync(join(dir, "audit.jsonl"), c.audit.map((e) => JSON.stringify(e)).join("\n") + "\n");
  writeFileSync(join(dir, "plan.yaml"), YAML.stringify(c.plan));
  writeFileSync(join(dir, "lesson.md"), LESSON);
  const args = ["--report", join(dir, "report.md"), "--session", join(dir, "session.json"), "--audit", join(dir, "audit.jsonl"),
    "--plan", join(dir, "plan.yaml"), "--lesson", join(dir, "lesson.md"), "--db", dbFile, "--agent-id", "a1", "--json"];
  const ok = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.deepEqual(JSON.parse(ok.stdout).failed, []);
  const bad = structuredClone(c.plan); delete bad.steps[0].expect;
  writeFileSync(join(dir, "plan.yaml"), YAML.stringify(bad));
  const blocked = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
  assert.equal(blocked.status, 3);
  assert.deepEqual(JSON.parse(blocked.stdout).failed.map((f) => f.n), [4]);
});
