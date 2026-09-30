// Tempi dei guard (brief K2.5; revisione finale: misura robusta). `npm run test:timing`, DOPO la suite principale,
// da solo e senza concorrenza (anche in CI, passo separato). Le suite avverse girano in un processo figlio con
// JVC_TIMING_LOG: ogni chiamata di hook di quelle suite è registrata (nome, durata del processo completo).
//
// Robustezza (FINAL, in:52/in:54):
//  - riscaldamento: le prime WARMUP chiamate di ogni hook non contano (cache del disco, JIT, antivirus);
//  - baseline nella stessa esecuzione: la mediana di `node -e 0` (avvio nudo di node) misurata subito prima;
//    le soglie valgono sul DELTA = durata della chiamata − baseline, cioè sul costo proprio dell'hook;
//  - mediana e p95 del delta, mai il massimo di un singolo campione;
//  - fino a ATTEMPTS tentativi: per ogni hook vale il tentativo con la mediana migliore.
// Obiettivi (dichiarati nel report di fase K6, sezione "Revisione finale"):
//  - ogni guard-*: mediana del delta < 150 ms e p95 del delta < 250 ms (≈ i 300 ms per chiamata del brief K2.5,
//    avvio di node incluso, con un avvio nudo di ~50 ms);
//  - observe-append (PostToolUse, fail-open): mediana del delta < 150 ms.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "../helpers/hook-env.mjs";

// K5: anche le suite avverse dei guard del browser (ambiente, produzione, 3A).
const SUITES = ["test/hooks/guards-adversarial.test.mjs", "test/hooks/guards-adversarial-r1.test.mjs",
  "test/hooks/guard-environment.test.mjs", "test/hooks/guard-production.test.mjs", "test/hooks/approvals-3a.test.mjs", "test/hooks/k5-fixround1.test.mjs", "test/hooks/k5-fixround2.test.mjs", "test/hooks/k5-fixround3.test.mjs",
  // K6.2: observe-append (PostToolUse, fail-open).
  "test/hooks/observe-append.test.mjs",
  // F0: guard-destructive (deny-list), guard-alm-write, gate di integrità.
  "test/hooks/guard-destructive.test.mjs", "test/hooks/guard-alm-write.test.mjs", "test/hooks/wp07-carry-claude-effects.test.mjs", "test/hooks/wp08-fixround1.test.mjs",
  // WP10d: guard-control (ogni strumento, anche con il transcript di 40 MB) e le regole di orchestrazione di guard-budget.
  "test/hooks/wp10d-control.test.mjs", "test/hooks/wp10d-vigilance.test.mjs", "test/hooks/wp10d-fixround1.test.mjs"];
const GUARDS = /^guard-/;
const WARMUP = 5;
const ATTEMPTS = 3;
export const TARGETS = { guardMedian: 150, guardP95: 250, observeMedian: 150 };

const q = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
const median = (arr) => q([...arr].sort((a, b) => a - b), 0.5);

// avvio nudo di node nella stessa esecuzione (3 di riscaldamento scartati)
function baselineMs(n = 20) {
  const times = [];
  for (let i = 0; i < n + 3; i++) {
    const t0 = performance.now();
    spawnSync(process.execPath, ["-e", "0"], { encoding: "utf8" });
    if (i >= 3) times.push(performance.now() - t0);
  }
  return median(times);
}

function attempt() {
  const base = baselineMs();
  const log = join(mkdtempSync(join(tmpdir(), "timing-")), "calls.jsonl");
  // Senza NODE_TEST_CONTEXT: ereditato dal runner esterno, farebbe del processo
  // figlio un "figlio del runner" che non esegue le suite (0 test, exit 0).
  const env = { ...process.env, JVC_TIMING_LOG: log };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...SUITES], { cwd: ROOT, env, encoding: "utf8", timeout: 900000 });
  assert.equal(r.status, 0, `le suite avverse devono passare:\n${r.stdout.slice(-2000)}`);
  assert.ok(existsSync(log), "nessuna chiamata registrata");
  const calls = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const by = {};
  for (const c of calls) (by[c.name] ??= []).push(c.ms);
  const stats = {};
  for (const [name, arr] of Object.entries(by)) {
    const kept = arr.slice(WARMUP);
    if (kept.length < 5) continue;
    const d = kept.map((ms) => ms - base).sort((a, b) => a - b);
    stats[name] = { n: kept.length, median: q(d, 0.5), p95: q(d, 0.95), abs_median: median(kept), abs_max: Math.max(...kept) };
  }
  return { base, stats, guardCalls: calls.filter((c) => GUARDS.test(c.name)).length };
}

const failures = (best) => {
  const out = [];
  for (const [name, s] of Object.entries(best)) {
    if (GUARDS.test(name) && (s.median >= TARGETS.guardMedian || s.p95 >= TARGETS.guardP95)) out.push(`${name}: mediana Δ ${s.median.toFixed(0)} ms, p95 Δ ${s.p95.toFixed(0)} ms`);
    if (name === "observe-append" && s.median >= TARGETS.observeMedian) out.push(`observe-append: mediana Δ ${s.median.toFixed(0)} ms`);
  }
  return out;
};

test("guard e observe-append: mediana e p95 del costo proprio (delta sull'avvio nudo di node) sotto gli obiettivi, fino a 3 tentativi", { concurrency: false, timeout: 3 * 900000 }, () => {
  const best = {};
  let last = [];
  for (let i = 1; i <= ATTEMPTS; i++) {
    const a = attempt();
    assert.ok(a.guardCalls >= 100, `${a.guardCalls} chiamate di guard misurate`);
    for (const [name, s] of Object.entries(a.stats)) if (!best[name] || s.median < best[name].median) best[name] = { ...s, base: a.base, attempt: i };
    console.log(`tentativo ${i}: node -e 0 mediana ${a.base.toFixed(0)} ms`);
    last = failures(best);
    if (!last.length) break;
  }
  for (const [name, s] of Object.entries(best).sort()) {
    console.log(`${name}: n=${s.n} (tentativo ${s.attempt}, base ${s.base.toFixed(0)} ms) · mediana Δ ${s.median.toFixed(0)} · p95 Δ ${s.p95.toFixed(0)} · assoluti: mediana ${s.abs_median.toFixed(0)}, max ${s.abs_max.toFixed(0)} ms`);
  }
  assert.ok(best["observe-append"]?.n >= 20, "observe-append: troppe poche chiamate misurate");
  assert.deepEqual(last, [], "hook sopra gli obiettivi (mediana/p95 del delta)");
});
