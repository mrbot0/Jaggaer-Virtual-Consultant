// Il draft dichiarato negli schemi è 2020-12: l'export di default di ajv non
// include quel meta-schema, serve la build dedicata "ajv/dist/2020.js".
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { readFileSync } from "node:fs";
import YAML from "yaml";
import { isValidCode } from "./codes.mjs";
import { fldErrors } from "./validate-fld.mjs";
import { isMain } from "../lib/is-main.mjs";
import { validateWith } from "../lib/schemas.mjs";

const load = (f) => JSON.parse(readFileSync(new URL(`../../schemas/${f}`, import.meta.url), "utf8"));
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addSchema(load("facets.schema.json"), "facets.schema.json");
const validateBase = ajv.compile(load("item.base.schema.json"));
// ACT: parte specifica del catalogo delle azioni (§29.4, schemas/act.schema.json).
const validateAct = ajv.compile(load("act.schema.json"));
// DOC: profilo del documento (§19.7, schemas/doc.schema.json — WP09a)
const validateDoc = ajv.compile(load("doc.schema.json"));
const words = (s) => (s || "").trim().split(/\s+/).filter(Boolean).length;

// WP09b: schemi di tipo (§5.5, §5.6, §27.1, §28, §64), agganciati per `type` (modifica minima). I casi NRT.* hanno il
// loro schema (nrt-case.schema.json) e la loro grammatica del codice NRT.<CLIENTE>.<SCOPE>.<GENERE>.<SEQ>, fuori dal registro.
export const TYPE_SCHEMAS = Object.freeze({ SEL: "sel.schema.json", HND: "hnd.schema.json", CHK: "chk.schema.json", CFP: "cfp.schema.json",
  FLW: "flw.schema.json", KEY: "key.schema.json", LCY: "lcy.schema.json", INT: "int.schema.json", CFG: "cfg.schema.json" });
const fmtErr = (e) => `${e.instancePath || "/"} ${e.message}${e.params?.missingProperty ? ` (${e.params.missingProperty})` : ""}${e.params?.allowedValues ? ` (${e.params.allowedValues.join(" ")})` : ""}`;
export const NRT_ID_RE = /^NRT\.(STD|[A-Z0-9]{4})\.([A-Z0-9]{3})\.(POS|NEG|INT|HND|BSL|CFG|SMK|OPS)\.(\d{4})$/;

export function validateCase(obj) {
  const v = validateWith("nrt-case.schema.json", obj);
  const errors = v.raw.filter((e) => e.keyword !== "if").map(fmtErr);
  const m = NRT_ID_RE.exec(String(obj?.id ?? ""));
  if (m && obj?.scope && m[2] !== obj.scope) errors.push(`id: lo scope del codice (${m[2]}) non coincide con scope (${obj.scope})`);
  if (m && obj?.genre && m[3] !== obj.genre) errors.push(`id: il genere del codice (${m[3]}) non coincide con genre (${obj.genre})`);
  const steps = Array.isArray(obj?.composition?.steps) ? obj.composition.steps : [];
  const stop = obj?.boundary?.stop_at_step;
  if (Number.isInteger(stop) && steps.length && !steps.some((s) => s?.n === stop)) errors.push(`boundary.stop_at_step: il passo ${stop} non è nella composizione`);
  if (words(obj?.summary) > 60) errors.push("summary: oltre 60 parole");
  return { ok: errors.length === 0, errors };
}

export function validateItem(obj) {
  if (obj?.type === "NRT" || /^NRT\./.test(String(obj?.id ?? ""))) return validateCase(obj);
  const errors = [];
  if (!validateBase(obj)) errors.push(...validateBase.errors.map((e) => `${e.instancePath || "/"} ${e.message}${e.params?.missingProperty ? ` (${e.params.missingProperty})` : ""}`));
  if (obj?.id && !isValidCode(obj.id)) errors.push("id: codice non valido per livello/tipo/scope");
  const limit = obj?.type === "FLD" ? 20 : 60;
  if (words(obj?.summary) > limit) errors.push(`summary: oltre ${limit} parole`);
  // FLD: parte specifica di schemas/fld.schema.json e regole di grafo (scripts/kb/validate-fld.mjs)
  if (obj?.type === "FLD") for (const e of fldErrors(obj)) if (!e.startsWith("summary:") && !errors.includes(e)) errors.push(e);
  if (obj?.type === "ACT" && !validateAct(obj)) for (const e of validateAct.errors) if (e.keyword !== "if") errors.push(`${e.instancePath || "/"} ${e.message}${e.params?.missingProperty ? ` (${e.params.missingProperty})` : ""}${e.params?.allowedValue !== undefined ? ` (atteso ${JSON.stringify(e.params.allowedValue)})` : ""}`);
  if (TYPE_SCHEMAS[obj?.type]) {
    for (const e of validateWith(TYPE_SCHEMAS[obj.type], obj).raw) {
      if (e.keyword === "if") continue;
      const m = fmtErr(e);
      if (!errors.includes(m)) errors.push(m);
    }
  }
  if (obj?.type === "DOC" && !validateDoc(obj)) for (const e of validateDoc.errors) errors.push(`${e.instancePath || "/"} ${e.message}${e.params?.missingProperty ? ` (${e.params.missingProperty})` : ""}`);
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
