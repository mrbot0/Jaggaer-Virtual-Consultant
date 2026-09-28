// Parser XSD → documento normalizzato (§19.8: parsing formale, peso 0.95).
// Ogni elemento/attributo è un record `tracciato` con obbligatorietà TECNICA (minOccurs ≥ 1 o use=required),
// tipo, lunghezze, pattern, enumerazioni. Anche usato da parse-spec.mjs per gli schemi dentro i WSDL.
//
//   parseXsd(buffer, { id, title?, source? }) → parsed-doc (sections[].kind = "tracciato", records[])
//   schemaRecords(schemaNode) → [{ kind: "element"|"attribute", name, path, type, min_occurs, max_occurs,
//       required, length?, min_length?, max_length?, pattern?, enumeration?, documentation? }]
//     i complexType con nome sono espansi sotto l'elemento che li usa (profondità ≤ 12, niente cicli).
// CLI: node scripts/ingest/parse-xsd.mjs --in <file.xsd> [--id <id>] [--out <file.json>] [--json]
import { parseXml, local, kids, kid, find, textOf, attr, XmlError } from "./lib/xml.mjs";
import { newDoc, newSection, finishDoc, oneLine, ParseError, sha256 } from "./lib/parsed.mjs";
import { runParserCli } from "./lib/cli.mjs";

export const TRACCIATO_HEADERS = ["Elemento", "Percorso", "Tipo", "Obbligatorio", "Min", "Max", "Lunghezza", "Pattern", "Valori ammessi", "Note"];
const bare = (q) => (q ? String(q).replace(/^[^:]*:/, "") : null);

function restrictions(node) {
  const out = {};
  const r = find(node, "restriction")[0];
  if (!r) return out;
  if (!out.base) out.base = bare(attr(r, "base"));
  for (const c of kids(r)) {
    const n = local(c.name), v = attr(c, "value");
    if (n === "length") out.length = Number(v);
    else if (n === "minLength") out.min_length = Number(v);
    else if (n === "maxLength") out.max_length = Number(v);
    else if (n === "pattern") out.pattern = v;
    else if (n === "enumeration") (out.enumeration ??= []).push(v);
    else if (n === "totalDigits") out.total_digits = Number(v);
    else if (n === "fractionDigits") out.fraction_digits = Number(v);
  }
  return out;
}

export function schemaRecords(schema) {
  const complex = new Map(kids(schema, "complexType").map((c) => [attr(c, "name"), c]));
  const simple = new Map(kids(schema, "simpleType").map((c) => [attr(c, "name"), c]));
  const globals = new Map(kids(schema, "element").map((e) => [attr(e, "name"), e]));
  const groups = new Map(kids(schema, "group").map((g) => [attr(g, "name"), g]));
  const records = [];
  const doc = (n) => oneLine(textOf(find(n, "documentation")[0] ?? null)) || undefined;

  const expandComplex = (ct, path, depth, seen) => {
    if (!ct || depth > 12) return;
    const ext = find(ct, "extension")[0];
    if (ext) { const base = complex.get(bare(attr(ext, "base"))); if (base && !seen.has(base)) expandComplex(base, path, depth + 1, new Set([...seen, base])); }
    const visit = (node) => {
      for (const c of kids(node)) {
        const n = local(c.name);
        if (n === "element") element(c, path, depth + 1, seen);
        else if (n === "attribute") attribute(c, path);
        else if (n === "group" && attr(c, "ref")) { const g = groups.get(bare(attr(c, "ref"))); if (g) visit(g); }
        else if (["sequence", "all", "choice", "complexContent", "simpleContent", "extension", "restriction"].includes(n)) visit(c);
      }
    };
    visit(ct);
  };
  const attribute = (a, path) => {
    const name = attr(a, "name") ?? bare(attr(a, "ref")) ?? "";
    const st = kid(a, "simpleType") ?? simple.get(bare(attr(a, "type")));
    records.push({ kind: "attribute", name, path: `${path}/@${name}`, type: bare(attr(a, "type")) ?? restrictions(st ?? { children: [] }).base ?? "string",
      min_occurs: attr(a, "use") === "required" ? 1 : 0, max_occurs: "1", required: attr(a, "use") === "required", ...stripBase(restrictions(st ?? { children: [] })), documentation: doc(a) });
  };
  const stripBase = ({ base, ...rest }) => rest;
  const element = (e, parentPath, depth, seen) => {
    let el = e;
    if (attr(e, "ref")) el = globals.get(bare(attr(e, "ref"))) ?? e;
    const name = attr(el, "name") ?? bare(attr(e, "ref")) ?? "";
    const path = `${parentPath}/${name}`;
    const min = Number(attr(e, "minOccurs") ?? 1);
    const max = attr(e, "maxOccurs") ?? "1";
    const typeName = bare(attr(el, "type"));
    const inlineCt = kid(el, "complexType");
    const namedCt = typeName ? complex.get(typeName) : null;
    const st = kid(el, "simpleType") ?? (typeName ? simple.get(typeName) : null);
    const r = restrictions(st ?? { children: [] });
    records.push({ kind: "element", name, path, type: typeName ?? (inlineCt ? "complex" : r.base ?? "string"), min_occurs: min, max_occurs: String(max),
      required: min >= 1 && attr(e, "nillable") !== "true", ...stripBase(r), documentation: doc(el) });
    const ct = inlineCt ?? namedCt;
    if (ct && !seen.has(ct)) expandComplex(ct, path, depth, new Set([...seen, ct]));
  };
  for (const e of globals.values()) element(e, "", 0, new Set());
  if (!globals.size) for (const [name, ct] of complex) expandComplex(ct, `/${name}`, 0, new Set([ct]));
  return records.map((r) => Object.fromEntries(Object.entries(r).filter(([, v]) => v !== undefined)));
}

export function recordRow(r) {
  const len = r.length ?? (r.max_length !== undefined ? `${r.min_length ?? 0}..${r.max_length}` : "");
  return [r.name, r.path, r.type ?? "", r.required ? "Sì" : "No", String(r.min_occurs ?? ""), String(r.max_occurs ?? ""), String(len ?? ""), r.pattern ?? "", (r.enumeration ?? []).join("; "), r.documentation ?? ""];
}

// Sezioni per elemento di primo livello: il tracciato di un messaggio resta insieme.
export function tracciatoSections(records, { prefix = "xsd", titlePrefix = "Tracciato" } = {}) {
  const byTop = new Map();
  for (const r of records) {
    const top = r.path.split("/")[1] ?? r.name;
    if (!byTop.has(top)) byTop.set(top, []);
    byTop.get(top).push(r);
  }
  let n = 0;
  return [...byTop].map(([top, list]) => {
    const s = newSection({ path: `${prefix}-${++n}`, title: `${titlePrefix} ${top}`, level: 1 });
    s.kind = "tracciato";
    s.records = list;
    s.tables.push({ caption: `tracciato ${top}`, headers: TRACCIATO_HEADERS, rows: list.map(recordRow) });
    return s;
  });
}

export function parseXsd(buffer, { id, title, source = null } = {}) {
  let root;
  try { root = parseXml(Buffer.isBuffer(buffer) ? buffer.toString("utf8") : String(buffer)); } catch (e) { throw new ParseError(`XSD non leggibile: ${e.message}`, { residue: "unsupported" }); }
  if (local(root.name) !== "schema") throw new ParseError(`radice ${root.name}: non è uno schema XSD`, { residue: "unsupported" });
  const doc = newDoc({ id, title: title ?? `Schema ${attr(root, "targetNamespace") ?? id}`, format: "xsd", source, parser: "parse-xsd" });
  doc.meta.sha256 = sha256(Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer)));
  doc.meta.kind_hint = "spec-integrazione";
  const records = schemaRecords(root);
  doc.sections.push(...tracciatoSections(records));
  const versions = find(root, "schema").length;
  if (versions > 0) doc.warnings.push("schemi annidati: versioni multiple nello stesso file");
  return finishDoc(doc);
}

export const parse = parseXsd;
runParserCli(import.meta.url, { name: "parse-xsd", ext: ".xsd", parse: parseXsd, errors: [XmlError] });
