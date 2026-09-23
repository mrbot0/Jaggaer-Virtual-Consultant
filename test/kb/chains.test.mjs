// K4.4 — catene logiche fra documenti (§19.6.4 passi 5-6, §27.2, ADR-77).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { chains, lineageRelations, writeRelations } from "../../scripts/kb/chains.mjs";
import { validateCluster } from "../../scripts/kb/cluster-rules.mjs";
import { openDb } from "../../scripts/kb/db.mjs";

const CLI = fileURLToPath(new URL("../../scripts/kb/chains.mjs", import.meta.url));
const FIXTURE = YAML.parse(readFileSync(new URL("../fixtures/items/S.STD.P2P.FLD.0117.yaml", import.meta.url), "utf8"));

function fld(id, document, over = {}) {
  return { id, type: "FLD", title: `Campo ${id}`, summary: "Campo di prova.", sources: [{ doc: "t" }], document, label: { it: `Campo ${id.slice(-4)}` },
    section: "header", field_type: "text", facets: { F4: "struttura-dati", F12: "digerito" }, ...over };
}
const prop = (field, document, transform = "direct") => ({ field, document, transform });

// Catena di 3 FLD su 2 documenti: richiesta → ordine (testata) → ordine (righe), più un INT che richiede il primo.
function chain3() {
  return [
    fld("C.ACME.P2P.FLD.0117", "document.requisition", { key_ref: "keys.cost_center.code", mandatory: { kind: "conditional", in_states: ["PENDING_APPROVAL"], reason: { kind: "business" } },
      lineage: { derived_from: null, propagates_to: [prop("C.ACME.P2P.FLD.0342", "document.purchase_order")], required_by: [] } }),
    fld("C.ACME.P2P.FLD.0342", "document.purchase_order", { key_ref: "keys.cost_center.code", mandatory: { kind: "always", reason: { kind: "integration", ref: "C.ACME.XSC.INT.0001" } },
      lineage: { derived_from: "C.ACME.P2P.FLD.0117", propagates_to: [prop("C.ACME.P2P.FLD.0343", "document.purchase_order", "copia sulle righe")], required_by: [] } }),
    fld("C.ACME.P2P.FLD.0343", "document.purchase_order", { key_ref: "keys.cost_center.code", mandatory: { kind: "always" } }),
    { id: "C.ACME.XSC.INT.0001", type: "INT", title: "IDoc ORDERS verso SAP", summary: "Uscita ordini.", mappings: [
      { field: "C.ACME.P2P.FLD.0117", target: "E1EDP19-IDTNR", mandatory: true },
      { field: "C.ACME.P2P.FLD.0999", target: "E1EDK01-CURCY", mandatory: false },
    ] },
  ];
}

test("lineageRelations: propagates_to, required_by e derived_from dal FLD; required_by dai mapping INT; required_by (workflow) dal LCY", () => {
  const r = lineageRelations(FIXTURE);
  assert.deepEqual(r.map((x) => [x.from, x.to, x.kind]), [
    ["S.STD.P2P.FLD.0117", "S.STD.P2P.FLD.0342", "propagates_to"],
    ["S.STD.P2P.FLD.0117", "S.STD.INV.FLD.0088", "propagates_to"],
    ["S.STD.P2P.FLD.0117", "S.STD.XSC.INT.0001", "required_by"],
    ["S.STD.P2P.FLD.0117", "S.STD.INV.FLD.0088", "required_by"],
  ]);
  assert.equal(r[2].detail.mandatory_there, true);
  assert.equal(r[2].detail.mapping, "E1EDP19-IDTNR");
  const [, fld342] = chain3();
  assert.deepEqual(lineageRelations(fld342).map((x) => [x.from, x.to, x.kind]).find((x) => x[2] === "derived_from"), ["C.ACME.P2P.FLD.0342", "C.ACME.P2P.FLD.0117", "derived_from"]);
  const int = lineageRelations(chain3()[3]);
  assert.deepEqual(int.map((x) => [x.from, x.to, x.kind, x.detail.mandatory_there]), [
    ["C.ACME.P2P.FLD.0117", "C.ACME.XSC.INT.0001", "required_by", true], ["C.ACME.P2P.FLD.0999", "C.ACME.XSC.INT.0001", "required_by", false]]);
  const lcy = lineageRelations({ id: "S.STD.P2P.LCY.0001", type: "LCY", document: "document.requisition", mandatory_by_state: { PENDING_APPROVAL: ["S.STD.P2P.FLD.0117"] } });
  assert.deepEqual(lcy.map((x) => [x.from, x.to, x.kind, x.detail.reason_kind]), [["S.STD.P2P.FLD.0117", "S.STD.P2P.LCY.0001", "required_by", "workflow"]]);
});

test("chains: 3 FLD su 2 documenti → CL-FLD-CHAIN proposto, in ordine di processo, con l'INT che attraversa", () => {
  const r = chains(chain3(), { existing: [] });
  assert.equal(r.proposed.length, 1);
  const c = r.proposed[0];
  assert.deepEqual(c.fields, ["C.ACME.P2P.FLD.0117", "C.ACME.P2P.FLD.0342", "C.ACME.P2P.FLD.0343"]);
  assert.deepEqual(c.documents, ["document.requisition", "document.purchase_order"]);
  assert.deepEqual(c.ints, ["C.ACME.XSC.INT.0001"]);
  assert.equal(c.scope, "P2P");
  assert.equal(c.cluster.family, "CL-FLD-CHAIN");
  assert.deepEqual(validateCluster(c.cluster).errors, []);
  assert.equal(r.rejected.length, 0);
});

test("chains: 2 FLD → rifiutata (servono ≥ 3 FLD di ≥ 2 documenti); 3 FLD di un solo documento → rifiutata", () => {
  const two = [
    fld("C.ACME.P2P.FLD.0200", "document.requisition", { mandatory: { kind: "always" }, lineage: { propagates_to: [prop("C.ACME.P2P.FLD.0201", "document.purchase_order")] } }),
    fld("C.ACME.P2P.FLD.0201", "document.purchase_order", { mandatory: { kind: "always" } }),
  ];
  const r = chains(two, { existing: [] });
  assert.equal(r.proposed.length, 0);
  assert.equal(r.rejected.length, 1);
  assert.deepEqual(r.rejected[0].fields, ["C.ACME.P2P.FLD.0200", "C.ACME.P2P.FLD.0201"]);
  assert.match(r.rejected[0].reason, /≥ 3 FLD/);
  const oneDoc = [
    fld("C.ACME.P2P.FLD.0300", "document.requisition", { mandatory: { kind: "always" }, lineage: { propagates_to: [prop("C.ACME.P2P.FLD.0301", "document.requisition"), prop("C.ACME.P2P.FLD.0302", "document.requisition")] } }),
    fld("C.ACME.P2P.FLD.0301", "document.requisition"), fld("C.ACME.P2P.FLD.0302", "document.requisition"),
  ];
  const r2 = chains(oneDoc, { existing: [] });
  assert.equal(r2.proposed.length, 0);
  assert.match(r2.rejected[0].reason, /≥ 2 documenti/);
});

test("chains: la ricostruzione parte solo dai campi con mandatory.kind ≠ never", () => {
  const items = chain3().map((it) => (it.type === "FLD" ? { ...it, mandatory: { kind: "never" } } : { ...it, mappings: [] }));
  const r = chains(items, { existing: [] });
  assert.equal(r.proposed.length + r.rejected.length, 0);
});

test("chains: reason integration dedotta dal mapping INT obbligatorio; reason ui senza altra ragione → domanda (ADR-77)", () => {
  const items = [...chain3(),
    fld("C.ACME.P2P.FLD.0500", "document.requisition", { custom: true, mandatory: { kind: "always", reason: { kind: "ui" } } }),
    fld("C.ACME.P2P.FLD.0501", "document.requisition", { mandatory: { kind: "always", reason: { kind: "ui" } },
      lineage: { required_by: [{ ref: "C.ACME.XSC.INT.0002", mapping: "E1EDK01-BSART", mandatory_there: true }] } }),
  ];
  const r = chains(items, { existing: [] });
  const inf = Object.fromEntries(r.reasons.map((x) => [x.field, x]));
  assert.deepEqual(inf["C.ACME.P2P.FLD.0117"].inferred, { kind: "integration", ref: "C.ACME.XSC.INT.0001" });
  assert.equal(inf["C.ACME.P2P.FLD.0117"].current, "business");
  assert.deepEqual(inf["C.ACME.P2P.FLD.0501"].inferred, { kind: "integration", ref: "C.ACME.XSC.INT.0002" });
  assert.equal(inf["C.ACME.P2P.FLD.0342"], undefined);                        // già integration: nessuna proposta
  assert.deepEqual(r.questions.map((q) => q.field), ["C.ACME.P2P.FLD.0500"]);   // 0501 ha una ragione a valle
  assert.equal(r.questions[0].adr, "ADR-77");
});

test("chains: una catena che soddisfa i criteri di un CL-FLD-CHAIN esistente lo propone come destinazione (niente duplicati)", () => {
  const r = chains(chain3());   // cluster del plugin: CL-FLD-CHAIN-012 = key_ref keys.cost_center.code + propagates_to
  assert.equal(r.proposed[0].cluster_code, "CL-FLD-CHAIN-012");
  assert.equal(r.proposed[0].new, false);
  const other = chain3().map((it) => (it.type === "FLD" ? { ...it, key_ref: "keys.project.code" } : it));
  const r2 = chains(other);
  assert.equal(r2.proposed[0].new, true);
  assert.equal(r2.proposed[0].cluster_code, "CL-FLD-CHAIN-013");   // dopo 001, 002, 012
});

test("writeRelations: il grafo lineage entra nella tabella relations (idempotente)", () => {
  const db = openDb(":memory:");
  const rel = chain3().flatMap(lineageRelations);
  writeRelations(db, rel);
  writeRelations(db, rel);
  const rows = db.prepare("select from_code, to_code, kind from relations order by kind, from_code, to_code").all();
  assert.deepEqual(rows.map((x) => x.kind).sort(), ["derived_from", "propagates_to", "propagates_to", "required_by", "required_by"]);
});

test("CLI chains: --root legge FLD/INT/LCY (kb/ e _inbox/*/digested/), --db scrive le relazioni, --write-proposals in _inbox/<scope>/chains/", () => {
  const root = mkdtempSync(join(tmpdir(), "chn-"));
  const dir = join(root, "_inbox", "P2P", "digested");
  mkdirSync(dir, { recursive: true });
  for (const it of chain3()) writeFileSync(join(dir, `${it.id}.yaml`), YAML.stringify(it));
  const dbPath = join(root, "k.db");
  openDb(dbPath).close();
  const r = spawnSync(process.execPath, [CLI, "--root", root, "--db", dbPath, "--write-proposals", "--json"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const out = JSON.parse(r.stdout);
  assert.equal(out.proposed.length, 1);
  assert.equal(out.relations_written, 5);
  const files = readdirSync(join(root, "_inbox", "P2P", "chains"));
  assert.equal(files.length, 1);
  assert.ok(existsSync(join(root, "_inbox", "P2P", "chains", files[0])));
  const bad = spawnSync(process.execPath, [CLI, "--json"], { encoding: "utf8" });
  assert.equal(bad.status, 1);
});
