import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { deliberationDepth } from "../../scripts/decide/depth.mjs";

const CLI = fileURLToPath(new URL("../../scripts/decide/depth.mjs", import.meta.url));

test("§10.4 rapida: consolidato × R ≤ R1 × precedente confermato × 0 sorprese → top 3, 1 precedente, niente alternative, niente file, self-check 1/3/9 (+ #11), T0", () => {
  const r = deliberationDepth({ risk: "R1", shape: "consolidato", surprises: 0, precedent: [{ d: 0.1, result: "confermata" }], graph_radius: 2 });
  assert.equal(r.depth, "rapida");
  assert.deepEqual(r.recall, { items: 3, precedents: 1, other_customers: false });
  assert.equal(r.alternatives, 0);
  assert.equal(r.open_files, "no");
  assert.equal(r.premortem, false);
  assert.equal(r.hypotheses_register, false);
  // §10.4 riduce a 1, 3, 9; #11 (RPT, §29.6) resta: stessa fonte di self-check (fix round 1, Minor #2)
  assert.deepEqual(r.self_check_controls, [1, 3, 9, 11]);
  assert.equal(r.tier, "T0");
});

test("§10.4 standard: il resto dei casi ordinari → top 8, 3 precedenti, 2 alternative, file solo se il summary non basta, T1", () => {
  const r = deliberationDepth({ risk: "R1", shape: "libresco", surprises: 0, precedent: "nessuno", graph_radius: 1 });
  assert.equal(r.depth, "standard");
  assert.deepEqual(r.recall, { items: 8, precedents: 3, other_customers: false });
  assert.equal(r.alternatives, 2);
  assert.equal(r.open_files, "se-il-summary-non-basta");
  assert.deepEqual(r.self_check_controls, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
  assert.equal(r.tier, "T1");
});

test("§10.4 profonda: R ≥ R2 × libresco → top 15, 5 precedenti anche di altri clienti, ipotesi, pre-mortem, file aperti, T2", () => {
  const r = deliberationDepth({ risk: "R2", shape: "libresco", surprises: 0, precedent: "nessuno", graph_radius: 1 });
  assert.equal(r.depth, "profonda");
  assert.deepEqual(r.recall, { items: 15, precedents: 5, other_customers: true });
  assert.equal(r.alternatives, "esplicite con costi e rischi");
  assert.equal(r.open_files, "sì");
  assert.equal(r.premortem, true);
  assert.equal(r.hypotheses_register, true);
  assert.equal(r.tier, "T2");
  // §18.4: profonda per forma contraddittoria a R0 — pre-mortem solo per R ≥ R2 (§14.2)
  const d = deliberationDepth({ risk: "R0", shape: "contraddittorio", surprises: 0, precedent: "nessuno" });
  assert.equal(d.depth, "profonda");
  assert.equal(d.premortem, false);
  // mai eseguito qui con impatto sul grafo > 5 nodi
  assert.equal(deliberationDepth({ risk: "R1", shape: "consolidato", precedent: "confermato-d<0.2", graph_radius: 8, never_executed_here: true }).depth, "profonda");
  // ≥ 2 sorprese
  assert.equal(deliberationDepth({ risk: "R0", shape: "consolidato", surprises: 2, precedent: "confermato-d<0.2" }).depth, "profonda");
});

test("CLI depth --json", () => {
  const r = spawnSync(process.execPath, [CLI, "--risk", "R2", "--shape", "libresco", "--json"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).depth, "profonda");
  const bad = spawnSync(process.execPath, [CLI, "--shape", "libresco", "--json"], { encoding: "utf8" });
  assert.equal(bad.status, 1);
});
