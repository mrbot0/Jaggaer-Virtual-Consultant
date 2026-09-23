// Il draft dichiarato negli schemi è 2020-12: l'export di default di ajv non
// include quel meta-schema, serve la build dedicata "ajv/dist/2020.js".
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { readFileSync } from "node:fs";
import YAML from "yaml";
import { isValidCode } from "./codes.mjs";
import { fldErrors } from "./validate-fld.mjs";
import { isMain } from "../lib/is-main.mjs";

const load = (f) => JSON.parse(readFileSync(new URL(`../../schemas/${f}`, import.meta.url), "utf8"));
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addSchema(load("facets.schema.json"), "facets.schema.json");
const validateBase = ajv.compile(load("item.base.schema.json"));
// ACT: parte specifica del catalogo delle azioni (§29.4, schemas/act.schema.json).
const validateAct = ajv.compile(load("act.schema.json"));
const words = (s) => (s || "").trim().split(/\s+/).filter(Boolean).length;

export function validateItem(obj) {
  const errors = [];
  if (!validateBase(obj)) errors.push(...validateBase.errors.map((e) => `${e.instancePath || "/"} ${e.message}${e.params?.missingProperty ? ` (${e.params.missingProperty})` : ""}`));
  if (obj?.id && !isValidCode(obj.id)) errors.push("id: codice non valido per livello/tipo/scope");
  const limit = obj?.type === "FLD" ? 20 : 60;
  if (words(obj?.summary) > limit) errors.push(`summary: oltre ${limit} parole`);
  // FLD: parte specifica di schemas/fld.schema.json e regole di grafo (scripts/kb/validate-fld.mjs)
  if (obj?.type === "FLD") for (const e of fldErrors(obj)) if (!e.startsWith("summary:") && !errors.includes(e)) errors.push(e);
  if (obj?.type === "ACT" && !validateAct(obj)) for (const e of validateAct.errors) if (e.keyword !== "if") errors.push(`${e.instancePath || "/"} ${e.message}${e.params?.missingProperty ? ` (${e.params.missingProperty})` : ""}${e.params?.allowedValue !== undefined ? ` (atteso ${JSON.stringify(e.params.allowedValue)})` : ""}`);
  return { ok: errors.length === 0, errors };
}

function printHelp() {
  console.log(`uso: node scripts/kb/validate-schema.mjs <file...> [--json] [--help]

Valida uno o più file YAML di item della knowledge base contro lo schema
base e le quindici faccette (§6.1, §8.3 della spec).

Exit code: 0 ok · 1 errore utente (item invalido) · 2 errore di sistema.`);
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.length === 0) { printHelp(); process.exit(args.length === 0 ? 1 : 0); }
  const asJson = args.includes("--json");
  const files = args.filter((a) => !a.startsWith("--"));
  let failed = 0;
  const results = [];
  try {
    for (const f of files) {
      const r = validateItem(YAML.parse(readFileSync(f, "utf8")));
      results.push({ file: f, ...r });
      if (!r.ok) { failed++; if (!asJson) console.error(`✗ ${f}\n  ${r.errors.join("\n  ")}`); }
    }
  } catch (err) {
    if (asJson) console.log(JSON.stringify({ ok: false, error: String(err?.message ?? err) }));
    else console.error(`errore di sistema: ${err?.message ?? err}`);
    process.exit(2);
  }
  if (asJson) console.log(JSON.stringify({ ok: failed === 0, results }));
  process.exit(failed ? 1 : 0);
}
