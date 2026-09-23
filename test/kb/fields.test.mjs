// K4.5 — recupero dei campi in pochi token (§19.6.5, §19.20): migrazione 0004-fld,
// reindex dei FLD, kb fields / impact / identity.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { openDb } from "../../scripts/kb/db.mjs";
import { reindex } from "../../scripts/kb/reindex.mjs";
import { fields, InvalidInputError } from "../../scripts/kb/fields.mjs";
import { impact } from "../../scripts/kb/impact.mjs";
import { identityCard, identityMissing, identityCoverage } from "../../scripts/kb/identity.mjs";

const KB = fileURLToPath(new URL("../../scripts/kb/kb.mjs", import.meta.url));
const FIXTURE = YAML.parse(readFileSync(new URL("../fixtures/items/S.STD.P2P.FLD.0117.yaml", import.meta.url), "utf8"));
const FACETS = FIXTURE.facets;

function fld(id, over = {}) {
  return { id, type: "FLD", title: `Campo ${id}`, summary: `Campo ${id.slice(-4)} di prova.`, sources: [{ doc: "t" }], document: "document.requisition",
    label: { it: `Campo ${id.slice(-4)}` }, section: "header.general", field_type: "text", facets: FACETS, ...over };
}
function workspace(items) {
  const root = mkdtempSync(join(tmpdir(), "kbf-"));
  const dir = join(root, "kb", "scopes", "P2P", "items");
  mkdirSync(dir, { recursive: true });
  for (const it of items) writeFileSync(join(dir, `${it.id}.yaml`), YAML.stringify(it));
  const dbPath = join(root, "knowledge.db");
  const stats = reindex(root, dbPath);
  return { root, dir, dbPath, db: openDb(dbPath), stats };
}
function sample() {
  return [
    FIXTURE,
    fld("S.STD.P2P.FLD.0342", { document: "document.purchase_order", section: "header.accounting", key_ref: "keys.cost_center.code", mandatory: { kind: "always", reason: { kind: "integration", ref: "S.STD.XSC.INT.0001" } },
      lineage: { derived_from: "S.STD.P2P.FLD.0117", propagates_to: [{ field: "S.STD.INV.FLD.0088", document: "document.invoice", transform: "via ordine" }], required_by: [] },
      identity: { system_of_record: { master: "erp_sap" } }, cluster: ["CL-FLD-003", "CL-FLD-CHAIN-012"] }),
    fld("S.STD.P2P.FLD.0200", { mandatory: { kind: "always" } }),
    fld("S.STD.P2P.FLD.0201", { mandatory: { kind: "conditional", in_states: ["DRAFT"] } }),
    fld("S.STD.P2P.FLD.0202", { mandatory: { kind: "conditional", when: "document.company IN (DE01)" } }),
    fld("S.STD.P2P.FLD.0203", { mandatory: { kind: "never" } }),
    fld("S.STD.P2P.FLD.0204", { custom: true, mandatory: { kind: "always", reason: { kind: "ui" } } }),
    fld("S.STD.P2P.FLD.0205", { custom: true, mandatory: { kind: "always", reason: { kind: "ui" } },
      lineage: { required_by: [{ ref: "S.STD.XSC.INT.0002", mapping: "E1EDK01-BSART", mandatory_there: true }] }, identity: { system_of_record: { master: "erp_sap" } } }),
    fld("S.STD.P2P.FLD.0206", { mandatory: { kind: "conditional", when: "document.amount > 5000", in_states: ["PENDING_APPROVAL"] } }),
  ];
}

test("migrazione 0004-fld: tabelle fields e field_lineage con indici", () => {
  const db = openDb(":memory:");
  const cols = db.prepare("pragma table_info(fields)").all().map((c) => c.name);
  for (const c of ["code", "document", "section", "technical_name", "mandatory_kind", "in_states", "when_cond", "by_role", "reason_kind", "custom"]) assert.ok(cols.includes(c), c);
  assert.ok(db.prepare("select name from sqlite_master where type='table' and name='field_lineage'").get());
  const idx = db.prepare("select name from sqlite_master where type='index' and tbl_name='fields'").all().map((x) => x.name);
  assert.ok(idx.length >= 3);
});

test("reindex popola fields per i FLD e relations/field_lineage dal lineage", () => {
  const { db, stats } = workspace(sample());
  assert.equal(stats.invalid, 0);
  const f = db.prepare("select * from fields where code='S.STD.P2P.FLD.0117'").get();
  assert.equal(f.document, "document.requisition");
  assert.equal(f.section, "header.accounting");
  assert.equal(f.technical_name, "REQ_HDR_COST_CENTER");
  assert.equal(f.mandatory_kind, "conditional");
  assert.deepEqual(JSON.parse(f.in_states), ["PENDING_APPROVAL", "APPROVED"]);
  assert.equal(f.when_cond, "document.company IN (IT01, IT02)");
  assert.equal(f.reason_kind, "integration");
  assert.equal(f.custom, 0);
  assert.equal(db.prepare("select count(*) n from fields").get().n, 9);
  const rel = db.prepare("select to_code, kind from relations where from_code='S.STD.P2P.FLD.0117' order by kind, to_code").all();
  assert.deepEqual(rel.map((r) => [r.kind, r.to_code]), [["propagates_to", "S.STD.INV.FLD.0088"], ["propagates_to", "S.STD.P2P.FLD.0342"],
    ["required_by", "S.STD.INV.FLD.0088"], ["required_by", "S.STD.XSC.INT.0001"]]);
  const det = db.prepare("select mapping, mandatory_there from field_lineage where from_code='S.STD.P2P.FLD.0117' and to_code='S.STD.XSC.INT.0001'").get();
  assert.deepEqual(det, { mapping: "E1EDP19-IDTNR", mandatory_there: 1 });
});

test("reindex: una modifica del lineage sostituisce le relazioni della fonte (niente archi orfani)", () => {
  const { root, dir, dbPath, db } = workspace(sample());
  const changed = { ...FIXTURE, lineage: { ...FIXTURE.lineage, propagates_to: [FIXTURE.lineage.propagates_to[0]] } };
  writeFileSync(join(dir, `${FIXTURE.id}.yaml`), YAML.stringify(changed));
  reindex(root, dbPath);
  const rel = db.prepare("select to_code from relations where from_code='S.STD.P2P.FLD.0117' and kind='propagates_to'").all().map((r) => r.to_code);
  assert.deepEqual(rel, ["S.STD.P2P.FLD.0342"]);
  // il derived_from di 0342 (altra fonte) resta
  assert.ok(db.prepare("select 1 from relations where from_code='S.STD.P2P.FLD.0342' and kind='derived_from'").get());
});

test("fields --mandatory-in: always, e conditional/undocumented senza stati o con lo stato; never escluso", () => {
  const { db } = workspace(sample());
  const codes = (r) => r.items.map((x) => x.code).sort();
  assert.deepEqual(codes(fields(db, { mandatoryIn: "PENDING_APPROVAL" })),
    ["S.STD.P2P.FLD.0117", "S.STD.P2P.FLD.0200", "S.STD.P2P.FLD.0202", "S.STD.P2P.FLD.0204", "S.STD.P2P.FLD.0205", "S.STD.P2P.FLD.0206", "S.STD.P2P.FLD.0342"]);
  assert.deepEqual(codes(fields(db, { mandatoryIn: "DRAFT", doc: "requisition" })),
    ["S.STD.P2P.FLD.0200", "S.STD.P2P.FLD.0201", "S.STD.P2P.FLD.0202", "S.STD.P2P.FLD.0204", "S.STD.P2P.FLD.0205"]);
  const one = fields(db, { mandatoryIn: "PENDING_APPROVAL", doc: "requisition" }).items.find((x) => x.code === "S.STD.P2P.FLD.0117");
  assert.equal(one.summary, FIXTURE.summary);
  assert.deepEqual(one.mandatory.in_states, ["PENDING_APPROVAL", "APPROVED"]);
  assert.throws(() => fields(db, { mandatoryIn: "pending; drop table" }), InvalidInputError);
});

test("fields --company IT01: FLD il cui when cita la società, o senza condizione di società", () => {
  const { db } = workspace(sample());
  const it = fields(db, { doc: "requisition", mandatoryIn: "PENDING_APPROVAL", company: "IT01" }).items.map((x) => x.code).sort();
  assert.deepEqual(it, ["S.STD.P2P.FLD.0117", "S.STD.P2P.FLD.0200", "S.STD.P2P.FLD.0204", "S.STD.P2P.FLD.0205", "S.STD.P2P.FLD.0206"]);
  const de = fields(db, { doc: "requisition", mandatoryIn: "PENDING_APPROVAL", company: "DE01" }).items.map((x) => x.code);
  assert.ok(de.includes("S.STD.P2P.FLD.0202") && !de.includes("S.STD.P2P.FLD.0117"));
});

test("fields --custom --reason ui: i campi custom obbligatori senza ragione a valle (le domande da fare)", () => {
  const { db } = workspace(sample());
  assert.deepEqual(fields(db, { doc: "requisition", custom: true, reason: "ui" }).items.map((x) => x.code), ["S.STD.P2P.FLD.0204"]);
  assert.throws(() => fields(db, { reason: "capriccio" }), InvalidInputError);
});

test("fields --chain: i campi della catena in ordine di processo, con documento e trasformazione", () => {
  const { db } = workspace(sample());
  const r = fields(db, { chain: "CL-FLD-CHAIN-012" });
  assert.deepEqual(r.items.map((x) => [x.code, x.document, x.transform]), [
    ["S.STD.P2P.FLD.0117", "document.requisition", null],
    ["S.STD.P2P.FLD.0342", "document.purchase_order", "direct"],
  ]);
  assert.equal(r.items.length <= 50, true);
});

test("fields --top: al massimo top codici, truncated se ce n'erano di più", () => {
  const { db } = workspace(sample());
  const r = fields(db, { top: 2 });
  assert.equal(r.items.length, 2);
  assert.equal(r.truncated, true);
});

test("impact S.STD.P2P.FLD.0117 --if \"mandatory.kind = never\" → si rompono INT.0001 (mapping mandatory) e INV.FLD.0088 (abbinamento)", () => {
  const { db } = workspace([FIXTURE]);
  const r = impact(db, "S.STD.P2P.FLD.0117", { if: "mandatory.kind = never" });
  assert.deepEqual(r.breaks.map((b) => b.code).sort(), ["S.STD.INV.FLD.0088", "S.STD.XSC.INT.0001"]);
  const int = r.breaks.find((b) => b.code === "S.STD.XSC.INT.0001");
  assert.equal(int.mapping, "E1EDP19-IDTNR");
  assert.match(int.why, /mapping/);
  assert.match(r.breaks.find((b) => b.code === "S.STD.INV.FLD.0088").why, /abbinamento/);
  assert.deepEqual(r.unknown.map((u) => u.code), ["S.STD.P2P.FLD.0342"]);   // a valle ma non modellato: da verificare
  const all = impact(db, "S.STD.P2P.FLD.0117", {});
  assert.deepEqual([...new Set(all.downstream.map((d) => d.code))].sort(), ["S.STD.INV.FLD.0088", "S.STD.P2P.FLD.0342", "S.STD.XSC.INT.0001"]);
  assert.throws(() => impact(db, "S.STD.P2P.FLD.0117", { if: "rm -rf" }), InvalidInputError);
  assert.throws(() => impact(db, "S.STD.P2P.FLD.9999", {}), /inesistente/);
});

test("impact transitivo: a valle di un campo non obbligatorio il vuoto si propaga; un campo a valle obbligatorio si rompe", () => {
  const { db } = workspace(sample());
  const r = impact(db, "S.STD.P2P.FLD.0117", { if: "mandatory.kind = never" });
  assert.ok(r.breaks.some((b) => b.code === "S.STD.P2P.FLD.0342" && /obbligatorio/.test(b.why)));
  // A (obbligatorio) → B (never) → C (always): B non si rompe, il vuoto arriva a C
  const p = (field) => ({ propagates_to: [{ field, document: "document.purchase_order", transform: "direct" }] });
  const w = workspace([
    fld("S.STD.P2P.FLD.0400", { mandatory: { kind: "always" }, lineage: p("S.STD.P2P.FLD.0401") }),
    fld("S.STD.P2P.FLD.0401", { document: "document.purchase_order", mandatory: { kind: "never" }, lineage: p("S.STD.P2P.FLD.0402") }),
    fld("S.STD.P2P.FLD.0402", { document: "document.purchase_order", mandatory: { kind: "always" } }),
  ]);
  const t = impact(w.db, "S.STD.P2P.FLD.0400", { if: "mandatory.kind = never" });
  assert.deepEqual(t.breaks.map((b) => [b.code, b.depth]), [["S.STD.P2P.FLD.0402", 2]]);
  assert.deepEqual(impact(w.db, "S.STD.P2P.FLD.0400", { if: "mandatory.kind = always" }).breaks, []);
});

test("identity: carta compatta, copertura dei 12 blocchi, --doc --missing <blocco>", () => {
  const { db } = workspace(sample());
  const card = identityCard(db, "S.STD.P2P.FLD.0117");
  assert.equal(card.code, "S.STD.P2P.FLD.0117");
  assert.equal(card.coverage.blocks_covered, 12);
  assert.match(card.blocks.system_of_record, /erp_sap/);
  assert.match(card.blocks.datatype, /string/);
  assert.ok(card.coverage.null_attributes.includes("datatype.precision"));
  assert.ok(JSON.stringify(card).length < 2500);                                  // compatta
  const miss = identityMissing(db, { doc: "requisition", missing: "system_of_record" }).map((x) => x.code);
  assert.ok(!miss.includes("S.STD.P2P.FLD.0117") && !miss.includes("S.STD.P2P.FLD.0205"));
  assert.ok(miss.includes("S.STD.P2P.FLD.0200"));
  assert.throws(() => identityMissing(db, { doc: "requisition", missing: "colore" }), InvalidInputError);
  assert.deepEqual(identityCoverage(null).blocks_covered, 0);
  assert.throws(() => identityCard(db, "S.STD.P2P.FLD.9999"), /inesistente/);
});

test("kb CLI: fields, impact, identity (--json); input non valido → exit 1", () => {
  const { dbPath } = workspace(sample());
  const run = (...a) => spawnSync(process.execPath, [KB, ...a, "--db", dbPath, "--json"], { encoding: "utf8" });
  const f = run("fields", "--doc", "requisition", "--mandatory-in", "PENDING_APPROVAL", "--company", "IT01", "--top", "50");
  assert.equal(f.status, 0, f.stderr + f.stdout);
  assert.equal(JSON.parse(f.stdout).items.length, 5);
  const c = run("fields", "--doc", "requisition", "--custom", "--reason", "ui");
  assert.deepEqual(JSON.parse(c.stdout).items.map((x) => x.code), ["S.STD.P2P.FLD.0204"]);
  const i = run("impact", "S.STD.P2P.FLD.0117", "--if", "mandatory.kind = never");
  assert.equal(i.status, 0, i.stderr + i.stdout);
  assert.ok(JSON.parse(i.stdout).breaks.some((b) => b.code === "S.STD.XSC.INT.0001"));
  const id = run("identity", "S.STD.P2P.FLD.0117");
  assert.equal(id.status, 0);
  assert.equal(JSON.parse(id.stdout).items[0].coverage.blocks_covered, 12);
  const m = run("identity", "--doc", "requisition", "--missing", "system_of_record");
  assert.equal(m.status, 0);
  assert.equal(run("identity", "--doc", "requisition", "--missing", "colore").status, 1);
  assert.equal(run("fields", "--reason", "capriccio").status, 1);
  assert.equal(run("impact", "S.STD.P2P.FLD.0117", "--if", "boh").status, 1);
});

test("prestazioni: kb fields --mandatory-in PENDING_APPROVAL su 1000 FLD sintetici < 1 s", () => {
  const states = ["DRAFT", "PENDING_APPROVAL", "APPROVED", "ORDERED"];
  const kinds = ["always", "conditional", "never", "undocumented"];
  const items = Array.from({ length: 1000 }, (_, i) => {
    const k = kinds[i % 4];
    const m = { kind: k };
    if (k === "conditional") { m.in_states = [states[i % 4], states[(i + 1) % 4]]; if (i % 3 === 0) m.when = `document.company IN (IT0${i % 5})`; }
    return fld(`S.STD.P2P.FLD.${String(i + 1).padStart(4, "0")}`, { document: i % 2 ? "document.requisition" : "document.purchase_order", section: `sec.${i % 20}`,
      technical_name: `F_${i}`, mandatory: m, custom: i % 7 === 0 });
  });
  const { db, dbPath, stats } = workspace(items);
  assert.equal(stats.invalid, 0);
  assert.equal(db.prepare("select count(*) n from fields").get().n, 1000);
  const t0 = process.hrtime.bigint();
  const r = fields(db, { mandatoryIn: "PENDING_APPROVAL", top: 50 });
  const fnMs = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.equal(r.items.length, 50);
  const t1 = process.hrtime.bigint();
  const cli = spawnSync(process.execPath, [KB, "fields", "--mandatory-in", "PENDING_APPROVAL", "--db", dbPath, "--json"], { encoding: "utf8" });
  const cliMs = Number(process.hrtime.bigint() - t1) / 1e6;
  assert.equal(cli.status, 0, cli.stderr);
  console.log(`perf kb fields --mandatory-in su 1000 FLD: funzione ${fnMs.toFixed(1)} ms · CLI (processo completo) ${cliMs.toFixed(0)} ms · query ${JSON.parse(cli.stdout).took_ms} ms`);
  assert.ok(fnMs < 1000, `${fnMs} ms`);
  assert.ok(cliMs < 1000, `${cliMs} ms`);
});
