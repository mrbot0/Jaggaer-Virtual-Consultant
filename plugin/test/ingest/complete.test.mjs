// 18/11/2026 (digestione T1 ferma: ENEL 2449 grezzi, 1973 needs_llm, 0 digeriti dai grezzi): ponte T0 → T1. Un grezzo per
// documento con ancore YAML (oltre 100 alias la libreria si fermava), lotti con il testo delle unità, completamenti che
// toccano solo i campi mancanti, coda dei pronti per il digester, segno di digerito; e la consegna del rapporto di un
// sub-agente (SubagentHandback) che guard-control non nega più.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import YAML from "yaml";
import { status, next, applyCompletions, ready, mark } from "../../scripts/ingest/complete.mjs";
import { envWs } from "../helpers/env-fixture.mjs";
import { ROOT, runHook, decisionOf } from "../helpers/hook-env.mjs";

function fixture(n = 150) {
  const ws = mkdtempSync(join(tmpdir(), "complete-"));
  const raw = join(ws, "customers/ENEL/_inbox/XSC/raw");
  const units = join(ws, "customers/ENEL/sources/units/DOC0013");
  mkdirSync(raw, { recursive: true });
  mkdirSync(units, { recursive: true });
  const items = [];
  for (let i = 1; i <= n; i++) {
    const id = String(i).padStart(4, "0");
    writeFileSync(join(units, `U.DOC0013.${id}.yaml`), YAML.stringify({ id: `U.DOC0013.${id}`, text: `Testo dell'unità ${i}`, context: { section: "Formati", prev: i > 1 ? `U.DOC0013.${String(i - 1).padStart(4, "0")}` : null, next: null } }));
    items.push(`  - raw_id: R.DOC0013.${id}\n    source_unit: U.DOC0013.${id}\n    section: Formati\n    candidates: &a${i}\n      - LCY\n    type_hint:\n      candidates: *a${i}\n      outcome: ambiguo\n    extraction:\n      subject: null\n      modality: immutabilita\n    needs_llm: ${i % 3 === 0 ? "false" : "true"}\n    missing:${i % 3 === 0 ? " []" : "\n      - subject"}`);
  }
  writeFileSync(join(raw, "DOC0013.yaml"), `doc: C.ENEL.XSC.DOC.0013\nscope: XSC\ntier: T0\nstats:\n  needs_llm: ${n - Math.floor(n / 3)}\nitems:\n${items.join("\n")}\n`);
  return ws;
}
const LVL = { customer: "ENEL", scope: "XSC" };

test("status e next: grezzi con 150 ancore YAML leggibili; il lotto porta il testo dell'unità e della vicina", () => {
  const ws = fixture();
  const s = status(ws, LVL);
  assert.equal(s.totale.grezzi, 150);
  assert.equal(s.totale["da completare"], 100);
  assert.equal(s.totale.pronto, 50);
  const b = next(ws, LVL, { max: 3 });
  assert.equal(b.doc, "DOC0013");
  assert.equal(b.batch.length, 3);
  assert.deepEqual(b.batch[0].missing, ["subject"]);
  assert.equal(b.batch[1].unit.text, "Testo dell'unità 2");
  assert.equal(b.batch[1].unit.prev_text, "Testo dell'unità 1");
});

test("apply: solo i campi mancanti; parziale, irrisolto e campo non mancante gestiti; gli errori non fermano gli altri", () => {
  const ws = fixture(6);
  const r = applyCompletions(ws, LVL, [
    { raw_id: "R.DOC0013.0001", fields: { subject: "formato documentale" }, citation: { unit: "U.DOC0013.0001", section: "Formati" } },
    { raw_id: "R.DOC0013.0002", fields: { modality: "obbligo" } },
    { raw_id: "R.DOC0013.0004", unresolved: "l'unità non nomina il soggetto" },
    { raw_id: "R.DOC0013.0005", fields: { subject: "" } },
    { raw_id: "R.DOCXXXX.0001", fields: {} },
  ]);
  assert.deepEqual(r.applied.map((a) => [a.raw_id, a.status]), [["R.DOC0013.0001", "completed"], ["R.DOC0013.0004", "unresolved"], ["R.DOC0013.0005", "partial"]]);
  assert.equal(r.errors.length, 2);
  const doc = YAML.parse(readFileSync(join(ws, "customers/ENEL/_inbox/XSC/raw/DOC0013.yaml"), "utf8"), { maxAliasCount: 100000 });
  const it = doc.items.find((x) => x.raw_id === "R.DOC0013.0001");
  assert.equal(it.extraction.subject, "formato documentale");
  assert.equal(it.needs_llm, false);
  assert.equal(it.t1.citation.unit, "U.DOC0013.0001");
  assert.equal(doc.items.find((x) => x.raw_id === "R.DOC0013.0002").extraction.modality, "immutabilita", "campo non mancante intatto");
  assert.equal(doc.stats.t1_completed, 1);
});

test("ready e mark: i completati entrano nella coda del digester, gli irrisolti no; il digerito ne esce", () => {
  const ws = fixture(6);
  applyCompletions(ws, LVL, [{ raw_id: "R.DOC0013.0001", fields: { subject: "x" } }, { raw_id: "R.DOC0013.0002", unresolved: "nessun soggetto" }]);
  const q = ready(ws, LVL).items.map((i) => i.raw_id);
  assert.ok(q.includes("R.DOC0013.0001"));
  assert.ok(q.includes("R.DOC0013.0003"));
  assert.ok(!q.includes("R.DOC0013.0002"));
  mark(ws, LVL, "R.DOC0013.0001", "C.ENEL.XSC.LCY.0001");
  assert.ok(!ready(ws, LVL).items.some((i) => i.raw_id === "R.DOC0013.0001"));
  assert.equal(status(ws, LVL).totale.digerito, 1);
  assert.throws(() => mark(ws, LVL, "R.DOC0013.0001", "non-un-codice"), /codice non valido/);
});

test("CLI: --help, status --json, uso sbagliato ⇒ exit 1", () => {
  const ws = fixture(3);
  const cli = (args) => spawnSync(process.execPath, [join(ROOT, "scripts/ingest/complete.mjs"), ...args], { encoding: "utf8" });
  assert.equal(cli(["--help"]).status, 0);
  const s = cli(["status", "--customer", "ENEL", "--scope", "XSC", "--workspace", ws, "--json"]);
  assert.equal(s.status, 0, s.stdout + s.stderr);
  assert.equal(JSON.parse(s.stdout).totale.grezzi, 3);
  assert.equal(cli(["status", "--scope", "XSC", "--workspace", ws, "--json"]).status, 1);
  assert.equal(cli(["status", "--customer", "ENEL", "--scope", "NONE", "--workspace", ws, "--json"]).status, 1);
});

test("guard-control: con il registro di controllo illeggibile ogni chiamata del sub-agente è negata, tranne la consegna del rapporto", () => {
  const ws = envWs({ env: "sandbox", scope: "XSC" });
  writeFileSync(join(ws, "customers/ACME/.sessions/sess-1/control.jsonl"), "non è json\n");
  const g = (tool) => runHook("guard-control", { session_id: "sess-1", cwd: ws, hook_event_name: "PreToolUse", tool_name: tool, tool_input: {}, agent_id: "a1", agent_type: "jaggaer-virtual-consultant:scope-digester" }, { JVC_WORKSPACE: ws, CLAUDE_PLUGIN_ROOT: ROOT });
  assert.equal(decisionOf(g("Read")), "deny");
  assert.notEqual(decisionOf(g("SubagentHandback")), "deny");
});
