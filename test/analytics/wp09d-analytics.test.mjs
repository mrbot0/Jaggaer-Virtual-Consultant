// WP09d — C. Analytics (§20.3, §20.5, DT-015): schemi tbl/qry/din/usr/psp/err agganciati a validate-schema, privacy dei
// DIN/USR (gruppo minimo 20, nessun valore identificativo), LIMIT iniettato e verificato, query non eseguita non
// consegnata, tabelle ignote con avvertenza e QRY solo dopo 2 esecuzioni coerenti, DIN con gruppo < 20 rifiutato,
// de_facto_mandatory rilevato (fill_rate ≥ 0.98 su un campo documentato opzionale ⇒ proposta di CTR).
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFileSync, readFileSync, existsSync, readdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import YAML from "yaml";
import { validateItem } from "../../scripts/kb/validate-schema.mjs";
import { ensureLimit, queryHash, recordRun, deliverable, QueryError, WARNING_UNKNOWN } from "../../scripts/analytics/query-guard.mjs";
import { buildDin, PrivacyError } from "../../scripts/analytics/din-build.mjs";
import { openDb } from "../../scripts/kb/db.mjs";
import { FACETS, writeItem } from "../helpers/wp09b-items.mjs";
import { ws09d, cli } from "../helpers/wp09d.mjs";

const base = (id, type, extra) => ({ id, type, title: `Item ${type} di prova`, summary: "Prova.", facets: structuredClone(FACETS), sources: [{ query: "C.ACME.ANL.QRY.0011" }], ...extra });
const errs = (o) => validateItem(o).errors.join(" | ");

test("schemi: TBL, QRY, DIN, USR, PSP, ERR validati per tipo; QRY senza LIMIT o non eseguita rifiutata; tabelle ignote richiedono 2 esecuzioni", () => {
  assert.equal(validateItem(base("L.ACME.ANL.TBL.0007", "TBL", { table: "PO_HEADER", columns: [{ name: "PO_NUMBER", type: "string", key: "primary" }], row_count_observed: 187420 })).ok, true);
  assert.match(errs(base("L.ACME.ANL.TBL.0007", "TBL", { table: "PO_HEADER" })), /columns/);
  const qry = (extra) => base("C.ACME.ANL.QRY.0011", "QRY", { sql: "select count(*) from PO_HEADER limit 100", limit: 100, tables_knowledge: "validate", executed: { runs: 1, coherence: "coerente" }, ...extra });
  assert.equal(validateItem(qry()).ok, true, errs(qry()));
  assert.match(errs(qry({ sql: "select count(*) from PO_HEADER" })), /sql/);
  assert.match(errs(qry({ executed: { runs: 1, coherence: "parziale" } })), /coherence/);
  assert.match(errs(qry({ executed: undefined })), /executed/);
  assert.match(errs(qry({ tables_knowledge: "ignote" })), /runs/, "ignote: una sola esecuzione non basta");
  assert.equal(validateItem(qry({ tables_knowledge: "ignote", executed: { runs: 2, coherence: "coerente" } })).ok, true);
  assert.equal(validateItem(base("S.STD.XSC.PSP.0007", "PSP", { applies_when: { procurement_model: ["indirect"] }, recommends: { process: "2 livelli" }, portability: { class: "condizionata", condition: "CL-PRO-002" } })).ok, true);
  assert.equal(validateItem(base("C.ACME.P2P.ERR.0007", "ERR", { message: { it: "Il centro di costo non è attivo", en: null }, category: "validation", blocking: true, severity: "medium" })).ok, true);
  assert.match(errs(base("C.ACME.P2P.ERR.0007", "ERR", { message: { it: "x" }, category: "boh" })), /category/);
});

test("privacy DIN/USR: gruppo minimo 20, values_retained none, nessun valore identificativo (email, elenchi di nomi/codici)", () => {
  const din = (extra) => base("L.ACME.P2P.DIN.0001", "DIN", { document: "document.requisition", sample: { size: 8420 }, fields: [{ field: "S.STD.P2P.FLD.0117", fill_rate: 0.998 }],
    privacy: { values_retained: "none", aggregation_min_group: 20 }, ...extra });
  assert.equal(validateItem(din()).ok, true, errs(din()));
  assert.match(errs(din({ privacy: { values_retained: "none", aggregation_min_group: 10 } })), /aggregation_min_group/);
  assert.match(errs(din({ privacy: { values_retained: "some", aggregation_min_group: 20 } })), /values_retained/);
  assert.match(errs(din({ by_role: { requester_names: ["Mario Rossi", "Anna Bianchi"] } })), /identificativi/);
  assert.match(errs(din({ volumes: { note: "contattare mario.rossi@acme.it" } })), /email/);
  assert.match(errs(din({ lifecycle: { paths: [{ seq: "DRAFT→CANCELLED", n: 7 }] } })), /gruppo di 7/);
  const usr = (extra) => base("L.ACME.XSC.USR.0003", "USR", { role: "BUYER", users_in_role: 64, period: "90 giorni", privacy: { per_user: "never", min_group: 20 }, ...extra });
  assert.equal(validateItem(usr()).ok, true, errs(usr()));
  assert.match(errs(usr({ users_in_role: 5 })), /users_in_role/);
  assert.match(errs(usr({ privacy: { per_user: "sometimes", min_group: 20 } })), /per_user/);
  assert.match(errs(usr({ friction: { users: ["u123", "u456"] } })), /identificativi/);
});

test("LIMIT: iniettato se manca, ridotto al massimo, mantenuto se valido; DML, più istruzioni e parole chiave nascoste rifiutate", () => {
  assert.deepEqual(ensureLimit("select * from PO_HEADER;"), { sql: "select * from PO_HEADER\nLIMIT 1000", limit: 1000, injected: true, capped: false });
  assert.equal(ensureLimit("select a from t limit 50").limit, 50);
  const c = ensureLimit("select a from t limit 999999");
  assert.equal(c.limit, 10000); assert.equal(c.capped, true); assert.match(c.sql, /limit 10000$/);
  assert.equal(ensureLimit("select top 20 a from t").limit, 20);
  assert.equal(ensureLimit("with x as (select 1 as a) select a from x fetch first 5 rows only").limit, 5);
  assert.equal(ensureLimit("select replace(name, 'a', 'b') from t").injected, true, "REPLACE come funzione è ammesso");
  assert.equal(ensureLimit("select 'delete from x' as s from t").injected, true, "la parola chiave in una stringa non conta");
  for (const bad of ["delete from PO_HEADER", "select 1; drop table t", "update t set a=1", "select * into copia from t", "insert into t select 1", ""]) assert.throws(() => ensureLimit(bad), QueryError, bad);
  assert.equal(queryHash("select a from t limit 10"), queryHash("SELECT a  FROM t LIMIT 500"), "limiti diversi, stessa query");
});

test("DT-015: non eseguita ⇒ non consegnabile; coerente con LIMIT ⇒ consegnabile; incoerente ⇒ no; tabelle ignote ⇒ avvertenza e QRY solo dopo 2 esecuzioni coerenti", () => {
  const db = openDb(join(mkdtempSync(join(tmpdir(), "qg-")), "k.db"));
  // giro 1 (m2): si registra il testo ESEGUITO, con il suo LIMIT
  const sql = "select status, count(*) from PO_HEADER group by status limit 100";
  let d = deliverable(db, { sql });
  assert.equal(d.deliverable, false); assert.match(d.reason, /non eseguita/);
  recordRun(db, { sql, rowCount: 5, coherence: "coerente", tablesKnowledge: "ignote" });
  assert.equal(deliverable(db, { sql }).deliverable, false, "DT-015: ignote e fuori dal pattern CL-ANL-008 ⇒ dubbio 0.40 ⇒ no");
  d = deliverable(db, { sql, patternKnown: true });
  assert.equal(d.deliverable, true); assert.equal(d.warning, WARNING_UNKNOWN); assert.equal(d.qry_eligible, false, "una sola esecuzione su tabelle ignote");
  recordRun(db, { sql, rowCount: 5, coherence: "coerente", tablesKnowledge: "ignote" });
  assert.equal(deliverable(db, { sql, patternKnown: true }).qry_eligible, true);
  const other = "select count(*) from PO_LINE limit 10";
  recordRun(db, { sql: other, rowCount: 1, coherence: "incoerente", tablesKnowledge: "validate" });
  assert.equal(deliverable(db, { sql: other }).deliverable, false);
  recordRun(db, { sql: "select 1 from TBL_OK limit 1", rowCount: 1, coherence: "coerente", tablesKnowledge: "validate" });
  const ok = deliverable(db, { sql: "select 1 from TBL_OK limit 1", patternKnown: true });
  assert.equal(ok.deliverable, true); assert.equal(ok.warning, null); assert.equal(ok.qry_eligible, true);
  db.close();
});

test("query-guard CLI: SQL da file, check exit 3 finché non eseguita, 0 dopo un'esecuzione coerente", () => {
  const ws = ws09d();
  const f = join(ws, "q.sql"); writeFileSync(f, "select status, count(*) from PO_HEADER group by status");
  const db = join(ws, "customers", "ACME", "knowledge.db");
  assert.equal(cli("scripts/analytics/query-guard.mjs", ["check", "--db", db, "--sql-file", f, "--json"], { ws }).status, 3);
  const l = cli("scripts/analytics/query-guard.mjs", ["limit", "--sql-file", f, "--json"], { ws });
  assert.equal(l.status, 0); assert.equal(l.json.injected, true);
  const unlimited = cli("scripts/analytics/query-guard.mjs", ["record", "--db", db, "--sql-file", f, "--coherence", "coerente", "--tables-knowledge", "validate", "--rows", "5", "--json"], { ws });
  assert.equal(unlimited.json.deliverable, false, "giro 1 (m2): eseguita senza LIMIT ⇒ non consegnabile");
  writeFileSync(f, l.json.sql);   // si esegue il testo con il LIMIT iniettato, e quello si registra
  const r = cli("scripts/analytics/query-guard.mjs", ["record", "--db", db, "--sql-file", f, "--coherence", "coerente", "--tables-knowledge", "validate", "--rows", "5", "--json"], { ws });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(cli("scripts/analytics/query-guard.mjs", ["check", "--db", db, "--sql-file", f, "--json"], { ws }).status, 0);
  writeFileSync(f, "delete from PO_HEADER");
  assert.equal(cli("scripts/analytics/query-guard.mjs", ["limit", "--sql-file", f, "--json"], { ws }).status, 1);
});

const AGG = {
  document: "document.requisition", scope: "P2P", sample: { size: 8420, period: "2025-09..2026-08", source: "C.ACME.ANL.QRY.0011" },
  fields: [{ field: "S.STD.P2P.FLD.0117", filled: 8403, total: 8420, distinct: 210, top5_share: 0.61 }, { field: "S.STD.P2P.FLD.0203", filled: 1010, total: 8420 }],
  groups: [{ dimension: "requester_roles", value: "BUYER", n: 6568 }, { dimension: "requester_roles", value: "REQUESTER", n: 1852 }],
};

test("DIN: gruppo < 20 rifiutato; fill_rate e quote calcolate; DIN valido", () => {
  assert.throws(() => buildDin({ ...AGG, groups: [...AGG.groups, { dimension: "requester_roles", value: "AUDITOR", n: 7 }] }), PrivacyError);
  assert.throws(() => buildDin({ ...AGG, sample: { size: 12 } }), PrivacyError);
  const { din, ctr_proposals } = buildDin(AGG);
  assert.equal(din.fields[0].fill_rate, 0.998); assert.equal(din.fields[1].fill_rate, 0.12);
  assert.deepEqual(din.by_role, { requester_roles: { BUYER: 0.78, REQUESTER: 0.22 } });
  assert.equal(ctr_proposals.length, 0, "senza la documentazione del campo nessuna proposta");
  assert.equal(validateItem({ ...din, id: "L.ACME.P2P.DIN.0001" }).ok, true, errs({ ...din, id: "L.ACME.P2P.DIN.0001" }));
});

test("de_facto_mandatory: fill_rate ≥ 0.98 su un campo documentato opzionale ⇒ DIN.de_facto_mandatory + proposta di CTR (--write, codice dal DB)", () => {
  const ws = ws09d();
  writeItem(ws, { ...base("S.STD.P2P.FLD.0117", "FLD", {}), summary: "Centro di costo.", mandatory: { kind: "never" } });
  writeFileSync(join(ws, "agg.yaml"), YAML.stringify(AGG));
  const small = join(ws, "small.yaml"); writeFileSync(small, YAML.stringify({ ...AGG, groups: [{ dimension: "r", value: "X", n: 3 }] }));
  assert.equal(cli("scripts/analytics/din-build.mjs", ["--input", small, "--customer", "ACME", "--json"], { ws }).status, 3, "gruppo < 20");
  const r = cli("scripts/analytics/din-build.mjs", ["--input", join(ws, "agg.yaml"), "--customer", "ACME", "--write", "--json"], { ws });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.json.din.id, "L.ACME.P2P.DIN.0001");
  assert.deepEqual(r.json.din.de_facto_mandatory, ["S.STD.P2P.FLD.0117"]);
  assert.ok(existsSync(join(ws, "customers/ACME/kb/scopes/P2P/din/L.ACME.P2P.DIN.0001.yaml")));
  const props = readdirSync(join(ws, "customers/ACME/contradictions/proposals"));
  assert.equal(props.length, 1);
  const ctr = YAML.parse(readFileSync(join(ws, "customers/ACME/contradictions/proposals", props[0]), "utf8"));
  assert.equal(ctr.proposal, "de_facto_mandatory"); assert.equal(ctr.subject, "S.STD.P2P.FLD.0117"); assert.equal(ctr.from, "L.ACME.P2P.DIN.0001");
  const fld = YAML.parse(readFileSync(join(ws, "product/kb/scopes/P2P/fields/S.STD.P2P.FLD.0117.yaml"), "utf8"));
  assert.equal(fld.mandatory.kind, "never", "il FLD non si modifica: la regola resta documentale");
});
