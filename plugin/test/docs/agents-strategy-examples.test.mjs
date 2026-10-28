// WP10b parte 2, giro di correzione 1 del blocco C (revisione 2C, I2): l'esempio di rapporto di ogni agente non deve
// insegnare una coppia (forma, strategia) che strategy-select non può dare. Per ogni corpo in agents/: si legge
// l'ultimo blocco ```yaml (l'esempio del rapporto), si prendono shape_before, strategy e depth della traccia e, dal
// comando strategy-select del corpo, i parametri fissati alla lettera (--risk R0, --mode ops, --depth rapida); gli
// altri input (rischio, precedente, sorprese, modalità, divergenza, ipotesi, prior) si enumerano. La strategia
// dell'esempio deve essere fra quelle che selectStrategy() restituisce (come strategia, `then` o combinazione) per quella
// forma — REPLAY solo da consolidato, TRIANGULATE da contraddittorio, ASK-EARLY da ignoto, e così via.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { selectStrategy } from "../../scripts/decide/strategy-select.mjs";
import { loadTable } from "../../scripts/decide/dt-eval.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const AGENTS = join(ROOT, "agents");
const RISKS = ["R0", "R1", "R2", "R3"];
const PRECEDENTS = ["confermato-d<0.2", "confermato-d<0.5", "nessuno", "smentito-d<0.3"];
const MODES = ["nrt", "config", "ops", "diag"];

export function exampleOf(body) {
  const blocks = [...body.replace(/\r\n/g, "\n").matchAll(/```yaml\n([\s\S]*?)```/g)];
  return blocks.length ? YAML.parse(blocks.at(-1)[1]) : null;
}

// Parametri fissati alla lettera nel comando strategy-select del corpo (un segnaposto <…> resta libero).
export function fixedParams(body) {
  const m = /strategy-select\.mjs"?([^\n]*)/.exec(body);
  const cmd = m ? m[1] : "";
  const lit = (flag, dom) => { const x = new RegExp(`--${flag} (\\S+)`).exec(cmd)?.[1]; return x && dom.includes(x) ? x : null; };
  return { risk: lit("risk", RISKS), mode: lit("mode", MODES), depth: lit("depth", ["rapida", "standard", "profonda"]) };
}

const DT017 = loadTable("DT-017");
const memo = new Map();
export function reachable(shape, { risk, mode, depth }) {
  const key = JSON.stringify([shape, risk, mode, depth]);
  if (memo.has(key)) return memo.get(key);
  const out = new Set();
  memo.set(key, out);
  for (const r of risk ? [risk] : RISKS) for (const precedent of PRECEDENTS) for (const surprises of [0, 1, 2, 3])
    for (const md of mode ? [mode] : MODES) for (const divergence_unknown of [false, true]) for (const has_hypotheses of [false, true])
      for (const preferred_prior of [undefined, 0.7]) {
        const x = selectStrategy({ shape, risk: r, precedent, surprises, mode: md, divergence_unknown, has_hypotheses, preferred_prior, depth }, { table: DT017 });
        out.add(x.strategy);
        if (x.then) out.add(x.then);
        for (const c of x.combine ?? []) out.add(c);
      }
  return out;
}

test("esempi dei rapporti: la coppia (forma, strategia) di ogni agente è una che strategy-select può dare con i parametri del corpo", () => {
  const files = readdirSync(AGENTS).filter((f) => f.endsWith(".md") && !["health-keeper", "workspace-manager"].includes(f.slice(0, -3))).sort();   // 28/10/2026: esclusi gli agenti di manutenzione
  assert.equal(files.length, 15, "i 15 agenti foglia");
  const errs = [];
  for (const f of files) {
    const body = readFileSync(join(AGENTS, f), "utf8");
    const ex = exampleOf(body);
    const ct = ex?.cognitive_trace;
    if (!ct?.epistemic?.shape_before || !ct?.strategy) { errs.push(`${f}: esempio senza shape_before o strategy`); continue; }
    const params = { ...fixedParams(body), depth: ct.depth ?? fixedParams(body).depth };
    const ok = reachable(ct.epistemic.shape_before, params);
    if (!ok.has(ct.strategy)) errs.push(`${f}: ${ct.epistemic.shape_before} + ${ct.strategy} non è producibile (${JSON.stringify(params)}): ${[...ok].join(", ")}`);
  }
  assert.deepEqual(errs, []);
});

test("il controllo riconosce le coppie impossibili (auto-test)", () => {
  assert.ok(!reachable("contraddittorio", { risk: "R1", mode: "diag", depth: "rapida" }).has("STR-REPLAY"));
  assert.ok(!reachable("ignoto", { risk: "R1", mode: "nrt", depth: "standard" }).has("STR-REPLAY"));
  assert.ok(!reachable("consolidato", { risk: "R0", mode: "config", depth: "rapida" }).has("STR-VERIFY-FIRST"));
  assert.ok(reachable("ignoto", { risk: "R0", mode: "ops", depth: "standard" }).has("STR-VERIFY-FIRST"));
  assert.deepEqual(fixedParams('strategy-select.mjs" --shape <forma> --risk R0 --precedent <classe> --mode config --depth rapida --json'), { risk: "R0", mode: "config", depth: "rapida" });
  assert.deepEqual(fixedParams('strategy-select.mjs" --shape <forma> --risk <R> --mode <modalità> --json'), { risk: null, mode: null, depth: null });
});
