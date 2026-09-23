// Carta d'identità del dato (§19.20) in forma compatta, e i campi da completare.
//
//   identityCoverage(identity) → { blocks_covered, missing_blocks[], null_attributes[] }
//     un blocco è coperto se è un oggetto con almeno un attributo non nullo; null_attributes
//     elenca gli attributi dichiarati ma null ("datatype.precision").
//   identityCard(db, code) → { code, label, technical_name, document, section, field_type,
//                              coverage, quality, blocks: { <blocco>: "k=v · k=v" } }
//   identityMissing(db, { doc, missing }) → [{ code, label, summary }]
//     i FLD del documento senza il blocco (`kb identity --doc requisition --missing system_of_record`).
import { IDENTITY_BLOCKS } from "./validate-fld.mjs";
import { InvalidInputError, NotFoundError } from "./fields.mjs";

const isScalar = (v) => v === null || ["string", "number", "boolean"].includes(typeof v);

function flatten(obj, prefix = "") {
  const pairs = [];
  for (const [k, v] of Object.entries(obj ?? {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v === null || v === undefined) continue;
    if (Array.isArray(v)) { if (v.length) pairs.push(`${key}=${v.map((x) => (isScalar(x) ? String(x) : Object.values(x).filter(isScalar).join("/"))).join(",")}`); }
    else if (typeof v === "object") pairs.push(...flatten(v, key));
    else pairs.push(`${key}=${v}`);
  }
  return pairs;
}
function nullAttrs(obj, prefix) {
  const out = [];
  for (const [k, v] of Object.entries(obj ?? {})) {
    const key = `${prefix}.${k}`;
    if (v === null) out.push(key);
    else if (v && typeof v === "object" && !Array.isArray(v)) out.push(...nullAttrs(v, key));
  }
  return out;
}
const covered = (b) => !!b && typeof b === "object" && flatten(b).length > 0;

export function identityCoverage(identity) {
  const id = identity && typeof identity === "object" ? identity : {};
  const missing_blocks = IDENTITY_BLOCKS.filter((b) => !covered(id[b]));
  return { blocks_covered: IDENTITY_BLOCKS.length - missing_blocks.length, missing_blocks,
    null_attributes: IDENTITY_BLOCKS.flatMap((b) => (id[b] && typeof id[b] === "object" ? nullAttrs(id[b], b) : [])) };
}

export function identityCard(db, code) {
  const r = db.prepare("select code, label_it, label_en, technical_name, document, section, field_type, identity, identity_quality from fields where code = ?").get(code);
  if (!r) throw new NotFoundError(`campo inesistente: ${code}`);
  const identity = r.identity ? JSON.parse(r.identity) : null;
  const blocks = {};
  for (const b of IDENTITY_BLOCKS) if (covered(identity?.[b])) blocks[b] = flatten(identity[b]).join(" · ");
  return { code: r.code, label: r.label_it ?? r.label_en, technical_name: r.technical_name, document: r.document, section: r.section, field_type: r.field_type,
    coverage: identityCoverage(identity), quality: r.identity_quality ? JSON.parse(r.identity_quality) : null, blocks };
}

export function identityMissing(db, { doc, missing } = {}) {
  if (!IDENTITY_BLOCKS.includes(missing)) throw new InvalidInputError(`--missing: uno dei blocchi ${IDENTITY_BLOCKS.join(", ")}`);
  if (!doc) throw new InvalidInputError("--missing richiede --doc <documento>");
  const rows = db.prepare(`select f.code, coalesce(f.label_it, f.label_en) as label, i.summary, f.identity from fields f join items i on i.code = f.code
    where i.status <> 'deprecato' and (f.document = ? or f.document = 'document.' || ?) order by f.section, f.code`).all(doc, doc);
  return rows.filter((r) => !covered(r.identity ? JSON.parse(r.identity)[missing] : null)).map(({ identity, ...rest }) => rest);
}
