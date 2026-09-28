// Tempi dei guard (brief K2.5: "log actual, assert < 300 ms per call").
// Gira DOPO la suite principale (npm test), da solo e senza concorrenza: riesegue
// le suite avverse in un processo figlio con JVC_TIMING_LOG, così ogni chiamata
// di guard di quelle suite viene misurata senza la contesa della CPU degli altri
// file di test, e qui si verifica che ciascuna stia sotto i 300 ms.
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
  // K6.2: observe-append (PostToolUse, fail-open) — tempo tipico (mediana) < 150 ms.
  "test/hooks/observe-append.test.mjs",
  // F0: guard-destructive (deny-list), guard-alm-write, gate di integrità.
  "test/hooks/guard-destructive.test.mjs", "test/hooks/guard-alm-write.test.mjs", "test/hooks/wp07-carry-claude-effects.test.mjs", "test/hooks/wp08-fixround1.test.mjs"];
const GUARDS = /^guard-/;

test("ogni chiamata di guard delle suite avverse < 300 ms (processo completo, avvio di node incluso)", { concurrency: false }, () => {
  const log = join(mkdtempSync(join(tmpdir(), "timing-")), "calls.jsonl");
  // Senza NODE_TEST_CONTEXT: ereditato dal runner esterno, farebbe del processo
  // figlio un "figlio del runner" che non esegue le suite (0 test, exit 0).
  const env = { ...process.env, JVC_TIMING_LOG: log };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...SUITES], {
    cwd: ROOT, env, encoding: "utf8", timeout: 600000,
  });
  assert.equal(r.status, 0, `le suite avverse devono passare:\n${r.stdout.slice(-2000)}`);
  assert.ok(existsSync(log), "nessuna chiamata registrata");
  const calls = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((c) => GUARDS.test(c.name));
  assert.ok(calls.length >= 100, `${calls.length} chiamate misurate`);
  const by = {};
  for (const c of calls) (by[c.name] ??= []).push(c.ms);
  for (const [g, arr] of Object.entries(by)) {
    const s = [...arr].sort((a, b) => a - b);
    console.log(`${g}: n=${s.length} media ${(s.reduce((a, b) => a + b) / s.length).toFixed(0)} ms · p50 ${s[s.length >> 1].toFixed(0)} · p95 ${s[Math.floor(s.length * 0.95)].toFixed(0)} · max ${s[s.length - 1].toFixed(0)} ms`);
  }
  const obs = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((c) => c.name === "observe-append").map((c) => c.ms).sort((a, b) => a - b);
  assert.ok(obs.length >= 20, `observe-append: ${obs.length} chiamate misurate`);
  const p50 = obs[obs.length >> 1];
  console.log(`observe-append: n=${obs.length} p50 ${p50.toFixed(0)} · p95 ${obs[Math.floor(obs.length * 0.95)].toFixed(0)} · max ${obs.at(-1).toFixed(0)} ms`);
  assert.ok(p50 < 150, `observe-append tipico ${p50.toFixed(0)} ms ≥ 150 ms`);
  const slow = calls.filter((c) => c.ms >= 300);
  assert.deepEqual(slow, [], `chiamate ≥ 300 ms: ${JSON.stringify(slow)}`);
});
