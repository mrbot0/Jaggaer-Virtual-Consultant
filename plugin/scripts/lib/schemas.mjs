// Validatori JSON Schema 2020-12 caricati a richiesta. Ajv costa ~60 ms fra
// caricamento e compilazione: gli hook che importano moduli con validazione
// (session.mjs, agent-report.mjs) non lo pagano finché non validano davvero.
// Stesso schema di scripts/kb/validate-schema.mjs (Ajv2020 + ajv-formats).
import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";

const require = createRequire(import.meta.url);
const SCHEMA_DIR = new URL("../../schemas/", import.meta.url);
let ajv = null;
const cache = new Map();

export const loadSchema = (name) => JSON.parse(readFileSync(new URL(name, SCHEMA_DIR), "utf8"));

function instance() {
  if (ajv) return ajv;
  const Ajv2020 = require("ajv/dist/2020.js");
  const addFormats = require("ajv-formats");
  ajv = new (Ajv2020.default ?? Ajv2020)({ allErrors: true, strict: false });
  (addFormats.default ?? addFormats)(ajv);
  // Registra tutti gli schemi JSON della cartella per risolvere i $ref fra file.
  for (const f of readdirSync(SCHEMA_DIR).filter((x) => x.endsWith(".schema.json"))) {
    const s = loadSchema(f);
    if (!ajv.getSchema(s.$id ?? f)) ajv.addSchema(s, s.$id ?? f);
  }
  return ajv;
}

export function getValidator(name) {
  if (!cache.has(name)) {
    const a = instance();
    cache.set(name, a.getSchema(name) ?? a.compile(loadSchema(name)));
  }
  return cache.get(name);
}

const fmt = (e) => `${e.instancePath || "/"} ${e.message}${e.params?.missingProperty ? ` (${e.params.missingProperty})` : ""}`;

export function validateWith(name, obj) {
  const v = getValidator(name);
  const ok = v(obj);
  return { ok: !!ok, errors: ok ? [] : v.errors.map(fmt), raw: ok ? [] : v.errors };
}
