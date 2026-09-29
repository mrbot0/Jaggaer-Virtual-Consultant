// xray verify (§27.5, M13 "Test Execution con evidenze sul passo corretto, leggibile dal QA lead"): rilegge dall'ALM le
// Test Execution pubblicate per il run (runs/<RUN>/xray-published.json) e le confronta col payload del dossier
// (runs/<RUN>/xray-payload.json): per ogni test lo stato e, passo per passo, il numero di evidenze. Sola lettura
// (getExecution dell'adattatore).
//
// CLI: node scripts/xray/verify.mjs --run <RUN> [--scope S] [--customer C] [--workspace <dir>] [--json]
// Exit: 0 coerente · 1 argomenti, configurazione o nulla di pubblicato · 2 errore di sistema · 3 differenze o
//       esecuzione illeggibile.
import { parseArgs } from "../lib/args.mjs";
import { isMain } from "../lib/is-main.mjs";
import { readPayload, readPublished } from "../../mcp/alm-server/queue.mjs";
import { XrayError, xrayContext, failWith } from "./common.mjs";

export function compare(expected, actual) {
  const mismatches = [];
  const got = new Map((actual?.tests ?? []).map((t) => [t.testKey, t]));
  for (const t of expected.tests ?? []) {
    if (!t.testKey) continue;
    const a = got.get(t.testKey);
    if (!a) { mismatches.push({ test: t.testKey, what: "assente nell'esecuzione" }); continue; }
    if (a.status !== t.status) mismatches.push({ test: t.testKey, what: "stato", expected: t.status, actual: a.status });
    const exp = (t.steps ?? []).map((s) => s.evidence?.length ?? 0);
    const act = (a.steps ?? []).map((s) => s.evidence ?? 0);
    for (let i = 0; i < Math.max(exp.length, act.length); i++) if ((exp[i] ?? 0) !== (act[i] ?? 0)) mismatches.push({ test: t.testKey, what: `evidenze del passo ${i + 1}`, expected: exp[i] ?? 0, actual: act[i] ?? 0 });
  }
  return mismatches;
}

export async function verify(c, { run, scope = null }) {
  const pub = readPublished(c.ws, c.customer, run);
  const doc = readPayload(c.ws, c.customer, run);
  const scopes = Object.entries(pub.scopes ?? {}).filter(([S, p]) => (!scope || S === scope) && p.execution_key && p.imported_at);
  if (!scopes.length || !doc) throw new XrayError(1, `nulla di pubblicato per ${run}${scope ? ` (scope ${scope})` : ""}: xray publish prima`);
  if (typeof c.adapter.getExecution !== "function") throw new XrayError(1, "l'adattatore non legge le esecuzioni");
  await c.adapter.authenticate();
  const out = [];
  for (const [S, p] of scopes) {
    const back = await c.adapter.getExecution(p.execution_key);
    const expected = doc.executions?.[S]?.results ?? { tests: [] };
    const mismatches = back ? compare(expected, back) : [{ what: "esecuzione non trovata nell'ALM" }];
    out.push({ scope: S, execution_key: p.execution_key, ok: mismatches.length === 0, tests: expected.tests.length, mismatches });
  }
  return { run, ok: out.every((x) => x.ok), executions: out };
}

const HELP = `uso: node scripts/xray/verify.mjs --run <RUN> [--scope S] [--customer C] [--workspace <dir>] [--json] [--help]

Rilegge le Test Execution pubblicate del run e le confronta col payload del dossier: stati e numero di evidenze per
passo. Sola lettura.

Exit code: 0 coerente · 1 argomenti o nulla di pubblicato · 2 errore di sistema · 3 differenze.`;

export async function run(argv, env = process.env) {
  const { opts } = parseArgs(argv);
  const asJson = !!opts.json;
  if (opts.help) { console.log(HELP); return 0; }
  try {
    if (!opts.run) throw new XrayError(1, "richiesto --run <RUN>");
    const c = await xrayContext(opts, env);
    const r = await verify(c, { run: opts.run, scope: opts.scope ?? null });
    console.log(asJson ? JSON.stringify({ ...r }) : r.executions.map((x) => `${x.scope} ${x.execution_key}: ${x.ok ? "coerente" : `${x.mismatches.length} differenze — ${x.mismatches.slice(0, 5).map((m) => `${m.test ?? ""} ${m.what}${m.expected !== undefined ? ` (atteso ${m.expected}, letto ${m.actual})` : ""}`).join("; ")}`}`).join("\n"));
    return r.ok ? 0 : 3;
  } catch (err) { return failWith(asJson, err); }
}

// exitCode, non process.exit: su Windows (Node 24) process.exit dopo più fetch termina il processo con 0xC0000409
if (isMain(import.meta.url)) run(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (e) => { console.error(e); process.exitCode = 2; });
