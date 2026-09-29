// baseline (ADR-15 "baseline dichiarata per i comportamenti non documentati", §27.2 validazione undocumented ⇒ BSL):
// l'atteso di un BSL non si inventa: si registra il comportamento osservato (dichiarato come baseline, con chi l'ha
// accettato) e i run successivi lo confrontano con le tolleranze del caso (stesso diff della corsia integration L1).
//
//   record(ws, { customer, caseId, observed, tolerances?, declaredBy?, reason?, replace?, now }) → baseline
//     customers/<C>/tests/baselines/<caso>.yaml { case, version, recorded_at, declared_by, observed, tolerances, history[] };
//     una baseline esistente si sostituisce solo con replace + reason (la precedente resta in history)
//   compare(ws, { customer, caseId, observed }) → { match, diffs[], version }
//
// CLI: node scripts/run/baseline.mjs record --case <NRT…BSL…> --observed <file.yaml> [--declared-by <nome>] [--replace --reason <testo>]
//      node scripts/run/baseline.mjs compare --case <NRT…> --observed <file.yaml>
// Exit: 0 ok / conforme · 1 errore utente · 2 errore di sistema · 3 difforme dalla baseline.
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import YAML from "yaml";
import { parseArgs, fail } from "../lib/args.mjs";
import { isMain } from "../lib/is-main.mjs";
import { writeFileAtomic } from "../../hooks/lib/fsx.mjs";
import { diffPayload } from "./integration.mjs";
import { workspaceCustomer } from "./fixtures.mjs";
import { confineInputs } from "../lib/text-file.mjs";

export class BaselineError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const NRT_RE = /^NRT\.[A-Z0-9]{3,4}\.[A-Z0-9]{3}\.[A-Z]{3}\.\d{4}$/;
const file = (ws, customer, caseId) => join(ws, "customers", customer, "tests", "baselines", `${caseId}.yaml`);

export function loadBaseline(ws, customer, caseId) {
  const f = file(ws, customer, caseId);
  return existsSync(f) ? YAML.parse(readFileSync(f, "utf8")) : null;
}

export function record(ws, { customer, caseId, observed, tolerances = null, declaredBy = null, reason = null, replace = false, now = new Date() }) {
  if (!NRT_RE.test(String(caseId ?? ""))) throw new BaselineError(1, `codice del caso non valido: ${caseId}`);
  if (observed === undefined || observed === null || typeof observed !== "object") throw new BaselineError(1, "comportamento osservato mancante (--observed <file.yaml>)");
  const prev = loadBaseline(ws, customer, caseId);
  if (prev && !replace) throw new BaselineError(1, `baseline di ${caseId} già registrata (versione ${prev.version}): --replace --reason per sostituirla`);
  if (prev && !reason) throw new BaselineError(1, "sostituire una baseline richiede --reason (perché il comportamento atteso è cambiato)");
  const b = {
    case: caseId, version: (prev?.version ?? 0) + 1, recorded_at: now.toISOString(), declared_by: declaredBy, observed,
    tolerances: tolerances ?? prev?.tolerances ?? {}, note: "ADR-15: comportamento non documentato, dichiarato come baseline (non un atteso inventato)",
    history: [...(prev?.history ?? []), ...(prev ? [{ version: prev.version, recorded_at: prev.recorded_at, declared_by: prev.declared_by, observed: prev.observed, replaced_because: reason }] : [])],
  };
  const f = file(ws, customer, caseId);
  mkdirSync(join(f, ".."), { recursive: true });
  writeFileAtomic(f, YAML.stringify(b));
  return b;
}

export function compare(ws, { customer, caseId, observed, tolerances = null }) {
  const b = loadBaseline(ws, customer, caseId);
  if (!b) throw new BaselineError(1, `nessuna baseline registrata per ${caseId} (baseline record)`);
  const r = diffPayload(b.observed, observed, tolerances ?? b.tolerances ?? {});
  return { ...r, version: b.version, case: caseId };
}

const HELP = `uso: node scripts/run/baseline.mjs record --case <NRT…> --observed <file.yaml> [--declared-by <nome>] [--replace --reason <testo>]
       node scripts/run/baseline.mjs compare --case <NRT…> --observed <file.yaml>
       Opzioni: [--customer C] [--workspace <dir>] [--json] [--help]
Baseline dei comportamenti non documentati (ADR-15): registrazione dichiarata e confronto con tolleranze.
Exit code: 0 ok / conforme · 1 errore utente · 2 errore di sistema · 3 difforme dalla baseline.`;

export function run(argv, env = process.env) {
  const { opts, positional } = parseArgs(argv, { flags: ["replace"] });
  const asJson = !!opts.json;
  const [cmd] = positional;
  if (opts.help || !cmd) { console.log(HELP); return opts.help ? 0 : 1; }
  { const bad = confineInputs(opts, ["observed"], { env }); if (bad) return fail(asJson, 1, bad); }
  const { ws, customer } = workspaceCustomer(opts, env);
  if (!customer) return fail(asJson, 1, "cliente non determinato: --customer <C>");
  try {
    const observed = opts.observed ? YAML.parse(readFileSync(resolvePath(opts.observed), "utf8")) : null;
    if (cmd === "record") {
      const b = record(ws, { customer, caseId: opts.case, observed, declaredBy: opts["declared-by"] ?? null, reason: opts.reason ?? null, replace: !!opts.replace });
      console.log(asJson ? JSON.stringify({ ok: true, baseline: b }) : `baseline ${b.case} v${b.version} registrata`);
      return 0;
    }
    if (cmd === "compare") {
      const r = compare(ws, { customer, caseId: opts.case, observed });
      console.log(asJson ? JSON.stringify({ ok: r.match, ...r }) : r.match ? `conforme alla baseline v${r.version}` : r.diffs.map((d) => `${d.kind} ${d.path}`).join("\n"));
      return r.match ? 0 : 3;
    }
    return fail(asJson, 1, `comando sconosciuto: ${cmd}`);
  } catch (err) {
    if (err instanceof BaselineError) return fail(asJson, err.code, err.message);
    return fail(asJson, 2, `errore di sistema: ${err?.message ?? err}`);
  }
}

if (isMain(import.meta.url)) process.exit(run(process.argv.slice(2)));
