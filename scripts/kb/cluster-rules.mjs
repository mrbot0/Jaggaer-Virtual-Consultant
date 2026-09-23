// Le dieci regole per creare un cluster (§7.3), una funzione pura per regola.
// Ogni funzione restituisce { rule, ok, reason } (+ skipped: true quando la
// regola non è applicabile, con il motivo). Nessun I/O: il chiamante passa il
// contesto (cluster della famiglia, membri, catalogo).
import Ajv2020 from "ajv/dist/2020.js";
import { readFileSync } from "node:fs";

const ajv = new Ajv2020({ allErrors: true, strict: false });
const validateSchema = ajv.compile(JSON.parse(readFileSync(new URL("../../schemas/cluster.schema.json", import.meta.url), "utf8")));

// Le famiglie di §7.2 (più CL-FLD-CHAIN e CL-FLD-MAND di §19.6.3).
export const KNOWN_FAMILIES = new Set(["CL-SYS", "CL-KNW", "CL-PRO", "CL-CUS", "CL-ERP", "CL-CFG", "CL-UIB", "CL-INT", "CL-CHK",
  "CL-ERR", "CL-PRT", "CL-RSK", "CL-LRN", "CL-ANL", "CL-DEC", "CL-EPI", "CL-STR", "CL-FLD", "CL-FLD-CHAIN", "CL-FLD-MAND"]);
export const VALIDATED_STATES = new Set(["validato", "clusterizzato", "promosso"]);
export const ANALYSIS_TYPES = new Set(["PAT", "PBK", "BRF", "RUL"]);
const FACET_RE = /^F([1-9]|1[0-5])$/;
const FIELD_RE = /^[a-z_][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)*$/;
const PORTABILITY = new Set(["universale", "condizionata", "specifica", "ignota"]);
// Una "parola" contiene almeno una lettera o cifra: frecce e segni ("→", "·")
// non contano (es. "CdC → ordine → ERP → fattura" = 4 parole).
const words = (s) => String(s ?? "").trim().split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
const res = (rule, ok, reason, extra = {}) => ({ rule, ok, reason, ...extra });

export function validateCluster(c) {
  if (validateSchema(c)) return { ok: true, errors: [] };
  return { ok: false, errors: validateSchema.errors.map((e) => `${e.instancePath || "/"} ${e.message}`) };
}

export function jaccard(a, b) {
  const A = new Set(a);
  const B = new Set(b);
  const union = new Set([...A, ...B]).size;
  if (union === 0) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / union;
}

// Chiave canonica di un criterio, per confrontare cluster senza membri.
export function criterionKey(c) {
  const v = Array.isArray(c.value) ? [...c.value].map(String).sort().join("|") : c.value === undefined ? "" : String(c.value);
  return `${c.facet ? `facet:${c.facet}` : `field:${c.field}`}:${c.op}:${v}`;
}

export function isCheckable(c) {
  if (!c || typeof c !== "object") return false;
  if (c.facet !== undefined) return FACET_RE.test(c.facet) && ["eq", "in", "neq"].includes(c.op) && c.value !== undefined && (c.op !== "in" || Array.isArray(c.value));
  if (c.field !== undefined) {
    if (!FIELD_RE.test(c.field) || !["exists", "eq", "in"].includes(c.op)) return false;
    if (c.op === "exists") return true;
    return c.value !== undefined && (c.op !== "in" || Array.isArray(c.value));
  }
  return false;
}

function getPath(obj, path) {
  let cur = obj;
  for (const k of path.split(".")) {
    if (cur === null || typeof cur !== "object" || !Object.prototype.hasOwnProperty.call(cur, k)) return { present: false };
    cur = cur[k];
  }
  return { present: true, value: cur };
}
const eqValue = (actual, expected) => (Array.isArray(actual) ? actual.map(String).includes(String(expected)) : String(actual) === String(expected));
const inValue = (actual, list) => list.some((x) => eqValue(actual, x));

// true · false · null (indeterminato: faccetta assente, o campo dichiarato
// con valore null = "non so"). Un campo non dichiarato non soddisfa eq/in.
export function evaluateCriterion(c, item) {
  if (c.facet !== undefined) {
    const facets = item?.facets ?? {};
    if (!Object.prototype.hasOwnProperty.call(facets, c.facet) || facets[c.facet] === null) return null;
    const v = facets[c.facet];
    if (c.op === "eq") return eqValue(v, c.value);
    if (c.op === "in") return inValue(v, c.value);
    if (c.op === "neq") return !eqValue(v, c.value);
    return null;
  }
  const { present, value } = getPath(item ?? {}, c.field);
  if (c.op === "exists") return present && value !== null && value !== undefined;
  if (!present) return false;
  if (value === null) return null;
  if (c.op === "eq") return eqValue(value, c.value);
  if (c.op === "in") return inValue(value, c.value);
  return null;
}

function matchesSignature(item, signature) {
  const facets = item?.facets ?? {};
  return Object.entries(signature).every(([f, v]) => {
    if (!Object.prototype.hasOwnProperty.call(facets, f)) return false;
    return Array.isArray(v) ? inValue(facets[f], v) : eqValue(facets[f], v);
  });
}
export function facetSignatureCoverage(members, signature) {
  if (!members?.length) return 0;
  return members.filter((m) => matchesSignature(m, signature)).length / members.length;
}
export { matchesSignature };

// ——— le dieci regole ———
export function rc01(c, { familyClusters = [] } = {}) {
  if (!String(c.code ?? "").startsWith(`${c.family}-`)) return res("RC-01", false, `il codice ${c.code} non appartiene alla famiglia ${c.family}`);
  if (KNOWN_FAMILIES.has(c.family)) return res("RC-01", true, `famiglia esistente ${c.family}`);
  const n = new Set(familyClusters.filter((x) => x.family === c.family).map((x) => x.code)).size;
  return n >= 3 ? res("RC-01", true, `famiglia nuova con ${n} cluster candidati`) : res("RC-01", false, `famiglia nuova ${c.family} con ${n} candidati (servono ≥ 3)`);
}

export function rc02(c) {
  const nw = words(c.name);
  const dw = words(c.definition);
  if (!nw || nw > 6) return res("RC-02", false, `nome di ${nw} parole (≤ 6)`);
  if (!/^Insieme degli item che\b/i.test(String(c.definition ?? "").trim())) return res("RC-02", false, "la definizione deve iniziare con 'Insieme degli item che'");
  if (dw > 40) return res("RC-02", false, `definizione di ${dw} parole (≤ 40)`);
  return res("RC-02", true, `nome ${nw} parole, definizione ${dw} parole`);
}

export function rc03(c) {
  const inc = c.inclusion ?? [];
  const exc = c.exclusion ?? [];
  if (inc.length < 2) return res("RC-03", false, `${inc.length} criteri di inclusione (≥ 2)`);
  if (exc.length < 1) return res("RC-03", false, "nessun criterio di esclusione (≥ 1)");
  const bad = [...inc, ...exc].find((x) => !isCheckable(x));
  if (bad) return res("RC-03", false, `criterio non verificabile su faccette o contenuto strutturato: ${JSON.stringify(bad)}`);
  return res("RC-03", true, `${inc.length} inclusione, ${exc.length} esclusione, tutti verificabili`);
}

export function rc04(c, { members = [] } = {}) {
  if (c.status === "bootstrap") return res("RC-04", true, "cluster di bootstrap: i membri validati arrivano dalla prima digestione", { skipped: true });
  const n = members.filter((m) => VALIDATED_STATES.has(m?.facets?.F12)).length;
  return n >= 3 ? res("RC-04", true, `${n} membri validati`) : res("RC-04", false, `${n} membri validati (≥ 3)`);
}

export function rc05(c, { familyClusters = [], members = [] } = {}) {
  const others = familyClusters.filter((x) => x.family === c.family && x.code !== c.code);
  const ownIds = members.map((m) => m.id ?? m.code ?? m);
  const ownKeys = (c.inclusion ?? []).map(criterionKey);
  let worst = { j: 0, code: null, basis: "criteri" };
  for (const o of others) {
    const useMembers = ownIds.length > 0 && (o.members?.length ?? 0) > 0;
    const j = useMembers ? jaccard(ownIds, o.members) : jaccard(ownKeys, (o.inclusion ?? []).map(criterionKey));
    if (j > worst.j) worst = { j, code: o.code, basis: useMembers ? "membri" : "criteri" };
  }
  const pct = Math.round(worst.j * 100);
  return worst.j < 0.5
    ? res("RC-05", true, `Jaccard massimo ${pct}% (${worst.basis}${worst.code ? `, ${worst.code}` : ""})`)
    : res("RC-05", false, `Jaccard ${pct}% con ${worst.code} sui ${worst.basis} (< 50%)`);
}

export function rc06(c, { members = [] } = {}) {
  if (!members.length) return res("RC-06", true, "nessun membro: firma non verificabile (bootstrap)", { skipped: true });
  const cov = facetSignatureCoverage(members, c.facet_signature ?? {});
  const pct = Math.round(cov * 100);
  return cov >= 0.8 ? res("RC-06", true, `la firma copre il ${pct}% dei membri`) : res("RC-06", false, `la firma copre il ${pct}% dei membri (≥ 80%)`);
}

export function rc07(c, { catalog = [] } = {}) {
  if (!Number.isInteger(c.depth) || c.depth < 1 || c.depth > 3) return res("RC-07", false, `profondità ${c.depth} (1..3)`);
  if (!c.parent) return c.depth === 1 ? res("RC-07", true, "profondità 1") : res("RC-07", false, `profondità ${c.depth} senza genitore`);
  const p = catalog.find((x) => x.code === c.parent);
  if (!p) return res("RC-07", false, `genitore ${c.parent} inesistente`);
  return c.depth === p.depth + 1 ? res("RC-07", true, `profondità ${c.depth} sotto ${p.code}`) : res("RC-07", false, `profondità ${c.depth} incoerente con il genitore (${p.depth})`);
}

export function rc08(c) {
  return typeof c.owner === "string" && /^[a-z][a-z0-9-]+$/.test(c.owner)
    ? res("RC-08", true, `responsabile ${c.owner}`)
    : res("RC-08", false, "serve un solo agente responsabile (nome kebab-case)");
}

export function rc09(c) {
  const p = c.portability ?? {};
  if (!PORTABILITY.has(p.class)) return res("RC-09", false, `classe di portabilità '${p.class}' non valida`);
  if (p.class !== "condizionata") return res("RC-09", true, `portabilità ${p.class}`);
  if (!p.condition || !/\bF([1-9]|1[0-5])\b|\bCL-[A-Z]{3}/.test(p.condition)) return res("RC-09", false, "condizionata senza faccetta condizionante (Fn o CL-…)");
  return res("RC-09", true, `condizionata da ${p.condition}`);
}

export function rc10(c, { members = [] } = {}) {
  if (typeof c.domain !== "string" || !["kb", "analysis"].includes(c.domain)) return res("RC-10", false, "serve un solo dominio: kb o analysis");
  const wrong = members.find((m) => {
    const type = m.type ?? String(m.id ?? "").split(".")[3];
    return c.domain === "kb" ? ANALYSIS_TYPES.has(type) : !ANALYSIS_TYPES.has(type);
  });
  if (wrong) return res("RC-10", false, `il membro ${wrong.id} appartiene all'altro dominio`);
  return res("RC-10", true, `dominio ${c.domain}`);
}

export const RULES = [rc01, rc02, rc03, rc04, rc05, rc06, rc07, rc08, rc09, rc10];

export function checkCluster(cluster, { familyClusters = [], members = [], catalog = [] } = {}) {
  const ctx = { familyClusters, members, catalog };
  const results = RULES.map((f) => f(cluster, ctx));
  return { code: cluster.code, ok: results.every((r) => r.ok), results };
}
