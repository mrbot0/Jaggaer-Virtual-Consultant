// Compila scripts/chrome/error-patterns.yaml in hooks/lib/generated/error-patterns.mjs: observe-append
// non carica il modulo yaml (~40 ms) a ogni chiamata. Come il validatore di session.json.
// Uso: node scripts/chrome/build-error-patterns.mjs [--check]  (--check: exit 1 se non allineato)
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { isMain } from "../lib/is-main.mjs";

export const SOURCE = fileURLToPath(new URL("./error-patterns.yaml", import.meta.url));
export const GENERATED = fileURLToPath(new URL("../../hooks/lib/generated/error-patterns.mjs", import.meta.url));

export function generate() {
  const doc = YAML.parse(readFileSync(SOURCE, "utf8"));
  // ogni regex deve compilare: un pattern rotto è un errore di build, non un errore a runtime
  for (const src of [doc.code, doc.success, doc.error_text, ...doc.categories.flatMap((c) => [c.it, c.en])]) new RegExp(src, "iu");
  const out = { version: doc.version, kinds: doc.kinds, code: doc.code, success: doc.success, error_text: doc.error_text,
    categories: doc.categories.map((c) => ({ id: c.id, blocking: c.blocking !== false, it: c.it, en: c.en })) };
  return `// GENERATO da scripts/chrome/build-error-patterns.mjs a partire da scripts/chrome/error-patterns.yaml: non modificare.\nexport default ${JSON.stringify(out, null, 2)};\n`;
}

if (isMain(import.meta.url)) {
  const code = generate();
  if (process.argv.includes("--check")) {
    let cur = "";
    try { cur = readFileSync(GENERATED, "utf8"); } catch { /* assente */ }
    if (cur !== code) { console.error("error-patterns generato non allineato: node scripts/chrome/build-error-patterns.mjs"); process.exit(1); }
    console.log("ok");
  } else {
    mkdirSync(dirname(GENERATED), { recursive: true });
    writeFileSync(GENERATED, code);
    console.log(`scritto ${GENERATED}`);
  }
}
