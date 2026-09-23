import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { isMain } from "../lib/is-main.mjs";

function* walk(d) { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) yield* walk(p); else if (/\.(ya?ml|md)$/.test(e.name)) yield p; } }
// Esportate: guard-domain-boundary usa le stesse regole sul contenuto in scrittura.
export const BOUNDARY_RULES = [
  { dir: "kb", re: /analysis\//, rule: "kb referenzia analysis/" },
  { dir: "kb", re: /\b[SCL]\.[A-Z0-9]{3,4}\.[A-Z0-9]{3}\.(PAT|PBK|BRF|RUL)\.\d{4}\b|\b(INC|TICKET|PAT)-\d+/, rule: "kb cita un identificatore analitico" },
  { dir: "analysis", re: /\bNRT\.[A-Z0-9]{3,4}\.[A-Z0-9]{3}\.[A-Z]{3}\.\d{4}\b|\bNRT-[A-Z]+-\d+/, rule: "analysis referenzia un test" },
];
export function checkBoundary(root) {
  const out = [];
  for (const r of BOUNDARY_RULES) { const dir = join(root, r.dir); if (!existsSync(dir)) continue;
    for (const f of walk(dir)) { const m = r.re.exec(readFileSync(f, "utf8")); if (m) out.push({ file: relative(root, f), rule: r.rule, match: m[0] }); } }
  return out;
}

function printHelp() {
  console.log(`uso: node scripts/kb/validate-boundary.mjs [<root>] [--json] [--help]

Verifica che kb/ non citi analysis/ né identificatori PAT/PBK/BRF/RUL, e
che analysis/ non citi identificatori di test NRT.* (§1.1, §5.4).

Exit code: 0 nessuna violazione · 1 errore utente (percorso non valido) ·
3 violazione di policy (§44.5).`);
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.includes("--help")) { printHelp(); process.exit(0); }
  const asJson = args.includes("--json");
  const root = args.find((a) => !a.startsWith("--")) ?? ".";
  if (!existsSync(root)) {
    const msg = `percorso non trovato: ${root}`;
    console.log(asJson ? JSON.stringify({ ok: false, error: msg }) : `errore: ${msg}`);
    process.exit(1);
  }
  const v = checkBoundary(root);
  if (asJson) console.log(JSON.stringify({ ok: v.length === 0, violations: v }));
  else for (const x of v) console.error(`✗ ${x.file}: ${x.rule} → "${x.match}"`);
  process.exit(v.length ? 3 : 0);
}
