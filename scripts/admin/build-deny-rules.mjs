// Compila policy/deny-rules.yaml in hooks/lib/generated/deny-rules.mjs: guard-destructive non carica il modulo yaml
// (~40 ms) a ogni chiamata. La copia vale solo se l'impronta del YAML coincide (hooks/lib/deny-rules.mjs), quindi un
// YAML cambiato senza rigenerare è comunque applicato (percorso lento), mai ignorato.
// Uso: node scripts/admin/build-deny-rules.mjs [--check] [--help]   (--check: exit 1 se non allineato)
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { isMain } from "../lib/is-main.mjs";
import { POLICY_FILE, policySha, normalizeDoc, compileRules } from "../../hooks/lib/deny-rules.mjs";

export const GENERATED = fileURLToPath(new URL("../../hooks/lib/generated/deny-rules.mjs", import.meta.url));

export function generate() {
  const text = readFileSync(POLICY_FILE, "utf8");
  const norm = normalizeDoc(YAML.parse(text));
  compileRules(norm);   // ogni regex deve compilare: un pattern rotto è un errore di build
  const out = { sha256: policySha(text), ...norm };
  return `// GENERATO da scripts/admin/build-deny-rules.mjs a partire da policy/deny-rules.yaml: non modificare.\nexport default ${JSON.stringify(out, null, 2)};\n`;
}

if (isMain(import.meta.url)) {
  if (process.argv.includes("--help")) {
    console.log("uso: node scripts/admin/build-deny-rules.mjs [--check]\nCompila policy/deny-rules.yaml in hooks/lib/generated/deny-rules.mjs. Exit: 0 ok · 1 non allineato (--check) · 2 errore.");
    process.exit(0);
  }
  try {
    const code = generate();
    if (process.argv.includes("--check")) {
      let cur = "";
      try { cur = readFileSync(GENERATED, "utf8"); } catch { /* assente */ }
      if (cur !== code) { console.error("deny-rules generato non allineato: node scripts/admin/build-deny-rules.mjs"); process.exit(1); }
      console.log("ok");
    } else {
      mkdirSync(dirname(GENERATED), { recursive: true });
      writeFileSync(GENERATED, code);
      console.log(`scritto ${GENERATED}`);
    }
  } catch (err) { console.error(`errore: ${err.message}`); process.exit(2); }
}
