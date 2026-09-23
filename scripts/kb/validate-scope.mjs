import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import YAML from "yaml";
import { parseCode } from "./codes.mjs";
import { isMain } from "../lib/is-main.mjs";

export function checkScope(root) {
  const out = []; const base = join(root, "kb", "scopes"); if (!existsSync(base)) return out;
  for (const s of readdirSync(base)) { if (s.startsWith("_")) continue;
    const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.ya?ml$/.test(e.name)) {
      const obj = YAML.parse(readFileSync(p, "utf8")); const c = obj?.id ? parseCode(obj.id) : null;
      if (c && c.scope !== s) out.push({ file: relative(root, p), rule: `scope del codice (${c.scope}) ≠ cartella (${s})` }); } } };
    walk(join(base, s)); }
  return out;
}

function printHelp() {
  console.log(`uso: node scripts/kb/validate-scope.mjs [<root>] [--json] [--help]

Verifica che lo scope codificato nell'id di ogni item sotto kb/scopes/<S>
coincida con la cartella <S> che lo contiene (§5).

Exit code: 0 nessuna violazione · 1 violazioni trovate.`);
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.includes("--help")) { printHelp(); process.exit(0); }
  const asJson = args.includes("--json");
  const root = args.find((a) => !a.startsWith("--")) ?? ".";
  const v = checkScope(root);
  if (asJson) console.log(JSON.stringify({ ok: v.length === 0, violations: v }));
  else for (const x of v) console.error(`✗ ${x.file}: ${x.rule}`);
  process.exit(v.length ? 1 : 0);
}
