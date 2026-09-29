// Rapporto del sub-agente (§46.2): estrazione dal messaggio finale e
// validazione con status effettivo. Usato da subagent-trace (SubagentStop) e
// dal manager. Regole di riclassificazione:
//  - self_check.failed non vuoto (o passed sotto i controlli della profondità: rapida 4, altrimenti 10) con status ok ⇒ partial (Review Focus 4; WP10b giro 1)
//  - open_questions non vuote con status ok ⇒ partial (§17.1 #10)
//  - rapporto invalido ⇒ partial (il manager non lo tratta mai come ok)
import { readFileSync } from "node:fs";
import YAML from "yaml";
import { validateWith } from "../lib/schemas.mjs";
import { isMain } from "../lib/is-main.mjs";
import { parseArgs, fail } from "../lib/args.mjs";
import { reportedControlsFor } from "../decide/self-check-controls.mjs";

const asObject = (text) => {
  try {
    const v = YAML.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch { return null; }
};

// Ultimo blocco ```yaml del messaggio; in assenza, YAML in coda a partire
// dall'ultima riga `task_id:`.
export function extractReport(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  const t = text.replace(/\r\n/g, "\n");
  const blocks = [...t.matchAll(/```ya?ml[ \t]*\n([\s\S]*?)\n?```/g)];
  if (blocks.length) return asObject(blocks[blocks.length - 1][1]);
  const idx = t.search(/^task_id:.*$(?![\s\S]*^task_id:)/m);
  return idx >= 0 ? asObject(t.slice(idx)) : null;
}

function missingFrom(raw) {
  const out = [];
  for (const e of raw) {
    if (e.keyword !== "required") continue;
    const base = e.instancePath.replace(/^\//, "").replace(/\//g, ".");
    out.push(base ? `${base}.${e.params.missingProperty}` : e.params.missingProperty);
  }
  return [...new Set(out)];
}

export function validateReport(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return { ok: false, errors: ["rapporto assente o non YAML"], missing: ["rapporto"], status_effective: "partial", reclassified: ["rapporto assente"] };
  }
  const v = validateWith("agent-report.schema.json", obj);
  const missing = missingFrom(v.raw);
  if (!v.ok) {
    const invalid = v.raw.filter((e) => e.keyword !== "required" && e.keyword !== "if" && e.instancePath).map((e) => e.instancePath.replace(/^\//, "").replace(/\//g, "."));
    return { ok: false, errors: v.errors, missing, invalid: [...new Set(invalid)], status_effective: "partial", reclassified: ["rapporto non valido"] };
  }
  let status = obj.status;
  const reclassified = [];
  if (status === "ok") {
    const sc = obj.cognitive_trace?.self_check;
    // giro 1 WP10b (I3): `passed` si giudica sull'insieme di controlli della profondità dichiarata (rapida 1, 3, 9, 11 = 4;
    // standard e profonda 1–10), la stessa fonte di self-check.mjs; failed non vuoto ⇒ partial sempre.
    const expected = reportedControlsFor(obj.cognitive_trace?.depth).length;
    if (sc && (sc.failed?.length > 0 || sc.passed < expected)) reclassified.push(`self_check ${sc.passed}/${expected}, falliti: ${JSON.stringify(sc.failed ?? [])}`);
    if (Array.isArray(obj.open_questions) && obj.open_questions.length > 0) reclassified.push(`open_questions: ${obj.open_questions.length}`);
    if (reclassified.length) status = "partial";
  }
  return { ok: true, errors: [], missing: [], status_effective: status, reclassified };
}

const HELP = `uso: node scripts/admin/agent-report.mjs <file> [--json] [--help]

Estrae il rapporto finale di un sub-agente (ultimo blocco \`\`\`yaml, o YAML in coda)
e lo valida contro schemas/agent-report.schema.json (§46.2). Riporta lo status
effettivo: self_check.failed non vuoto, passed sotto i controlli della profondità (rapida 4,
altrimenti 10) o open_questions con status ok ⇒ partial.

Exit code: 0 rapporto valido · 1 rapporto assente/invalido o file illeggibile · 2 errore di sistema.`;

if (isMain(import.meta.url)) {
  const { opts, positional } = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(HELP); process.exit(0); }
  if (!positional[0]) process.exit(fail(!!opts.json, 1, "file del rapporto mancante"));
  let text;
  try { text = readFileSync(positional[0], "utf8"); } catch (err) { process.exit(fail(!!opts.json, 1, `file illeggibile: ${err.code ?? err.message}`)); }
  try {
    const report = extractReport(text);
    const r = validateReport(report);
    if (opts.json) console.log(JSON.stringify({ ok: r.ok, task_id: report?.task_id ?? null, status: report?.status ?? null, ...r }));
    else console.log(r.ok ? `valido · status effettivo ${r.status_effective}${r.reclassified.length ? ` (${r.reclassified.join("; ")})` : ""}` : `non valido: ${r.errors.join("; ")}`);
    process.exit(r.ok ? 0 : 1);
  } catch (err) { process.exit(fail(!!opts.json, 2, `errore di sistema: ${err?.message ?? err}`)); }
}
