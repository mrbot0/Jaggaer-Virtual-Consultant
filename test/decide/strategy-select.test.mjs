import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { selectStrategy, precedentClass, loadStrategies, STRATEGIES_DIR } from "../../scripts/decide/strategy-select.mjs";
import { validateWith } from "../../scripts/lib/schemas.mjs";

const CLI = fileURLToPath(new URL("../../scripts/decide/strategy-select.mjs", import.meta.url));
const CASES = YAML.parse(readFileSync(new URL("../eval/strategy-select/cases.yaml", import.meta.url), "utf8"));
const ORDER = ["REPLAY", "VERIFY-FIRST", "TRIANGULATE", "DRY-RUN", "MIN-CHANGE", "BISECT", "EXPLORE-BUDGET", "ASK-EARLY",
  "GENERALIZE-CAUTIOUSLY", "STOP-RECORD", "PREMORTEM", "DISCONFIRM"];

test("golden strategy-select: 20 casi (§18, bordi di banda, ogni strategia) → ≥ 18/20 (M4)", () => {
  assert.equal(CASES.length, 20);
  const misses = [];
  for (const c of CASES) {
    const r = selectStrategy(c.input);
    const okStrategy = r.strategy === c.expect.strategy;
    const okCombine = JSON.stringify(r.combine) === JSON.stringify(c.expect.combine ?? []);
    const okThen = c.expect.then === undefined || r.then === c.expect.then;
    const okScore = c.expect.score === undefined || Math.abs(r.score - c.expect.score) < 1e-6;
    if (!(okStrategy && okCombine && okThen && okScore)) misses.push(`${c.id}: atteso ${JSON.stringify(c.expect)} → ${JSON.stringify({ strategy: r.strategy, then: r.then, combine: r.combine, score: r.score })}`);
  }
  const score = CASES.length - misses.length;
  console.log(`strategy-select golden: ${score}/${CASES.length}${misses.length ? `\n  ${misses.join("\n  ")}` : ""}`);
  assert.ok(score >= 18, `golden ${score}/20 < 18:\n${misses.join("\n")}`);
  // copertura del repertorio: ogni strategia almeno una volta come scelta o in combinazione
  const seen = new Set(CASES.flatMap((c) => [c.expect.strategy, c.expect.then, ...(c.expect.combine ?? [])]).filter(Boolean));
  for (const n of ORDER) assert.ok(seen.has(`STR-${n}`), `STR-${n} non coperta dal golden`);
});

test("precedentClass: il precedente più vicino nelle classi di DT-017 (§14.3, §12.4)", () => {
  assert.equal(precedentClass([]), "nessuno");
  assert.equal(precedentClass(undefined), "nessuno");
  assert.equal(precedentClass("smentito-d<0.3"), "smentito-d<0.3");
  assert.equal(precedentClass([{ d: 0.12, result: "confermata" }]), "confermato-d<0.2");
  assert.equal(precedentClass([{ d: 0.2, result: "confermata" }]), "confermato-d<0.5");
  assert.equal(precedentClass([{ d: 0.29, result: "smentita" }]), "smentito-d<0.3");
  assert.equal(precedentClass([{ d: 0.31, result: "smentita" }]), "nessuno");   // §12.4: smentito oltre 0.3 non conta
  assert.equal(precedentClass([{ d: 0.55, result: "confermata" }]), "nessuno");
  assert.equal(precedentClass({ d: 0.1, result: "confermata" }), "confermato-d<0.2");
  assert.throws(() => precedentClass("forse"), /precedente/);
});

test("selectStrategy: input fuori dominio → errore, mai un'approssimazione; rischio mancante → errore (null_policy)", () => {
  assert.throws(() => selectStrategy({ shape: "libresco", risk: "R4" }));
  assert.throws(() => selectStrategy({ shape: "libresco" }));
  assert.throws(() => selectStrategy({ shape: "libresco", risk: "R1", mode: "boh" }), /modalità/);
});

test("strategies/: le dodici strategie di §14.2, schema §14.4, id S.STD.XSC.STR.0001…0012, file STR-<NOME>.yaml", () => {
  const files = readdirSync(STRATEGIES_DIR).filter((f) => f.endsWith(".yaml")).sort();
  assert.equal(files.length, 12);
  const all = loadStrategies();
  ORDER.forEach((name, i) => {
    const code = `STR-${name}`;
    const s = all[code];
    assert.ok(s, `${code} mancante`);
    assert.ok(files.includes(`${code}.yaml`));
    assert.equal(s.id, `S.STD.XSC.STR.${String(i + 1).padStart(4, "0")}`);
    const v = validateWith("strategy.schema.json", s);
    assert.ok(v.ok, `${code}: ${v.errors.join("; ")}`);
    assert.deepEqual(s.plan.map((p) => p.n), s.plan.map((_, j) => j + 1), `${code}: passi numerati 1..n`);
    assert.equal(s.cluster, `CL-STR-${String(i + 1).padStart(3, "0")}`);
    assert.ok(existsSync(fileURLToPath(new URL(`../../clusters/CL-STR/${s.cluster}.yaml`, import.meta.url))));
    assert.doesNotMatch(JSON.stringify(s), /\bDELETE\b/);
  });
  // STR-VERIFY-FIRST esattamente come §14.4
  const vf = all["STR-VERIFY-FIRST"];
  assert.equal(vf.name, "Verifica prima di agire");
  assert.deepEqual(vf.applies_when, { shape: "libresco", risk_min: "R1" });
  assert.equal(vf.plan.length, 5);
  assert.equal(vf.plan[0].do, "kb epistemic <subject> → gaps");
  assert.match(vf.plan[2].do, /≤ 8 passi, ≤ 5 min/);
  assert.match(vf.plan[4].do, /STR-TRIANGULATE/);
  assert.match(vf.plan[4].do, /STR-ASK-EARLY/);
  assert.deepEqual(vf.cost, { tier: "T0 per i passi 1-4, T1 per il 5" });
  assert.equal(vf.success_criteria, "forma finale ≠ libresco");
  // le combinazioni sono dichiarate tali
  for (const c of ["STR-PREMORTEM", "STR-DISCONFIRM", "STR-MIN-CHANGE"]) assert.equal(all[c].applies_when.combination, true, c);
  // schema: id fuori formato o passo senza `do` → invalido
  assert.equal(validateWith("strategy.schema.json", { ...vf, id: "S.STD.ADM.STR.0002" }).ok, false);
  assert.equal(validateWith("strategy.schema.json", { ...vf, plan: [{ n: 1 }] }).ok, false);
});

test("ogni esito di DT-017 e ogni combinazione ha la sua strategia nel repertorio", async () => {
  const { loadTable } = await import("../../scripts/decide/dt-eval.mjs");
  const t = loadTable("DT-017");
  const all = loadStrategies();
  for (const o of t.outcomes.filter((x) => x !== "nessuna")) assert.ok(all[o], o);
  for (const c of t.combinations) assert.ok(all[c.add], c.add);
});

test("CLI strategy-select --json (e --input file) → { strategy, combine, score }", () => {
  const r = spawnSync(process.execPath, [CLI, "--shape", "libresco", "--risk", "R2", "--precedent", "smentito-d<0.3", "--surprises", "0", "--mode", "config", "--json"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, true);
  assert.equal(out.strategy, "STR-DRY-RUN");
  assert.equal(out.then, "STR-VERIFY-FIRST");
  assert.deepEqual(out.combine, []);
  assert.ok(Math.abs(out.score - 0.6) < 1e-9);
  const combo = spawnSync(process.execPath, [CLI, "--shape", "libresco", "--risk", "R1", "--mode", "config", "--has-hypotheses", "--json"], { encoding: "utf8" });
  assert.deepEqual(JSON.parse(combo.stdout).combine, ["STR-MIN-CHANGE"]);
  const bad = spawnSync(process.execPath, [CLI, "--shape", "libresco", "--risk", "R9", "--json"], { encoding: "utf8" });
  assert.equal(bad.status, 1);
  assert.equal(JSON.parse(bad.stdout).ok, false);
  assert.equal(spawnSync(process.execPath, [CLI, "--help"], { encoding: "utf8" }).status, 0);
});
