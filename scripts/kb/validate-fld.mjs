// Validazione degli item FLD (§19.6.2, §19.20): schema (schemas/fld.schema.json)
// più le regole di grafo che JSON Schema non esprime.
//
//   validateFld(obj)      → { ok, errors }   item completo: item.base + parte FLD + regole
//   fldErrors(obj)        → [errori]         solo parte FLD + regole (usato da validate-schema
//                                            per gli item di tipo FLD, senza duplicare item.base)
//   hasParsedMandatory(o) → boolean          la regola di obbligatorietà è parsata (kind del
//                                            vocabolario), non testo libero (§19.6.4 passo 6)
//   IDENTITY_BLOCKS                          i dodici blocchi della carta d'identità, in ordine
//
// Regole di grafo:
//   R1 `mandatory.kind: conditional` richiede `when`, `in_states` (non vuota) o `by_role`;
//   R2 `identity.system_of_record` è obbligatorio quando il campo compare in un mapping INT
//      (`lineage.required_by[].ref` di tipo INT, o `mandatory.reason.ref` di tipo INT);
//   R3 al più un cluster di sezione CL-FLD-nnn e al più un CL-FLD-MAND-nnn in `cluster[]`
//      (un FLD appartiene a esattamente uno di ciascuno, §19.6.3: l'unicità nel DB la
//      impone l'ammissione, scripts/kb/cluster.mjs);
//   R4 summary ≤ 20 parole (§8.3).
// Nessun I/O oltre al caricamento degli schemi.
import { validateWith, getValidator } from "../lib/schemas.mjs";
import { isValidCode, parseCode } from "./codes.mjs";
import { isMain } from "../lib/is-main.mjs";
import { readFileSync } from "node:fs";
import YAML from "yaml";

export const IDENTITY_BLOCKS = ["names", "datatype", "domain", "constraints", "structure", "relations", "system_of_record",
  "ownership", "lifecycle", "sensitivity", "errors", "real_data"];
export const MANDATORY_KINDS = ["always", "conditional", "never", "undocumented"];
export const REASON_KINDS = ["integration", "workflow", "legal", "business", "ui", "derived"];
export const FIELD_TYPES = ["text", "number", "date", "lookup", "list", "flag", "file", "table"];

const words = (s) => (s || "").trim().split(/\s+/).filter(Boolean).length;
const nonEmpty = (v) => (Array.isArray(v) ? v.length > 0 : typeof v === "string" ? v.trim() !== "" : v !== null && v !== undefined);
const fmt = (e) => `${e.instancePath || "/"} ${e.message}${e.params?.missingProperty ? ` (${e.params.missingProperty})` : ""}${e.params?.allowedValues ? ` (${e.params.allowedValues.join(", ")})` : ""}`;

export function hasParsedMandatory(obj) {
  const m = obj?.mandatory;
  return !!m && typeof m === "object" && !Array.isArray(m) && MANDATORY_KINDS.includes(m.kind);
}

// Riferimenti INT del campo: i mapping che lo richiedono.
export function intRefs(obj) {
  const refs = new Set();
  for (const r of obj?.lineage?.required_by ?? []) if (parseCode(String(r?.ref ?? ""))?.type === "INT") refs.add(r.ref);
  const rr = obj?.mandatory?.reason?.ref;
  if (typeof rr === "string" && parseCode(rr)?.type === "INT") refs.add(rr);
  return [...refs];
}

export function graphRules(obj) {
  const errors = [];
  const m = obj?.mandatory;
  if (m && typeof m === "object" && m.kind === "conditional" && !nonEmpty(m.when) && !nonEmpty(m.in_states) && !nonEmpty(m.by_role)) {
    errors.push("mandatory: kind conditional richiede when, in_states o by_role (R1)");
  }
  const ints = intRefs(obj);
  if (ints.length && !(obj?.identity?.system_of_record && typeof obj.identity.system_of_record === "object")) {
    errors.push(`identity.system_of_record: obbligatorio, il campo compare nel mapping di ${ints.join(", ")} (R2, §19.20)`);
  }
  const cl = Array.isArray(obj?.cluster) ? obj.cluster : [];
  const sec = cl.filter((c) => /^CL-FLD-\d{3}$/.test(c));
  const mand = cl.filter((c) => /^CL-FLD-MAND-\d{3}$/.test(c));
  if (sec.length > 1) errors.push(`cluster: al più un CL-FLD di sezione (${sec.join(", ")}) (R3)`);
  if (mand.length > 1) errors.push(`cluster: al più un CL-FLD-MAND (${mand.join(", ")}) (R3)`);
  if (words(obj?.summary) > 20) errors.push("summary: oltre 20 parole (R4)");
  return errors;
}

export function fldErrors(obj) {
  const v = getValidator("fld.schema.json#/$defs/fld");
  const errors = v(obj) ? [] : v.errors.map(fmt);
  if (obj?.mandatory !== undefined && !hasParsedMandatory(obj) && !errors.some((e) => e.startsWith("/mandatory"))) {
    errors.push("mandatory: regola non parsata (serve kind; il testo libero va in mandatory_text)");
  }
  return [...errors, ...graphRules(obj)];
}

export function validateFld(obj) {
  const r = validateWith("fld.schema.json", obj);
  const errors = [...r.errors];
  if (obj?.id && !isValidCode(obj.id)) errors.push("id: codice non valido per livello/tipo/scope");
  if (obj?.id && parseCode(obj.id)?.type !== "FLD") errors.push("id: il codice non è di tipo FLD");
  for (const e of graphRules(obj)) if (!errors.includes(e)) errors.push(e);
  return { ok: errors.length === 0, errors: [...new Set(errors)] };
}

const HELP = `uso: node scripts/kb/validate-fld.mjs <file...> [--json] [--help]

Valida item FLD (§19.6.2, §19.20): schemas/fld.schema.json più le regole di grafo
(conditional con condizione, system_of_record per i campi in un mapping INT, al più
un CL-FLD e un CL-FLD-MAND, summary ≤ 20 parole).

Exit code: 0 ok · 1 errore utente (item invalido, file illeggibile) · 2 errore di sistema.`;

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.includes("--help") || !args.length) { console.log(HELP); process.exit(args.length ? 0 : 1); }
  const asJson = args.includes("--json");
  const results = [];
  let failed = 0;
  for (const f of args.filter((a) => !a.startsWith("--"))) {
    let r;
    try { r = validateFld(YAML.parse(readFileSync(f, "utf8"))); } catch (e) { r = { ok: false, errors: [String(e.message ?? e)] }; }
    results.push({ file: f, ...r });
    if (!r.ok) { failed++; if (!asJson) console.error(`✗ ${f}\n  ${r.errors.join("\n  ")}`); }
  }
  if (asJson) console.log(JSON.stringify({ ok: failed === 0, results }));
  process.exit(failed ? 1 : 0);
}
