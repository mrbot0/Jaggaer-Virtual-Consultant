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
  FLW: "flw.schema.json", KEY: "key.schema.json", LCY: "lcy.schema.json", INT: "int.schema.json", CFG: "cfg.schema.json",
  // WP09d: Analytics (§20.3, §20.5, §20.6)
  TBL: "tbl.schema.json", QRY: "qry.schema.json", DIN: "din.schema.json", USR: "usr.schema.json", PSP: "psp.schema.json", ERR: "err.schema.json",
  // WP09d: dominio analitico (§1.1, F8, F10)
  PAT: "pat.schema.json", PBK: "pbk.schema.json", BRF: "brf.schema.json", RUL: "rul.schema.json",
  // Revisione finale (§44.7 "un JSON Schema per ogni tipo del registro"): profilo e mappa di processo (prodotti dagli
  // agenti), strategia e ambiente come item, e gli schemi minimi dei tipi che non ne avevano uno.
  PRF: "prf.schema.json", PMP: "pmp.schema.json", STR: "str.schema.json", ENV: "env.schema.json",
  CAP: "cap.schema.json", INV: "inv.schema.json", GLS: "gls.schema.json", OBS: "obs.schema.json", CTR: "ctr.schema.json",
  EVD: "evd.schema.json", DEC: "dec.schema.json", EPI: "epi.schema.json" });

// Lo schema di OGNI tipo del registro (test "ogni tipo del registro ha uno schema"): i TYPE_SCHEMAS applicati qui sopra,
// FLD/ACT/DOC applicati in validateItem con i loro validatori, e i tipi che non sono item di kb/ e che i loro script
// validano alla scrittura: LSN (lesson), CLS (cluster-rules), DT (dt-eval), RPT (build-report); UNT (unit.schema.json,
// la forma prodotta da segmentUnits, verificata dai test di ingestion).
export const SCHEMA_FOR_TYPE = Object.freeze({ ...TYPE_SCHEMAS, FLD: "fld.schema.json", ACT: "act.schema.json", DOC: "doc.schema.json",
  UNT: "unit.schema.json", LSN: "lesson.schema.json", CLS: "cluster.schema.json", DT: "dt.schema.json", RPT: "rpt.schema.json",
  // TPL (spec 2026-10-06 §3.8): template di caricamento massivo, item di kb/ senza busta title/summary/facets (non indicizzato)
  TPL: "tpl.schema.json" });

// WP09d (§20.5.5): DIN e USR non conservano valori che identificano qualcuno. Oltre allo schema (values_retained: none,
// gruppo minimo 20): nessun indirizzo email in nessun valore; nessun campo chiamato come nomi/email/codici/utenti/valori
// con un elenco di valori; nessun gruppo aggregato (n/count/size) sotto 20.
export const MIN_GROUP = 20;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/;
const IDENTIFYING_KEY = /(^|_)(names?|full_?names?|emails?|e_?mails?|mails?|users?|user_?names?|usernames?|user_?ids?|persons?|people|suppliers?|supplier_?names?|vendors?|codes?|ids|values|top_values|sample_values|samples|examples|document_?numbers?|doc_?numbers?|phones?|telefon[oi])$/i;
// giro 1 (m10): mappe indicizzate per valore (istogrammi, quote per ruolo o motivo): nessuna chiave identificativa (email,
// numeri di ≥ 5 cifre, mappe chiamate come persone/fornitori/documenti) e, nei DIN, nessun secchio con quota × popolazione
// sotto 20 (la popolazione di un values_histogram è la parte compilata del campione).
const PERSON_MAP_KEY = /(^|_)(names?|full_?names?|emails?|e_?mails?|mails?|users?|user_?names?|usernames?|user_?ids?|persons?|people|suppliers?|supplier_?names?|vendors?|document_?numbers?|doc_?numbers?|phones?)$/i;
const IDENTIFYING_BUCKET = /@|\d{5,}/;
const isShareMap = (v) => v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length >= 2 && Object.values(v).every((x) => typeof x === "number" && x >= 0 && x <= 1);
function mapErrors(obj) {
  const out = [];
  const size = obj?.type === "DIN" && Number.isFinite(Number(obj?.sample?.size)) ? Number(obj.sample.size) : null;
  const walk = (v, path, base) => {
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${path}/${i}`, x && typeof x === "object" && typeof x.fill_rate === "number" && base != null ? base * x.fill_rate : base)); return; }
    if (!v || typeof v !== "object") return;
    for (const [k, x] of Object.entries(v)) {
      if (x && typeof x === "object" && !Array.isArray(x)) {
        if (PERSON_MAP_KEY.test(k) && Object.keys(x).length) out.push(`${path}/${k}: mappa indicizzata da valori identificativi (persone, fornitori, documenti)`);
        if (isShareMap(x)) for (const [bucket, share] of Object.entries(x)) {
          if (IDENTIFYING_BUCKET.test(bucket)) out.push(`${path}/${k}: chiave identificativa "${bucket.slice(0, 40)}" (valori identificativi mai conservati)`);
          if (base != null && share > 0 && share * base < MIN_GROUP) out.push(`${path}/${k}/${bucket}: gruppo di circa ${Math.round(share * base)} < ${MIN_GROUP} (nessun aggregato su gruppi piccoli)`);
        }
      }
      walk(x, `${path}/${k}`, base);
    }
  };
  walk(obj, "", size);
  return out;
}

export function privacyErrors(obj) {
  const out = mapErrors(obj);
  const walk = (v, path) => {
    if (typeof v === "string") { if (EMAIL.test(v)) out.push(`${path}: indirizzo email (valore identificativo, §20.5.5)`); return; }
    if (Array.isArray(v)) {
      v.forEach((x, i) => {
        if (x && typeof x === "object" && !Array.isArray(x)) for (const k of ["n", "count", "size"]) if (typeof x[k] === "number" && x[k] < MIN_GROUP) out.push(`${path}/${i}: gruppo di ${x[k]} < ${MIN_GROUP} (nessun aggregato su gruppi piccoli)`);
        walk(x, `${path}/${i}`);
      });
      return;
    }
    if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) {
      if (IDENTIFYING_KEY.test(k) && Array.isArray(x) && x.some((e) => typeof e === "string" || typeof e === "number")) out.push(`${path}/${k}: elenco di valori identificativi (solo distribuzioni e quote)`);
      walk(x, `${path}/${k}`);
    }
  };
  walk(obj, "");
  return out;
}
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
  if (obj?.type === "TPL") {
    const errors = validateWith(SCHEMA_FOR_TYPE.TPL, obj).raw.filter((e) => e.keyword !== "if").map(fmtErr);
    if (obj.id && !isValidCode(obj.id)) errors.push("id: codice non valido per livello/tipo/scope");
    return { ok: errors.length === 0, errors };
  }
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
  if (obj?.type === "DIN" || obj?.type === "USR") for (const e of privacyErrors(obj)) if (!errors.includes(e)) errors.push(e);
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
