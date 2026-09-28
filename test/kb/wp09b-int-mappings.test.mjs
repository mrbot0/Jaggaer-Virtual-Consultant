// WP09b carry 1: INT mappings[].field = codice FLD; field_ref (id grezzo dell'estrazione) accettato solo se è già un codice
// FLD e convertito da normalizeIntMappings; obbligatorietà uno-fra di una xs:choice sul lato del mapping (one_of) —
// schema INT, lineage.required_by del FLD, chains.mjs ed extract.mjs allineati.
import { test } from "node:test";
import assert from "node:assert/strict";
import { lineageRelations, chains, normalizeIntMappings } from "../../scripts/kb/chains.mjs";
import { validateItem } from "../../scripts/kb/validate-schema.mjs";
import { parseXsd } from "../../scripts/ingest/parse-xsd.mjs";
import { segmentUnits } from "../../scripts/ingest/segment.mjs";
import { extractDocument } from "../../scripts/ingest/extract.mjs";
import { int, FACETS } from "../helpers/wp09b-items.mjs";

const XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:element name="Order">
    <xs:complexType><xs:sequence>
      <xs:element name="OrderNumber" type="xs:string"/>
      <xs:choice>
        <xs:element name="SupplierId" type="xs:string"/>
        <xs:element name="SupplierCode" type="xs:string"/>
      </xs:choice>
      <xs:element name="Note" type="xs:string" minOccurs="0"/>
    </xs:sequence></xs:complexType>
  </xs:element>
</xs:schema>`;

test("extract: il mapping INT porta one_of { group, required } per i rami di una xs:choice obbligatoria (mandatory false), e il FLD lo riceve in lineage.required_by", () => {
  const doc = parseXsd(Buffer.from(XSD), { id: "order", title: "order.xsd" });
  const units = segmentUnits(doc).units;
  const s = extractDocument(doc, units, { profile: { id: "S.STD.XSC.DOC.0009", kind: "spec-integrazione", genre: "tecnica", facets: { F1: "spec-integrazione-formale" } } });
  const intC = s.items.find((x) => x.candidates[0] === "INT");
  const byTarget = Object.fromEntries(intC.extraction.mappings.map((m) => [m.target, m]));
  assert.equal(byTarget["/Order/OrderNumber"].mandatory, true);
  assert.equal(byTarget["/Order/OrderNumber"].one_of, undefined);
  const a = byTarget["/Order/SupplierId"]; const b = byTarget["/Order/SupplierCode"];
  assert.equal(a.mandatory, false); assert.equal(a.one_of.required, true);
  assert.equal(a.one_of.group, b.one_of.group);
  assert.equal(byTarget["/Order/Note"].mandatory, false);
  const fldA = s.items.find((x) => x.raw_id === a.field_ref);
  assert.deepEqual(fldA.lineage.required_by, [{ ref: intC.raw_id, mandatory_there: false, one_of: a.one_of }]);
});

test("normalizeIntMappings: field_ref grezzo → field (codice FLD) con la mappa della digestione; un id non risolto resta fuori e segnalato; l'INT risultante valida lo schema", () => {
  const raw = { mappings: [{ field_ref: "R.D1.T1", target: "/Order/OrderNumber", mandatory: true }, { field_ref: "R.D1.T2", target: "/Order/SupplierId", mandatory: false, one_of: { group: "g1", required: true } }, { field_ref: "R.D1.T9", target: "/X" }] };
  const r = normalizeIntMappings(raw, { "R.D1.T1": "S.STD.XSC.FLD.0001", "R.D1.T2": "S.STD.XSC.FLD.0002" });
  assert.deepEqual(r.mappings, [{ field: "S.STD.XSC.FLD.0001", target: "/Order/OrderNumber", mandatory: true }, { field: "S.STD.XSC.FLD.0002", target: "/Order/SupplierId", mandatory: false, one_of: { group: "g1", required: true } }]);
  assert.deepEqual(r.unresolved, ["R.D1.T9"]);
  const item = int("S.STD.XSC.INT.0003", { mappings: r.mappings });
  assert.equal(validateItem(item).ok, true, validateItem(item).errors.join("; "));
  // un field_ref che è già un codice FLD è accettato così com'è
  assert.deepEqual(normalizeIntMappings({ mappings: [{ field_ref: "S.STD.XSC.FLD.0004", target: "/Y" }] }).mappings, [{ field: "S.STD.XSC.FLD.0004", target: "/Y" }]);
});

test("chains: il lato del mapping uno-fra porta one_of; entra nella catena (gruppo obbligatorio) ma non deduce reason integration da solo; field_ref con codice FLD accettato", () => {
  const rel = lineageRelations({ id: "S.STD.XSC.INT.0003", type: "INT", mappings: [{ field: "S.STD.XSC.FLD.0002", target: "/Order/SupplierId", mandatory: false, one_of: { group: "g1", required: true } }, { field_ref: "S.STD.XSC.FLD.0001", target: "/Order/OrderNumber", mandatory: true }] });
  assert.deepEqual(rel.map((r) => [r.from, r.detail.mandatory_there, r.detail.one_of ?? null]), [["S.STD.XSC.FLD.0002", false, { group: "g1", required: true }], ["S.STD.XSC.FLD.0001", true, null]]);
  const f = (id, doc, over = {}) => ({ id, type: "FLD", title: id, summary: "x", sources: [{ doc: "t" }], document: doc, label: { it: id }, section: "h", field_type: "text", facets: FACETS, mandatory: { kind: "always" }, ...over });
  const items = [
    f("S.STD.P2P.FLD.0010", "document.requisition", { lineage: { propagates_to: [{ field: "S.STD.P2P.FLD.0011", document: "document.purchase_order" }] } }),
    f("S.STD.P2P.FLD.0011", "document.purchase_order", { mandatory: { kind: "never" } }),
    f("S.STD.P2P.FLD.0012", "document.purchase_order", { mandatory: { kind: "never" }, lineage: { derived_from: "S.STD.P2P.FLD.0010" } }),
    { id: "S.STD.XSC.INT.0003", type: "INT", mappings: [{ field: "S.STD.P2P.FLD.0010", target: "/Order/SupplierId", mandatory: false, one_of: { group: "g1", required: true } }] },
  ];
  const r = chains(items, { existing: [] });
  assert.ok(r.proposed.some((p) => p.ints.includes("S.STD.XSC.INT.0003")), "il mapping uno-fra obbligatorio attraversa la catena");
  assert.ok(!r.reasons.some((x) => x.field === "S.STD.P2P.FLD.0010" && x.inferred.kind === "integration"), "uno-fra: nessuna reason integration dedotta per il singolo campo");
  // un gruppo facoltativo (required false) non entra, come un mapping non obbligatorio
  items[3].mappings[0].one_of.required = false;
  assert.ok(!chains(items, { existing: [] }).proposed.some((p) => p.ints.includes("S.STD.XSC.INT.0003")));
});

test("FLD: lineage.required_by accetta one_of { group, required } (schema FLD)", () => {
  const f = { id: "S.STD.XSC.FLD.0002", type: "FLD", title: "SupplierId", summary: "Identificativo fornitore.", facets: FACETS, sources: [{ doc: "order.xsd" }], document: "document.order", label: { en: "SupplierId" }, section: "header", field_type: "text",
    identity: { system_of_record: { system: "SAP" } }, lineage: { required_by: [{ ref: "S.STD.XSC.INT.0003", mandatory_there: false, one_of: { group: "g1", required: true } }] } };
  assert.equal(validateItem(f).ok, true, validateItem(f).errors.join("; "));
  f.lineage.required_by[0].one_of = { group: "g1" };
  assert.equal(validateItem(f).ok, false);
});
