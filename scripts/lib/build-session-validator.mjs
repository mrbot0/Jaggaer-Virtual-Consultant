// Genera hooks/lib/generated/session-validate.mjs: il validatore Ajv di
// schemas/session.schema.json compilato in anticipo (Ajv "standalone").
// Gli hook lo usano per il predicato "stato leggibile e coerente" senza pagare
// ~100 ms di caricamento e compilazione di Ajv a ogni chiamata di guard.
// Uso: node scripts/lib/build-session-validator.mjs [--check]
// (--check: exit 1 se il file generato non corrisponde allo schema attuale;
// lo stesso controllo gira nei test).
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isMain } from "./is-main.mjs";
import { activeWorkspace } from "./dev-only.mjs";

const require = createRequire(import.meta.url);
export const GENERATED = fileURLToPath(new URL("../../hooks/lib/generated/session-validate.mjs", import.meta.url));
const SCHEMA = new URL("../../schemas/session.schema.json", import.meta.url);

export function generate() {
  const Ajv2020 = require("ajv/dist/2020.js");
  const addFormats = require("ajv-formats");
  const standalone = require("ajv/dist/standalone").default;
  const ajv = new (Ajv2020.default ?? Ajv2020)({ allErrors: true, strict: false, code: { source: true, esm: true } });
  (addFormats.default ?? addFormats)(ajv);
  const validate = ajv.compile(JSON.parse(readFileSync(SCHEMA, "utf8")));
  let code = standalone(ajv, validate);
  // Ajv emette `require(...)` anche in modalità esm: diventano import ESM.
  const imports = [];
  code = code.replace(/require\("([^"]+)"\)/g, (_m, mod) => {
    const name = `__dep${imports.length}`;
    imports.push(`import ${name} from "${mod.endsWith(".js") ? mod : `${mod}.js`}";`);
    return name;
  });
  code = code.replace(/^"use strict";/, "");
  return `// GENERATO da scripts/lib/build-session-validator.mjs — non modificare a mano.\n// Sorgente: schemas/session.schema.json.\n${imports.join("\n")}\n${code}\n`;
}

if (isMain(import.meta.url)) {
  // WP08 giro 1 (I1): i moduli generati del plugin si riscrivono solo nel repository del plugin, mai dentro un workspace JVC
  if (!process.argv.includes("--check") && !process.argv.includes("--help")) {
    const ws = activeWorkspace(fileURLToPath(new URL("../..", import.meta.url)));
    if (ws) { console.error(`rifiutato: esecuzione dentro il workspace JVC ${ws}; si rigenera solo nel repository del plugin`); process.exit(3); }
  }
  const code = generate();
  if (process.argv.includes("--check")) {
    let cur = "";
    try { cur = readFileSync(GENERATED, "utf8"); } catch { /* assente */ }
    if (cur !== code) { console.error("session-validate.mjs non aggiornato: rigeneralo"); process.exit(1); }
    console.log("session-validate.mjs aggiornato");
  } else {
    mkdirSync(dirname(GENERATED), { recursive: true });
    writeFileSync(GENERATED, code);
    console.log(`scritto ${GENERATED}`);
  }
}
