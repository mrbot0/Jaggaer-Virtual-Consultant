// Corsia integration (F6, §27.4, §47.2 regola 5, ADR-13, DT-013).
//
//   L1 diffPayload(golden, actual, tolerances) → { match, diffs[] }   contratto sul golden con tolleranze: numeric
//      { percorso: ± }, ignore_fields [percorsi], order_insensitive [percorsi di array], date_formats [YYYYMMDD, …];
//      percorsi con / o . (E1EDP01/MENGE); un percorso di tolleranza vale per ogni indice di array ([] ignorati)
//   L2 expectedStage(int, { priors? }) → { stage, dec }   DT-013 da document_impact blocking, silence_semantics e p95
//      dichiarata; default queued_accepted (ADR-13)
//      classifyCheckpoint({ expected, reached, elapsedS, p95S, timedOut, error }) →
//        pass · fail (errore del controparte: difetto candidato) · E2 (timeout entro la p95 dichiarata: ambientale,
//        ritentare) · observation (timeout oltre la p95: la latenza dichiarata era sbagliata — si registra, non è un
//        difetto, §47.2 regola 5)
//   L3 stubDescriptor(int, { envType }) → descrittore dello stub inbound: SOLO sandbox; INT inbound o bidirezionale
//
// CLI: node scripts/run/integration.mjs diff --golden <file> --actual <file> [--int <codice|file>] [--json]
//      node scripts/run/integration.mjs checkpoint --int <codice|file> --reached <stadio|none> --elapsed-s <n> [--timed-out] [--error]
//      node scripts/run/integration.mjs stub --int <codice|file> [--env-type sandbox]
// Exit: 0 ok/pass · 1 argomenti · 2 errore di sistema · 3 diff, fail o rifiuto (stub fuori sandbox).
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import YAML from "yaml";
import { parseArgs, fail } from "../lib/args.mjs";
import { isMain } from "../lib/is-main.mjs";
import { evaluate, loadTable } from "../decide/dt-eval.mjs";
import { loadItem } from "../lib/kb-items.mjs";
import { workspaceCustomer } from "./fixtures.mjs";
import { confineInputs } from "../lib/text-file.mjs";

export class IntegrationError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
export const STAGES = ["queued_accepted", "processed", "acknowledged"];

// ——— L1 ———
const segs = (p) => String(p).split(/[/.]/).filter(Boolean);
const pathKey = (parts) => parts.filter((x) => !/^\d+$/.test(x)).join("/");
const DATE_RES = [
  [/^(\d{4})(\d{2})(\d{2})$/, (m) => `${m[1]}-${m[2]}-${m[3]}`],
  [/^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/, (m) => `${m[1]}-${m[2]}-${m[3]}`],
  [/^(\d{2})\/(\d{2})\/(\d{4})$/, (m) => `${m[3]}-${m[2]}-${m[1]}`],
  [/^(\d{2})\.(\d{2})\.(\d{4})$/, (m) => `${m[3]}-${m[2]}-${m[1]}`],
];
function asDate(v) {
  if (typeof v !== "string") return null;
  for (const [re, f] of DATE_RES) { const m = re.exec(v.trim()); if (m) return f(m); }
  return null;
}

export function diffPayload(golden, actual, tolerances = {}) {
  const numeric = Object.fromEntries(Object.entries(tolerances.numeric ?? {}).map(([k, v]) => [pathKey(segs(k)), Number(v)]));
  const ignore = new Set((tolerances.ignore_fields ?? []).map((p) => pathKey(segs(p))));
  const unordered = new Set((tolerances.order_insensitive ?? []).map((p) => pathKey(segs(p))));
  const dates = (tolerances.date_formats ?? []).length > 0;
  const diffs = [];
  const sub = (g, a, parts) => { const saved = diffs.length; walk(g, a, parts); const d = diffs.splice(saved); return d.length; };
  const walk = (g, a, parts) => {
    const key = pathKey(parts);
    const at = parts.join("/") || "/";
    if (key && ignore.has(key)) return;
    if (g === undefined) { diffs.push({ path: at, kind: "extra", actual: a }); return; }
    if (a === undefined) { diffs.push({ path: at, kind: "missing", golden: g }); return; }
    if (Array.isArray(g) || Array.isArray(a)) {
      if (!Array.isArray(g) || !Array.isArray(a)) { diffs.push({ path: at, kind: "type", golden: g, actual: a }); return; }
      if (unordered.has(key)) {
        // abbinamento senza ordine: ogni elemento del golden con un elemento non ancora usato che coincide (con le
        // tolleranze); i rimasti si confrontano in ordine e gli eccedenti sono mancanti/in più
        if (g.length !== a.length) diffs.push({ path: at, kind: "length", golden: g.length, actual: a.length });
        const used = new Set();
        const left = [];
        g.forEach((ge, gi) => {
          const ai = a.findIndex((ae, i) => !used.has(i) && sub(ge, ae, [...parts, String(gi)]) === 0);
          if (ai >= 0) used.add(ai); else left.push(gi);
        });
        const restA = a.map((_, i) => i).filter((i) => !used.has(i));
        left.forEach((gi, k) => walk(g[gi], restA[k] === undefined ? undefined : a[restA[k]], [...parts, String(gi)]));
        restA.slice(left.length).forEach((i) => walk(undefined, a[i], [...parts, String(i)]));
        return;
      }
      if (g.length !== a.length) diffs.push({ path: at, kind: "length", golden: g.length, actual: a.length });
      for (let i = 0; i < Math.max(g.length, a.length); i++) walk(g[i], a[i], [...parts, String(i)]);
      return;
    }
    if (g && typeof g === "object" && a && typeof a === "object") {
      for (const k of new Set([...Object.keys(g), ...Object.keys(a)])) walk(g[k], a[k], [...parts, k]);
      return;
    }
    const tol = numeric[key];
    const gn = typeof g === "number" ? g : typeof g === "string" && /^-?\d+(\.\d+)?$/.test(g.trim()) ? Number(g) : null;
    const an = typeof a === "number" ? a : typeof a === "string" && /^-?\d+(\.\d+)?$/.test(a.trim()) ? Number(a) : null;
    if (gn !== null && an !== null) {
      if (Math.abs(gn - an) > (Number.isFinite(tol) ? tol + 1e-12 : 0)) diffs.push({ path: at, kind: "value", golden: g, actual: a, ...(Number.isFinite(tol) ? { tolerance: tol } : {}) });
      return;
    }
    if (dates) { const gd = asDate(g); const ad = asDate(a); if (gd && ad) { if (gd !== ad) diffs.push({ path: at, kind: "value", golden: g, actual: a }); return; } }
    if (g !== a) diffs.push({ path: at, kind: typeof g !== typeof a ? "type" : "value", golden: g, actual: a });
  };
  walk(golden, actual, []);
  return { match: diffs.length === 0, diffs };
}

// ——— L2 ———
export function expectedStage(int, { priors = {} } = {}) {
  const dec = evaluate(loadTable("DT-013"), {
    blocking_impact: int?.document_impact?.severity === "blocking",
    silence_possible: int?.silence_semantics?.silent_failure_possible === true,
    latency_declared: Number.isFinite(int?.mode_latency?.p95_s),
  }, { priors: { stage_timeout_rate: priors.stage_timeout_rate ?? null } });
  return { stage: dec.outcome, dec: { outcome: dec.outcome, score: dec.score } };
}

export function classifyCheckpoint({ expected = "queued_accepted", reached = null, elapsedS = 0, p95S = null, timedOut = false, error = false }) {
  if (error) return { outcome: "fail", class: "E4", reason: "il controparte ha segnalato un errore: difetto candidato (Defect, mai Incident)" };
  if (reached && STAGES.indexOf(reached) >= STAGES.indexOf(expected)) return { outcome: "pass", reason: `stadio ${reached} raggiunto (atteso ${expected})` };
  if (timedOut) {
    if (!Number.isFinite(p95S)) return { outcome: "E2", class: "E2", reason: "timeout senza latenza p95 dichiarata: ambientale (ritentare, poi blocked), mai difetto" };
    if (elapsedS <= p95S) return { outcome: "E2", class: "E2", reason: `timeout entro la p95 dichiarata (${elapsedS} s ≤ ${p95S} s): ambientale, ritentare (§47.2 regola 5)` };
    return { outcome: "observation", reason: `timeout oltre la p95 dichiarata (${elapsedS} s > ${p95S} s): la latenza dichiarata era sbagliata — si registra un'osservazione, non un difetto (§47.2 regola 5)` };
  }
  return { outcome: "pending", reason: `stadio ${reached ?? "nessuno"} < ${expected}: attendere entro la p95` };
}

// ——— L3 ———
export function stubDescriptor(int, { envType = "sandbox" } = {}) {
  if (envType !== "sandbox") throw new IntegrationError(3, `stub inbound solo in sandbox (ambiente ${envType}, §27.4 L3)`);
  if (!["inbound", "bidirectional"].includes(int?.direction)) throw new IntegrationError(3, `${int?.id ?? "INT"}: lo stub L3 vale per le interfacce in ingresso (direction ${int?.direction ?? "ignota"})`);
  const payload = {};
  for (const m of int.mappings ?? []) payload[m.target] = m.one_of ? `{{${m.field}|uno fra ${m.one_of.group}}}` : `{{${m.field}}}`;
  return { int: int.id, protocol: int.protocol, env: "sandbox", trigger: int.trigger ?? null, payload_template: payload,
    mandatory: (int.mappings ?? []).filter((m) => m.mandatory).map((m) => m.target), expected_checkpoint: int.e2e_checkpoint?.stage ?? "queued_accepted",
    silence: int.silence_semantics ?? null, note: "descrittore dello stub inbound (L3): lo esegue la pipeline in sandbox, mai in pre-produzione o produzione" };
}

// ——— CLI ———
const read = (f) => { const t = readFileSync(resolvePath(f), "utf8"); return /\.json$/i.test(f) ? JSON.parse(t) : YAML.parse(t); };
function readInt(ws, ref, customer) {
  if (!ref) throw new IntegrationError(1, "richiesto --int <codice|file>");
  if (/^[SCL]\.[A-Z0-9]{3,4}\.[A-Z0-9]{3}\.INT\.\d{4}$/.test(ref)) { const it = loadItem(ws, ref, customer); if (!it) throw new IntegrationError(1, `${ref} non trovato`); return it; }
  return read(ref);
}
const HELP = `uso: node scripts/run/integration.mjs diff --golden <file> --actual <file> [--int <codice|file>] [--json]
       node scripts/run/integration.mjs checkpoint --int <codice|file> --reached <stadio|none> --elapsed-s <n> [--timed-out] [--error]
       node scripts/run/integration.mjs stub --int <codice|file> [--env-type sandbox]
Corsia integration: L1 diff con tolleranze dell'INT, L2 checkpoint DT-013 (default queued_accepted, ADR-13) con la
classificazione dei timeout (§47.2 regola 5), L3 descrittore dello stub inbound (solo sandbox).
Exit code: 0 ok/pass · 1 argomenti · 2 errore di sistema · 3 diff, fail o rifiuto.`;

export function run(argv, env = process.env) {
  const { opts, positional } = parseArgs(argv, { flags: ["timed-out", "error"] });
  const asJson = !!opts.json;
  const [cmd] = positional;
  if (opts.help || !cmd) { console.log(HELP); return opts.help ? 0 : 1; }
  { const bad = confineInputs(opts, ["golden","actual","int"], { env, skip: (n, v) => n === "int" && /^[SCL]\.[A-Z0-9]{3,4}\.[A-Z0-9]{3}\.INT\.\d{4}$/.test(v) }); if (bad) return fail(asJson, 1, bad); }
  const { ws, customer } = workspaceCustomer(opts, env);
  try {
    if (cmd === "diff") {
      if (!opts.golden || !opts.actual) return fail(asJson, 1, "richiesti --golden e --actual");
      const int = opts.int ? readInt(ws, opts.int, customer) : null;
      const r = diffPayload(read(opts.golden), read(opts.actual), int?.tolerances ?? {});
      console.log(asJson ? JSON.stringify({ ok: r.match, ...r }) : r.match ? "contratto rispettato" : r.diffs.map((d) => `${d.kind} ${d.path}: ${JSON.stringify(d.golden)} ≠ ${JSON.stringify(d.actual)}`).join("\n"));
      return r.match ? 0 : 3;
    }
    if (cmd === "checkpoint") {
      const int = readInt(ws, opts.int, customer);
      const exp = expectedStage(int);
      const r = classifyCheckpoint({ expected: exp.stage, reached: opts.reached && opts.reached !== "none" ? opts.reached : null, elapsedS: Number(opts["elapsed-s"] ?? 0), p95S: int.mode_latency?.p95_s ?? null, timedOut: !!opts["timed-out"], error: !!opts.error });
      console.log(asJson ? JSON.stringify({ ok: r.outcome === "pass", expected: exp, ...r }) : `${r.outcome}: ${r.reason}`);
      return r.outcome === "fail" ? 3 : 0;
    }
    if (cmd === "stub") {
      const d = stubDescriptor(readInt(ws, opts.int, customer), { envType: opts["env-type"] ?? "sandbox" });
      console.log(asJson ? JSON.stringify({ ok: true, stub: d }) : YAML.stringify(d));
      return 0;
    }
    return fail(asJson, 1, `comando sconosciuto: ${cmd}`);
  } catch (err) {
    if (err instanceof IntegrationError) return fail(asJson, err.code, err.message);
    return fail(asJson, 2, `errore di sistema: ${err?.message ?? err}`);
  }
}

if (isMain(import.meta.url)) process.exit(run(process.argv.slice(2)));
