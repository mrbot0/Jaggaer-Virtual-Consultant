// Parser delle specifiche formali di interfaccia: WSDL, OpenAPI (JSON/YAML), JSON Schema → documento
// normalizzato con sezioni `tracciato` (§19.8: peso 0.95, obbligatorietà TECNICA).
//
//   parseSpec(buffer, { id, title?, source? }) → parsed-doc
//     WSDL      servizi, porte e indirizzi; operazioni (input/output); schemi in <types> (come parse-xsd)
//     OpenAPI   operazioni (metodo, percorso, operationId, parametri con required), corpo delle richieste e
//               components.schemas (proprietà con required, tipo, formato, lunghezze, pattern, enum)
//     JSON Schema proprietà annidate con required
// CLI: node scripts/ingest/parse-spec.mjs --in <file.wsdl|json|yaml> [--id <id>] [--out <file.json>] [--json]
import YAML from "yaml";
import { parseXml, local, kids, kid, find, attr, XmlError } from "./lib/xml.mjs";
import { newDoc, newSection, finishDoc, oneLine, ParseError, sha256 } from "./lib/parsed.mjs";
import { schemaRecords, tracciatoSections, TRACCIATO_HEADERS, recordRow } from "./parse-xsd.mjs";
import { runParserCli } from "./lib/cli.mjs";

const bare = (q) => (q ? String(q).replace(/^[^:]*:/, "") : null);

function wsdl(root, doc) {
  const ops = [];
  for (const pt of find(root, "portType")) for (const op of kids(pt, "operation")) {
    ops.push({ kind: "operation", name: attr(op, "name") ?? "", port_type: attr(pt, "name") ?? null,
      input: bare(attr(kid(op, "input"), "message")), output: bare(attr(kid(op, "output"), "message")), fault: bare(attr(kid(op, "fault"), "message")) });
  }
  const services = find(root, "service").flatMap((s) => kids(s, "port").map((p) => ({ kind: "endpoint", name: `${attr(s, "name")}/${attr(p, "name")}`, binding: bare(attr(p, "binding")),
    address: attr(kid(p, "address"), "location") ?? null })));
  const sec = newSection({ path: "operazioni", title: "Operazioni del servizio", level: 1 });
  sec.kind = "tracciato";
  sec.records = [...services, ...ops];
  sec.tables.push({ caption: "operazioni", headers: ["Operazione", "PortType", "Input", "Output", "Fault"], rows: ops.map((o) => [o.name, o.port_type ?? "", o.input ?? "", o.output ?? "", o.fault ?? ""]) });
  if (services.length) sec.paragraphs.push(...services.map((s) => `Endpoint ${s.name}: ${s.address ?? "indirizzo non dichiarato"} (binding ${s.binding ?? "?"})`));
  doc.sections.push(sec);
  const schemas = find(root, "schema");
  schemas.forEach((s, i) => doc.sections.push(...tracciatoSections(schemaRecords(s), { prefix: `types${schemas.length > 1 ? i + 1 : ""}` })));
  if (schemas.length > 1) doc.warnings.push("più schemi in <types>: versioni o namespace multipli nello stesso file");
}

function jsonSchemaRecords(schema, root, path = "", depth = 0, out = [], requiredHere = null) {
  if (!schema || typeof schema !== "object" || depth > 12) return out;
  if (schema.$ref && typeof schema.$ref === "string" && schema.$ref.startsWith("#/")) {
    const target = schema.$ref.slice(2).split("/").reduce((a, k) => a?.[k.replace(/~1/g, "/").replace(/~0/g, "~")], root);
    return jsonSchemaRecords(target, root, path, depth + 1, out, requiredHere);
  }
  for (const k of ["allOf", "anyOf", "oneOf"]) for (const s of schema[k] ?? []) jsonSchemaRecords(s, root, path, depth + 1, out, requiredHere);
  const req = new Set(Array.isArray(schema.required) ? schema.required : []);
  for (const [name, p] of Object.entries(schema.properties ?? {})) {
    const pp = p?.$ref ? { ...p, ...(p.$ref.slice(2).split("/").reduce((a, k) => a?.[k], root) ?? {}) } : p ?? {};
    const rec = { kind: "property", name, path: `${path}/${name}`, type: pp.type ? String(pp.type) : pp.properties ? "object" : p?.$ref ? bare(p.$ref.split("/").pop()) : "any",
      min_occurs: req.has(name) ? 1 : 0, max_occurs: pp.type === "array" ? "unbounded" : "1", required: req.has(name) };
    if (pp.format) rec.format = pp.format;
    if (pp.maxLength !== undefined) rec.max_length = pp.maxLength;
    if (pp.minLength !== undefined) rec.min_length = pp.minLength;
    if (pp.pattern) rec.pattern = pp.pattern;
    if (Array.isArray(pp.enum)) rec.enumeration = pp.enum.map(String);
    if (pp.description) rec.documentation = oneLine(pp.description);
    out.push(rec);
    jsonSchemaRecords(pp.type === "array" ? pp.items : pp, root, rec.path, depth + 1, out);
  }
  return out;
}

function openapi(spec, doc) {
  const ops = [];
  for (const [p, item] of Object.entries(spec.paths ?? {})) for (const [method, op] of Object.entries(item ?? {})) {
    if (!/^(get|post|put|patch|delete|head|options)$/i.test(method)) continue;
    const params = [...(item.parameters ?? []), ...(op.parameters ?? [])];
    ops.push({ kind: "operation", name: op.operationId ?? `${method.toUpperCase()} ${p}`, method: method.toUpperCase(), path: p,
      summary: op.summary ? oneLine(op.summary) : null, parameters: params.map((x) => ({ name: x.name, in: x.in, required: !!x.required })) });
  }
  const sec = newSection({ path: "operazioni", title: "Operazioni (OpenAPI)", level: 1 });
  sec.kind = "tracciato";
  sec.records = ops;
  sec.tables.push({ caption: "operazioni", headers: ["Operazione", "Metodo", "Percorso", "Parametri obbligatori", "Descrizione"],
    rows: ops.map((o) => [o.name, o.method, o.path, o.parameters.filter((x) => x.required).map((x) => `${x.name} (${x.in})`).join(", "), o.summary ?? ""]) });
  doc.sections.push(sec);
  const schemas = spec.components?.schemas ?? spec.definitions ?? {};
  let n = 0;
  for (const [name, s] of Object.entries(schemas)) {
    const recs = jsonSchemaRecords(s, spec, `/${name}`);
    if (!recs.length) continue;
    const ss = newSection({ path: `schema-${++n}`, title: `Tracciato ${name}`, level: 1 });
    ss.kind = "tracciato";
    ss.records = recs;
    ss.tables.push({ caption: `tracciato ${name}`, headers: TRACCIATO_HEADERS, rows: recs.map(recordRow) });
    doc.sections.push(ss);
  }
}

export function parseSpec(buffer, { id, title, source = null } = {}) {
  const text = Buffer.isBuffer(buffer) ? buffer.toString("utf8") : String(buffer);
  const t = text.replace(/^[^<{a-zA-Z]*/, "");
  let doc;
  if (t.startsWith("<")) {
    let root;
    try { root = parseXml(text); } catch (e) { throw new ParseError(`WSDL non leggibile: ${e.message}`, { residue: "unsupported" }); }
    if (local(root.name) === "schema") throw new ParseError("è uno schema XSD: usare parse-xsd", { residue: "unsupported" });
    if (local(root.name) !== "definitions" && local(root.name) !== "description") throw new ParseError(`radice ${root.name}: non è un WSDL`, { residue: "unsupported" });
    doc = newDoc({ id, title: title ?? `Servizio ${attr(root, "name") ?? id}`, format: "wsdl", source, parser: "parse-spec" });
    wsdl(root, doc);
  } else {
    let spec;
    try { spec = t.startsWith("{") ? JSON.parse(t) : YAML.parse(text); } catch (e) { throw new ParseError(`specifica non leggibile: ${e.message}`, { residue: "unsupported" }); }
    if (!spec || typeof spec !== "object") throw new ParseError("specifica vuota", { residue: "unsupported" });
    if (spec.openapi || spec.swagger) {
      doc = newDoc({ id, title: title ?? spec.info?.title ?? id, format: "openapi", source, parser: "parse-spec" });
      if (spec.info?.version) doc.version = String(spec.info.version);
      openapi(spec, doc);
    } else if (spec.$schema || spec.properties || spec.type === "object") {
      doc = newDoc({ id, title: title ?? spec.title ?? id, format: "json", source, parser: "parse-spec" });
      const recs = jsonSchemaRecords(spec, spec, "");
      const s = newSection({ path: "schema-1", title: `Tracciato ${spec.title ?? "JSON Schema"}`, level: 1 });
      s.kind = "tracciato";
      s.records = recs;
      s.tables.push({ caption: "tracciato", headers: TRACCIATO_HEADERS, rows: recs.map(recordRow) });
      doc.sections.push(s);
    } else throw new ParseError("né OpenAPI né JSON Schema", { residue: "unsupported" });
  }
  doc.meta.sha256 = sha256(Buffer.from(text));
  doc.meta.kind_hint = "spec-integrazione";
  return finishDoc(doc);
}

export const parse = parseSpec;
runParserCli(import.meta.url, { name: "parse-spec", ext: ".wsdl", parse: parseSpec, errors: [XmlError] });
