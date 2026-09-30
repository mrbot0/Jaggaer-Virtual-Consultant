// learn brief --scope (§56.7, §1.1, F8, M18) — WP09d. Il BRF per scope e livello: i pattern più frequenti dello scope,
// i loro playbook e un testo breve per il digester (la funzione del digester su analysis/). Livello C: i PAT/PBK del
// cliente; livello S: i PAT/PBK di product/analysis (già pseudonimizzati). Mai citazioni di test (§1.1).
import { resolve, join } from "node:path";
import { loadAnalysis, writeAnalysisItem, facetsFor, rootOf, AnalysisError } from "./common.mjs";
import { REGISTRY } from "../kb/codes.mjs";
import { parseArgs, fail } from "../lib/args.mjs";
import { isMain } from "../lib/is-main.mjs";

export const TOP = 5;

export function buildBrief({ patterns, playbooks, scope, level, top = TOP }) {
  const total = patterns.reduce((a, p) => a + (p.occurrences ?? 0), 0);
  const ranked = [...patterns].sort((a, b) => (b.occurrences ?? 0) - (a.occurrences ?? 0) || a.id.localeCompare(b.id)).slice(0, top);
  const byPattern = new Map(playbooks.map((b) => [b.pattern, b]));
  const topPatterns = ranked.map((p) => ({ pattern: p.id, occurrences: p.occurrences, share: total ? Math.round((p.occurrences / total) * 100) / 100 : 0, symptom: p.symptom }));
  const lines = [`Scope ${scope} (livello ${level}): ${patterns.length} pattern da ${total} ticket.`];
  ranked.forEach((p, i) => {
    const c = p.chain ?? {};
    const pb = byPattern.get(p.id);
    lines.push(`${i + 1}. ${p.symptom} — ${p.occurrences} ticket (${Math.round((topPatterns[i].share ?? 0) * 100)}%).` +
      `${c.root_cause?.value ? ` Causa radice: ${c.root_cause.value}.` : " Causa radice ignota."}` +
      `${c.resolution?.value ? ` Risoluzione: ${c.resolution.value}.` : ""}${pb ? ` Playbook ${pb.id}.` : ""}`);
  });
  if (!ranked.length) lines.push("Nessun pattern: nessun ticket importato per questo scope.");
  return { top_patterns: topPatterns, playbooks: ranked.map((p) => byPattern.get(p.id)?.id).filter(Boolean), text: lines.join("\n").slice(0, 4000), tickets_total: total };
}

export function brief(ws, { customer = null, scope, level = "C", top = TOP }) {
  if (!REGISTRY.scopes.includes(scope)) throw new AnalysisError(1, `scope non valido: ${scope}`);
  if (level === "C" && !customer) throw new AnalysisError(1, "il livello C richiede --customer");
  const root = rootOf(ws, level, customer);
  const patterns = loadAnalysis(root, "PAT", { scope });
  const playbooks = loadAnalysis(root, "PBK", { scope });
  const b = buildBrief({ patterns, playbooks, scope, level, top });
  return writeAnalysisItem(ws, { level, customer, scope, type: "BRF" }, (code) => ({
    id: code, type: "BRF", title: `Briefing ${scope} (${level === "S" ? "prodotto" : customer})`, summary: `I ${b.top_patterns.length} pattern più frequenti dello scope ${scope} e i loro playbook.`,
    facets: facetsFor("BRF"), sources: b.top_patterns.length ? b.top_patterns.map((p) => ({ pattern: p.pattern })) : [{ note: "nessun pattern" }],
    scope_ref: scope, level, audience: "configuratore", ...b,
  }));
}

export const HELP = `uso: learn brief --scope <S> [--customer <C> | --level S] [--top 5] [--workspace <dir>] [--json]

BRF per scope e livello (§1.1, F8): i pattern più frequenti, i playbook e il testo del briefing per il digester.
Livello C (default) dai PAT/PBK di customers/<C>/analysis; livello S da product/analysis (pseudonimizzato).

Exit code: 0 ok · 1 errore d'uso · 2 errore di sistema · 3 confine dei domini violato.`;

export function run(argv, env = process.env) {
  const { opts } = parseArgs(argv);
  const asJson = !!opts.json;
  if (opts.help) { console.log(HELP); return 0; }
  const ws = resolve(opts.workspace || env.JVC_WORKSPACE || env.CLAUDE_PROJECT_DIR || process.cwd());
  try {
    const r = brief(ws, { customer: opts.customer ?? null, scope: opts.scope, level: opts.level ?? "C", top: opts.top ? Number(opts.top) : TOP });
    console.log(asJson ? JSON.stringify({ ok: true, code: r.code, file: r.file, brief: r.obj }) : r.obj.text);
    return 0;
  } catch (err) {
    if (err instanceof AnalysisError) return fail(asJson, err.code, err.message);
    return fail(asJson, 2, `errore di sistema: ${err?.message ?? err}`);
  }
}

if (isMain(import.meta.url)) process.exitCode = run(process.argv.slice(2));
